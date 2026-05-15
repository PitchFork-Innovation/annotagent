# API And Server Data

## Purpose
- Document the boundary between thin route handlers and the shared orchestration layer in `lib/server-data.ts`.

## When To Read This
- Read before changing route handlers, auth rules, workspace payload shape, ingestion orchestration, or any server-side fetch flow.

## Source Of Truth Code Areas
- `app/api/ingest/route.ts`
- `app/api/ingest/authorize/route.ts`
- `app/api/ingest/apply/route.ts`
- `app/api/chat/route.ts`
- `app/api/papers/[paperId]/route.ts`
- `app/api/papers/[paperId]/pdf/route.ts`
- `app/api/papers/[paperId]/reprocess/route.ts`
- `app/api/papers/[paperId]/reprocess/authorize/route.ts`
- `app/api/papers/[paperId]/reprocess/apply/route.ts`
- `lib/server-data.ts`
- `lib/env.ts`
- `lib/models/`
- `lib/s3.ts`
- `lib/mongodb.ts`

## Responsibility Split
- Route handlers:
  - parse and validate request input
  - enforce request-level auth when needed
  - return HTTP status codes and response objects
- `lib/server-data.ts`:
  - loads and shapes app data
  - orchestrates MongoDB reads and writes via Mongoose models
  - applies completed Python ingestion payloads to MongoDB
  - caches PDFs in S3
  - persists and reads TTL-indexed chat history in MongoDB (`chats` collection)
  - handles fallback behavior like missing `aiSummary`
- The browser:
  - requests short-lived Python-service tokens from authenticated route handlers
  - calls the Python service directly for long-running ingest/reprocess jobs and progress polling

## Current Routes
- `/api/ingest`
  - POST with `arxivId` and optional `jobId`
  - requires authenticated user
  - delegates to `ensurePaperIngested`
- `/api/ingest/authorize`
  - POST with `jobId`
  - requires authenticated user
  - returns a short-lived token plus Python base URL for direct browser-to-Python ingest
- `/api/ingest/apply`
  - POST with a validated `IngestionPayload`
  - requires authenticated user
  - saves the finished ingest result to MongoDB
- `/api/papers/[paperId]`
  - GET paper workspace JSON
- `/api/papers/[paperId]/pdf`
  - GET proxied PDF bytes — redirects to an S3 presigned URL when a cached PDF is available, otherwise falls back to arXiv-direct
- `/api/papers/[paperId]/reprocess`
  - POST with optional `jobId`
  - requires authenticated user and linked paper
- `/api/papers/[paperId]/reprocess/authorize`
  - POST with `jobId`
  - requires authenticated user and linked paper
  - returns a short-lived token plus Python base URL for direct browser-to-Python reprocess
- `/api/papers/[paperId]/reprocess/apply`
  - POST with a validated `IngestionPayload`
  - requires authenticated user and linked paper
  - saves the finished reprocess result to MongoDB
- `/api/chat`
  - POST with `paperId` and `messages`
  - loads paper context, streams completion, stores chat history on finish

## Auth And Authorization Rules
- Routes that mutate library state require an authenticated NextAuth session (JWT).
- Every server-data function that returns paper or annotation data takes a `userId` and calls `UserPaper.exists({ userId, paperId })` before returning. This is the application-layer replacement for Supabase RLS — there is no database-level row security.
- Long-running annotation generation runs browser → Python service directly with short-lived HMAC tokens issued by authenticated route handlers.
- `PYTHON_SERVICE_SHARED_SECRET` must match between the app host and the Python service host.
- `ensurePaperIngested` performs the `userpapers` link check and MongoDB paper/annotation persistence in a single flow — there is no separate admin client; MongoDB Atlas does not use per-user DB credentials.
- `reprocessPaperAnnotations` first proves the current user owns the paper through `UserPaper.exists`.
- Reprocess prefers the cached S3 PDF when present, but falls back to the paper's saved `pdfUrl` so older papers can still be regenerated.
- Chat history is stored in the `chats` MongoDB collection with a 24-hour TTL. A missing chat document is a normal state and must not break chat responses.
- Shared ingest progress on multi-instance Python deployments relies on optional shared Redis; without it, progress falls back to the Python host's local temp storage.

## Coupled Contracts
- `PaperWorkspace`, `PaperRecord`, `AnnotationRecord`, and `IngestionPayload` in `lib/types.ts` are the main TypeScript contracts.
- Annotation records may now include a deterministic text `anchor` in addition to `bbox`; keep Python JSON, database rows, server mapping, and workspace consumers in sync.
- `PaperRecord` now includes `annotationStyle` read from `papers.annotation_style` and returned by `getPaperWorkspace`. The workspace uses this to pre-populate the reprocess style dropdown.
- `IngestionPayload` includes an optional `annotationStyle` field emitted by the Python service and written to `papers.annotation_style` via `buildPaperMutationPayload`.
- If you change fields in the Python ingest response, update:
  - `lib/types.ts`
  - `lib/ingestion-schema.ts`
  - `lib/server-data.ts`
  - affected route handlers
  - frontend consumers
- If you change `papers` or `annotations` fields, inspect:
  - the Mongoose model in `lib/models/`
  - `lib/server-data.ts`
  - workspace consumers

## Common Change Patterns
- New route, existing business logic: keep the route thin and call a helper in `lib/server-data.ts`.
- New data on the paper page: update the DB read in `getPaperWorkspace`, then `lib/types.ts`, then the UI.
- New ingest-side payload field: update both the Python return shape and TypeScript `IngestionPayload`.
- PDF retrieval changes must preserve authenticated paper access, the cached S3-first lookup, and PDF content-type validation for network fallbacks.

## Verification
- `npm run lint`
- `npm run typecheck`
- If chat or ingestion changed, run the relevant Python checks too
