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

## Common Agent Habits For This Repo
- Start from a doc page, then inspect the exact code paths it names.
- Prefer modifying existing helpers over duplicating logic in new files.
- Treat missing KV or missing `ai_summary` support as expected fallback scenarios, not hard failures.
- Be careful when a change crosses frontend, server-data, schema, and Python at once; those are the easiest places for contract drift.

## Documentation Rule
- `AGENTS.md` is the map.
- `docs/` is the durable system of record.
- Keep pages concise, linked, and task-oriented rather than turning one file into a full handbook.
