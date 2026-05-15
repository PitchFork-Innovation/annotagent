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
- `lib/models/`
- `python_service/main.py`

## System Map

**Stack:** Next.js 15 App Router, MongoDB Atlas (Mongoose), NextAuth.js v5 (Credentials + JWT), AWS S3, Resend, FastAPI Python service.

- Next.js App Router serves the landing page, paper workspace page, and JSON/PDF APIs.
- Client UI lives mostly in `components/landing-shell.tsx`, `components/auth-panel.tsx`, and `components/workspace/*`.
- Route handlers validate requests, enforce NextAuth session checks, and delegate business logic to `lib/server-data.ts`.
- `lib/server-data.ts` bridges MongoDB, S3 PDF storage, TTL-based chat persistence, and the Python ingestion/summary service.
- MongoDB Atlas stores papers (with embedded annotations), library membership (`userpapers`), chat history (`chats`), and auth data (`users`, `accounts`). S3 stores cached PDF files.
- Auth is handled by NextAuth.js v5 with a Credentials provider; sessions are JWT-based. Password reset tokens are stored in MongoDB with a 1-hour TTL. Email delivery uses Resend.
- The Python service resolves arXiv metadata, fetches PDFs, extracts text and boxes, generates annotations, and generates summaries.

## Main Flows
### Ingest An arXiv ID
- Landing page posts to `/api/ingest` with `arxivId` and a client-generated `jobId`.
- Route handler requires a valid NextAuth session, then calls `ensurePaperIngested`.
- `lib/server-data.ts` checks for an existing paper by `arxivId`; if missing, it calls the Python `/ingest` endpoint.
- Returned payload is cached into S3, upserted into the MongoDB `papers` collection (with embedded annotations), then linked to the user through `userpapers`.
- Frontend navigates to `/paper/[paperId]` once ingest succeeds.

### Open A Paper Workspace
- `app/paper/[paperId]/page.tsx` loads `getPaperWorkspace`.
- Server data fetches the paper row, annotations, chat history, and a summary fallback if `ai_summary` is empty.
- `AnnotationWorkspace` renders the PDF workspace and the collapsible chat panel from a single `PaperWorkspace` object.

### Ask A Chat Question
- `ChatPanel` sends messages to `/api/chat`.
- Route handler loads the same workspace context, streams an OpenAI response, and persists the finished transcript to the MongoDB `chats` collection (24-hour TTL).
- Chat must stay paper-bounded. The system prompt tells the model to use only the paper context.

### Reprocess Annotations
- Workspace UI presents a style dropdown (pre-populated from `paper.annotationStyle`) and a reprocess button.
- User selects a style and triggers reprocess; the browser calls `/api/papers/[paperId]/reprocess/authorize` to get a short-lived token, then calls the Python `/reprocess` endpoint directly with `annotation_style` in the request body.
- The Python service runs the full pipeline with the chosen style and returns an `IngestionPayload` including `annotationStyle`.
- The browser posts the payload to `/api/papers/[paperId]/reprocess/apply`, which replaces embedded annotations and updates `annotationStyle` in the MongoDB `papers` document.
- Progress status is written by the Python side to shared Redis or KV REST when configured, with temp-file fallback for local development, and exposed by the progress route.

## Where To Start By Boundary
- Page or route selection issue: inspect `app/`
- Layout, interaction, or reader UX change: inspect `components/`
- Shared response shape or orchestration issue: inspect `lib/server-data.ts` and `lib/types.ts`
- Extraction, prompt, or annotation quality issue: inspect `python_service/main.py` and tests
- Persistence or access issue: inspect `lib/models/`, `lib/server-data.ts`, and `lib/s3.ts`

## Core Invariants
- Route handlers stay thin; orchestration belongs in `lib/server-data.ts`.
- `PaperWorkspace` is the shared contract between server loading and workspace UI.
- A paper is globally deduplicated by `arxivId`, then linked into each user library through `userpapers`.
- Annotation generation and summary generation are Python-owned concerns even when consumed from TypeScript.

## Verification
- Cross-boundary changes: `npm run lint`, `npm run typecheck`, and the relevant Python checks
- Ingestion or summary changes: include `python3 -m py_compile python_service/main.py`
