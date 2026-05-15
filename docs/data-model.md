# Data Model

## Purpose
- Summarize the stored data shape and the persistence invariants agents must preserve across schema and app changes.

## When To Read This
- Read before editing MongoDB models, S3 storage behavior, record shapes, library ownership logic, or any change that adds/removes persisted fields.

## Source Of Truth Code Areas
- `lib/models/` — Mongoose model definitions
- `lib/types.ts`
- `lib/server-data.ts`
- `lib/s3.ts`

## MongoDB Collections

### `papers`
- One document per ingested paper.
- Fields: `_id` (UUID string), `source` (`"arxiv"` | `"upload"`), `arxivId` (sparse, arxiv papers only), `originalFilename` (user-upload papers only), `storagePath`, `title`, `abstract`, `aiSummary`, `pdfUrl`, `pageCount`, `fullText`, `starterQuestions`, `annotationStyle` (`"default"` | `"novice"` | `"expert"`, default `"default"`), `annotations` (embedded array), `createdAt`, `updatedAt`.
- `annotationStyle` records which preset style was used to generate the current annotations; updated on each reprocess.
- Embedded `annotations` fields: `page_number`, `type`, `text_ref`, `note`, `importance`, `bbox` (normalized page-space rectangle, may include fragment rectangles), optional `anchor` (deterministic page-text offsets plus occurrence index).
- Index: `arxivId` sparse unique (arXiv papers only).

### `userpapers`
- Join collection linking authenticated users to papers in their private library.
- Fields: `_id`, `userId`, `paperId`, `createdAt`, `updatedAt`.
- Indexes: compound unique `(userId, paperId)`, secondary on `userId`.

### `chats`
- One document per paper, keyed by `paperId`.
- Fields: `_id`, `paperId` (unique), `messages`, `expiresAt`, `createdAt`.
- TTL index on `expiresAt` — MongoDB auto-deletes documents 24 hours after creation.

### `passwordresettokens`
- Fields: `_id`, `tokenHash` (unique), `userId`, `expiresAt`.
- TTL index on `expiresAt` — tokens expire 1 hour after creation (set at document creation time).

### NextAuth-managed collections
- `users` — `_id` UUID string, `email`, `passwordHash`, `emailVerified`, and other NextAuth standard fields.
- `accounts` — credentials provider link managed by NextAuth adapter.

## S3 Object Storage
- Bucket layout:
  - `arxiv/<arxivId>.pdf` — cached arXiv PDFs, shared across all users who added that paper.
  - `user-uploads/<userId>/<uploadId>.pdf` — private user-uploaded PDFs.
- `storagePath` on each paper document is the S3 key.
- The PDF API route generates an S3 presigned URL for authenticated access, with arXiv-direct fallback for uncached papers.

## Authorization Model
- There is no database-level row security. Authorization is enforced at the application layer.
- Every server-data function that returns paper or annotation data takes a `userId` and calls `UserPaper.exists({ userId, paperId })` before returning. This is the application-layer replacement for Supabase RLS.
- Library management is user-scoped through `userpapers`.

## Deduplication
- arXiv papers are global: one document per `arxivId`, shared across all users. A user adding an existing arXiv paper creates only a new `userpapers` document.
- User-uploaded papers are private: one document per upload. The document and its S3 object are deleted when the owner removes it from their library.

## Application Invariants
- A paper is globally deduplicated by `arxivId` (arXiv papers only).
- Annotations are page-scoped and rely on valid bounding boxes for overlay rendering. Stored boxes should be as close as possible to the final `text_ref`, and stored anchors should remain aligned with the page-level extracted text.
- Chat persistence is TTL-based. Absence of a chat document is a normal state, not an error.
- `aiSummary` is treated as optional; absence triggers a fallback summary path.
- `annotationStyle` defaults to `"default"` for all new documents; no migration of existing annotations is required when adding new styles.

## If You Change Data Shape, Also Inspect
- Relevant Mongoose model in `lib/models/`
- `lib/types.ts`
- `lib/server-data.ts`
- Relevant route handlers under `app/api/`
- Frontend consumers that render paper or annotation fields
- Python output contract if the new field originates from ingestion

## Verification
- `npm run typecheck`
- Any route or UI checks affected by the shape change
- Python checks if the new field is emitted by the ingestion service
