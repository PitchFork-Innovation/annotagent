"use client";

import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Document, Page, pdfjs } from "react-pdf";
import { RichText } from "@/components/rich-text";
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
  const [pageWidth, setPageWidth] = useState<number>();
  const [activePopup, setActivePopup] = useState<PopupState>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [reprocessMessage, setReprocessMessage] = useState<string | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<IngestProgress | null>(null);
  const pdfFileUrl = `/api/papers/${workspace.paper.id}/pdf`;
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const viewerRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    const updatePageWidth = () => {
      const nextWidth = Math.max(Math.floor(viewer.getBoundingClientRect().width), 320);
      setPageWidth(nextWidth);
    };

    updatePageWidth();

    const observer = new ResizeObserver(updatePageWidth);
    observer.observe(viewer);

    return () => {
      observer.disconnect();
    };
  }, []);

  const annotationsByPage = useMemo(() => {
    return workspace.annotations.reduce<Record<number, AnnotationRecord[]>>((acc, annotation) => {
      acc[annotation.pageNumber] ??= [];
      acc[annotation.pageNumber].push(annotation);
      return acc;
    }, {});
  }, [workspace.annotations]);
  const summaryContent = workspace.paper.aiSummary ?? workspace.paper.abstract;

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
          <section className="mt-5 max-w-3xl rounded-[1.6rem] border border-black/10 bg-white/78 p-5 shadow-sm backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-night/45">AI key points</p>
                <p className="mt-1 text-xs text-night/45">Short summary generated from the paper abstract and extracted text.</p>
              </div>
              <span className="rounded-full border border-black/10 bg-[#f5ecdd] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-night/50">
                LaTeX ready
              </span>
            </div>
            <RichText content={summaryContent} className="mt-4 text-[15px] leading-7 text-night/72" />
          </section>
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

      <div ref={viewerRef} className="mx-auto flex w-full max-w-[1180px] flex-col gap-6">
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
              <section key={pageNumber} className="relative overflow-hidden rounded-[1.5rem] bg-white shadow-float">
                <div className="flex items-center justify-between px-3 pb-2 pt-3">
                  <span className="text-xs uppercase tracking-[0.25em] text-night/40">Page {pageNumber}</span>
                  <span className="text-xs text-night/50">{pageAnnotations.length} annotations</span>
                </div>
                <div
                  ref={(node) => {
                    pageRefs.current[pageNumber] = node;
                  }}
                  className="relative mx-auto w-fit max-w-full"
                >
                  <Page
                    pageNumber={pageNumber}
                    renderAnnotationLayer={false}
                    renderTextLayer={true}
                    width={pageWidth}
                  />
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
    let observer: MutationObserver | null = null;

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
    const pageRoot = pageRootRef.current;

    if (pageRoot) {
      observer = new MutationObserver(updateLayouts);
      observer.observe(pageRoot, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    window.addEventListener("resize", updateLayouts);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
      window.removeEventListener("resize", updateLayouts);
    };
  }, [annotations, pageRootRef]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {annotations.map((annotation) => (
        <AnnotationHighlight
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
  fragments: HighlightFragment[];
  anchorX: number;
  anchorY: number;
};

type HighlightFragment = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function AnnotationHighlight({
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
  const resolvedLayout = layout ?? createFallbackLayout(annotation.bbox);

  return (
    <>
      {resolvedLayout.fragments.map((fragment, index) => (
        <button
          key={`${annotation.id}-${index}`}
          aria-label={`${annotation.type}: ${annotation.textRef}`}
          className="pointer-events-auto absolute z-10 cursor-pointer rounded-[4px] transition-transform hover:scale-[1.01]"
          style={{
            left: `${fragment.x * 100}%`,
            top: `${fragment.y * 100}%`,
            width: `${fragment.width * 100}%`,
            height: `${fragment.height * 100}%`
          }}
          title={annotation.note}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen({
              x: resolvedLayout.anchorX,
              y: resolvedLayout.anchorY
            });
          }}
        >
          <span
            className="absolute inset-0 rounded-[4px]"
            style={{
              backgroundColor: tone,
              opacity: style.fillOpacity
            }}
          />
          <span
            className="absolute inset-0 rounded-[4px] border"
            style={{
              borderColor: tone,
              opacity: style.borderOpacity
            }}
          />
          {index === 0 ? <span className="sr-only">{annotation.type}</span> : null}
        </button>
      ))}
    </>
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
      <RichText content={popup.annotation.note} className="mt-4 text-sm leading-6 text-night" />
      <button className="mt-4 text-sm font-medium text-night/65" onClick={onClose} type="button">
        Dismiss
      </button>
    </aside>
  );
}

function resolveAnnotationLayout(annotation: AnnotationRecord, pageRoot: HTMLDivElement): ResolvedAnnotationLayout {
  const textLayer = pageRoot.querySelector(".react-pdf__Page__textContent");
  if (!textLayer) {
    return createFallbackLayout(annotation.bbox);
  }

  const matchedFragments = matchTextLayerFragments(annotation.textRef, textLayer, pageRoot);
  return matchedFragments ? buildResolvedLayout(matchedFragments) : createFallbackLayout(annotation.bbox);
}

function matchTextLayerFragments(query: string, textLayer: Element, pageRoot: HTMLDivElement): HighlightFragment[] | null {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return null;
  }

  const queryWords = normalizedQuery.split(" ").filter((word) => word.length > 2).slice(0, 6);
  const queryTarget = normalizedQuery.slice(0, Math.min(normalizedQuery.length, 120));
  const spans = Array.from(textLayer.querySelectorAll("span"))
    .map((span) => ({
      element: span,
      text: normalizeText(span.textContent ?? "")
    }))
    .filter((span) => span.text);

  const rootRect = pageRoot.getBoundingClientRect();

  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    const wordMatch =
      queryWords.length === 0 || queryWords.some((word) => span.text.includes(word) || word.includes(span.text));
    if (!wordMatch) {
      continue;
    }

    const matchedElements = [span.element];
    let combinedText = span.text;
    const lineBuckets = new Set([Math.round(span.element.getBoundingClientRect().top / 6)]);

    if (combinedText.includes(queryTarget)) {
      return buildHighlightFragments(matchedElements, rootRect);
    }

    for (let nextIndex = index + 1; nextIndex < spans.length && matchedElements.length < 24; nextIndex += 1) {
      const nextSpan = spans[nextIndex];
      const nextRect = nextSpan.element.getBoundingClientRect();
      lineBuckets.add(Math.round(nextRect.top / 6));
      if (lineBuckets.size > 5) {
        break;
      }

      matchedElements.push(nextSpan.element);
      combinedText = `${combinedText} ${nextSpan.text}`.trim();

      if (combinedText.includes(queryTarget)) {
        return buildHighlightFragments(matchedElements, rootRect);
      }

      if (combinedText.length > normalizedQuery.length + 160) {
        break;
      }
    }
  }

  return null;
}

function buildHighlightFragments(elements: Element[], rootRect: DOMRect): HighlightFragment[] | null {
  const rects = elements
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);

  if (rects.length === 0 || rootRect.width === 0 || rootRect.height === 0) {
    return null;
  }

  const mergedRects = rects
    .sort((leftRect, rightRect) => {
      if (Math.abs(leftRect.top - rightRect.top) < 6) {
        return leftRect.left - rightRect.left;
      }

      return leftRect.top - rightRect.top;
    })
    .reduce<Array<{ left: number; top: number; right: number; bottom: number }>>((acc, rect) => {
      const previous = acc.at(-1);

      if (previous && Math.abs(previous.top - rect.top) < 6 && rect.left <= previous.right + 8) {
        previous.left = Math.min(previous.left, rect.left);
        previous.top = Math.min(previous.top, rect.top);
        previous.right = Math.max(previous.right, rect.right);
        previous.bottom = Math.max(previous.bottom, rect.bottom);
        return acc;
      }

      acc.push({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      });
      return acc;
    }, []);

  return mergedRects.map((rect) => ({
    x: (rect.left - rootRect.left) / rootRect.width,
    y: (rect.top - rootRect.top) / rootRect.height,
    width: (rect.right - rect.left) / rootRect.width,
    height: (rect.bottom - rect.top) / rootRect.height
  }));
}

function buildResolvedLayout(fragments: HighlightFragment[]): ResolvedAnnotationLayout {
  const left = Math.min(...fragments.map((fragment) => fragment.x));
  const top = Math.min(...fragments.map((fragment) => fragment.y));
  const right = Math.max(...fragments.map((fragment) => fragment.x + fragment.width));

  return {
    fragments,
    anchorX: (left + right) / 2,
    anchorY: top
  };
}

function createFallbackLayout(bbox: AnnotationRecord["bbox"]): ResolvedAnnotationLayout {
  return buildResolvedLayout([
    {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height
    }
  ]);
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
