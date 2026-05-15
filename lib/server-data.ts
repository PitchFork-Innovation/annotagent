import http from "http";
import https from "https";
import { randomUUID } from "crypto";
import { env } from "./env";
import { getChatHistory, setChatHistory } from "./chat-store";
import { createPythonServiceToken } from "./python-auth";
import { connectDB } from "./mongodb";
import { Paper, UserPaper } from "./models";
import {
  createPresignedPutUrl,
  createPresignedGetUrl,
  deleteObject,
  objectExists,
  uploadObject,
} from "./s3";
import { getSessionUser } from "@/auth";
import type {
  AnnotationRecord,
  ChatMessage,
  IngestionPayload,
  PaperListItem,
  PaperSource,
  PaperWorkspace,
  TextAnchor,
  TextAnchorPayload,
  UserProfile,
} from "./types";

const PYTHON_INGEST_TIMEOUT_MS = env.PYTHON_INGEST_TIMEOUT_MS;

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getCurrentUser(): Promise<UserProfile | null> {
  return getSessionUser();
}

export async function getRecentPapers(): Promise<PaperListItem[]> {
  const user = await getSessionUser();
  if (!user) return [];
  await connectDB();
  const links = await UserPaper.find({ userId: user.id })
    .sort({ createdAt: -1 })
    .limit(12)
    .lean();
  if (!links.length) return [];
  const paperIds = links.map((l) => l.paperId as string);
  const papers = await Paper.find(
    { _id: { $in: paperIds } },
    { _id: 1, source: 1, arxivId: 1, originalFilename: 1, title: 1, abstract: 1, "annotations._id": 1 }
  ).lean();
  const paperMap = new Map(papers.map((p) => [p._id as string, p]));
  return paperIds
    .map((id) => paperMap.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({
      id: p._id as string,
      source: normalizeSource(p.source),
      arxivId: (p.arxivId as string | null) ?? null,
      originalFilename: (p.originalFilename as string | null) ?? null,
      title: p.title as string,
      abstract: p.abstract as string,
      annotationCount: Array.isArray(p.annotations) ? p.annotations.length : 0,
    }));
}

export async function getPaperWorkspace(paperId: string): Promise<PaperWorkspace | null> {
  const user = await getSessionUser();
  if (!user) return null;
  await connectDB();
  const linked = await UserPaper.exists({ userId: user.id, paperId });
  if (!linked) return null;
  const paper = await Paper.findById(paperId).lean();
  if (!paper) return null;
  const chatHistory = await getChatHistory(paperId);
  const resolvedSummary = await ensurePaperSummary(paper as unknown as Record<string, unknown>);
  return {
    paper: {
      id: paper._id as string,
      source: normalizeSource(paper.source),
      arxivId: (paper.arxivId as string | null) ?? null,
      originalFilename: (paper.originalFilename as string | null) ?? null,
      title: paper.title as string,
      abstract: paper.abstract as string,
      aiSummary:
        resolvedSummary ??
        (paper.aiSummary as string | null) ??
        (paper.abstract as string),
      pdfUrl: paper.pdfUrl as string,
      pageCount: paper.pageCount as number,
      fullText: paper.fullText as string,
      starterQuestions: (paper.starterQuestions as string[]) ?? [],
      annotationStyle:
        ((paper.annotationStyle as string) as "default" | "novice" | "expert") ?? "default",
    },
    annotations: ((paper.annotations as unknown[]) ?? []).map((a) =>
      mapAnnotationDoc(a, paperId)
    ),
    chatHistory,
  };
}

export async function ensurePaperIngested(arxivId: string, userId: string, jobId?: string) {
  const normalizedArxivId = arxivId.trim();
  const payload = await fetchArxivIngestionPayload(normalizedArxivId, jobId);
  return applyIngestedPaper(payload, userId);
}

export async function applyIngestedPaper(payload: IngestionPayload, userId: string) {
  if (payload.source === "arxiv") {
    return applyArxivIngestedPaper(payload, userId);
  }
  return applyUploadIngestedPaper(payload, userId);
}

export async function upsertChatHistory(paperId: string, messages: ChatMessage[]) {
  await setChatHistory(paperId, messages);
}

export async function reprocessPaperAnnotations(paperId: string, userId: string, jobId?: string) {
  await connectDB();
  const paper = await getLinkedPaperForUser(paperId, userId);

  if (!paper?.title || !(paper.pdfUrl as string | null)) {
    throw new Error("Paper not found in your library.");
  }

  const source = normalizeSource(paper.source);
  const resolvedPdfUrl = await resolvePreferredPaperPdfUrl(
    source,
    (paper.arxivId as string | null) ?? null,
    (paper.storagePath as string | null) ?? null,
    paper.pdfUrl as string
  );
  const payload = await fetchReprocessPayload(
    {
      paperId: paper._id as string,
      source,
      arxivId: (paper.arxivId as string | null) ?? null,
      originalFilename: (paper.originalFilename as string | null) ?? null,
      storagePath: (paper.storagePath as string | null) ?? null,
      title: paper.title as string,
      abstract: paper.abstract as string,
      pdfUrl: resolvedPdfUrl,
    },
    jobId
  );
  return applyReprocessedPaper(paper._id as string, userId, payload);
}

export async function applyReprocessedPaper(
  paperId: string,
  userId: string,
  payload: IngestionPayload
) {
  await connectDB();
  const paper = await getLinkedPaperForUser(paperId, userId);

  if (!paper?.title || !(paper.pdfUrl as string | null)) {
    throw new Error("Paper not found in your library.");
  }

  const source = normalizeSource(paper.source);
  if (payload.source !== source) {
    throw new Error("Reprocess payload source does not match the selected paper.");
  }
  if (source === "arxiv" && paper.arxivId !== payload.arxivId) {
    throw new Error("Reprocess payload does not match the selected paper.");
  }

  let cachedPdfUrl = paper.pdfUrl as string;
  if (source === "arxiv" && payload.arxivId) {
    await cachePaperPdf(payload.arxivId, payload.pdfUrl);
    cachedPdfUrl = payload.pdfUrl;
  }

  await Paper.findByIdAndUpdate(paperId, buildPaperUpdate(payload, cachedPdfUrl));

  const annotationCount = payload.annotations.length;
  if (annotationCount === 0) {
    throw new Error("Python ingestion completed without annotations.");
  }

  return { paperId, annotationCount };
}

export async function removePaperFromLibrary(paperId: string, userId: string) {
  await connectDB();
  const paper = await getLinkedPaperForUser(paperId, userId);
  if (!paper) {
    throw new Error("Paper not found in your library.");
  }

  await UserPaper.deleteOne({ userId, paperId });

  const source = normalizeSource(paper.source);
  if (source !== "upload") {
    return { source };
  }

  const remainingLinks = await UserPaper.countDocuments({ paperId });
  if (remainingLinks > 0) {
    return { source };
  }

  await Paper.deleteOne({ _id: paperId });
  const storagePath = paper.storagePath as string | null;
  if (storagePath) {
    await deleteObject(storagePath);
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

  const uploadId = randomUUID();
  const storagePath = `user-uploads/${userId}/${uploadId}.pdf`;
  const signedUploadUrl = await createPresignedPutUrl(storagePath, "application/pdf");

  return { uploadId, storagePath, signedUploadUrl };
}

export async function createUploadDownloadUrl(userId: string, uploadId: string) {
  const storagePath = `user-uploads/${userId}/${uploadId}.pdf`;
  const signedDownloadUrl = await createPresignedGetUrl(storagePath);
  return { storagePath, signedDownloadUrl };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function applyArxivIngestedPaper(payload: IngestionPayload, userId: string) {
  if (!payload.arxivId) throw new Error("arxivId is required for arXiv ingestion.");
  const normalizedArxivId = payload.arxivId.trim();
  await connectDB();

  const existing = await Paper.findOne(
    { source: "arxiv", arxivId: normalizedArxivId },
    { _id: 1, arxivId: 1 }
  ).lean();

  if (existing) {
    await UserPaper.findOneAndUpdate(
      { userId, paperId: existing._id as string },
      { userId, paperId: existing._id as string },
      { upsert: true }
    );
    return existing;
  }

  await cachePaperPdf(normalizedArxivId, payload.pdfUrl);

  const paperId = randomUUID();
  try {
    await Paper.create({ _id: paperId, ...buildPaperDoc(payload, payload.pdfUrl) });
  } catch (err: unknown) {
    const mongoErr = err as { code?: number };
    if (mongoErr.code === 11000) {
      // Race condition: another request inserted the same arXiv paper
      const dup = await Paper.findOne(
        { source: "arxiv", arxivId: normalizedArxivId },
        { _id: 1, arxivId: 1 }
      ).lean();
      if (dup) {
        await UserPaper.findOneAndUpdate(
          { userId, paperId: dup._id as string },
          { userId, paperId: dup._id as string },
          { upsert: true }
        );
        return dup;
      }
    }
    throw err;
  }

  await UserPaper.findOneAndUpdate(
    { userId, paperId },
    { userId, paperId },
    { upsert: true }
  );
  return { _id: paperId, arxivId: normalizedArxivId };
}

async function applyUploadIngestedPaper(payload: IngestionPayload, userId: string) {
  if (!payload.storagePath) throw new Error("storagePath is required for upload ingestion.");
  // Per-PRD: uploads are not deduped. Each upload mints a fresh paper row,
  // even if the file is byte-identical to one a different user uploaded.
  const expectedPrefix = `user-uploads/${userId}/`;
  if (!payload.storagePath.startsWith(expectedPrefix)) {
    throw new Error("Upload storage path does not belong to the authenticated user.");
  }
  await connectDB();
  const paperId = randomUUID();
  await Paper.create({ _id: paperId, ...buildPaperDoc(payload, payload.pdfUrl) });
  await UserPaper.findOneAndUpdate(
    { userId, paperId },
    { userId, paperId },
    { upsert: true }
  );
  return { _id: paperId };
}

function mapAnnotationDoc(doc: unknown, contextPaperId: string): AnnotationRecord {
  const a = doc as Record<string, unknown>;
  return {
    id: a._id as string,
    paperId: contextPaperId,
    pageNumber: a.pageNumber as number,
    type: a.type as AnnotationRecord["type"],
    textRef: a.textRef as string,
    note: a.note as string,
    importance: a.importance as 1 | 2 | 3,
    bbox: a.bbox as AnnotationRecord["bbox"],
    anchor: mapTextAnchor(a.anchor as TextAnchorPayload | null | undefined),
  };
}

function mapTextAnchor(anchor: TextAnchorPayload | null | undefined): TextAnchor | null {
  if (!anchor) return null;
  return {
    pageTextStart: anchor.page_text_start,
    pageTextEnd: anchor.page_text_end,
    occurrenceIndex: anchor.occurrence_index,
  };
}

function normalizeSource(source: unknown): PaperSource {
  return source === "upload" ? "upload" : "arxiv";
}

async function getLinkedPaperForUser(paperId: string, userId: string) {
  const linked = await UserPaper.exists({ userId, paperId });
  if (!linked) return null;
  return Paper.findById(paperId).lean();
}

async function cachePaperPdf(arxivId: string, sourceUrl: string): Promise<void> {
  const key = `arxiv/${arxivId}.pdf`;
  if (await objectExists(key)) return;
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) return;
    const buf = await response.arrayBuffer();
    await uploadObject(key, buf, "application/pdf");
  } catch {
    // Non-fatal: proxy will fall back to arxiv.org
  }
}

async function resolvePreferredPaperPdfUrl(
  source: PaperSource,
  arxivId: string | null,
  storagePath: string | null,
  fallbackUrl: string
): Promise<string> {
  if (source === "upload") {
    if (!storagePath) throw new Error("Upload paper is missing its storage path.");
    return createPresignedGetUrl(storagePath);
  }
  if (!arxivId) return fallbackUrl;
  const key = `arxiv/${arxivId}.pdf`;
  if (await objectExists(key)) {
    return createPresignedGetUrl(key);
  }
  return fallbackUrl;
}

async function ensurePaperSummary(paper: Record<string, unknown>): Promise<string | null> {
  const existing = normalizeSummaryText(paper.aiSummary as string | null | undefined);
  if (existing) return existing;
  try {
    const generated = await fetchPaperSummary(
      paper.title as string,
      paper.abstract as string,
      paper.fullText as string
    );
    if (!generated) return null;
    await Paper.findByIdAndUpdate(paper._id, { aiSummary: generated });
    return generated;
  } catch {
    return null;
  }
}

async function fetchPaperSummary(
  title: string,
  abstract: string,
  fullText: string
): Promise<string | null> {
  const url = new URL("/summarize", env.PYTHON_SERVICE_URL);
  const payload = JSON.stringify({ title, abstract, fullText });
  const response = await postJson(url, payload, PYTHON_INGEST_TIMEOUT_MS);
  if (response.status < 200 || response.status >= 300) {
    throw new Error("Python summary service failed.");
  }
  const parsed = JSON.parse(response.body) as { summary?: string };
  return normalizeSummaryText(parsed.summary);
}

function normalizeSummaryText(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const t = summary.trim();
  return t.length > 0 ? t : null;
}

function buildPaperDoc(payload: IngestionPayload, pdfUrl: string) {
  return {
    source: payload.source,
    arxivId: payload.source === "arxiv" ? payload.arxivId : null,
    originalFilename: payload.source === "upload" ? payload.originalFilename : null,
    storagePath:
      payload.source === "upload"
        ? payload.storagePath
        : payload.arxivId
          ? `arxiv/${payload.arxivId}.pdf`
          : null,
    title: payload.title,
    abstract: payload.abstract,
    aiSummary: payload.summary || payload.abstract,
    pdfUrl,
    pageCount: payload.pageCount,
    fullText: payload.fullText,
    starterQuestions: payload.starterQuestions,
    annotationStyle: payload.annotationStyle ?? "default",
    annotations: payload.annotations.map((a) => ({
      _id: randomUUID(),
      pageNumber: a.page_number,
      type: a.type,
      textRef: a.text_ref,
      note: a.note,
      importance: a.importance,
      bbox: a.bbox,
      anchor: a.anchor ?? null,
    })),
  };
}

function buildPaperUpdate(payload: IngestionPayload, pdfUrl: string) {
  return {
    aiSummary: payload.summary || payload.abstract,
    pdfUrl,
    pageCount: payload.pageCount,
    fullText: payload.fullText,
    starterQuestions: payload.starterQuestions,
    annotationStyle: payload.annotationStyle ?? "default",
    annotations: payload.annotations.map((a) => ({
      _id: randomUUID(),
      pageNumber: a.page_number,
      type: a.type,
      textRef: a.text_ref,
      note: a.note,
      importance: a.importance,
      bbox: a.bbox,
      anchor: a.anchor ?? null,
    })),
  };
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
    job_id: resolvedJobId,
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
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(response.body) as { detail?: string };
      detail = parsed.detail;
    } catch {
      // body is not JSON — fall through to use raw body
    }
    throw new Error(detail ?? (response.body || "Python ingestion service failed."));
  }

  return JSON.parse(response.body) as IngestionPayload;
}

function postJson(
  url: URL,
  body: string,
  timeoutMs: number,
  token?: string
): Promise<{ status: number; body: string }> {
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
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error(`Python annotation service timed out after ${timeoutMs / 1000} seconds.`)
      );
    });
    request.on("error", (error) => reject(error));
    request.write(body);
    request.end();
  });
}
