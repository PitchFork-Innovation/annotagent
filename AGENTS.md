# Annotagent Agent Guide

## Purpose
- Annotagent is an arXiv paper reading app with inline PDF annotations, per-user paper libraries, and a paper-aware chat panel.
- Treat this file as the fast entrypoint. Use the linked docs for subsystem detail instead of expanding this file into a long manual.

## Stack Snapshot
- Frontend: Next.js 15 App Router, React 19, TypeScript, Tailwind, `react-pdf`.
- Server layer: Next.js route handlers plus shared orchestration in `lib/server-data.ts`.
- Data: Supabase Postgres, Supabase Auth, Supabase Storage, optional KV REST chat persistence.
- Ingestion: FastAPI service in `python_service/` using PyMuPDF, OpenAI, and Pydantic validation.

## PRDs
- All PRDs must be created under the `prds/` folder.

## Repo Rules
- Preserve the current split:
  - route handlers validate/authenticate and delegate
  - `lib/server-data.ts` owns orchestration and cross-service data flow
  - `python_service/` owns PDF extraction, annotation generation, and summary generation
- Keep contracts synchronized across boundaries. If you change schema or payload shape, inspect `supabase/schema.sql`, `lib/types.ts`, `lib/ingestion-schema.ts`, `lib/server-data.ts`, route handlers, and Python models/prompts together.
- Annotation style (`"default"` | `"novice"` | `"expert"`) flows from UI → Python request body → `IngestResponse.annotationStyle` → `papers.annotation_style` → `PaperRecord.annotationStyle`. Any new style requires updates at every point in this chain plus the UI dropdowns.
- Prefer small coherent changes over broad rewrites. Follow existing naming and file placement before introducing new patterns.
- Maintain docs with the code. If behavior, architecture, or workflow expectations change, update the relevant page in `docs/` in the same change.

## Style And Workflow
- Inspect before editing. Start from the relevant guide below, then open the actual code paths it names.
- Keep client/server boundaries explicit. Avoid moving server logic into client components or duplicating orchestration in route handlers.
- Preserve UI invariants in the paper workspace: PDF overlay alignment, single annotation popup flow, collapsible inquiry panel, and server-loaded workspace shape.
- Preserve AI/data invariants: short exact `text_ref` values, validated annotation output, one paper per `arxiv_id`, and graceful fallback when optional KV persistence is unavailable.
- Verify with the narrowest useful checks for the subsystem you changed.

## Verification Defaults
- Frontend and route changes: `npm run lint` and `npm run typecheck`
- Python changes: `python3 -m py_compile python_service/main.py`
- Full-stack behavior changes: run the relevant frontend and Python checks together

## Task Guide
- UI, pages, reader behavior, chat panel UX:
  - `docs/frontend.md`
  - `docs/agent-playbooks.md#paper-workspace-ui`
- Route handlers, auth gates, orchestration, response shapes:
  - `docs/api-server-data.md`
  - `docs/architecture.md`
- Ingestion pipeline, annotation prompts, summary generation, progress reporting:
  - `docs/python-ingestion.md`
  - `docs/ai-contracts.md`
- Schema, storage, cached PDFs, data-shape changes:
  - `docs/data-model.md`
  - `docs/api-server-data.md`
- Model defaults, prompt contracts, output invariants:
  - `docs/ai-contracts.md`
- Local setup, verification, and expected agent workflow:
  - `docs/development-workflows.md`
- Need a concrete task recipe:
  - `docs/agent-playbooks.md`

## Docs Index
- `docs/architecture.md`: system map and end-to-end request flows
- `docs/frontend.md`: App Router and workspace UI structure
- `docs/api-server-data.md`: route handler and orchestration rules
- `docs/python-ingestion.md`: FastAPI ingestion pipeline and annotation contract
- `docs/data-model.md`: Supabase schema, storage, and persistence invariants
- `docs/ai-contracts.md`: model usage, prompts, and output contracts
- `docs/development-workflows.md`: execution and verification playbook
- `docs/agent-playbooks.md`: task-oriented lookup paths for common changes
