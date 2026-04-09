# Annotagent

**AI-powered annotation engine for arXiv research papers.**

Annotagent automatically reads, analyzes, and annotates academic papers — generating precise inline highlights, contextual notes, and jargon definitions anchored directly to PDF coordinates. A built-in chat interface lets you interrogate any paper with full-text context, turning passive reading into active inquiry.

**[Live Deployment](https://annotagent.vercel.app/)**

---

## How It Works

1. **Enter an arXiv ID** — Annotagent resolves the paper, downloads the PDF, and extracts structured text blocks with bounding-box geometry via PyMuPDF.
2. **Chunked annotation pipeline** — The full text is split into overlapping paragraph-scale chunks and processed through a multi-stage LLM pipeline: generation with few-shot prompting, structural repair, cross-page validation, and bbox refinement against the original PDF layout.
3. **Anchored overlays** — Annotations are rendered as hand-drawn SVG underlines positioned with sub-page precision using text anchors resolved against extracted page content, not fragile absolute coordinates.
4. **Paper-aware chat** — Ask questions with the full paper text injected as context. Responses are streamed in real time with LaTeX math rendering and chat history persistence.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  Next.js 15 App Router (Vercel)                           │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ PDF Workspace│  │  Chat Panel  │  │  Auth / Library │  │
│  │ react-pdf +  │  │  Streaming   │  │  Supabase Auth  │  │
│  │ SVG overlays │  │  AI SDK      │  │  SSR client     │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                 │                   │           │
│  ┌──────┴─────────────────┴───────────────────┴─────────┐ │
│  │             Server Data Layer (lib/)                 │ │
│  │   Orchestration · PDF caching · Auth guards          │ │
│  └──────────────────────┬───────────────────────────────┘ │
└─────────────────────────┼─────────────────────────────────┘
                          │
              ┌───────────┴──────────────┐
              │  FastAPI Python Service  │
              │  arXiv fetch · PyMuPDF   │
              │  LLM annotation pipeline │
              │  Pydantic validation     │
              └───────────┬──────────────┘
                          │
              ┌───────────┴────────────┐
              │   Supabase (Postgres)  │
              │  Papers · Annotations  │
              │  User libraries · RLS  │
              │  PDF storage bucket    │
              └────────────────────────┘
```

## Key Features

- **Multi-stage annotation pipeline** — Few-shot generation, LLM-based repair of malformed outputs, cross-page validation with page-source grounding, and PDF-native bbox refinement using text search against the rendered document.
- **Annotation style presets** — Choose between Default, Novice (non-technical reader; defines all jargon and general technical terms, higher density), and Expert (active practitioner; focuses on novelty discovery, field implications, and prior-work comparisons, lower density) before ingesting or reprocessing a paper.
- **Rolling memory system** — The annotation pipeline maintains a compact memory of paper state, defined terms, covered topics, and recent annotations across chunks to ensure coherence and avoid redundancy over long papers.
- **Text anchor resolution** — Annotations are anchored to exact character offsets within page text, enabling precise positioning even when the same term appears multiple times on a page.
- **Deterministic paper briefs** — Before annotation begins, the pipeline samples early, middle, and late chunks to build a structural brief that guides annotation quality across the full document.
- **Per-user paper libraries** — Authenticated users maintain private libraries with row-level security enforced at the database layer.
- **Streamed chat with math rendering** — Paper Q&A uses the Vercel AI SDK with OpenAI streaming, rendered with React Markdown, remark-math, and KaTeX.
- **PDF caching** — Papers are cached to Supabase Storage on first ingest, with signed-URL fallback for reprocessing, eliminating repeated arXiv downloads.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind CSS, Zustand, TanStack Query |
| PDF Rendering | react-pdf with custom SVG annotation overlays |
| Chat | Vercel AI SDK, OpenAI streaming, KaTeX math rendering |
| Ingestion Service | FastAPI, PyMuPDF, LangChain text splitters, OpenAI |
| Database | Supabase (PostgreSQL with RLS), Supabase Storage |
| Auth | Supabase Auth (email/password, OAuth) |
| Deployment | Vercel (frontend), configurable Python service host |

## Getting Started

### Prerequisites

- Node.js 20.x
- Python 3.10+
- A Supabase project
- An OpenAI API key

### Environment Setup

Copy `.env.example` to `.env.local` and configure:

```bash
cp .env.example .env.local
```

Required variables:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `OPENAI_API_KEY` | OpenAI API key |
| `PYTHON_SERVICE_URL` | URL of the FastAPI ingestion service |
| `KV_REDIS_URL` | *(Optional)* Direct Redis connection URL for shared ingest progress on the Python service |
| `KV_REST_API_URL` | *(Optional)* Vercel KV endpoint for chat persistence and shared ingest progress |
| `KV_REST_API_TOKEN` | *(Optional)* Vercel KV token shared by Vercel and the Python service |
| `PROGRESS_TTL_SECONDS` | *(Optional)* TTL for stored ingest progress updates |

### Frontend

```bash
npm install
npm run dev
```

### Python Ingestion Service

```bash
python3 -m venv .venv
.venv/bin/pip install -r python_service/requirements.txt
.venv/bin/python python_service/main.py
```

### Database

1. Run `supabase/schema.sql` against your Supabase project to create tables, indexes, and RLS policies.
2. Create a storage bucket named `papers` in Supabase Storage.
3. Enable your preferred Supabase Auth providers.

## Project Structure

```
app/                    Next.js routes and API endpoints
  api/
    chat/               Paper Q&A streaming endpoint
    ingest/             Paper ingestion trigger + progress polling
    papers/[paperId]/   Workspace data, PDF proxy, reprocessing
  auth/                 OAuth callback and sign-out
  paper/[paperId]/      Paper workspace page
  reset-password/       Password reset flow

components/             React components
  workspace/            PDF viewer, annotation overlays, chat panel
  auth-panel.tsx        Authentication UI
  landing-shell.tsx     Home page with library and search
  providers.tsx         React Query + context providers
  rich-text.tsx         Markdown/math rendering

lib/                    Shared utilities
  server-data.ts        Core orchestration layer
  env.ts                Zod-validated environment config
  types.ts              TypeScript type definitions
  annotations.ts        Annotation processing helpers
  kv.ts                 KV cache wrapper for chat history
  utils.ts              General utilities
  supabase/             Server, admin, and browser Supabase clients

python_service/         FastAPI ingestion pipeline
  main.py               arXiv resolution, PDF extraction, LLM annotation

supabase/
  schema.sql            Database schema with RLS policies

docs/                   Architecture and development documentation
```

## License

MIT 
