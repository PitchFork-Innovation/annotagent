import type { AnnotationPathway, AnnotationStyle, IngestionPayload, PaperRecord } from "./types";
import { readJsonResponse } from "./http";

type AuthorizationResponse = {
  pythonServiceUrl: string;
  token: string;
};

type UploadAuthorizationResponse = AuthorizationResponse & {
  storagePath: string;
  signedDownloadUrl: string;
};

type ProgressPayload = {
  status?: "pending" | "running" | "completed" | "failed";
  stage?: string;
  message?: string;
  currentChunk?: number;
  totalChunks?: number;
};

type PythonProgressAction = "ingest" | "reprocess";

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

export async function authorizePythonUpload(jobId: string, uploadId: string) {
  const response = await fetch("/api/upload/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ jobId, uploadId })
  });

  return readJsonResponse<UploadAuthorizationResponse & { error?: string }>(response);
}

export async function authorizePythonReprocess(paperId: string, jobId: string) {
  const response = await fetch(`/api/papers/${paperId}/reprocess/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ jobId })
  });

  return readJsonResponse<
    AuthorizationResponse & {
      error?: string;
      paper?: Pick<PaperRecord, "id" | "source" | "arxivId" | "originalFilename" | "title" | "abstract"> & {
        pdfUrl: string;
        storagePath: string | null;
      };
    }
  >(response);
}

export async function fetchPythonProgress(jobId: string, action: PythonProgressAction = "ingest") {
  const searchParams = new URLSearchParams({
    jobId,
    action
  });
  const response = await fetch(`/api/ingest/progress?${searchParams.toString()}`, {
    cache: "no-store"
  });

  const payload = await readJsonResponse<ProgressPayload & { detail?: string }>(response);

  if (!response.ok) {
    throw new Error(payload.detail ?? "Unable to read annotation progress.");
  }

  return payload;
}

export async function runPythonIngest(
  baseUrl: string,
  token: string,
  arxivId: string,
  jobId: string,
  annotationStyle: AnnotationStyle = "default",
  annotationPathway: AnnotationPathway = "validated"
) {
  const response = await fetch(buildPythonUrl(baseUrl, "/ingest"), {
    method: "POST",
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      arxiv_id: arxivId,
      job_id: jobId,
      annotation_style: annotationStyle,
      annotation_pathway: annotationPathway
    })
  });

  const payload = await readJsonResponse<IngestionPayload & { detail?: string }>(response);

  if (!response.ok) {
    throw new Error(payload.detail ?? "Python ingestion failed.");
  }

  return payload;
}

export async function runPythonUploadIngest(
  baseUrl: string,
  token: string,
  args: {
    storagePath: string;
    signedDownloadUrl: string;
    originalFilename: string;
    jobId: string;
    annotationStyle?: AnnotationStyle;
    annotationPathway?: AnnotationPathway;
  }
) {
  const response = await fetch(buildPythonUrl(baseUrl, "/ingest/upload"), {
    method: "POST",
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      storage_path: args.storagePath,
      pdf_url: args.signedDownloadUrl,
      original_filename: args.originalFilename,
      job_id: args.jobId,
      annotation_style: args.annotationStyle ?? "default",
      annotation_pathway: args.annotationPathway ?? "validated"
    })
  });

  const payload = await readJsonResponse<IngestionPayload & { detail?: string }>(response);

  if (!response.ok) {
    throw new Error(payload.detail ?? "Python upload ingestion failed.");
  }

  return payload;
}

export async function runPythonReprocess(
  baseUrl: string,
  token: string,
  paper: Pick<PaperRecord, "id" | "source" | "arxivId" | "originalFilename" | "title" | "abstract" | "pdfUrl"> & {
    storagePath?: string | null;
  },
  jobId: string,
  annotationStyle: AnnotationStyle = "default",
  annotationPathway: AnnotationPathway = "validated"
) {
  const response = await fetch(buildPythonUrl(baseUrl, "/reprocess"), {
    method: "POST",
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      paper_id: paper.id,
      source: paper.source,
      arxiv_id: paper.arxivId,
      original_filename: paper.originalFilename,
      storage_path: paper.storagePath ?? null,
      title: paper.title,
      abstract: paper.abstract,
      pdf_url: paper.pdfUrl,
      job_id: jobId,
      annotation_style: annotationStyle,
      annotation_pathway: annotationPathway
    })
  });

  const payload = await readJsonResponse<IngestionPayload & { detail?: string }>(response);

  if (!response.ok) {
    throw new Error(payload.detail ?? "Python reprocess failed.");
  }

  return payload;
}
