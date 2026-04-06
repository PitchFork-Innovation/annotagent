"use client";

import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Document, Page, pdfjs } from "react-pdf";
import { RichText } from "@/components/rich-text";
import { readJsonResponse } from "@/lib/http";
import { authorizePythonReprocess, fetchPythonProgress, runPythonReprocess } from "@/lib/python-service";
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
    let progressInterval: number | undefined;

    try {
      const authorization = await authorizePythonReprocess(workspace.paper.id, jobId);
      if (!authorization.pythonServiceUrl || !authorization.token) {
        setReprocessMessage(authorization.error ?? "Unable to contact the reprocess service.");
        return;
      }

      progressInterval = window.setInterval(async () => {
        try {
          const json = await fetchPythonProgress(authorization.pythonServiceUrl, authorization.token, jobId);
          setReprocessProgress(json);
        } catch {
          // Leave the current progress state in place during transient polling failures.
        }
      }, 1000);

      const payload = await runPythonReprocess(authorization.pythonServiceUrl, authorization.token, workspace.paper, jobId);
      const response = await fetch(`/api/papers/${workspace.paper.id}/reprocess/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const json = await readJsonResponse<{ error?: string; annotationCount?: number }>(response);

      if (!response.ok) {
        setReprocessMessage(json.error ?? "Unable to reprocess annotations.");
        return;
      }

      if (typeof json.annotationCount !== "number") {
        setReprocessMessage("The reprocess request completed without a valid annotation count.");
        return;
      }

      setReprocessMessage(`Reprocessed annotations successfully. ${json.annotationCount} annotations are now stored.`);
      router.refresh();
    } catch (error) {
      setReprocessMessage(error instanceof Error ? error.message : "Unable to reprocess annotations.");
    } finally {
      if (progressInterval) {
        window.clearInterval(progressInterval);
      }
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
              className="rounded border border-gold/25 bg-gradient-to-b from-shell to-cave px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-linen shadow-[0_12px_30px_rgba(0,0,0,0.28)] ring-1 ring-gold/10 transition hover:border-gold/45 hover:from-shell hover:to-shell hover:text-ghost"
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
          <section className="mt-5 max-w-3xl rounded-xl border border-rim/90 bg-gradient-to-br from-cave via-cave to-shell/70 p-5 shadow-[0_20px_48px_rgba(0,0,0,0.24)] ring-1 ring-white/5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-gold/80">AI Key Points</p>
                <p className="mt-0.5 font-mono text-[11px] text-fog">
                  Summary from abstract and extracted text.
                </p>
              </div>
            </div>
            <RichText content={summaryContent} className="font-mono text-[13px] leading-[1.8] text-linen/90" />
          </section>
        </div>

        {/* Chat toggle */}
        <button
          className="shrink-0 rounded border border-gold/25 bg-gradient-to-b from-shell to-cave px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-linen shadow-[0_12px_30px_rgba(0,0,0,0.28)] ring-1 ring-gold/10 transition hover:border-gold/45 hover:from-shell hover:to-shell hover:text-ghost"
          onClick={onToggleChat}
          type="button"
        >
          Inquiry ›
        </button>
      </div>

      {/* Reprocess controls */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          className="rounded border border-gold/25 bg-gradient-to-b from-shell to-cave px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-linen shadow-[0_12px_30px_rgba(0,0,0,0.28)] ring-1 ring-gold/10 transition hover:border-gold/45 hover:from-shell hover:to-shell hover:text-ghost disabled:cursor-not-allowed disabled:opacity-50"
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

  const stackOrder = useMemo(() => assignAnnotationStackOrder(annotations, layouts), [annotations, layouts]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {annotations.map((annotation) => (
        <AnnotationHighlight
          key={annotation.id}
          active={activeAnnotationId === annotation.id}
          annotation={annotation}
          layout={layouts[annotation.id]}
          stackOrder={stackOrder[annotation.id] ?? 0}
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
  stackOrder,
  onOpen,
  onActiveChange
}: {
  active: boolean;
  annotation: AnnotationRecord;
  layout?: ResolvedAnnotationLayout;
  stackOrder: number;
  onOpen: (coords: { x: number; y: number }) => void;
  onActiveChange: (isActive: boolean) => void;
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
          className="pointer-events-auto absolute cursor-pointer rounded-[4px] transition-transform hover:scale-[1.01] focus:scale-[1.01]"
          style={{
            left: `${fragment.x * 100}%`,
            top: `${fragment.y * 100}%`,
            width: `${fragment.width * 100}%`,
            height: `${fragment.height * 100}%`,
            zIndex: active ? 60 : 10 + stackOrder
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
              y: resolvedLayout.anchorY
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

    document.addEventListener("scroll", requestUpdate, { passive: true, capture: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      document.removeEventListener("scroll", requestUpdate, true);
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
  const pageRect = pageRoot?.getBoundingClientRect();
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const hasPageRect = Boolean(pageRect);
  const anchorLeft = pageRect ? pageRect.left + popup.anchorX * pageRect.width : 0;
  const anchorTop = pageRect ? pageRect.top + popup.anchorY * pageRect.height : 0;
  const anchorIsVisible =
    hasPageRect &&
    (pageRect?.width ?? 0) > 0 &&
    (pageRect?.height ?? 0) > 0 &&
    anchorLeft >= 0 &&
    anchorLeft <= viewportWidth &&
    anchorTop >= 0 &&
    anchorTop <= viewportHeight;

  useEffect(() => {
    if (!anchorIsVisible) {
      onClose();
    }
  }, [anchorIsVisible, onClose]);

  if (!pageRect || !anchorIsVisible) {
    return null;
  }

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

  const matchedFragments = matchTextLayerFragments(annotation, textLayer, pageRoot);
  return matchedFragments ? buildResolvedLayout(matchedFragments) : createFallbackLayout(annotation.bbox);
}

type TextLayerSegment = {
  element: HTMLSpanElement;
  normalizedStart: number;
  normalizedEnd: number;
  rawMap: Array<{ start: number; end: number }>;
};

type TextLayerMatch = {
  fragments: HighlightFragment[];
  bounds: LayoutBounds;
};

function matchTextLayerFragments(
  annotation: AnnotationRecord,
  textLayer: Element,
  pageRoot: HTMLDivElement
): HighlightFragment[] | null {
  const normalizedQuery = normalizeText(annotation.textRef);
  if (!normalizedQuery) {
    return null;
  }

  const textIndex = buildTextLayerIndex(textLayer);
  if (!textIndex.pageText) {
    return null;
  }

  const matches = findNormalizedOccurrences(textIndex.pageText, normalizedQuery)
    .map((start) => buildTextLayerMatch(start, start + normalizedQuery.length, textIndex.segments, pageRoot))
    .filter((candidate): candidate is TextLayerMatch => Boolean(candidate));

  if (matches.length === 0) {
    return null;
  }

  return selectBestTextLayerMatch(matches, annotation).fragments;
}

function buildTextLayerIndex(textLayer: Element): {
  pageText: string;
  segments: TextLayerSegment[];
} {
  let pageText = "";
  const segments: TextLayerSegment[] = [];

  for (const span of Array.from(textLayer.querySelectorAll("span"))) {
    const normalized = normalizeTextWithMapping(span.textContent ?? "");
    if (!normalized.text) {
      continue;
    }

    if (pageText) {
      pageText += " ";
    }

    const normalizedStart = pageText.length;
    pageText += normalized.text;
    segments.push({
      element: span as HTMLSpanElement,
      normalizedStart,
      normalizedEnd: pageText.length,
      rawMap: normalized.rawMap
    });
  }

  return { pageText, segments };
}

function findNormalizedOccurrences(source: string, query: string): number[] {
  const matches: number[] = [];
  let startIndex = 0;

  while (startIndex < source.length) {
    const matchIndex = source.indexOf(query, startIndex);
    if (matchIndex === -1) {
      break;
    }

    const atWordStart = matchIndex === 0 || source[matchIndex - 1] === " ";
    const matchEnd = matchIndex + query.length;
    const atWordEnd = matchEnd >= source.length || source[matchEnd] === " ";
    if (atWordStart && atWordEnd) {
      matches.push(matchIndex);
    }

    startIndex = matchIndex + 1;
  }

  return matches;
}

function buildTextLayerMatch(
  matchStart: number,
  matchEnd: number,
  segments: TextLayerSegment[],
  pageRoot: HTMLDivElement
): TextLayerMatch | null {
  const rootRect = pageRoot.getBoundingClientRect();
  const rects: DOMRect[] = [];

  for (const segment of segments) {
    if (segment.normalizedEnd <= matchStart || segment.normalizedStart >= matchEnd) {
      continue;
    }

    const localStart = Math.max(matchStart, segment.normalizedStart) - segment.normalizedStart;
    const localEnd = Math.min(matchEnd, segment.normalizedEnd) - segment.normalizedStart;
    rects.push(...getSegmentMatchRects(segment, localStart, localEnd));
  }

  const fragments = rectsToHighlightFragments(rects, rootRect);
  if (!fragments) {
    return null;
  }

  return {
    fragments,
    bounds: getBoundsFromFragments(fragments)
  };
}

function getSegmentMatchRects(segment: TextLayerSegment, start: number, end: number): DOMRect[] {
  if (start >= end) {
    return [];
  }

  const textNode = segment.element.firstChild;
  if (!(textNode instanceof Text)) {
    return [segment.element.getBoundingClientRect()];
  }

  const rawStart = segment.rawMap[start]?.start;
  const rawEnd = segment.rawMap[end - 1]?.end;
  if (rawStart === undefined || rawEnd === undefined || rawStart >= rawEnd) {
    return [];
  }

  const range = document.createRange();
  range.setStart(textNode, rawStart);
  range.setEnd(textNode, rawEnd);
  return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
}

function selectBestTextLayerMatch(matches: TextLayerMatch[], annotation: AnnotationRecord): TextLayerMatch {
  const anchoredMatch = annotation.anchor ? matches[annotation.anchor.occurrenceIndex] : undefined;
  if (anchoredMatch) {
    return anchoredMatch;
  }

  const bbox = annotation.bbox;
  const targetX = bbox.x + bbox.width / 2;
  const targetY = bbox.y + bbox.height / 2;

  return matches.reduce((best, candidate) => {
    const bestDistance = getBoundsCenterDistance(best.bounds, targetX, targetY);
    const candidateDistance = getBoundsCenterDistance(candidate.bounds, targetX, targetY);

    if (candidateDistance !== bestDistance) {
      return candidateDistance < bestDistance ? candidate : best;
    }

    return getBoundsArea(candidate.bounds) < getBoundsArea(best.bounds) ? candidate : best;
  });
}

function rectsToHighlightFragments(rects: DOMRect[], rootRect: DOMRect): HighlightFragment[] | null {
  const visibleRects = rects.filter((rect) => rect.width > 0 && rect.height > 0);

  if (visibleRects.length === 0 || rootRect.width === 0 || rootRect.height === 0) {
    return null;
  }

  const mergedRects = visibleRects
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
  const { left, top, right, bottom } = getBoundsFromFragments(fragments);

  return {
    fragments,
    anchorX: (left + right) / 2,
    anchorY: (top + bottom) / 2
  };
}

function createFallbackLayout(bbox: AnnotationRecord["bbox"]): ResolvedAnnotationLayout {
  const fragments = bbox.fragments?.length
    ? bbox.fragments
    : [
        {
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height
        }
      ];

  return buildResolvedLayout(fragments);
}

function assignAnnotationStackOrder(
  annotations: AnnotationRecord[],
  layouts: Record<string, ResolvedAnnotationLayout>
): Record<string, number> {
  const positioned = annotations.map((annotation) => ({
    id: annotation.id,
    bounds: getLayoutBounds(layouts[annotation.id] ?? createFallbackLayout(annotation.bbox))
  }));

  const stackSorted = positioned
    .map((item) => ({
      ...item,
      area: getBoundsArea(item.bounds),
      width: item.bounds.right - item.bounds.left,
      containmentDepth: positioned.filter(
        (other) => other.id !== item.id && boundsContain(other.bounds, item.bounds)
      ).length
    }))
    .sort((left, right) => {
      if (left.containmentDepth !== right.containmentDepth) {
        return left.containmentDepth - right.containmentDepth;
      }

      if (left.area !== right.area) {
        return right.area - left.area;
      }

      if (left.width !== right.width) {
        return right.width - left.width;
      }

      if (left.bounds.top !== right.bounds.top) {
        return left.bounds.top - right.bounds.top;
      }

      return left.bounds.left - right.bounds.left;
    });

  return Object.fromEntries(stackSorted.map((item, index) => [item.id, index]));
}

type LayoutBounds = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

function getLayoutBounds(layout: ResolvedAnnotationLayout): LayoutBounds {
  return getBoundsFromFragments(layout.fragments);
}

function getBoundsFromFragments(fragments: HighlightFragment[]): LayoutBounds {
  const left = Math.min(...fragments.map((fragment) => fragment.x));
  const right = Math.max(...fragments.map((fragment) => fragment.x + fragment.width));
  const top = Math.min(...fragments.map((fragment) => fragment.y));
  const bottom = Math.max(...fragments.map((fragment) => fragment.y + fragment.height));

  return { top, bottom, left, right };
}

function boundsContain(container: LayoutBounds, candidate: LayoutBounds) {
  const tolerance = 0.001;
  return (
    container.left <= candidate.left + tolerance &&
    container.right >= candidate.right - tolerance &&
    container.top <= candidate.top + tolerance &&
    container.bottom >= candidate.bottom - tolerance
  );
}

function normalizeText(value: string) {
  return normalizeTextWithMapping(value).text;
}

function normalizeTextWithMapping(value: string): {
  text: string;
  rawMap: Array<{ start: number; end: number }>;
} {
  const characters: string[] = [];
  const rawMap: Array<{ start: number; end: number }> = [];
  let pendingSpaceIndex: number | null = null;
  let rawIndex = 0;

  for (const char of value) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      if (pendingSpaceIndex !== null && characters.length > 0) {
        characters.push(" ");
        rawMap.push({ start: pendingSpaceIndex, end: pendingSpaceIndex + 1 });
        pendingSpaceIndex = null;
      }

      characters.push(char.toLowerCase());
      rawMap.push({ start: rawIndex, end: rawIndex + char.length });
    } else if (characters.length > 0 && pendingSpaceIndex === null) {
      pendingSpaceIndex = rawIndex;
    }

    rawIndex += char.length;
  }

  return {
    text: characters.join(""),
    rawMap
  };
}

function getBoundsCenterDistance(bounds: LayoutBounds, targetX: number, targetY: number) {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return Math.hypot(centerX - targetX, centerY - targetY);
}

function getBoundsArea(bounds: LayoutBounds) {
  return Math.max(bounds.right - bounds.left, 0) * Math.max(bounds.bottom - bounds.top, 0);
}
