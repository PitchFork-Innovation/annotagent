import type { AnnotationStyle, IngestionPayload, PaperRecord } from "./types";
import { readJsonResponse } from "./http";

type AuthorizationResponse = {
  pythonServiceUrl: string;
  token: string;
};

type ProgressPayload = {
  status?: "pending" | "running" | "completed" | "failed";
  stage?: string;
  message?: string;
  currentChunk?: number;
  totalChunks?: number;
};

function buildPythonUrl(baseUrl: string, pathname: string, searchParams?: Record<string, string>) {
  const url = new URL(pathname, `${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}`);

  if (searchParams) {
    Object.entries(searchParams).forEach(([key, value]) => url.searchParams.set(key, value));
  }

  return url.toString();
}

function buildAuthHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

export async function authorizePythonIngest(jobId: string) {
  const response = await fetch("/api/ingest/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ jobId })
  });

  return readJsonResponse<AuthorizationResponse & { error?: string }>(response);
}

export async function authorizePythonReprocess(paperId: string, jobId: string) {
  const response = await fetch(`/api/papers/${paperId}/reprocess/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ jobId })
  });

  return readJsonResponse<AuthorizationResponse & { error?: string }>(response);
}

export async function fetchPythonProgress(baseUrl: string, token: string, jobId: string) {
  const response = await fetch(buildPythonUrl(baseUrl, "/progress", { jobId }), {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const payload = await readJsonResponse<ProgressPayload & { detail?: string }>(response);

  if (!response.ok) {
    throw new Error(payload.detail ?? "Unable to read annotation progress.");
  }

  return payload;
}

export async function runPythonIngest(baseUrl: string, token: string, arxivId: string, jobId: string, annotationStyle: AnnotationStyle = "default") {
  const response = await fetch(buildPythonUrl(baseUrl, "/ingest"), {
    method: "POST",
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      arxiv_id: arxivId,
      job_id: jobId,
      annotation_style: annotationStyle
    })
  });

  const payload = await readJsonResponse<IngestionPayload & { detail?: string }>(response);

  if (!response.ok) {
    throw new Error(payload.detail ?? "Python ingestion failed.");
  }

  return payload;
}

export async function runPythonReprocess(baseUrl: string, token: string, paper: Pick<PaperRecord, "arxivId" | "title" | "abstract" | "pdfUrl">, jobId: string, annotationStyle: AnnotationStyle = "default") {
  const response = await fetch(buildPythonUrl(baseUrl, "/reprocess"), {
    method: "POST",
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      arxiv_id: paper.arxivId,
      title: paper.title,
      abstract: paper.abstract,
      pdf_url: paper.pdfUrl,
      job_id: jobId,
      annotation_style: annotationStyle
    })
  });

  const payload = await readJsonResponse<IngestionPayload & { detail?: string }>(response);

  if (!response.ok) {
    throw new Error(payload.detail ?? "Python reprocess failed.");
  }

  return payload;
}
