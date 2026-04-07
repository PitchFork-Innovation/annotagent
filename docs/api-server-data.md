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
- `lib/kv.ts`
- `lib/supabase/*`

## Responsibility Split
- Route handlers:
  - parse and validate request input
  - enforce request-level auth when needed
  - return HTTP status codes and response objects
- `lib/server-data.ts`:
  - loads and shapes app data
  - orchestrates Supabase reads and writes
  - applies completed Python ingestion payloads to Supabase
  - caches PDFs in storage
  - persists and reads optional KV chat history
  - handles fallback behavior like missing `ai_summary`
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
  - saves the finished ingest result to Supabase
- `/api/papers/[paperId]`
  - GET paper workspace JSON
- `/api/papers/[paperId]/pdf`
  - GET proxied PDF bytes from cached Supabase storage when available, otherwise arXiv-based fallbacks
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
  - saves the finished reprocess result to Supabase
- `/api/chat`
  - POST with `paperId` and `messages`
  - loads paper context, streams completion, stores chat history on finish

## Auth And Client Rules
- Routes that mutate library state require a Supabase-authenticated user.
- Long-running annotation generation now runs browser → Python service directly with short-lived HMAC tokens issued by authenticated route handlers.
- `PYTHON_SERVICE_SHARED_SECRET` must match between Vercel and the Python service host.
- `ensurePaperIngested` uses both server and admin clients:
  - server client for user-scoped reads/writes like `user_papers`
  - admin client for cross-user paper and annotation persistence plus storage access
- `reprocessPaperAnnotations` first proves the current user owns the paper through `user_papers`.
- Reprocess prefers the cached storage PDF when present, but should fall back to the paper's saved `pdf_url` if the cache object is missing so older papers can still be regenerated.
- Chat history is optional. Missing KV env vars should not break chat responses.

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
- If you change `papers` or `annotations` columns, inspect:
  - `supabase/schema.sql`
  - `lib/server-data.ts`
  - workspace consumers

## Common Change Patterns
- New route, existing business logic: keep the route thin and call a helper in `lib/server-data.ts`.
- New data on the paper page: update the DB read in `getPaperWorkspace`, then `lib/types.ts`, then the UI.
- New ingest-side payload field: update both the Python return shape and TypeScript `IngestionPayload`.
- PDF retrieval changes must preserve authenticated paper access, the cached-storage-first lookup, and PDF content-type validation for network fallbacks.

## Verification
- `npm run lint`
- `npm run typecheck`
- If chat or ingestion changed, run the relevant Python checks too
