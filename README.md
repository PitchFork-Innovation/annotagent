# ArXiv Annotation Agent

[Live deployment](https://annotagent.vercel.app/)

## What is implemented

- Next.js App Router frontend with:
  - arXiv ID entry workflow
  - private library landing page
  - per-paper workspace
  - `react-pdf` viewer
  - overlayed hand-drawn SVG underlines for `highlight`, `note`, and `definition`
  - single-popover annotation interaction model
  - collapsible NotebookLM-style inquiry panel with streamed responses
- Python ingestion microservice with:
  - arXiv resolution by ID
  - PDF fetch
  - PyMuPDF text block and bbox extraction
  - paragraph-scale chunking
  - OpenAI-based annotation pass with Pydantic validation
- Supabase-oriented persistence:
  - paper records
  - annotation records
  - user paper library
  - storage caching for PDFs by arXiv ID
- KV-style session chat persistence with 24-hour TTL support

## Project structure

- [`app`](https://github.com/kokonut121/annotagent/blob/main/app): Next.js routes and API endpoints
- [`components`](https://github.com/kokonut121/annotagent/blob/main/components): viewer, workspace, and landing UI
- [`lib`](https://github.com/kokonut121/annotagent/blob/main/lib): environment config, Supabase/KV helpers, server data layer
- [`python_service`](https://github.com/kokonut121/annotagent/blob/main/python_service): FastAPI ingestion pipeline
- [`supabase/schema.sql`](https://github.com/kokonut121/annotagent/blob/main/supabase/schema.sql): database schema and RLS starter policies

## Environment

Copy [`.env.example`](https://github.com/kokonut121/annotagent/blob/main/.env.example) to `.env.local` and set:

- Supabase URL, anon key, and service role key
- OpenAI API key
- Python service URL
- KV REST endpoint/token if you want session chat persistence

## Local setup

Frontend:

```bash
nvm use
npm install
npm run dev
```

Python service:

```bash
python3 -m venv .venv
.venv/bin/pip install -r python_service/requirements.txt
.venv/bin/python python_service/main.py
```

Supabase:

1. Run [`supabase/schema.sql`](https://github.com/kokonut121/annotagent/blob/main/supabase/schema.sql).
2. Create a storage bucket named `papers`.
3. Enable Supabase Auth providers required by the PRD.

## Verification notes

- `python3 -m py_compile python_service/main.py` passes.
- Python service imports validate successfully.
- Frontend verification should be run on Node `20.x` to match the committed runtime contract used for local development and Vercel deployments.

## Important implementation note

The app now uses OpenAI model identifiers directly. By default it is configured for `gpt-4o-mini`, which keeps annotation and paper Q&A costs low while preserving the existing architecture.
