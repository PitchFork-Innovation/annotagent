# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Annotagent is an arXiv paper reading app with inline PDF annotations, per-user paper libraries, and a paper-aware chat panel. See `AGENTS.md` for the fast entry point and `docs/` for subsystem detail.

## Commands

```bash
# Frontend
npm run dev          # start Next.js dev server
npm run build        # production build
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit

# Python service
npm run python:dev                            # run FastAPI service via .venv
python3 -m py_compile python_service/main.py # syntax check only
```

## Architecture

**Three runtime layers:**

1. **Next.js App Router** (`app/`, `components/`) — server pages load data and pass shaped objects to client components. Route handlers stay thin: validate, auth-check, delegate.
2. **Server orchestration** (`lib/server-data.ts`) — owns all cross-service data flow: Supabase reads/writes, optional KV chat persistence, cached PDF access, calls to the Python service.
3. **Python ingestion service** (`python_service/main.py`) — FastAPI service that resolves arXiv metadata, fetches PDFs, extracts text/boxes with PyMuPDF, and generates annotations and summaries via OpenAI.

**Key contracts:**
- `lib/types.ts` — shared TypeScript types; `PaperWorkspace` is the main server-to-UI contract
- `lib/ingestion-schema.ts` — Zod validation of Python service payloads at the apply routes
- `supabase/schema.sql` — authoritative schema; papers deduplicated by `arxiv_id`, linked to users via `user_papers`
- Python Pydantic models in `python_service/main.py` — annotation output contract

**When a change crosses boundaries** (e.g., new field in annotations), update `supabase/schema.sql`, `lib/types.ts`, `lib/ingestion-schema.ts`, `lib/server-data.ts`, the relevant route handler, and Python models/prompts together.

## Verification Matrix

| Change type | Required checks |
|---|---|
| UI only | `npm run lint`, `npm run typecheck` |
| Route or server-data | `npm run lint`, `npm run typecheck` |
| Python ingestion/prompts | `python3 -m py_compile python_service/main.py` |
| Cross-boundary | all of the above |

## Docs Index

Start here before opening code files for subsystem work:

- `docs/architecture.md` — system map and end-to-end request flows
- `docs/frontend.md` — App Router and workspace UI structure
- `docs/api-server-data.md` — route handler and orchestration rules
- `docs/python-ingestion.md` — FastAPI ingestion pipeline and annotation contract
- `docs/data-model.md` — Supabase schema, storage, and persistence invariants
- `docs/ai-contracts.md` — model usage, prompts, and output contracts
- `docs/development-workflows.md` — execution and verification playbook
- `docs/agent-playbooks.md` — task-oriented lookup paths for common changes

## PRDs

All PRDs must be created under the `prds/` folder.
