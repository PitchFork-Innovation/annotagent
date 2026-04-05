import http from "http";
import https from "https";
import { env } from "./env";
import { getChatHistory, setChatHistory } from "./kv";
import { createSupabaseAdminClient } from "./supabase/admin";
import { createSupabaseServerClient } from "./supabase/server";
import type { AnnotationRecord, ChatMessage, IngestionPayload, PaperListItem, PaperWorkspace, TextAnchor, TextAnchorPayload, UserProfile } from "./types";

const PYTHON_INGEST_TIMEOUT_MS = env.PYTHON_INGEST_TIMEOUT_MS;
let aiSummaryColumnAvailable: boolean | null = null;

type RecentPaperRow = {
  id: string;
  arxiv_id: string;
  title: string;
  abstract: string;
  annotations?: Array<{
    count: number;
  }> | null;
};

type RecentUserPaperRow = {
  paper: RecentPaperRow | RecentPaperRow[] | null;
};

type LinkedPaperRow = {
  paper: {
    id: string;
    arxiv_id: string;
    title: string;
    abstract: string;
    pdf_url: string;
  } | null;
};

type AnnotationRow = {
  id: string;
  paper_id: string;
  page_number: number;
  type: AnnotationRecord["type"];
  text_ref: string;
  note: string;
  importance: AnnotationRecord["importance"];
  bbox: AnnotationRecord["bbox"];
  anchor: TextAnchorPayload | null;
};

type WorkspacePaperRow = {
  id: string;
  arxiv_id: string;
  title: string;
  abstract: string;
  ai_summary: string | null;
  pdf_url: string;
  page_count: number;
  full_text: string;
  starter_questions: string[] | null;
};

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

  return (data as unknown as RecentUserPaperRow[])
    .map((entry) => normalizeRecentPaper(entry.paper))
    .filter((paper): paper is RecentPaperRow => Boolean(paper))
    .map((paper) => ({
      id: paper.id,
      arxivId: paper.arxiv_id,
      title: paper.title,
      abstract: paper.abstract,
      annotationCount: paper.annotations?.[0]?.count ?? 0
    }));
}

export async function getPaperWorkspace(paperId: string): Promise<PaperWorkspace | null> {
  const supabase = await createSupabaseServerClient();
  const [paper, annotationsResult] = await Promise.all([
    fetchPaperWorkspaceRow(supabase, paperId),
    supabase
      .from("annotations")
      .select("id, paper_id, page_number, type, text_ref, note, importance, bbox, anchor")
      .eq("paper_id", paperId)
      .order("page_number", { ascending: true })
  ]);

  if (!paper) {
    return null;
  }

  const chatHistory = await getChatHistory(paperId);
  const resolvedSummary = await ensurePaperSummary(paper as WorkspacePaperRow);

  return {
    paper: {
      id: paper.id,
      arxivId: paper.arxiv_id,
      title: paper.title,
      abstract: paper.abstract,
      aiSummary: resolvedSummary ?? paper.ai_summary ?? paper.abstract,
      pdfUrl: paper.pdf_url,
      pageCount: paper.page_count,
      fullText: paper.full_text,
      starterQuestions: paper.starter_questions ?? []
    },
    annotations: (annotationsResult.data ?? []).map(mapAnnotationRow),
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

  const { data: createdPaper, error: paperError } = await insertPaperRow(admin, payload, cachedPdfUrl);

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
        bbox: annotation.bbox,
        anchor: annotation.anchor ?? null
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

export async function reprocessPaperAnnotations(paperId: string, userId: string, jobId?: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();

  const { data: linkedPaper } = await supabase
    .from("user_papers")
    .select("paper:papers(id, arxiv_id, title, abstract, pdf_url)")
    .eq("user_id", userId)
    .eq("paper_id", paperId)
    .maybeSingle();

  const paper = (linkedPaper as LinkedPaperRow | null)?.paper;

  if (!paper?.id || !paper?.arxiv_id || !paper.title || !paper.pdf_url) {
    throw new Error("Paper not found in your library.");
  }

  const resolvedPdfUrl = await resolvePreferredPaperPdfUrl(admin, paper.arxiv_id, paper.pdf_url);

  await upgradePaperFromPipeline(
    admin,
    {
      id: paper.id,
      arxivId: paper.arxiv_id,
      title: paper.title,
      abstract: paper.abstract,
      pdfUrl: resolvedPdfUrl
    },
    jobId
  );

  const { count } = await admin
    .from("annotations")
    .select("*", { count: "exact", head: true })
    .eq("paper_id", paper.id);

  return {
    paperId: paper.id,
    annotationCount: count ?? 0
  };
}

function mapAnnotationRow(row: AnnotationRow): AnnotationRecord {
  return {
    id: row.id,
    paperId: row.paper_id,
    pageNumber: row.page_number,
    type: row.type,
    textRef: row.text_ref,
    note: row.note,
    importance: row.importance,
    bbox: row.bbox,
    anchor: mapTextAnchor(row.anchor)
  };
}

function mapTextAnchor(anchor: TextAnchorPayload | null | undefined): TextAnchor | null {
  if (!anchor) {
    return null;
  }

  return {
    pageTextStart: anchor.page_text_start,
    pageTextEnd: anchor.page_text_end,
    occurrenceIndex: anchor.occurrence_index
  };
}

function normalizeRecentPaper(paper: RecentUserPaperRow["paper"]): RecentPaperRow | null {
  if (Array.isArray(paper)) {
    return paper[0] ?? null;
  }

  return paper;
}

async function fetchIngestionPayload(arxivId: string, jobId?: string): Promise<IngestionPayload> {
  const url = new URL("/ingest", env.PYTHON_SERVICE_URL);
  const payload = JSON.stringify({ arxiv_id: arxivId, job_id: jobId });
  return fetchPythonPayload(url, payload);
}

async function fetchReprocessPayload(
  paper: {
    arxivId: string;
    title: string;
    abstract: string;
    pdfUrl: string;
  },
  jobId?: string
): Promise<IngestionPayload> {
  const url = new URL("/reprocess", env.PYTHON_SERVICE_URL);
  const payload = JSON.stringify({
    arxiv_id: paper.arxivId,
    title: paper.title,
    abstract: paper.abstract,
    pdf_url: paper.pdfUrl,
    job_id: jobId
  });
  return fetchPythonPayload(url, payload);
}

async function fetchPythonPayload(url: URL, payload: string): Promise<IngestionPayload> {
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

    // Temporarily disable the end-to-end ingest request timeout so we can
    // validate correctness on long-running papers before optimizing speed.
    // request.setTimeout(timeoutMs, () => {
    //   request.destroy(new Error(`Python annotation service timed out after ${timeoutMs / 1000} seconds.`));
    // });

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

async function upgradePaperFromPipeline(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  paper: {
    id: string;
    arxivId: string;
    title: string;
    abstract: string;
    pdfUrl: string;
  },
  jobId?: string
) {
  const payload = await fetchReprocessPayload(paper, jobId);
  const cachedPdfUrl = await cachePaperPdf(admin, payload.arxivId, payload.pdfUrl);

  const { error: paperError } = await updatePaperRow(admin, paper.id, payload, cachedPdfUrl);

  if (paperError) {
    throw new Error(paperError.message);
  }

  const { error: deleteError } = await admin.from("annotations").delete().eq("paper_id", paper.id);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (payload.annotations.length === 0) {
    throw new Error("Python ingestion completed without annotations.");
  }

  const { error: insertError } = await admin.from("annotations").insert(
    payload.annotations.map((annotation) => ({
      paper_id: paper.id,
      page_number: annotation.page_number,
      type: annotation.type,
      text_ref: annotation.text_ref,
      note: annotation.note,
      importance: annotation.importance,
      bbox: annotation.bbox,
      anchor: annotation.anchor ?? null
    }))
  );

  if (insertError) {
    throw new Error(insertError.message);
  }
}

async function resolvePreferredPaperPdfUrl(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  arxivId: string,
  fallbackUrl: string
) {
  const bucket = env.SUPABASE_STORAGE_BUCKET;
  const objectPath = `arxiv/${arxivId}.pdf`;
  const { data: existing } = await admin.storage.from(bucket).list("arxiv", {
    search: `${arxivId}.pdf`
  });

  if (existing?.some((file) => file.name === `${arxivId}.pdf`)) {
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(objectPath, 60 * 15);

    if (error || !data?.signedUrl) {
      throw new Error(error?.message ?? "Unable to create a signed URL for the cached PDF.");
    }

    return data.signedUrl;
  }

  // Older papers or missing storage objects may only have an arXiv PDF URL.
  // Reprocess should fall back to that source and let the normal cache step
  // restore the stored copy after a successful pipeline run.
  return fallbackUrl;
}

async function ensurePaperSummary(paper: WorkspacePaperRow): Promise<string | null> {
  if (aiSummaryColumnAvailable === false) {
    return null;
  }

  const existingSummary = normalizeSummaryText(paper.ai_summary);
  if (existingSummary) {
    return existingSummary;
  }

  try {
    const generatedSummary = await fetchPaperSummary(paper.title, paper.abstract, paper.full_text);
    if (!generatedSummary) {
      return null;
    }

    const admin = createSupabaseAdminClient();
    const { error } = await updatePaperSummary(admin, paper.id, generatedSummary);

    if (error) {
      return generatedSummary;
    }

    return generatedSummary;
  } catch {
    return null;
  }
}

async function fetchPaperSummary(title: string, abstract: string, fullText: string): Promise<string | null> {
  const url = new URL("/summarize", env.PYTHON_SERVICE_URL);
  const payload = JSON.stringify({
    title,
    abstract,
    fullText
  });
  const response = await postJson(url, payload, PYTHON_INGEST_TIMEOUT_MS);

  if (response.status < 200 || response.status >= 300) {
    throw new Error("Python summary service failed.");
  }

  const parsed = JSON.parse(response.body) as { summary?: string };
  return normalizeSummaryText(parsed.summary);
}

function normalizeSummaryText(summary: string | null | undefined) {
  if (!summary) {
    return null;
  }

  const normalized = summary.trim();
  return normalized.length > 0 ? normalized : null;
}

async function fetchPaperWorkspaceRow(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  paperId: string
): Promise<WorkspacePaperRow | null> {
  const includeSummary = aiSummaryColumnAvailable !== false;
  const selectedColumns = getPaperWorkspaceSelect(includeSummary);
  let response = await supabase.from("papers").select(selectedColumns).eq("id", paperId).maybeSingle();

  if (response.error && includeSummary && isMissingAiSummaryColumnError(response.error)) {
    aiSummaryColumnAvailable = false;
    response = await supabase.from("papers").select(getPaperWorkspaceSelect(false)).eq("id", paperId).maybeSingle();
  } else if (!response.error && includeSummary) {
    aiSummaryColumnAvailable = true;
  }

  if (response.error || !response.data) {
    return null;
  }

  const paperRow = response.data as unknown as Record<string, unknown>;
  return {
    ...paperRow,
    ai_summary: includeSummary && "ai_summary" in paperRow ? (paperRow.ai_summary as string | null | undefined) ?? null : null
  } as WorkspacePaperRow;
}

function getPaperWorkspaceSelect(includeSummary: boolean) {
  const base = "id, arxiv_id, title, abstract, pdf_url, page_count, full_text, starter_questions";
  return includeSummary ? `${base}, ai_summary` : base;
}

async function insertPaperRow(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  payload: IngestionPayload,
  cachedPdfUrl: string
) {
  const includeSummary = aiSummaryColumnAvailable !== false;
  let response = await admin
    .from("papers")
    .insert(buildPaperMutationPayload(payload, cachedPdfUrl, includeSummary))
    .select("id")
    .single();

  if (response.error && includeSummary && isMissingAiSummaryColumnError(response.error)) {
    aiSummaryColumnAvailable = false;
    response = await admin
      .from("papers")
      .insert(buildPaperMutationPayload(payload, cachedPdfUrl, false))
      .select("id")
      .single();
  } else if (!response.error && includeSummary) {
    aiSummaryColumnAvailable = true;
  }

  return response;
}

async function updatePaperRow(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  paperId: string,
  payload: IngestionPayload,
  cachedPdfUrl: string
) {
  const includeSummary = aiSummaryColumnAvailable !== false;
  let response = await admin
    .from("papers")
    .update(buildPaperMutationPayload(payload, cachedPdfUrl, includeSummary))
    .eq("id", paperId);

  if (response.error && includeSummary && isMissingAiSummaryColumnError(response.error)) {
    aiSummaryColumnAvailable = false;
    response = await admin.from("papers").update(buildPaperMutationPayload(payload, cachedPdfUrl, false)).eq("id", paperId);
  } else if (!response.error && includeSummary) {
    aiSummaryColumnAvailable = true;
  }

  return response;
}

async function updatePaperSummary(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  paperId: string,
  summary: string
) {
  const includeSummary = aiSummaryColumnAvailable !== false;
  if (!includeSummary) {
    return { error: null };
  }

  const response = await admin.from("papers").update({ ai_summary: summary }).eq("id", paperId);

  if (response.error && isMissingAiSummaryColumnError(response.error)) {
    aiSummaryColumnAvailable = false;
    return { error: null };
  }

  aiSummaryColumnAvailable = true;
  return response;
}

function buildPaperMutationPayload(payload: IngestionPayload, cachedPdfUrl: string, includeSummary: boolean) {
  const basePayload = {
    arxiv_id: payload.arxivId,
    title: payload.title,
    abstract: payload.abstract,
    pdf_url: cachedPdfUrl,
    page_count: payload.pageCount,
    full_text: payload.fullText,
    starter_questions: payload.starterQuestions
  };

  return includeSummary
    ? {
        ...basePayload,
        ai_summary: payload.summary || payload.abstract
      }
    : basePayload;
}

function isMissingAiSummaryColumnError(error: { message?: string; details?: string | null }) {
  const haystack = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return haystack.includes("ai_summary") && (haystack.includes("schema cache") || haystack.includes("column"));
}
