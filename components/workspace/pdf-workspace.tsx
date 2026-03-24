"use client";

import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Document, Page, pdfjs } from "react-pdf";
import type { AnnotationRecord, PaperWorkspace } from "@/lib/types";
import { annotationTone, importanceStyle } from "@/lib/annotations";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

type Props = {
  workspace: PaperWorkspace;
  onToggleChat: () => void;
};

type PopupState = {
  annotation: AnnotationRecord;
  x: number;
  y: number;
} | null;

type IngestProgress = {
  status?: "pending" | "running" | "completed" | "failed";
  stage?: string;
  message?: string;
  currentChunk?: number;
  totalChunks?: number;
};

export function PdfWorkspace({ workspace, onToggleChat }: Props) {
  const router = useRouter();
  const [pageCount, setPageCount] = useState<number>(0);
  const [activePopup, setActivePopup] = useState<PopupState>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [reprocessMessage, setReprocessMessage] = useState<string | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<IngestProgress | null>(null);
  const pdfFileUrl = `/api/papers/${workspace.paper.id}/pdf`;
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActivePopup(null);
      }
    }

    function onClickOutside(event: MouseEvent) {
      if ((event.target as HTMLElement | null)?.closest("[data-annotation-popup]")) {
        return;
      }
      setActivePopup(null);
    }

    window.addEventListener("keydown", onEscape);
    window.addEventListener("click", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("click", onClickOutside);
    };
  }, []);

  const annotationsByPage = useMemo(() => {
    return workspace.annotations.reduce<Record<number, AnnotationRecord[]>>((acc, annotation) => {
      acc[annotation.pageNumber] ??= [];
      acc[annotation.pageNumber].push(annotation);
      return acc;
    }, {});
  }, [workspace.annotations]);

  async function onReprocess() {
    setIsReprocessing(true);
    setReprocessMessage(null);
    setReprocessProgress(null);
    const jobId = crypto.randomUUID();
    const progressInterval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/ingest/progress?jobId=${jobId}`, {
          cache: "no-store"
        });
        const json = await response.json();
        setReprocessProgress(json);
      } catch {
        // Leave the current progress state in place during transient polling failures.
      }
    }, 1000);

    try {
      const response = await fetch(`/api/papers/${workspace.paper.id}/reprocess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jobId })
      });
      const json = await response.json();

      if (!response.ok) {
        setReprocessMessage(json.error ?? "Unable to reprocess annotations.");
        return;
      }

      setReprocessMessage(`Reprocessed annotations successfully. ${json.annotationCount} annotations are now stored.`);
      router.refresh();
    } catch (error) {
      setReprocessMessage(error instanceof Error ? error.message : "Unable to reprocess annotations.");
    } finally {
      window.clearInterval(progressInterval);
      setIsReprocessing(false);
    }
  }

  const reprocessProgressValue =
    reprocessProgress?.totalChunks && reprocessProgress.totalChunks > 0 && reprocessProgress.currentChunk
      ? Math.min((reprocessProgress.currentChunk / reprocessProgress.totalChunks) * 100, 100)
      : reprocessProgress?.status === "completed"
        ? 100
        : 8;

  return (
    <div className="px-4 py-5 md:px-8">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <button
            className="rounded-full border border-black/10 bg-white/85 px-4 py-2 text-sm font-medium text-night shadow-sm transition hover:bg-white"
            onClick={() => router.push("/")}
            type="button"
          >
            Back to library
          </button>
          <p className="text-xs uppercase tracking-[0.28em] text-night/40">{workspace.paper.arxivId}</p>
          <h1 className="mt-2 max-w-4xl font-serif text-3xl leading-tight md:text-4xl">{workspace.paper.title}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-night/65">{workspace.paper.abstract}</p>
        </div>
        <button
          className="rounded-full border border-black/10 bg-white/85 px-4 py-2 text-sm font-medium text-night shadow-sm"
          onClick={onToggleChat}
          type="button"
        >
          Toggle inquiry panel
        </button>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          className="rounded-full border border-black/10 bg-white/85 px-4 py-2 text-sm font-medium text-night shadow-sm transition hover:bg-white"
          disabled={isReprocessing}
          onClick={onReprocess}
          type="button"
        >
          {isReprocessing ? "Reprocessing annotations..." : "Reprocess annotations"}
        </button>
        {reprocessMessage ? <p className="text-sm text-night/65">{reprocessMessage}</p> : null}
      </div>
      {isReprocessing ? (
        <div className="mb-5 space-y-3 rounded-[1.5rem] border border-black/10 bg-white/70 p-4 shadow-sm">
          <div className="overflow-hidden rounded-full bg-black/10">
            <div
              className="h-2 rounded-full bg-ink transition-[width] duration-700"
              style={{ width: `${reprocessProgressValue}%` }}
            />
          </div>
          <p className="text-sm text-night/60">
            {reprocessProgress?.message ?? "Re-running PDF extraction and annotation generation for this paper."}
          </p>
          {reprocessProgress?.currentChunk && reprocessProgress?.totalChunks ? (
            <p className="text-xs uppercase tracking-[0.18em] text-night/45">
              Chunk {reprocessProgress.currentChunk} of {reprocessProgress.totalChunks}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        {pdfError ? (
          <div className="rounded-[1.5rem] border border-red-200 bg-red-50 p-6 text-red-900 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-red-700">PDF unavailable</p>
            <p className="mt-3 text-sm leading-6">
              {pdfError}
            </p>
            <a
              className="mt-4 inline-flex rounded-2xl bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-800"
              href={pdfFileUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open raw PDF route
            </a>
          </div>
        ) : null}
        <Document
          file={pdfFileUrl}
          loading={<PaperCard label="Loading PDF..." />}
          onLoadError={(error) => setPdfError(error.message)}
          onSourceError={(error) => setPdfError(error.message)}
          onLoadSuccess={({ numPages }) => {
            setPdfError(null);
            setPageCount(numPages);
          }}
        >
          {Array.from({ length: pageCount || workspace.paper.pageCount || 1 }, (_, pageIndex) => {
            const pageNumber = pageIndex + 1;
            const pageAnnotations = annotationsByPage[pageNumber] ?? [];

            return (
              <section key={pageNumber} className="relative rounded-[1.5rem] bg-white p-4 shadow-float">
                <div className="mb-3 flex items-center justify-between px-2">
                  <span className="text-xs uppercase tracking-[0.25em] text-night/40">Page {pageNumber}</span>
                  <span className="text-xs text-night/50">{pageAnnotations.length} annotations</span>
                </div>
                <div
                  ref={(node) => {
                    pageRefs.current[pageNumber] = node;
                  }}
                  className="relative mx-auto w-fit"
                >
                  <Page pageNumber={pageNumber} renderAnnotationLayer={false} renderTextLayer={true} />
                  <AnnotationOverlay
                    annotations={pageAnnotations}
                    pageRootRef={{
                      get current() {
                        return pageRefs.current[pageNumber] ?? null;
                      }
                    }}
                    onOpen={(annotation, coords) => setActivePopup({ annotation, ...coords })}
                  />
                  {activePopup?.annotation.pageNumber === pageNumber ? (
                    <AnnotationPopup popup={activePopup} onClose={() => setActivePopup(null)} />
                  ) : null}
                </div>
              </section>
            );
          })}
        </Document>
      </div>
    </div>
  );
}

function AnnotationOverlay({
  annotations,
  pageRootRef,
  onOpen
}: {
  annotations: AnnotationRecord[];
  pageRootRef: RefObject<HTMLDivElement | null>;
  onOpen: (annotation: AnnotationRecord, coords: { x: number; y: number }) => void;
}) {
  const [layouts, setLayouts] = useState<Record<string, ResolvedAnnotationLayout>>({});

  useEffect(() => {
    let cancelled = false;

    const updateLayouts = () => {
      if (cancelled) {
        return;
      }

      const pageRoot = pageRootRef.current;
      if (!pageRoot) {
        return;
      }

      const nextLayouts = Object.fromEntries(
        annotations.map((annotation) => [annotation.id, resolveAnnotationLayout(annotation, pageRoot)])
      );

      setLayouts(nextLayouts);
    };

    const rafId = window.requestAnimationFrame(updateLayouts);
    window.addEventListener("resize", updateLayouts);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updateLayouts);
    };
  }, [annotations, pageRootRef]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {annotations.map((annotation) => (
        <AnnotationUnderline
          key={annotation.id}
          annotation={annotation}
          layout={layouts[annotation.id]}
          onOpen={(coords) => onOpen(annotation, coords)}
        />
      ))}
    </div>
  );
}

function PaperCard({ label }: { label: string }) {
  return (
    <div className="flex min-h-[320px] items-center justify-center rounded-[1.5rem] bg-white text-night/50">
      {label}
    </div>
  );
}

type ResolvedAnnotationLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function AnnotationUnderline({
  annotation,
  layout,
  onOpen
}: {
  annotation: AnnotationRecord;
  layout?: ResolvedAnnotationLayout;
  onOpen: (coords: { x: number; y: number }) => void;
}) {
  const tone = annotationTone(annotation.type);
  const style = importanceStyle(annotation.importance);
  const { x, y, width, height } = layout ?? annotation.bbox;

  return (
    <button
      className="pointer-events-auto absolute z-10 cursor-pointer"
      style={{
        left: `${x * 100}%`,
        top: `${(y + Math.max(height - 0.01, 0)) * 100}%`,
        width: `${width * 100}%`,
        height: `${Math.max(height * 100, 1.6)}%`
      }}
      title={annotation.note}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen({
          x: x + width / 2,
          y
        });
      }}
    >
      <span
        className="absolute inset-x-0 bottom-0 block rounded-full"
        style={{
          borderBottom: `${style.strokeWidth}px solid ${tone}`,
          opacity: style.opacity
        }}
      />
      <span className="absolute inset-x-0 bottom-0 top-[-8px]" />
      <span className="sr-only">{annotation.type}</span>
    </button>
  );
}

function AnnotationPopup({
  popup,
  onClose
}: {
  popup: NonNullable<PopupState>;
  onClose: () => void;
}) {
  const tone = annotationTone(popup.annotation.type);
  const left = Math.min(Math.max(popup.x * 100, 16), 84);
  const top = Math.max(popup.y * 100 - 12, 3);

  return (
    <aside
      className="absolute z-20 w-[320px] max-w-[calc(100vw-48px)] -translate-x-1/2 rounded-2xl border border-black/10 bg-white p-4 shadow-float"
      data-annotation-popup
      style={{
        left: `${left}%`,
        top: `${top}%`
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: tone, backgroundColor: `${tone}16` }}>
          {popup.annotation.type === "highlight" ? "Key Result" : popup.annotation.type}
        </span>
        <span className="text-xs text-night/45">Importance {popup.annotation.importance}</span>
      </div>
      <p className="mt-4 text-sm leading-6 text-night">{popup.annotation.note}</p>
      <button className="mt-4 text-sm font-medium text-night/65" onClick={onClose} type="button">
        Dismiss
      </button>
    </aside>
  );
}

function resolveAnnotationLayout(annotation: AnnotationRecord, pageRoot: HTMLDivElement): ResolvedAnnotationLayout {
  const textLayer = pageRoot.querySelector(".react-pdf__Page__textContent");
  if (!textLayer) {
    return annotation.bbox;
  }

  const matchedRect = matchTextLayerRect(annotation.textRef, textLayer, pageRoot);
  return matchedRect ?? annotation.bbox;
}

function matchTextLayerRect(query: string, textLayer: Element, pageRoot: HTMLDivElement): ResolvedAnnotationLayout | null {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return null;
  }

  const queryWords = normalizedQuery.split(" ").filter((word) => word.length > 3).slice(0, 5);
  const spans = Array.from(textLayer.querySelectorAll("span")).map((span) => ({
    element: span,
    text: normalizeText(span.textContent ?? "")
  }));

  const rootRect = pageRoot.getBoundingClientRect();

  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (!span.text) {
      continue;
    }

    const wordMatch = queryWords.some((word) => span.text.includes(word) || word.includes(span.text));
    if (!wordMatch) {
      continue;
    }

    const matchedElements = [span.element];
    let combinedText = span.text;
    const baseTop = span.element.getBoundingClientRect().top;

    for (let nextIndex = index + 1; nextIndex < spans.length && matchedElements.length < 8; nextIndex += 1) {
      const nextSpan = spans[nextIndex];
      if (!nextSpan.text) {
        continue;
      }

      const nextRect = nextSpan.element.getBoundingClientRect();
      if (Math.abs(nextRect.top - baseTop) > 12) {
        break;
      }

      matchedElements.push(nextSpan.element);
      combinedText = `${combinedText} ${nextSpan.text}`.trim();

      if (combinedText.includes(normalizedQuery.slice(0, Math.min(normalizedQuery.length, 72)))) {
        break;
      }
    }

    const unionRect = buildUnionRect(matchedElements, rootRect);
    if (unionRect) {
      return unionRect;
    }
  }

  return null;
}

function buildUnionRect(elements: Element[], rootRect: DOMRect): ResolvedAnnotationLayout | null {
  const rects = elements
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);

  if (rects.length === 0 || rootRect.width === 0 || rootRect.height === 0) {
    return null;
  }

  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    x: (left - rootRect.left) / rootRect.width,
    y: (top - rootRect.top) / rootRect.height,
    width: (right - left) / rootRect.width,
    height: (bottom - top) / rootRect.height
  };
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
