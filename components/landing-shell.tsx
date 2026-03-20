"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState, useTransition } from "react";
import type { PaperListItem, UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  user: UserProfile | null;
  papers: PaperListItem[];
};

export function LandingShell({ user, papers }: Props) {
  const router = useRouter();
  const [arxivId, setArxivId] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ arxivId })
    });
    const json = await response.json();

    if (!response.ok) {
      setError(json.error ?? "Unable to annotate that paper.");
      return;
    }

    startTransition(() => {
      router.push(`/paper/${json.paper.id}`);
    });
  }

  return (
    <main className="paper-grid min-h-screen px-6 py-8 text-night md:px-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-10">
        <section className="overflow-hidden rounded-[2rem] border border-black/10 bg-white/70 shadow-float backdrop-blur">
          <div className="grid gap-8 p-8 md:grid-cols-[1.2fr_0.8fr] md:p-12">
            <div className="space-y-6">
              <p className="inline-flex rounded-full border border-ink/15 bg-ink/5 px-4 py-2 text-xs font-medium uppercase tracking-[0.3em] text-ink">
                ArXiv Annotation Agent
              </p>
              <div className="space-y-4">
                <h1 className="max-w-3xl font-serif text-4xl leading-tight text-night md:text-6xl">
                  Read machine learning papers with inline underlines, margin notes, and a paper-aware chat copilot.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-night/70">
                  Paste an arXiv ID, fetch the PDF, generate structured annotations with Claude, and explore the paper through a NotebookLM-style inquiry panel.
                </p>
              </div>
              <form className="flex flex-col gap-3 sm:flex-row" onSubmit={onSubmit}>
                <input
                  className="h-14 flex-1 rounded-2xl border border-black/10 bg-paper px-5 text-base outline-none ring-0 transition focus:border-ink/40"
                  placeholder="Enter arXiv ID, e.g. 2301.07041"
                  value={arxivId}
                  onChange={(event) => setArxivId(event.target.value)}
                />
                <button
                  className={cn(
                    "h-14 rounded-2xl bg-ink px-6 text-sm font-semibold text-white transition hover:bg-ink/90",
                    isPending && "cursor-progress opacity-70"
                  )}
                  disabled={isPending}
                  type="submit"
                >
                  {isPending ? "Opening paper..." : "Annotate paper"}
                </button>
              </form>
              {error ? <p className="text-sm text-red-700">{error}</p> : null}
              <div className="flex flex-wrap gap-3 text-sm text-night/60">
                <span className="rounded-full bg-coral/10 px-3 py-1.5 text-coral">Key results</span>
                <span className="rounded-full bg-amber/15 px-3 py-1.5 text-amber">Definitions</span>
                <span className="rounded-full bg-ink/10 px-3 py-1.5 text-ink">Explanatory notes</span>
              </div>
            </div>
            <div className="rounded-[1.5rem] border border-black/10 bg-night p-6 text-white">
              <p className="text-sm uppercase tracking-[0.28em] text-white/45">Session</p>
              <div className="mt-4 space-y-4">
                <div>
                  <h2 className="text-2xl font-semibold">{user ? user.email : "Sign in required"}</h2>
                  <p className="mt-2 text-sm leading-6 text-white/70">
                    The PRD requires private per-user paper libraries via Supabase Auth. Anonymous browsing is not supported for ingestion.
                  </p>
                </div>
                <ul className="space-y-3 text-sm text-white/80">
                  <li>PDF cached by arXiv ID in Supabase Storage</li>
                  <li>Annotations persisted with page and normalized bounding boxes</li>
                  <li>24-hour inquiry history kept in KV-compatible session storage</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-3xl text-night">Your annotated library</h2>
            <span className="text-sm text-night/55">{papers.length} papers</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {papers.map((paper) => (
              <button
                key={paper.id}
                className="rounded-[1.5rem] border border-black/10 bg-white/80 p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-float"
                onClick={() => router.push(`/paper/${paper.id}`)}
                type="button"
              >
                <p className="text-xs uppercase tracking-[0.24em] text-night/45">{paper.arxivId}</p>
                <h3 className="mt-3 text-xl font-semibold text-night">{paper.title}</h3>
                <p className="mt-3 line-clamp-3 text-sm leading-6 text-night/65">{paper.abstract}</p>
                <div className="mt-6 flex items-center justify-between text-sm">
                  <span className="text-night/50">{paper.annotationCount} annotations</span>
                  <span className="text-ink">Open workspace</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
