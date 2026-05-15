# Development Workflows

## Purpose
- Give future agents a concise operating playbook for making safe, low-drift changes in this repo.

## When To Read This
- Read before starting implementation if you need a quick checklist for how to inspect, change, verify, and document work here.

## Source Of Truth Code Areas
- `README.md`
- `package.json`
- `python_service/README.md`
- `AGENTS.md`
- the subsystem-specific guide you are working from

## Default Execution Playbook
- Inspect before editing.
- Localize the subsystem before touching code.
- Preserve the current architecture and naming unless the task explicitly requires refactoring.
- Make the smallest coherent change that satisfies the task.
- Verify with the narrowest relevant checks first, then broaden only if the change crosses boundaries.
- Update the relevant docs page when behavior, architecture, or workflow expectations move.

## Local Commands
- Frontend dev: `npm run dev`
- Frontend lint: `npm run lint`
- Frontend typecheck: `npm run typecheck`
- Python service dev: `.venv/bin/python python_service/main.py`
- Python syntax sanity: `python3 -m py_compile python_service/main.py`

## Verification Matrix
- UI-only change:
  - `npm run lint`
  - `npm run typecheck`
  - manual reader or landing-page sanity check
- Route or server-data change:
  - `npm run lint`
  - `npm run typecheck`
  - include Python checks if the route talks to ingestion or summary endpoints
- Schema or persisted data change:
  - `npm run typecheck`
  - relevant frontend checks
  - relevant Python checks if ingest payloads or stored fields changed
- Ingestion, prompt, or summary change:
  - `python3 -m py_compile python_service/main.py`
  - `npm run typecheck` if the TypeScript side consumes changed data

## Environment Variables

**Required:**
- `MONGODB_URI` — MongoDB Atlas connection string (e.g. `mongodb+srv://...`)
- `NEXTAUTH_SECRET` — random 32+ byte string; generate with `openssl rand -base64 32`
- `NEXTAUTH_URL` — full URL of the deployment (e.g. `http://localhost:3000` for dev)
- `RESEND_API_KEY` — Resend API key
- `RESEND_FROM_EMAIL` — verified sender address in Resend
- `AWS_REGION` — S3 bucket region (e.g. `us-east-1`)
- `AWS_ACCESS_KEY_ID` — IAM credentials
- `AWS_SECRET_ACCESS_KEY` — IAM credentials
- `S3_BUCKET` — S3 bucket name
- `PYTHON_SERVICE_URL` — base URL of the running FastAPI ingestion service
- `PYTHON_SERVICE_SHARED_SECRET` — HMAC secret shared between Next.js and Python service
- `OPENAI_API_KEY` — OpenAI API key used by the Python service

**Removed (Supabase / Vercel KV era):**
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`

## Provisioning Checklist

1. **MongoDB Atlas** — create an M0 free cluster, get the connection string, and add your deployment's IP (or `0.0.0.0/0` for dev) to the IP allowlist. Set `MONGODB_URI`.
2. **AWS S3** — create a bucket, create an IAM user with `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on that bucket. Configure CORS to allow `PUT` from the app origin. Set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`.
3. **Resend** — obtain an API key and verify a sender domain or address. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`.
4. **NextAuth** — run `openssl rand -base64 32` and set the output as `NEXTAUTH_SECRET`. Set `NEXTAUTH_URL` to the deployment URL.

## Common Agent Habits For This Repo
- Start from a doc page, then inspect the exact code paths it names.
- Prefer modifying existing helpers over duplicating logic in new files.
- Treat a missing chat document in MongoDB as an expected fallback state, not an error. Missing `aiSummary` is also an expected fallback.
- Be careful when a change crosses frontend, server-data, schema, and Python at once; those are the easiest places for contract drift.

## Documentation Rule
- `AGENTS.md` is the map.
- `docs/` is the durable system of record.
- Keep pages concise, linked, and task-oriented rather than turning one file into a full handbook.
