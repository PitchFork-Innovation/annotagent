import http from "http";
import https from "https";
import { env } from "./env";
import { getChatHistory, setChatHistory } from "./kv";
import { createSupabaseAdminClient } from "./supabase/admin";
import { createSupabaseServerClient } from "./supabase/server";
import type { AnnotationRecord, ChatMessage, IngestionPayload, PaperListItem, PaperWorkspace, UserProfile } from "./types";

const PYTHON_INGEST_TIMEOUT_MS = env.PYTHON_INGEST_TIMEOUT_MS;

export async function getCurrentUser(): Promise<UserProfile | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return null;
  }

  return {
    id: user.id,
    email: user.email
  };
}

export async function getRecentPapers(): Promise<PaperListItem[]> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data } = await supabase
    .from("user_papers")
    .select("paper:papers(id, arxiv_id, title, abstract, annotations(count))")
    .eq("user_id", user.id)
    .limit(12);

  if (!data) {
    return [];
  }

  return data
    .map((entry: any) => entry.paper)
    .filter(Boolean)
    .map((paper: any) => ({
    id: paper.id,
    arxivId: paper.arxiv_id,
    title: paper.title,
    abstract: paper.abstract,
    annotationCount: paper.annotations?.[0]?.count ?? 0
    }));
}

export async function getPaperWorkspace(paperId: string): Promise<PaperWorkspace | null> {
  const supabase = await createSupabaseServerClient();
  const [{ data: paper }, { data: annotations }] = await Promise.all([
    supabase
      .from("papers")
      .select("id, arxiv_id, title, abstract, pdf_url, page_count, full_text, starter_questions")
      .eq("id", paperId)
      .single(),
    supabase
      .from("annotations")
      .select("id, paper_id, page_number, type, text_ref, note, importance, bbox")
      .eq("paper_id", paperId)
      .order("page_number", { ascending: true })
  ]);

  if (!paper) {
    return null;
  }

  const chatHistory = await getChatHistory(paperId);

  return {
    paper: {
      id: paper.id,
      arxivId: paper.arxiv_id,
      title: paper.title,
      abstract: paper.abstract,
      pdfUrl: paper.pdf_url,
      pageCount: paper.page_count,
      fullText: paper.full_text,
      starterQuestions: paper.starter_questions ?? []
    },
    annotations: (annotations ?? []).map(mapAnnotationRow),
    chatHistory
  };
}

export async function ensurePaperIngested(arxivId: string, userId: string, jobId?: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  const normalizedArxivId = arxivId.trim();
  const { data: existing } = await admin
    .from("papers")
    .select("id, arxiv_id")
    .eq("arxiv_id", normalizedArxivId)
    .maybeSingle();

  if (existing) {
    await supabase.from("user_papers").upsert({ user_id: userId, paper_id: existing.id });
    return existing;
  }

  const payload = await fetchIngestionPayload(normalizedArxivId, jobId);
  const cachedPdfUrl = await cachePaperPdf(admin, payload.arxivId, payload.pdfUrl);

  const { data: createdPaper, error: paperError } = await admin
    .from("papers")
    .insert({
      arxiv_id: payload.arxivId,
      title: payload.title,
      abstract: payload.abstract,
      pdf_url: cachedPdfUrl,
      page_count: payload.pageCount,
      full_text: payload.fullText,
      starter_questions: payload.starterQuestions
    })
    .select("id")
    .single();

  if (paperError?.code === "23505") {
    const { data: duplicatePaper } = await admin.from("papers").select("id").eq("arxiv_id", payload.arxivId).single();

    if (duplicatePaper) {
      await supabase.from("user_papers").upsert({ user_id: userId, paper_id: duplicatePaper.id });
      return duplicatePaper;
    }
  }

  if (paperError || !createdPaper) {
    throw new Error(paperError?.message ?? "Paper insert failed.");
  }

  if (payload.annotations.length > 0) {
    const { error: annotationError } = await admin.from("annotations").insert(
      payload.annotations.map((annotation) => ({
        paper_id: createdPaper.id,
        page_number: annotation.page_number,
        type: annotation.type,
        text_ref: annotation.text_ref,
        note: annotation.note,
        importance: annotation.importance,
        bbox: annotation.bbox
      }))
    );

    if (annotationError) {
      throw new Error(annotationError.message);
    }
  }

  await supabase.from("user_papers").upsert({ user_id: userId, paper_id: createdPaper.id });

  return createdPaper;
}

export async function upsertChatHistory(paperId: string, messages: ChatMessage[]) {
  await setChatHistory(paperId, messages);
}

export async function reprocessPaperAnnotations(paperId: string, userId: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();

  const { data: linkedPaper } = await supabase
    .from("user_papers")
    .select("paper:papers(id, arxiv_id)")
    .eq("user_id", userId)
    .eq("paper_id", paperId)
    .maybeSingle();

  const paper = (linkedPaper as any)?.paper;

  if (!paper?.id || !paper?.arxiv_id) {
    throw new Error("Paper not found in your library.");
  }

  await upgradePaperFromPipeline(admin, paper.id, paper.arxiv_id);

  const { count } = await admin
    .from("annotations")
    .select("*", { count: "exact", head: true })
    .eq("paper_id", paper.id);

  return {
    paperId: paper.id,
    annotationCount: count ?? 0
  };
}

function mapAnnotationRow(row: any): AnnotationRecord {
  return {
    id: row.id,
    paperId: row.paper_id,
    pageNumber: row.page_number,
    type: row.type,
    textRef: row.text_ref,
    note: row.note,
    importance: row.importance,
    bbox: row.bbox
  };
}

async function fetchIngestionPayload(arxivId: string, jobId?: string): Promise<IngestionPayload> {
  const url = new URL("/ingest", env.PYTHON_SERVICE_URL);
  const payload = JSON.stringify({ arxiv_id: arxivId, job_id: jobId });
  let response: { status: number; body: string };

  try {
    response = await postJson(url, payload, PYTHON_INGEST_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Python ingestion service request failed.";
    throw new Error(message);
  }

  if (response.status < 200 || response.status >= 300) {
    try {
      const parsed = JSON.parse(response.body) as { detail?: string };
      throw new Error(parsed.detail ?? "Python ingestion service failed.");
    } catch {
      throw new Error(response.body || "Python ingestion service failed.");
    }
  }

  return JSON.parse(response.body) as IngestionPayload;
}

function postJson(url: URL, body: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Python annotation service timed out after ${timeoutMs / 1000} seconds.`));
    });

    request.on("error", (error) => {
      reject(error);
    });

    request.write(body);
    request.end();
  });
}

async function cachePaperPdf(admin: ReturnType<typeof createSupabaseAdminClient>, arxivId: string, sourceUrl: string) {
  const objectPath = `arxiv/${arxivId}.pdf`;
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  const { data: existing } = await admin.storage.from(bucket).list("arxiv", {
    search: `${arxivId}.pdf`
  });

  if (!existing?.some((file) => file.name === `${arxivId}.pdf`)) {
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        return sourceUrl;
      }

      const pdfBuffer = await response.arrayBuffer();
      const { error } = await admin.storage.from(bucket).upload(objectPath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true
      });

      if (error) {
        return sourceUrl;
      }
    } catch {
      return sourceUrl;
    }
  }

  const { data } = admin.storage.from(bucket).getPublicUrl(objectPath);
  return data.publicUrl;
}
function buildStarterQuestions(title: string) {
  return [
    `What is the main contribution of '${title}'?`,
    "Which assumptions are most important for interpreting the results?",
    "What terms or concepts would a non-expert need defined first?",
    "What are the paper's biggest limitations or open questions?"
  ];
}

async function upgradePaperFromPipeline(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  paperId: string,
  arxivId: string,
  jobId?: string
) {
  const payload = await fetchIngestionPayload(arxivId, jobId);
  const cachedPdfUrl = await cachePaperPdf(admin, payload.arxivId, payload.pdfUrl);

  const { error: paperError } = await admin
    .from("papers")
    .update({
      title: payload.title,
      abstract: payload.abstract,
      pdf_url: cachedPdfUrl,
      page_count: payload.pageCount,
      full_text: payload.fullText,
      starter_questions: payload.starterQuestions
    })
    .eq("id", paperId);

  if (paperError) {
    throw new Error(paperError.message);
  }

  const { error: deleteError } = await admin.from("annotations").delete().eq("paper_id", paperId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (payload.annotations.length === 0) {
    throw new Error("Python ingestion completed without annotations.");
  }

  const { error: insertError } = await admin.from("annotations").insert(
    payload.annotations.map((annotation) => ({
      paper_id: paperId,
      page_number: annotation.page_number,
      type: annotation.type,
      text_ref: annotation.text_ref,
      note: annotation.note,
      importance: annotation.importance,
      bbox: annotation.bbox
    }))
  );

  if (insertError) {
    throw new Error(insertError.message);
  }
}
