import { env } from "./env";
import { getChatHistory, setChatHistory } from "./kv";
import { createSupabaseAdminClient } from "./supabase/admin";
import { createSupabaseServerClient } from "./supabase/server";
import type { AnnotationRecord, ChatMessage, IngestionPayload, PaperListItem, PaperWorkspace, UserProfile } from "./types";

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

export async function ensurePaperIngested(arxivId: string, userId: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  const { data: existing } = await supabase.from("papers").select("id").eq("arxiv_id", arxivId).single();

  if (existing) {
    await supabase.from("user_papers").upsert({ user_id: userId, paper_id: existing.id });
    return existing;
  }

  const response = await fetch(`${env.PYTHON_SERVICE_URL}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ arxiv_id: arxivId })
  });

  if (!response.ok) {
    throw new Error("Python ingestion service failed.");
  }

  const payload = (await response.json()) as IngestionPayload;
  const cachedPdfUrl = await cachePaperPdf(admin, payload.arxivId, payload.pdfUrl);

  const { data: createdPaper, error: paperError } = await supabase
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

  if (paperError || !createdPaper) {
    throw new Error(paperError?.message ?? "Paper insert failed.");
  }

  if (payload.annotations.length > 0) {
    const { error: annotationError } = await supabase.from("annotations").insert(
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

async function cachePaperPdf(admin: ReturnType<typeof createSupabaseAdminClient>, arxivId: string, sourceUrl: string) {
  const objectPath = `arxiv/${arxivId}.pdf`;
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  const { data: existing } = await admin.storage.from(bucket).list("arxiv", {
    search: `${arxivId}.pdf`
  });

  if (!existing?.some((file) => file.name === `${arxivId}.pdf`)) {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error("Failed to fetch PDF for storage cache.");
    }

    const pdfBuffer = await response.arrayBuffer();
    const { error } = await admin.storage.from(bucket).upload(objectPath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true
    });

    if (error) {
      throw new Error(error.message);
    }
  }

  const { data } = admin.storage.from(bucket).getPublicUrl(objectPath);
  return data.publicUrl;
}
