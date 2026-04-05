# Data Model

## Purpose
- Summarize the stored data shape and the persistence invariants agents must preserve across schema and app changes.

## When To Read This
- Read before editing Supabase schema, storage behavior, record shapes, library ownership logic, or any change that adds/removes persisted fields.

## Source Of Truth Code Areas
- `supabase/schema.sql`
- `supabase/storage.md`
- `lib/types.ts`
- `lib/server-data.ts`
- `lib/kv.ts`

## Tables
- `papers`
  - one row per `arxiv_id`
  - stores title, abstract, full text, PDF URL, page count, starter questions, and optional `ai_summary`
- `annotations`
  - child rows keyed by `paper_id`
  - stores `page_number`, `type`, `text_ref`, `note`, `importance`, and JSON `bbox`
  - `bbox` is a normalized page-space rectangle and may also carry finer-grained fragment rectangles for multi-fragment highlights
  - optional JSON `anchor` stores deterministic page-text offsets plus occurrence index for repeated-term disambiguation
- `user_papers`
  - join table linking authenticated users to papers in their private library
  - primary key is `(user_id, paper_id)`

## Storage And Non-Postgres Persistence
- Supabase Storage bucket defaults to `papers`.
- Cached PDFs are expected at `arxiv/<arxiv_id>.pdf`.
- Chat history is not in Postgres; it is optional KV REST storage with a 24-hour TTL keyed by paper ID.

## Access Model
- Row-level security is enabled on `papers`, `annotations`, and `user_papers`.
- Users can read papers and annotations only when linked through `user_papers`.
- Library management is user-scoped through `user_papers`.
- Admin client usage in the app bypasses user scoping intentionally for shared paper/annotation persistence and storage operations.

## Application Invariants
- A paper is globally deduplicated by `arxiv_id`.
- A user can link an existing paper into their library without duplicating the paper row.
- Annotations are page-scoped and rely on valid bounding boxes for overlay rendering. Stored boxes should be as close as possible to the final `text_ref`, not just the original source chunk, and stored anchors should remain aligned with the page-level extracted text.
- PDF URLs may point to cached Supabase storage, but the PDF API route also preserves arXiv fallback fetching.
- `ai_summary` is treated as optional in code because older schemas may not have the column yet.
- KV chat persistence is optional and failure-tolerant.

## If You Change Data Shape, Also Inspect
- `supabase/schema.sql`
- `lib/types.ts`
- `lib/server-data.ts`
- relevant route handlers under `app/api/`
- frontend consumers that render paper or annotation fields
- Python output contract if the new field originates from ingestion

## Verification
- `npm run typecheck`
- Any route or UI checks affected by the shape change
- Python tests too if the new field is emitted by the ingestion service
