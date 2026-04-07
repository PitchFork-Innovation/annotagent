# Frontend

## Purpose
- Explain where UI behavior lives and which reader/chat invariants must survive frontend changes.

## When To Read This
- Read before editing pages, client components, reader interactions, visual styling, or anything that consumes `PaperWorkspace`.

## Source Of Truth Code Areas
- `app/page.tsx`
- `app/paper/[paperId]/page.tsx`
- `components/landing-shell.tsx`
- `components/auth-panel.tsx`
- `components/workspace/annotation-workspace.tsx`
- `components/workspace/pdf-workspace.tsx`
- `components/workspace/chat-panel.tsx`
- `lib/types.ts`
- `lib/annotations.ts`

## Current UI Structure
- `app/page.tsx` is the server entrypoint for the landing screen. It loads current user and recent papers, then renders `LandingShell`.
- `LandingShell` is the main marketing plus ingestion screen. It owns arXiv submission, progress polling, annotation style selection, and library navigation.
- `AuthPanel` owns sign-in, sign-up, password reset, and sign-out entrypoints using the browser Supabase client.
- `app/paper/[paperId]/page.tsx` is a server page that loads a `PaperWorkspace` and passes it into `AnnotationWorkspace`.
- `AnnotationWorkspace` is the top-level client shell for the paper screen and toggles the chat panel.
- `PdfWorkspace` owns PDF rendering, overlay rendering, summary display, reprocess polling, reprocess style selection, and annotation popup behavior.
- `ChatPanel` owns the collapsible inquiry panel and streams responses from `/api/chat`.
- Assistant responses in the inquiry panel render markdown and LaTeX via the shared rich-text renderer, while preserving the paper-scoped streaming chat flow.

## Client And Server Boundaries
- Keep data loading in server pages or route handlers unless there is a clear browser-only need.
- Client components should consume already-shaped data from `lib/types.ts` rather than rebuild server payloads ad hoc.
- Browser-only libraries like `react-pdf` stay in client components and are dynamically loaded where needed.

## Core Invariants
- PDF overlay alignment depends on annotation bounding boxes matching the rendered page coordinate system. The reader now prefers deterministic text anchors and exact text-layer range matches, then falls back to stored bbox fragments from ingestion, so avoid casual changes to scaling, text-layer querying, or overlay positioning.
- Overlapping annotations should remain geometrically aligned to the underlying text. Prefer stack ordering over visual y-offsets so narrower contained highlights stay visible without shifting off the text they annotate.
- Annotation interaction is currently a single-popup model. Escape and outside click both close the active popup.
- The inquiry panel is collapsible, stateful, and scoped to a single paper.
- After a user submits a question, the inquiry panel should show an in-panel pending state until the assistant has visible response text.
- Workspace rendering assumes one `PaperWorkspace` object with `paper`, `annotations`, and `chatHistory`.
- The current visual language is editorial rather than dashboard-like: warm paper background, serif display headings, rounded surfaces, and restrained accent colors from annotation type.

## Where Changes Belong
- Add or change page-level server loading: `app/`
- Add or change reusable UI behavior: `components/`
- Change shared frontend/server shapes: `lib/types.ts`
- Change annotation color or importance rendering: `lib/annotations.ts`

## Common Change Patterns
- New landing-page behavior usually touches `app/page.tsx` plus `components/landing-shell.tsx`.
- Workspace interaction changes usually start in `components/workspace/pdf-workspace.tsx`.
- Chat UX changes usually touch `components/workspace/chat-panel.tsx` and may require matching API or contract updates.
- If a UI change needs new data, update the server loader and `PaperWorkspace` contract first, then the client components.
- Annotation style dropdown changes: the landing shell owns the ingest-time dropdown; `PdfWorkspace` owns the reprocess-time dropdown. Both read from and write to local `AnnotationStyle` state before passing the value to `runPythonIngest` / `runPythonReprocess` in `lib/python-service.ts`. The reprocess dropdown initializes from `workspace.paper.annotationStyle`.

## Verification
- `npm run lint`
- `npm run typecheck`
- For reader changes, manually sanity-check loading, annotation overlay alignment, popup dismissal, chat toggle, and reprocess progress UI
