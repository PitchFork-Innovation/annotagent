# Architecture

## Purpose
- Map the full system so an agent can quickly choose the correct runtime boundary before editing.

## When To Read This
- Read first for cross-cutting work, new features, or any change that crosses frontend, route, data, or Python boundaries.

## Source Of Truth Code Areas
- `app/`
- `components/`
- `lib/server-data.ts`
- `lib/types.ts`
- `python_service/main.py`
- `supabase/schema.sql`

## System Map
- Next.js App Router serves the landing page, paper workspace page, auth callback routes, and JSON/PDF APIs.
- Client UI lives mostly in `components/landing-shell.tsx`, `components/auth-panel.tsx`, and `components/workspace/*`.
- Route handlers validate requests, perform auth checks, and delegate business logic to `lib/server-data.ts`.
- `lib/server-data.ts` bridges Supabase, optional KV storage, cached PDFs, and the Python ingestion/summary service.
- Supabase stores papers, annotations, library membership, auth state, and cached PDFs in the `papers` storage bucket.
- The Python service resolves arXiv metadata, fetches PDFs, extracts text and boxes, generates annotations, and generates summaries.

## Main Flows
### Ingest An arXiv ID
- Landing page posts to `/api/ingest` with `arxivId` and a client-generated `jobId`.
- Route handler requires an authenticated Supabase user, then calls `ensurePaperIngested`.
- `lib/server-data.ts` checks for an existing paper by `arxiv_id`; if missing, it calls the Python `/ingest` endpoint.
- Returned payload is cached into Supabase Storage, inserted into `papers` and `annotations`, then linked to the user through `user_papers`.
- Frontend navigates to `/paper/[paperId]` once ingest succeeds.

### Open A Paper Workspace
- `app/paper/[paperId]/page.tsx` loads `getPaperWorkspace`.
- Server data fetches the paper row, annotations, chat history, and a summary fallback if `ai_summary` is empty.
- `AnnotationWorkspace` renders the PDF workspace and the collapsible chat panel from a single `PaperWorkspace` object.

### Ask A Chat Question
- `ChatPanel` sends messages to `/api/chat`.
- Route handler loads the same workspace context, streams an OpenAI response, and persists the finished transcript to KV if configured.
- Chat must stay paper-bounded. The system prompt tells the model to use only the paper context.

### Reprocess Annotations
- Workspace UI starts a reprocess request and polls `/api/ingest/progress` with a `jobId`.
- `/api/papers/[paperId]/reprocess` requires auth and delegates to `reprocessPaperAnnotations`.
- Server data reruns the Python pipeline, updates the paper row, replaces annotations, and refreshes the workspace.
- Progress status is written by the Python side to temp files and exposed by the progress route.

## Where To Start By Boundary
- Page or route selection issue: inspect `app/`
- Layout, interaction, or reader UX change: inspect `components/`
- Shared response shape or orchestration issue: inspect `lib/server-data.ts` and `lib/types.ts`
- Extraction, prompt, or annotation quality issue: inspect `python_service/main.py` and tests
- Persistence or access issue: inspect `supabase/schema.sql` and Supabase helpers in `lib/supabase/`

## Core Invariants
- Route handlers stay thin; orchestration belongs in `lib/server-data.ts`.
- `PaperWorkspace` is the shared contract between server loading and workspace UI.
- A paper is globally deduplicated by `arxiv_id`, then linked into each user library through `user_papers`.
- Annotation generation and summary generation are Python-owned concerns even when consumed from TypeScript.

## Verification
- Cross-boundary changes: `npm run lint`, `npm run typecheck`, and the relevant Python checks
- Ingestion or summary changes: include `.venv/bin/python -m unittest python_service.tests.test_annotation_prompts`
