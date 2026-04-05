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
  anchorX: number;
  anchorY: number;
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
  const pdfDocumentOptions = useMemo(() => ({ withCredentials: true }), []);
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
      {/* Top controls row */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Back + ArXiv ID */}
          <div className="mb-3 flex items-center gap-3">
            <button
              className="rounded border border-rim bg-cave px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-smoke transition hover:border-gold/40 hover:text-linen"
              onClick={() => router.push("/")}
              type="button"
            >
              ← Library
            </button>
            <span className="font-mono text-[10px] uppercase tracking-[0.4em] text-smoke">
              {workspace.paper.arxivId}
            </span>
          </div>

          {/* Paper title */}
          <h1 className="max-w-4xl font-display text-3xl font-light leading-tight text-ghost md:text-[2.6rem]">
            {workspace.paper.title}
          </h1>

          {/* AI summary card */}
          <section className="mt-5 max-w-3xl rounded-xl border border-rim bg-cave p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-smoke">AI Key Points</p>
                <p className="mt-0.5 font-mono text-[11px] text-fog">
                  Summary from abstract and extracted text.
                </p>
              </div>
              <span className="rounded border border-gold/25 bg-gold/[0.07] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-gold/70">
                LaTeX ready
              </span>
            </div>
            <RichText content={summaryContent} className="font-mono text-[13px] leading-[1.8] text-smoke" />
          </section>
        </div>

        {/* Chat toggle */}
        <button
          className="shrink-0 rounded border border-rim bg-cave px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-smoke transition hover:border-gold/40 hover:text-linen"
          onClick={onToggleChat}
          type="button"
        >
          Inquiry ›
        </button>
      </div>

      {/* Reprocess controls */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          className="rounded border border-rim bg-cave px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-smoke transition hover:border-gold/40 hover:text-linen disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isReprocessing}
          onClick={onReprocess}
          type="button"
        >
          {isReprocessing ? "Reprocessing..." : "Reprocess annotations"}
        </button>
        {reprocessMessage ? (
          <p className="font-mono text-[11px] text-fog">{reprocessMessage}</p>
        ) : null}
      </div>

      {isReprocessing ? (
        <div className="mb-5 space-y-2 rounded-xl border border-rim bg-cave p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-smoke">
              {reprocessProgress?.stage ?? "Re-running annotation pipeline"}
            </span>
            {reprocessProgress?.currentChunk && reprocessProgress?.totalChunks && (
              <span className="font-mono text-[11px] text-gold/70">
                {reprocessProgress.currentChunk}/{reprocessProgress.totalChunks}
              </span>
            )}
          </div>
          <div className="h-px w-full bg-rim">
            <div
              className="h-px bg-gold transition-[width] duration-700"
              style={{ width: `${reprocessProgressValue}%` }}
            />
          </div>
          <p className="font-mono text-[11px] text-fog">
            {reprocessProgress?.message ?? "Re-running PDF extraction and annotation generation for this paper."}
          </p>
        </div>
      ) : null}

      <div ref={viewerRef} className="mx-auto flex w-full max-w-[1180px] flex-col gap-5">
        {pdfError ? (
          <div className="rounded-xl border border-ember/30 bg-ember/[0.07] p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-ember">PDF unavailable</p>
            <p className="mt-2 font-mono text-[12px] leading-6 text-fog">
              {pdfError}
            </p>
            <a
              className="mt-4 inline-flex rounded border border-ember/40 bg-ember/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ember transition hover:bg-ember/20"
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
          options={pdfDocumentOptions}
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
              <section key={pageNumber} className="relative overflow-visible rounded-xl bg-white shadow-float">
                <div className="flex items-center justify-between border-b border-black/8 px-3 pb-2 pt-2.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-black/35">
                    Page {pageNumber}
                  </span>
                  <span className="font-mono text-[10px] text-black/40">{pageAnnotations.length} annotations</span>
                </div>
                <div
                  ref={(node) => {
                    pageRefs.current[pageNumber] = node;
                  }}
                  className="relative mx-auto w-fit max-w-full overflow-visible"
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
                    onOpen={(annotation, coords) => {
                      const pageRoot = pageRefs.current[pageNumber];
                      if (!pageRoot) {
                        return;
                      }

                      setActivePopup({
                        annotation,
                        anchorX: coords.x,
                        anchorY: coords.y
                      });
                    }}
                  />
                  {activePopup?.annotation.pageNumber === pageNumber ? (
                    <AnnotationPopup
                      pageRootRef={{
                        get current() {
                          return pageRefs.current[pageNumber] ?? null;
                        }
                      }}
                      popup={activePopup}
                      onClose={() => setActivePopup(null)}
                    />
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
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);

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

  const overlapLanes = useMemo(() => assignOverlapLanes(annotations, layouts), [annotations, layouts]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {annotations.map((annotation) => (
        <AnnotationHighlight
          key={annotation.id}
          active={activeAnnotationId === annotation.id}
          annotation={annotation}
          layout={layouts[annotation.id]}
          lane={overlapLanes[annotation.id] ?? 0}
          onOpen={(coords) => onOpen(annotation, coords)}
          onActiveChange={(isActive) => setActiveAnnotationId(isActive ? annotation.id : null)}
        />
      ))}
    </div>
  );
}

function PaperCard({ label }: { label: string }) {
  return (
    <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-rim bg-cave font-mono text-[12px] text-smoke">
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
  active,
  annotation,
  layout,
  lane,
  onOpen,
  onActiveChange
}: {
  active: boolean;
  annotation: AnnotationRecord;
  layout?: ResolvedAnnotationLayout;
  lane: number;
  onOpen: (coords: { x: number; y: number }) => void;
  onActiveChange: (isActive: boolean) => void;
}) {
  const tone = annotationTone(annotation.type);
  const style = importanceStyle(annotation.importance);
  const resolvedLayout = layout ?? createFallbackLayout(annotation.bbox);
  const laneOffset = lane * 0.008;

  return (
    <>
      {resolvedLayout.fragments.map((fragment, index) => (
        <button
          key={`${annotation.id}-${index}`}
          aria-label={`${annotation.type}: ${annotation.textRef}`}
          className="pointer-events-auto absolute cursor-pointer rounded-[4px] transition-transform hover:scale-[1.01] focus:scale-[1.01]"
          style={{
            left: `${fragment.x * 100}%`,
            top: `${(fragment.y + laneOffset) * 100}%`,
            width: `${fragment.width * 100}%`,
            height: `${fragment.height * 100}%`,
            zIndex: active ? 30 : 10 + lane
          }}
          title={annotation.note}
          type="button"
          onMouseEnter={() => onActiveChange(true)}
          onMouseLeave={() => onActiveChange(false)}
          onFocus={() => onActiveChange(true)}
          onBlur={() => onActiveChange(false)}
          onClick={(event) => {
            event.stopPropagation();
            onOpen({
              x: resolvedLayout.anchorX,
              y: resolvedLayout.anchorY + laneOffset
            });
          }}
        >
          <span
            className="absolute inset-0 rounded-[4px]"
            style={{
              backgroundColor: tone,
              opacity: active ? Math.min(style.fillOpacity + 0.08, 0.35) : style.fillOpacity
            }}
          />
          <span
            className="absolute inset-0 rounded-[4px] border"
            style={{
              borderColor: tone,
              opacity: active ? 0.95 : style.borderOpacity,
              borderWidth: active ? 2 : 1
            }}
          />
          {index === 0 ? <span className="sr-only">{annotation.type}</span> : null}
        </button>
      ))}
    </>
  );
}

function AnnotationPopup({
  pageRootRef,
  popup,
  onClose
}: {
  pageRootRef: RefObject<HTMLDivElement | null>;
  popup: NonNullable<PopupState>;
  onClose: () => void;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [, setViewportTick] = useState(0);
  const tone = annotationTone(popup.annotation.type);

  useEffect(() => {
    let frameId = 0;

    const updatePosition = () => {
      frameId = 0;
      setViewportTick((value) => value + 1);
    };

    const requestUpdate = () => {
      if (frameId !== 0) {
        return;
      }

      frameId = window.requestAnimationFrame(updatePosition);
    };

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => setIsVisible(true));
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  const pageRoot = pageRootRef.current;
  if (!pageRoot) {
    return null;
  }

  const pageRect = pageRoot.getBoundingClientRect();
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const anchorLeft = pageRect.left + popup.anchorX * pageRect.width;
  const anchorTop = pageRect.top + popup.anchorY * pageRect.height;
  const side = anchorLeft > (pageRect.left + pageRect.right) / 2 ? "left" : "right";
  const cardWidth = Math.min(320, viewportWidth - 32);
  const edgeGap = 20;
  const cardGap = 28;
  const lineEndX =
    side === "right"
      ? Math.min(pageRect.right + cardGap, viewportWidth - cardWidth - edgeGap)
      : Math.max(pageRect.left - cardGap, cardWidth + edgeGap);
  const cardLeft =
    side === "right"
      ? Math.min(lineEndX, viewportWidth - cardWidth - edgeGap)
      : Math.max(lineEndX - cardWidth, edgeGap);
  const connectorLeft = Math.min(anchorLeft, side === "right" ? cardLeft : cardLeft + cardWidth);
  const connectorWidth = Math.abs((side === "right" ? cardLeft : cardLeft + cardWidth) - anchorLeft);
  const top = Math.min(Math.max(anchorTop - 42, 16), viewportHeight - 180);

  return (
    <div className="pointer-events-none fixed inset-0 z-30 overflow-visible" data-annotation-popup>
      <div
        aria-hidden="true"
        className="absolute"
        style={{
          top: `${anchorTop}px`,
          left: `${connectorLeft}px`,
          width: `${Math.max(connectorWidth, 18)}px`,
          height: "2px",
          transformOrigin: side === "right" ? "left center" : "right center",
          transform: isVisible ? "scaleX(1)" : "scaleX(0)",
          transition: "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)"
        }}
      >
        <span
          className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-white/70 shadow-sm"
          style={{
            left: side === "right" ? "-0.18rem" : undefined,
            right: side === "left" ? "-0.18rem" : undefined,
            backgroundColor: tone
          }}
        />
        <span
          className="absolute inset-y-0 rounded-full"
          style={{
            left: 0,
            right: 0,
            background: `linear-gradient(${side === "right" ? "90deg" : "270deg"}, ${tone}, ${tone}55)`
          }}
        />
        <span
          className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border-t-2 border-r-2"
          style={{
            [side === "right" ? "right" : "left"]: "-0.2rem",
            borderColor: tone
          }}
        />
      </div>
      <aside
        className="pointer-events-auto absolute z-20 max-w-[calc(100vw-64px)] rounded-xl border border-rim bg-cave/[0.97] p-4 shadow-float backdrop-blur"
        style={{
          top: `${top}px`,
          left: `${cardLeft}px`,
          width: `${cardWidth}px`,
          opacity: isVisible ? 1 : 0,
          transform: isVisible
            ? "scale(1)"
            : `${side === "right" ? "translateX(-12px)" : "translateX(12px)"} scale(0.96)`,
          transition: "opacity 180ms ease 140ms, transform 260ms cubic-bezier(0.22, 1, 0.36, 1) 140ms"
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <span
            className="rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.24em]"
            style={{ color: tone, backgroundColor: `${tone}12`, borderColor: `${tone}40` }}
          >
            {popup.annotation.type === "highlight" ? "Key Result" : popup.annotation.type}
          </span>
          <span className="font-mono text-[10px] text-smoke">
            importance {popup.annotation.importance}
          </span>
        </div>
        <RichText content={popup.annotation.note} className="font-mono text-[12px] leading-[1.75] text-linen" />
        <button
          className="mt-4 font-mono text-[11px] text-fog transition hover:text-linen"
          onClick={onClose}
          type="button"
        >
          Dismiss ×
        </button>
      </aside>
    </div>
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
  const bottom = Math.max(...fragments.map((fragment) => fragment.y + fragment.height));

  return {
    fragments,
    anchorX: (left + right) / 2,
    anchorY: (top + bottom) / 2
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

function assignOverlapLanes(
  annotations: AnnotationRecord[],
  layouts: Record<string, ResolvedAnnotationLayout>
): Record<string, number> {
  const positioned = annotations.map((annotation) => ({
    id: annotation.id,
    bounds: getLayoutBounds(layouts[annotation.id] ?? createFallbackLayout(annotation.bbox))
  }));

  positioned.sort((left, right) => {
    if (left.bounds.top !== right.bounds.top) {
      return left.bounds.top - right.bounds.top;
    }

    return left.bounds.left - right.bounds.left;
  });

  const laneMap: Record<string, number> = {};
  const activeGroups: Array<{ lane: number; bounds: LayoutBounds }> = [];

  for (const item of positioned) {
    for (let index = activeGroups.length - 1; index >= 0; index -= 1) {
      if (activeGroups[index].bounds.bottom < item.bounds.top - 0.004) {
        activeGroups.splice(index, 1);
      }
    }

    let lane = 0;
    while (
      activeGroups.some((group) => group.lane === lane && boundsOverlap(group.bounds, item.bounds))
    ) {
      lane += 1;
    }

    laneMap[item.id] = lane;
    activeGroups.push({ lane, bounds: item.bounds });
  }

  return laneMap;
}

type LayoutBounds = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

function getLayoutBounds(layout: ResolvedAnnotationLayout): LayoutBounds {
  const left = Math.min(...layout.fragments.map((fragment) => fragment.x));
  const right = Math.max(...layout.fragments.map((fragment) => fragment.x + fragment.width));
  const top = Math.min(...layout.fragments.map((fragment) => fragment.y));
  const bottom = Math.max(...layout.fragments.map((fragment) => fragment.y + fragment.height));

  return { top, bottom, left, right };
}

function boundsOverlap(left: LayoutBounds, right: LayoutBounds) {
  const verticalOverlap = left.top <= right.bottom && right.top <= left.bottom;
  const horizontalOverlap = left.left <= right.right && right.left <= left.right;
  return verticalOverlap && horizontalOverlap;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
