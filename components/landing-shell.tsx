"use client";

import { useRouter } from "next/navigation";
import { ChangeEvent, DragEvent, FormEvent, useState, useTransition } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { readJsonResponse } from "@/lib/http";
import {
  authorizePythonIngest,
  authorizePythonUpload,
  fetchPythonProgress,
  runPythonIngest,
  runPythonUploadIngest
} from "@/lib/python-service";
import type {
  AnnotationPathway,
  AnnotationStyle,
  PaperListItem,
  UploadInitResponse,
  UserProfile
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  user: UserProfile | null;
  papers: PaperListItem[];
  hasAuthError?: boolean;
};

type IngestProgress = {
  status?: "pending" | "running" | "completed" | "failed";
  stage?: string;
  message?: string;
  currentChunk?: number;
  totalChunks?: number;
};

type IngestTab = "arxiv" | "upload";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function LandingShell({ user, papers: initialPapers, hasAuthError = false }: Props) {
  const router = useRouter();
  const [papers, setPapers] = useState(initialPapers);
  const [activeTab, setActiveTab] = useState<IngestTab>("arxiv");
  const [arxivId, setArxivId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [annotationStyle, setAnnotationStyle] = useState<AnnotationStyle>("default");
  const [annotationPathway, setAnnotationPathway] = useState<AnnotationPathway>("direct");
  const [removingId, setRemovingId] = useState<string | null>(null);

  function pickFile(file: File | null) {
    setError(null);
    if (!file) {
      setUploadFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setError("Only PDF files are supported.");
      setUploadFile(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("PDF must be 25 MB or smaller.");
      setUploadFile(null);
      return;
    }
    setUploadFile(file);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    pickFile(file);
  }

  function onSelectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    pickFile(file);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setProgress(null);

    if (!user) {
      setError("Sign in first — paper ingestion requires an authenticated session.");
      return;
    }

    if (activeTab === "arxiv") {
      await submitArxiv();
    } else {
      await submitUpload();
    }
  }

  async function submitArxiv() {
    setIsSubmitting(true);
    const jobId = crypto.randomUUID();
    let progressInterval: number | undefined;

    try {
      const authorization = await authorizePythonIngest(jobId);
      if (!authorization.pythonServiceUrl || !authorization.token) {
        setError(authorization.error ?? "Unable to contact the annotation service.");
        return;
      }

      progressInterval = startProgressPolling(jobId);

      const payload = await runPythonIngest(
        authorization.pythonServiceUrl,
        authorization.token,
        arxivId,
        jobId,
        annotationStyle,
        annotationPathway
      );
      const response = await fetch("/api/ingest/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await readJsonResponse<{ error?: string; paper?: { id: string } }>(response);

      if (!response.ok || !json.paper?.id) {
        setError(json.error ?? "Unable to annotate that paper.");
        return;
      }

      const paperId = json.paper.id;
      startTransition(() => {
        router.push(`/paper/${paperId}`);
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to annotate that paper.");
    } finally {
      if (progressInterval) {
        window.clearInterval(progressInterval);
      }
      setIsSubmitting(false);
    }
  }

  async function submitUpload() {
    if (!uploadFile) {
      setError("Pick a PDF first.");
      return;
    }

    setIsSubmitting(true);
    const jobId = crypto.randomUUID();
    let progressInterval: number | undefined;

    try {
      setProgress({ status: "running", stage: "uploading", message: "Uploading PDF..." });
      const initResponse = await fetch("/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadFile.name, declaredSize: uploadFile.size })
      });
      const initJson = await readJsonResponse<UploadInitResponse & { error?: string }>(initResponse);
      if (!initResponse.ok || !initJson.signedUploadUrl) {
        setError(initJson.error ?? "Unable to start upload.");
        return;
      }

      const putResponse = await fetch(initJson.signedUploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: uploadFile
      });
      if (!putResponse.ok) {
        setError("Upload failed — please retry.");
        return;
      }

      const authorization = await authorizePythonUpload(jobId, initJson.uploadId);
      if (!authorization.pythonServiceUrl || !authorization.token || !authorization.signedDownloadUrl) {
        setError(authorization.error ?? "Unable to contact the annotation service.");
        return;
      }

      progressInterval = startProgressPolling(jobId);

      const payload = await runPythonUploadIngest(authorization.pythonServiceUrl, authorization.token, {
        storagePath: authorization.storagePath,
        signedDownloadUrl: authorization.signedDownloadUrl,
        originalFilename: uploadFile.name,
        jobId,
        annotationStyle,
        annotationPathway
      });

      const response = await fetch("/api/ingest/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await readJsonResponse<{ error?: string; paper?: { id: string } }>(response);

      if (!response.ok || !json.paper?.id) {
        setError(json.error ?? "Unable to annotate that paper.");
        return;
      }

      const paperId = json.paper.id;
      startTransition(() => {
        router.push(`/paper/${paperId}`);
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to annotate that paper.");
    } finally {
      if (progressInterval) {
        window.clearInterval(progressInterval);
      }
      setIsSubmitting(false);
    }
  }

  function startProgressPolling(jobId: string) {
    return window.setInterval(async () => {
      try {
        const json = await fetchPythonProgress(jobId, "ingest");
        setProgress(json);
      } catch {
        // ignore transient polling failures
      }
    }, 1000);
  }

  async function onRemovePaper(paper: PaperListItem) {
    if (paper.source === "upload") {
      const ok = window.confirm(
        `Remove "${paper.title}" from your library? The uploaded PDF will be permanently deleted.`
      );
      if (!ok) {
        return;
      }
    }

    setRemovingId(paper.id);
    try {
      const response = await fetch(`/api/papers/${paper.id}`, { method: "DELETE" });
      if (!response.ok) {
        const json = await readJsonResponse<{ error?: string }>(response);
        setError(json.error ?? "Unable to remove paper.");
        return;
      }
      setPapers((current) => current.filter((entry) => entry.id !== paper.id));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove paper.");
    } finally {
      setRemovingId(null);
    }
  }

  const progressValue =
    progress?.totalChunks && progress.totalChunks > 0 && progress.currentChunk
      ? Math.min((progress.currentChunk / progress.totalChunks) * 100, 100)
      : progress?.status === "completed"
        ? 100
        : 8;

  const submitDisabled =
    !user || isSubmitting || isPending || (activeTab === "arxiv" ? arxivId.trim().length < 4 : !uploadFile);

  return (
    <main className="dot-grid min-h-screen bg-void text-linen">
      <header className="reveal border-b border-rim/70 px-6 py-4 md:px-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.44em] text-gold">
              Annotagent
            </span>
            <span className="h-1 w-1 rounded-full bg-rim" />
            <span className="font-mono text-[11px] text-smoke">AI research annotation</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-[7px] w-[7px] animate-pulse rounded-full bg-sea" />
            <span className="font-mono text-[11px] text-smoke">online</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-12 md:px-10">
        <section className="grid gap-8 md:grid-cols-[1.15fr_0.85fr] md:gap-14">
          <div className="flex flex-col gap-8">
            <div className="reveal reveal-1 flex items-center gap-3">
              <span className="h-px w-8 bg-gold/50" />
              <span className="font-mono text-[10px] uppercase tracking-[0.48em] text-gold/80">
                Research Intelligence
              </span>
            </div>

            <div className="reveal reveal-2">
              <h1 className="font-display text-[3.6rem] font-light leading-[1.04] tracking-tight text-ghost md:text-[5.5rem]">
                Annotate<br />
                <em className="italic text-gold">the Archive.</em>
              </h1>
              <p className="mt-6 max-w-lg font-mono text-[13px] leading-7 text-smoke">
                Paste an arXiv ID or upload your own PDF. Generate inline underlines, margin notes,
                and definitions with OpenAI — then interrogate the paper through an agentic
                inquiry panel.
              </p>
            </div>

            <div className="reveal reveal-3 space-y-3">
              <div className="flex items-center gap-2 border-b border-rim/60">
                <button
                  type="button"
                  className={cn(
                    "border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.24em] transition",
                    activeTab === "arxiv"
                      ? "border-gold text-gold"
                      : "border-transparent text-smoke hover:text-linen"
                  )}
                  onClick={() => setActiveTab("arxiv")}
                  disabled={isSubmitting || isPending}
                >
                  Paste arXiv ID
                </button>
                <button
                  type="button"
                  className={cn(
                    "border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.24em] transition",
                    activeTab === "upload"
                      ? "border-gold text-gold"
                      : "border-transparent text-smoke hover:text-linen"
                  )}
                  onClick={() => setActiveTab("upload")}
                  disabled={isSubmitting || isPending}
                >
                  Upload PDF
                </button>
              </div>

              <form onSubmit={onSubmit}>
                {activeTab === "arxiv" ? (
                  <div
                    className={cn(
                      "glow-gold flex items-center rounded-lg border border-rim bg-cave transition-all",
                      (isSubmitting || isPending) && "opacity-60"
                    )}
                  >
                    <span className="select-none px-4 font-mono text-[13px] text-gold/60">arXiv ID:</span>
                    <input
                      className="flex-1 bg-transparent py-4 pr-2 font-mono text-[13px] text-linen outline-none placeholder:text-fog"
                      placeholder="2301.07041"
                      value={arxivId}
                      onChange={(e) => setArxivId(e.target.value)}
                      disabled={isSubmitting || isPending}
                    />
                    <button
                      className={cn(
                        "m-1.5 rounded px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.24em] transition",
                        submitDisabled
                          ? "cursor-not-allowed bg-shell text-smoke"
                          : "bg-gold text-void hover:bg-gold/90 active:scale-95"
                      )}
                      disabled={submitDisabled}
                      type="submit"
                    >
                      {!user
                        ? "Sign in"
                        : isSubmitting
                          ? "Processing..."
                          : isPending
                            ? "Opening..."
                            : "Annotate →"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <label
                      htmlFor="upload-input"
                      onDragOver={(event) => {
                        event.preventDefault();
                        setIsDragging(true);
                      }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={onDrop}
                      className={cn(
                        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-cave px-6 py-10 text-center transition",
                        isDragging ? "border-gold bg-gold/[0.05]" : "border-rim hover:border-gold/50",
                        (isSubmitting || isPending) && "pointer-events-none opacity-60"
                      )}
                    >
                      <span className="font-mono text-[13px] text-linen">
                        {uploadFile ? uploadFile.name : "Drop PDF here or click to choose"}
                      </span>
                      <span className="font-mono text-[10px] text-fog">
                        {uploadFile
                          ? `${(uploadFile.size / 1024 / 1024).toFixed(2)} MB · PDF`
                          : "PDF only · 25 MB max"}
                      </span>
                      <input
                        id="upload-input"
                        type="file"
                        accept="application/pdf,.pdf"
                        className="hidden"
                        onChange={onSelectFile}
                        disabled={isSubmitting || isPending}
                      />
                    </label>
                    <button
                      className={cn(
                        "w-full rounded px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.24em] transition",
                        submitDisabled
                          ? "cursor-not-allowed bg-shell text-smoke"
                          : "bg-gold text-void hover:bg-gold/90 active:scale-95"
                      )}
                      disabled={submitDisabled}
                      type="submit"
                    >
                      {!user
                        ? "Sign in"
                        : isSubmitting
                          ? "Processing..."
                          : isPending
                            ? "Opening..."
                            : "Ingest PDF →"}
                    </button>
                  </div>
                )}
              </form>

              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="annotation-style" className="font-mono text-[11px] text-fog">
                  Annotation style:
                </label>
                <select
                  id="annotation-style"
                  className="rounded border border-rim bg-cave px-2 py-1 font-mono text-[11px] text-linen outline-none focus:border-gold/40"
                  value={annotationStyle}
                  onChange={(e) => setAnnotationStyle(e.target.value as AnnotationStyle)}
                  disabled={isSubmitting || isPending}
                >
                  <option value="default">Default</option>
                  <option value="novice">Novice</option>
                  <option value="expert">Expert</option>
                </select>
                <label htmlFor="annotation-pathway" className="font-mono text-[11px] text-fog">
                  Pathway:
                </label>
                <select
                  id="annotation-pathway"
                  className="rounded border border-rim bg-cave px-2 py-1 font-mono text-[11px] text-linen outline-none focus:border-gold/40"
                  value={annotationPathway}
                  onChange={(e) => setAnnotationPathway(e.target.value as AnnotationPathway)}
                  disabled={isSubmitting || isPending}
                >
                  <option value="direct">Instant</option>
                  <option value="validated">Thinking</option>
                </select>
              </div>

              {isSubmitting && (
                <div className="space-y-2 rounded-lg border border-rim bg-cave p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-smoke">
                      {progress?.stage ?? "Initializing pipeline"}
                    </span>
                    {progress?.currentChunk && progress?.totalChunks && (
                      <span className="font-mono text-[11px] text-gold/70">
                        {progress.currentChunk}/{progress.totalChunks} chunks
                      </span>
                    )}
                  </div>
                  <div className="h-px w-full bg-rim">
                    <div
                      className="h-px bg-gold transition-[width] duration-700"
                      style={{ width: `${progressValue}%` }}
                    />
                  </div>
                  <p className="font-mono text-[11px] text-fog">
                    {progress?.message ?? "Fetching PDF, extracting text, generating annotations with OpenAI..."}
                  </p>
                </div>
              )}

              {error && (
                <p className="rounded-lg border border-ember/30 bg-ember/[0.07] px-4 py-3 font-mono text-[11px] text-ember">
                  {error}
                </p>
              )}
            </div>

            <div className="reveal reveal-4 flex flex-wrap gap-2">
              <span className="rounded border border-ember/30 bg-ember/[0.07] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.24em] text-ember">
                ◆ key results
              </span>
              <span className="rounded border border-gold/30 bg-gold/[0.07] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.24em] text-gold">
                ◆ definitions
              </span>
              <span className="rounded border border-steel/30 bg-steel/[0.07] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.24em] text-steel">
                ◆ notes
              </span>
            </div>
          </div>

          <div className="reveal reveal-3">
            <div className="rounded-xl border border-rim bg-cave p-6">
              <div className="mb-5 flex items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.42em] text-smoke">Session</span>
                <span className="ml-auto inline-block h-1.5 w-1.5 rounded-full bg-sea" />
              </div>
              <AuthPanel hasAuthError={hasAuthError} user={user} />
            </div>
          </div>
        </section>

        <section className="mt-24">
          <div className="reveal mb-8 flex items-center gap-5">
            <span className="h-px flex-1 bg-rim" />
            <h2 className="font-display text-2xl font-light text-linen/60 md:text-3xl">Library</h2>
            <span className="font-mono text-[11px] text-smoke">{papers.length} papers</span>
            <span className="h-px flex-1 bg-rim" />
          </div>

          {papers.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {papers.map((paper, i) => (
                <div
                  key={paper.id}
                  className="group reveal relative rounded-xl border border-rim bg-cave p-5 text-left transition-all duration-300 hover:border-gold/40 hover:bg-shell hover:shadow-glow-sm"
                  style={{ animationDelay: `${0.06 * i}s` }}
                >
                  <button
                    type="button"
                    className="absolute right-3 top-3 rounded border border-rim bg-cave px-2 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-smoke opacity-0 transition hover:border-ember/60 hover:text-ember group-hover:opacity-100 disabled:cursor-not-allowed"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemovePaper(paper);
                    }}
                    disabled={removingId === paper.id}
                    aria-label={`Remove ${paper.title} from library`}
                  >
                    {removingId === paper.id ? "Removing..." : "Remove"}
                  </button>
                  <button
                    className="block w-full text-left"
                    onClick={() => router.push(`/paper/${paper.id}`)}
                    type="button"
                  >
                    <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.4em] text-smoke">
                      {paper.source === "upload"
                        ? paper.originalFilename ?? "Uploaded PDF"
                        : paper.arxivId ?? "—"}
                    </p>
                    <h3 className="font-display text-lg font-medium leading-snug text-linen transition-colors group-hover:text-ghost">
                      {paper.title}
                    </h3>
                    <p className="mt-2 line-clamp-3 font-mono text-[11px] leading-[1.65] text-fog">
                      {paper.abstract}
                    </p>
                    <div className="mt-5 flex items-center justify-between">
                      <span className="font-mono text-[10px] text-smoke">
                        {paper.annotationCount} annotations
                      </span>
                      <span className="font-mono text-[10px] text-gold/0 transition-all duration-200 group-hover:text-gold/80">
                        open →
                      </span>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-rim p-12 text-center">
              <p className="font-display text-2xl font-light text-linen/35">
                {user ? "No papers ingested yet." : "Sign in to access your library."}
              </p>
              <p className="mt-3 font-mono text-[11px] text-fog">
                {user
                  ? "Paste an arXiv ID or upload a PDF above to annotate your first paper."
                  : "Your private paper library is tied to your account."}
              </p>
            </div>
          )}
        </section>

        <footer className="mt-20 flex items-center justify-center border-t border-rim/50 pt-8">
          <span className="font-mono text-[10px] uppercase tracking-[0.5em] text-fog/50">
            Annotagent · AI Paper Annotation
          </span>
        </footer>
      </div>
    </main>
  );
}
