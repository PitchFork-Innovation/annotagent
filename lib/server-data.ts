import http from "http";
import https from "https";
import { randomUUID } from "crypto";
import { env } from "./env";
import { getChatHistory, setChatHistory } from "./kv";
import { createPythonServiceToken } from "./python-auth";
import { createSupabaseAdminClient } from "./supabase/admin";
import { createSupabaseServerClient } from "./supabase/server";
import type {
  AnnotationRecord,
  ChatMessage,
  IngestionPayload,
  PaperListItem,
  PaperSource,
  PaperWorkspace,
  TextAnchor,
  TextAnchorPayload,
  UserProfile
} from "./types";

const PYTHON_INGEST_TIMEOUT_MS = env.PYTHON_INGEST_TIMEOUT_MS;
const SIGNED_URL_TTL_SECONDS = 60 * 15;
let aiSummaryColumnAvailable: boolean | null = null;

type RecentPaperRow = {
  id: string;
  arxiv_id: string | null;
  source: string | null;
  original_filename: string | null;
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
    source: string | null;
    arxiv_id: string | null;
    original_filename: string | null;
    storage_path: string | null;
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
  source: string | null;
  arxiv_id: string | null;
  original_filename: string | null;
  storage_path: string | null;
  title: string;
  abstract: string;
  ai_summary: string | null;
  pdf_url: string;
  page_count: number;
  full_text: string;
  starter_questions: string[] | null;
  annotation_style: string | null;
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
    .select("paper:papers(id, source, arxiv_id, original_filename, title, abstract, annotations(count))")
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
      source: normalizeSource(paper.source),
      arxivId: paper.arxiv_id,
      originalFilename: paper.original_filename,
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
      source: normalizeSource(paper.source),
      arxivId: paper.arxiv_id,
      originalFilename: paper.original_filename,
      title: paper.title,
      abstract: paper.abstract,
      aiSummary: resolvedSummary ?? paper.ai_summary ?? paper.abstract,
      pdfUrl: paper.pdf_url,
      pageCount: paper.page_count,
      fullText: paper.full_text,
      starterQuestions: paper.starter_questions ?? [],
      annotationStyle: (paper.annotation_style as "default" | "novice" | "expert") ?? "default"
    },
    annotations: (annotationsResult.data ?? []).map(mapAnnotationRow),
    chatHistory
  };
}

export async function ensurePaperIngested(arxivId: string, userId: string, jobId?: string) {
  const normalizedArxivId = arxivId.trim();
  const payload = await fetchArxivIngestionPayload(normalizedArxivId, jobId);
  return applyIngestedPaper(payload, userId);
}

export async function applyIngestedPaper(payload: IngestionPayload, userId: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();

  if (payload.source === "arxiv") {
    return applyArxivIngestedPaper(payload, userId, supabase, admin);
  }

  return applyUploadIngestedPaper(payload, userId, supabase, admin);
}

async function applyArxivIngestedPaper(
  payload: IngestionPayload,
  userId: string,
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  admin: ReturnType<typeof createSupabaseAdminClient>
) {
  if (!payload.arxivId) {
    throw new Error("arxivId is required for arXiv ingestion.");
  }

  const normalizedArxivId = payload.arxivId.trim();
  const { data: existing } = await admin
    .from("papers")
    .select("id, arxiv_id")
    .eq("source", "arxiv")
    .eq("arxiv_id", normalizedArxivId)
    .maybeSingle();

  if (existing) {
    await supabase.from("user_papers").upsert({ user_id: userId, paper_id: existing.id });
    return existing;
  }

  const cachedPdfUrl = await cachePaperPdf(admin, normalizedArxivId, payload.pdfUrl);
  const { data: createdPaper, error: paperError } = await insertPaperRow(admin, payload, cachedPdfUrl);

  if (paperError?.code === "23505") {
    const { data: duplicatePaper } = await admin
      .from("papers")
      .select("id, arxiv_id")
      .eq("source", "arxiv")
      .eq("arxiv_id", normalizedArxivId)
      .single();

    if (duplicatePaper) {
      await supabase.from("user_papers").upsert({ user_id: userId, paper_id: duplicatePaper.id });
      return duplicatePaper;
    }
  }

  if (paperError || !createdPaper) {
    throw new Error(paperError?.message ?? "Paper insert failed.");
  }

  await insertAnnotations(admin, createdPaper.id, payload);
  await supabase.from("user_papers").upsert({ user_id: userId, paper_id: createdPaper.id });
  return createdPaper;
}

async function applyUploadIngestedPaper(
  payload: IngestionPayload,
  userId: string,
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  admin: ReturnType<typeof createSupabaseAdminClient>
) {
  if (!payload.storagePath) {
    throw new Error("storagePath is required for upload ingestion.");
  }

  // Per-PRD: uploads are not deduped. Each upload mints a fresh paper row,
  // even if the file is byte-identical to one a different user uploaded.
  const expectedPrefix = `user-uploads/${userId}/`;
  if (!payload.storagePath.startsWith(expectedPrefix)) {
    throw new Error("Upload storage path does not belong to the authenticated user.");
  }

  const { data: createdPaper, error: paperError } = await insertPaperRow(admin, payload, payload.pdfUrl);

  if (paperError || !createdPaper) {
    throw new Error(paperError?.message ?? "Paper insert failed.");
  }

  await insertAnnotations(admin, createdPaper.id, payload);
  await supabase.from("user_papers").upsert({ user_id: userId, paper_id: createdPaper.id });
  return createdPaper;
}

export async function upsertChatHistory(paperId: string, messages: ChatMessage[]) {
  await setChatHistory(paperId, messages);
}

export async function reprocessPaperAnnotations(paperId: string, userId: string, jobId?: string) {
  const admin = createSupabaseAdminClient();
  const paper = await getLinkedPaperForUser(paperId, userId);

  if (!paper?.id || !paper.title || !paper.pdf_url) {
    throw new Error("Paper not found in your library.");
  }

  const source = normalizeSource(paper.source);
  const resolvedPdfUrl = await resolvePreferredPaperPdfUrl(admin, source, paper.arxiv_id, paper.storage_path, paper.pdf_url);
  const payload = await fetchReprocessPayload(
    {
      paperId: paper.id,
      source,
      arxivId: paper.arxiv_id,
      originalFilename: paper.original_filename,
      storagePath: paper.storage_path,
      title: paper.title,
      abstract: paper.abstract,
      pdfUrl: resolvedPdfUrl
    },
    jobId
  );
  return applyReprocessedPaper(paper.id, userId, payload);
}

export async function applyReprocessedPaper(paperId: string, userId: string, payload: IngestionPayload) {
  const admin = createSupabaseAdminClient();
  const paper = await getLinkedPaperForUser(paperId, userId);

  if (!paper?.id || !paper.title || !paper.pdf_url) {
    throw new Error("Paper not found in your library.");
  }

  const source = normalizeSource(paper.source);
  if (payload.source !== source) {
    throw new Error("Reprocess payload source does not match the selected paper.");
  }
  if (source === "arxiv" && paper.arxiv_id !== payload.arxivId) {
    throw new Error("Reprocess payload does not match the selected paper.");
  }

  const cachedPdfUrl =
    source === "arxiv" && payload.arxivId
      ? await cachePaperPdf(admin, payload.arxivId, payload.pdfUrl)
      : paper.pdf_url;
  const { error: paperError } = await updatePaperRow(admin, paper.id, payload, cachedPdfUrl);

  if (paperError) {
    throw new Error(paperError.message);
  }

  const { error: deleteError } = await admin.from("annotations").delete().eq("paper_id", paper.id);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  await insertAnnotations(admin, paper.id, payload);

  const { count } = await admin
    .from("annotations")
    .select("*", { count: "exact", head: true })
    .eq("paper_id", paper.id);

  return {
    paperId: paper.id,
    annotationCount: count ?? 0
  };
}

export async function removePaperFromLibrary(paperId: string, userId: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();

  const paper = await getLinkedPaperForUser(paperId, userId);
  if (!paper?.id) {
    throw new Error("Paper not found in your library.");
  }

  const { error: unlinkError } = await supabase
    .from("user_papers")
    .delete()
    .eq("user_id", userId)
    .eq("paper_id", paper.id);

  if (unlinkError) {
    throw new Error(unlinkError.message);
  }

  // arXiv papers are shared across users; leave the global record and any cached
  // PDF in place. Uploads are private and cascade-deleted when no other user
  // links them. With the no-dedup model the "other refs" check is structurally
  // always zero in v1, but it's performed defensively.
  const source = normalizeSource(paper.source);
  if (source !== "upload") {
    return { source };
  }

  const { count: remainingLinks } = await admin
    .from("user_papers")
    .select("*", { count: "exact", head: true })
    .eq("paper_id", paper.id);

  if ((remainingLinks ?? 0) > 0) {
    return { source };
  }

  await admin.from("annotations").delete().eq("paper_id", paper.id);
  await admin.from("papers").delete().eq("id", paper.id);

  if (paper.storage_path) {
    await admin.storage.from(env.SUPABASE_STORAGE_BUCKET).remove([paper.storage_path]);
  }

  return { source };
}

export async function createUploadSlot(userId: string, declaredSize: number) {
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    throw new Error("Upload size is required.");
  }
  if (declaredSize > MAX_UPLOAD_BYTES) {
    throw new Error("PDF must be 25 MB or smaller.");
  }

  const admin = createSupabaseAdminClient();
  const uploadId = randomUUID();
  const storagePath = `user-uploads/${userId}/${uploadId}.pdf`;

  const { data, error } = await admin.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to create signed upload URL.");
  }

  return {
    uploadId,
    storagePath,
    signedUploadUrl: data.signedUrl,
    signedUploadToken: data.token
  };
}

export async function createUploadDownloadUrl(userId: string, uploadId: string) {
  const admin = createSupabaseAdminClient();
  const storagePath = `user-uploads/${userId}/${uploadId}.pdf`;
  const { data, error } = await admin.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? "Unable to locate the uploaded PDF.");
  }

  return {
    storagePath,
    signedDownloadUrl: data.signedUrl
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

function normalizeSource(source: string | null | undefined): PaperSource {
  return source === "upload" ? "upload" : "arxiv";
}

async function fetchArxivIngestionPayload(arxivId: string, jobId?: string): Promise<IngestionPayload> {
  const resolvedJobId = jobId ?? randomUUID();
  const url = new URL("/ingest", env.PYTHON_SERVICE_URL);
  const payload = JSON.stringify({ arxiv_id: arxivId, job_id: resolvedJobId });
  return fetchPythonPayload(url, payload, createPythonServiceToken(resolvedJobId, "ingest"));
}

async function fetchReprocessPayload(
  paper: {
    paperId: string;
    source: PaperSource;
    arxivId: string | null;
    originalFilename: string | null;
    storagePath: string | null;
    title: string;
    abstract: string;
    pdfUrl: string;
  },
  jobId?: string
): Promise<IngestionPayload> {
  const resolvedJobId = jobId ?? randomUUID();
  const url = new URL("/reprocess", env.PYTHON_SERVICE_URL);
  const payload = JSON.stringify({
    paper_id: paper.paperId,
    source: paper.source,
    arxiv_id: paper.arxivId,
    original_filename: paper.originalFilename,
    storage_path: paper.storagePath,
    title: paper.title,
    abstract: paper.abstract,
    pdf_url: paper.pdfUrl,
    job_id: resolvedJobId
  });
  return fetchPythonPayload(url, payload, createPythonServiceToken(resolvedJobId, "reprocess"));
}

async function fetchPythonPayload(url: URL, payload: string, token: string): Promise<IngestionPayload> {
  let response: { status: number; body: string };

  try {
    response = await postJson(url, payload, PYTHON_INGEST_TIMEOUT_MS, token);
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

function postJson(url: URL, body: string, timeoutMs: number, token?: string): Promise<{ status: number; body: string }> {
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
          "Content-Length": Buffer.byteLength(body),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
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

async function resolvePreferredPaperPdfUrl(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  source: PaperSource,
  arxivId: string | null,
  storagePath: string | null,
  fallbackUrl: string
) {
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  if (source === "upload") {
    if (!storagePath) {
      throw new Error("Upload paper is missing its storage path.");
    }
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      throw new Error(error?.message ?? "Unable to create a signed URL for the uploaded PDF.");
    }
    return data.signedUrl;
  }

  if (!arxivId) {
    return fallbackUrl;
  }

  const objectPath = `arxiv/${arxivId}.pdf`;
  const { data: existing } = await admin.storage.from(bucket).list("arxiv", {
    search: `${arxivId}.pdf`
  });

  if (existing?.some((file) => file.name === `${arxivId}.pdf`)) {
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

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
  const base =
    "id, source, arxiv_id, original_filename, storage_path, title, abstract, pdf_url, page_count, full_text, starter_questions, annotation_style";
  return includeSummary ? `${base}, ai_summary` : base;
}

async function getLinkedPaperForUser(paperId: string, userId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: linkedPaper } = await supabase
    .from("user_papers")
    .select("paper:papers(id, source, arxiv_id, original_filename, storage_path, title, abstract, pdf_url)")
    .eq("user_id", userId)
    .eq("paper_id", paperId)
    .maybeSingle();

  return (linkedPaper as LinkedPaperRow | null)?.paper;
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

async function insertAnnotations(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  paperId: string,
  payload: IngestionPayload
) {
  if (payload.annotations.length === 0) {
    throw new Error("Python ingestion completed without annotations.");
  }

  const { error } = await admin.from("annotations").insert(
    payload.annotations.map((annotation) => ({
      paper_id: paperId,
      page_number: annotation.page_number,
      type: annotation.type,
      text_ref: annotation.text_ref,
      note: annotation.note,
      importance: annotation.importance,
      bbox: annotation.bbox,
      anchor: annotation.anchor ?? null
    }))
  );

  if (error) {
    throw new Error(error.message);
  }
}

function buildPaperMutationPayload(payload: IngestionPayload, cachedPdfUrl: string, includeSummary: boolean) {
  const basePayload = {
    source: payload.source,
    arxiv_id: payload.source === "arxiv" ? payload.arxivId : null,
    original_filename: payload.source === "upload" ? payload.originalFilename : null,
    storage_path: payload.source === "upload" ? payload.storagePath : null,
    title: payload.title,
    abstract: payload.abstract,
    pdf_url: cachedPdfUrl,
    page_count: payload.pageCount,
    full_text: payload.fullText,
    starter_questions: payload.starterQuestions,
    annotation_style: payload.annotationStyle ?? "default"
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
