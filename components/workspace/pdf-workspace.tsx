"use client";

import { useEffect, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { AnnotationRecord, PaperWorkspace } from "@/lib/types";
import { annotationTone, importanceStyle } from "@/lib/annotations";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type Props = {
  workspace: PaperWorkspace;
  onToggleChat: () => void;
};

type PopupState = {
  annotation: AnnotationRecord;
  x: number;
  y: number;
} | null;

export function PdfWorkspace({ workspace, onToggleChat }: Props) {
  const [pageCount, setPageCount] = useState<number>(0);
  const [activePopup, setActivePopup] = useState<PopupState>(null);

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

  return (
    <div className="px-4 py-5 md:px-8">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
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

      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <Document
          file={workspace.paper.pdfUrl}
          loading={<PaperCard label="Loading PDF..." />}
          onLoadSuccess={({ numPages }) => setPageCount(numPages)}
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
                <div className="relative mx-auto w-fit">
                  <Page pageNumber={pageNumber} renderAnnotationLayer={false} renderTextLayer={true} />
                  <div className="pointer-events-none absolute inset-0">
                    {pageAnnotations.map((annotation) => (
                      <AnnotationUnderline
                        key={annotation.id}
                        annotation={annotation}
                        onOpen={(coords) => setActivePopup({ annotation, ...coords })}
                      />
                    ))}
                  </div>
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

function PaperCard({ label }: { label: string }) {
  return (
    <div className="flex min-h-[320px] items-center justify-center rounded-[1.5rem] bg-white text-night/50">
      {label}
    </div>
  );
}

function AnnotationUnderline({
  annotation,
  onOpen
}: {
  annotation: AnnotationRecord;
  onOpen: (coords: { x: number; y: number }) => void;
}) {
  const tone = annotationTone(annotation.type);
  const style = importanceStyle(annotation.importance);
  const { x, y, width, height } = annotation.bbox;

  const path = `M 2 ${height - 4} Q ${width * 0.2} ${height - 1}, ${width * 0.35} ${height - 4} T ${width *
    0.7} ${height - 5} T ${Math.max(width - 2, 3)} ${height - 4}`;

  return (
    <button
      className="pointer-events-auto absolute"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${width * 100}%`,
        height: `${height * 100}%`
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
      <svg className="h-full w-full overflow-visible" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <path
          d={path}
          fill="none"
          stroke={tone}
          strokeLinecap="round"
          strokeOpacity={style.opacity}
          strokeWidth={style.strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
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
