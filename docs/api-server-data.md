# API And Server Data

## Purpose
- Document the boundary between thin route handlers and the shared orchestration layer in `lib/server-data.ts`.

## When To Read This
- Read before changing route handlers, auth rules, workspace payload shape, ingestion orchestration, or any server-side fetch flow.

## Source Of Truth Code Areas
- `app/api/ingest/route.ts`
- `app/api/ingest/progress/route.ts`
- `app/api/chat/route.ts`
- `app/api/papers/[paperId]/route.ts`
- `app/api/papers/[paperId]/pdf/route.ts`
- `app/api/papers/[paperId]/reprocess/route.ts`
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
  - calls the Python service
  - caches PDFs in storage
  - persists and reads optional KV chat history
  - handles fallback behavior like missing `ai_summary`

## Current Routes
- `/api/ingest`
  - POST with `arxivId` and optional `jobId`
  - requires authenticated user
  - delegates to `ensurePaperIngested`
- `/api/ingest/progress`
  - GET with `jobId`
  - reads temp-file progress state
  - returns a pending placeholder when no file exists yet
- `/api/papers/[paperId]`
  - GET paper workspace JSON
- `/api/papers/[paperId]/pdf`
  - GET proxied PDF bytes from cached Supabase storage when available, otherwise arXiv-based fallbacks
- `/api/papers/[paperId]/reprocess`
  - POST with optional `jobId`
  - requires authenticated user and linked paper
- `/api/chat`
  - POST with `paperId` and `messages`
  - loads paper context, streams completion, stores chat history on finish

## Auth And Client Rules
- Routes that mutate library state require a Supabase-authenticated user.
- `ensurePaperIngested` uses both server and admin clients:
  - server client for user-scoped reads/writes like `user_papers`
  - admin client for cross-user paper and annotation persistence plus storage access
- `reprocessPaperAnnotations` first proves the current user owns the paper through `user_papers`.
- Reprocess prefers the cached storage PDF when present, but should fall back to the paper's saved `pdf_url` if the cache object is missing so older papers can still be regenerated.
- Chat history is optional. Missing KV env vars should not break chat responses.

## Coupled Contracts
- `PaperWorkspace`, `PaperRecord`, `AnnotationRecord`, and `IngestionPayload` in `lib/types.ts` are the main TypeScript contracts.
- Annotation records may now include a deterministic text `anchor` in addition to `bbox`; keep Python JSON, database rows, server mapping, and workspace consumers in sync.
- If you change fields in the Python ingest response, update:
  - `lib/types.ts`
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
