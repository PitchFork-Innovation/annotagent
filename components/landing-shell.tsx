"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState, useTransition } from "react";
import { AuthPanel } from "@/components/auth-panel";
import type { PaperListItem, UserProfile } from "@/lib/types";
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

export function LandingShell({ user, papers, hasAuthError = false }: Props) {
  const router = useRouter();
  const [arxivId, setArxivId] = useState("");
  const [isPending, startTransition] = useTransition();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setProgress(null);

    if (!user) {
      setError("Sign in first — paper ingestion requires an authenticated session.");
      return;
    }

    setIsSubmitting(true);
    const jobId = crypto.randomUUID();
    const progressInterval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/ingest/progress?jobId=${jobId}`, {
          cache: "no-store"
        });
        const json = await response.json();
        setProgress(json);
      } catch {
        // ignore transient polling failures
      }
    }, 1000);

    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ arxivId, jobId })
      });
      const json = await response.json();

      if (!response.ok) {
        setError(json.error ?? "Unable to annotate that paper.");
        return;
      }

      startTransition(() => {
        router.push(`/paper/${json.paper.id}`);
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to annotate that paper.");
    } finally {
      window.clearInterval(progressInterval);
      setIsSubmitting(false);
    }
  }

  const progressValue =
    progress?.totalChunks && progress.totalChunks > 0 && progress.currentChunk
      ? Math.min((progress.currentChunk / progress.totalChunks) * 100, 100)
      : progress?.status === "completed"
        ? 100
        : 8;

  return (
    <main className="dot-grid min-h-screen bg-void text-linen">
      {/* Top navigation bar */}
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
        {/* Hero + auth panel */}
        <section className="grid gap-8 md:grid-cols-[1.15fr_0.85fr] md:gap-14">

          {/* Left: hero */}
          <div className="flex flex-col gap-8">
            {/* Overline */}
            <div className="reveal reveal-1 flex items-center gap-3">
              <span className="h-px w-8 bg-gold/50" />
              <span className="font-mono text-[10px] uppercase tracking-[0.48em] text-gold/80">
                Research Intelligence
              </span>
            </div>

            {/* Headline */}
            <div className="reveal reveal-2">
              <h1 className="font-display text-[3.6rem] font-light leading-[1.04] tracking-tight text-ghost md:text-[5.5rem]">
                Annotate<br />
                <em className="italic text-gold">the Archive.</em>
              </h1>
              <p className="mt-6 max-w-lg font-mono text-[13px] leading-7 text-smoke">
                Paste an arXiv ID. Fetch the PDF. Generate inline underlines, margin notes,
                and definitions with OpenAI — then interrogate the paper through an agentic
                inquiry panel.
              </p>
            </div>

            {/* Input form */}
            <div className="reveal reveal-3 space-y-3">
              <form onSubmit={onSubmit}>
                <div
                  className={cn(
                    "glow-gold flex items-center rounded-lg border border-rim bg-cave transition-all",
                    (isSubmitting || isPending) && "opacity-60"
                  )}
                >
                  <span className="select-none px-4 font-mono text-[13px] text-gold/60">
                    arxiv:
                  </span>
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
                      !user || isSubmitting || isPending
                        ? "cursor-not-allowed bg-shell text-smoke"
                        : "bg-gold text-void hover:bg-gold/90 active:scale-95"
                    )}
                    disabled={isPending || isSubmitting || !user}
                    type="submit"
                  >
                    {!user
                      ? "Sign in"
                      : isSubmitting
                        ? "Processing..."
                        : isPending
                          ? "Opening..."
                          : "Run →"}
                  </button>
                </div>
              </form>

              {/* Progress indicator */}
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

            {/* Annotation type legend */}
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

          {/* Right: auth */}
          <div className="reveal reveal-3">
            <div className="rounded-xl border border-rim bg-cave p-6">
              <div className="mb-5 flex items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.42em] text-smoke">
                  Session
                </span>
                <span className="ml-auto inline-block h-1.5 w-1.5 rounded-full bg-sea" />
              </div>
              <AuthPanel hasAuthError={hasAuthError} user={user} />
            </div>
          </div>
        </section>

        {/* Library */}
        <section className="mt-24">
          {/* Section header */}
          <div className="reveal mb-8 flex items-center gap-5">
            <span className="h-px flex-1 bg-rim" />
            <h2 className="font-display text-2xl font-light text-linen/60 md:text-3xl">
              Library
            </h2>
            <span className="font-mono text-[11px] text-smoke">{papers.length} papers</span>
            <span className="h-px flex-1 bg-rim" />
          </div>

          {papers.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {papers.map((paper, i) => (
                <button
                  key={paper.id}
                  className="group reveal rounded-xl border border-rim bg-cave p-5 text-left transition-all duration-300 hover:border-gold/40 hover:bg-shell hover:shadow-glow-sm"
                  style={{ animationDelay: `${0.06 * i}s` }}
                  onClick={() => router.push(`/paper/${paper.id}`)}
                  type="button"
                >
                  <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.4em] text-smoke">
                    {paper.arxivId}
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
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-rim p-12 text-center">
              <p className="font-display text-2xl font-light text-linen/35">
                {user ? "No papers ingested yet." : "Sign in to access your library."}
              </p>
              <p className="mt-3 font-mono text-[11px] text-fog">
                {user
                  ? "Enter an arXiv ID above to annotate your first paper."
                  : "Your private paper library is tied to your account."}
              </p>
            </div>
          )}
        </section>

        {/* Footer */}
        <footer className="mt-20 flex items-center justify-center border-t border-rim/50 pt-8">
          <span className="font-mono text-[10px] uppercase tracking-[0.5em] text-fog/50">
            Annotagent · AI Paper Annotation
          </span>
        </footer>
      </div>
    </main>
  );
}
