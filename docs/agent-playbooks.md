# Agent Playbooks

## Purpose
- Convert common prompts into concrete lookup paths so a future agent can gather the right context quickly.

## When To Read This
- Read when you have a task prompt and need to know which docs and code areas to inspect first.

## Source Of Truth Code Areas
- This file plus the linked subsystem docs

## Paper Workspace UI
- Read first:
  - `docs/frontend.md`
  - `docs/architecture.md`
- Inspect next:
  - `app/paper/[paperId]/page.tsx`
  - `components/workspace/annotation-workspace.tsx`
  - `components/workspace/pdf-workspace.tsx`
- Preserve:
  - `PaperWorkspace` shape
  - overlay alignment
  - single-popup annotation flow
  - chat toggle behavior
  - current editorial visual language
- Verify:
  - `npm run lint`
  - `npm run typecheck`
  - manual workspace sanity check

## Modify Chat Behavior
- Read first:
  - `docs/frontend.md`
  - `docs/api-server-data.md`
  - `docs/ai-contracts.md`
- Inspect next:
  - `components/workspace/chat-panel.tsx`
  - `app/api/chat/route.ts`
  - `lib/kv.ts`
  - `lib/types.ts`
- Preserve:
  - paper-scoped context
  - streaming response behavior
  - optional KV persistence fallback
- Verify:
  - `npm run lint`
  - `npm run typecheck`

## Change Ingestion Or Annotation Logic
- Read first:
  - `docs/python-ingestion.md`
  - `docs/ai-contracts.md`
  - `docs/api-server-data.md`
- Inspect next:
  - `python_service/main.py`
  - `lib/server-data.ts`
  - `lib/types.ts`
- Preserve:
  - short exact `text_ref`
  - validated structured output
  - synchronized Python and TypeScript payload shape
  - reprocess compatibility
- Verify:
  - `python3 -m py_compile python_service/main.py`
  - `npm run typecheck` if contracts changed

## Update Schema Or Storage Behavior
- Read first:
  - `docs/data-model.md`
  - `docs/api-server-data.md`
  - `docs/architecture.md`
- Inspect next:
  - `supabase/schema.sql`
  - `supabase/storage.md`
  - `lib/server-data.ts`
  - `lib/types.ts`
  - affected route handlers or UI consumers
- Preserve:
  - one paper per `arxiv_id`
  - user library gating through `user_papers`
  - storage path expectations for cached PDFs
  - fallback behavior for optional or rolling-schema fields like `ai_summary`
- Verify:
  - `npm run typecheck`
  - relevant frontend or Python checks based on the changed field source

## Troubleshoot Auth Or Paper Loading
- Read first:
  - `docs/api-server-data.md`
  - `docs/data-model.md`
  - `docs/frontend.md`
- Inspect next:
  - `components/auth-panel.tsx`
  - `app/page.tsx`
  - `app/auth/*`
  - `app/api/ingest/route.ts`
  - `app/api/papers/[paperId]/route.ts`
  - `lib/supabase/*`
  - `lib/server-data.ts`
- Preserve:
  - auth-required ingestion
  - per-user library visibility
  - graceful empty-state behavior on the landing page
- Verify:
  - `npm run lint`
  - `npm run typecheck`

## Adjust Model Or Prompt Configuration
- Read first:
  - `docs/ai-contracts.md`
  - `docs/python-ingestion.md`
- Inspect next:
  - `app/api/chat/route.ts`
  - `python_service/main.py`
  - `.env.example`
  - `lib/env.ts`
- Preserve:
  - explicit model defaults
  - paper-bounded chat instructions
  - annotation output contract
- Verify:
  - Python tests for Python-side prompt changes
  - TypeScript checks if env or payload handling changed
