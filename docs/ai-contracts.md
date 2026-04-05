# AI Contracts

## Purpose
- Centralize the model defaults, prompt boundaries, and structured-output expectations used across chat, summaries, and annotations.

## When To Read This
- Read before changing model names, prompt wording, output schemas, or the boundary between prompt-only tweaks and contract changes.

## Source Of Truth Code Areas
- `app/api/chat/route.ts`
- `python_service/main.py`
- `python_service/tests/test_annotation_prompts.py`
- `lib/types.ts`
- `lib/server-data.ts`

## Current Model Usage
- Chat route defaults to `OPENAI_CHAT_MODEL ?? "gpt-4o-mini"`.
- Python annotation generation defaults to `gpt-4o-mini` unless `OPENAI_ANNOTATION_MODELS` overrides it.
- Python summary generation defaults to the same family unless `OPENAI_SUMMARY_MODELS` overrides it.

## Chat Contract
- Chat is scoped to a single paper and receives the paper full text as system context.
- The model is instructed to:
  - answer only from the paper context
  - say when the paper does not support a claim
  - stay crisp
  - cite sections or pages when available in the context
  - explain jargon clearly
- The route streams output and stores the completed transcript in KV after finish.

## Annotation Contract
- The Python service produces structured annotations with:
  - `type`
  - `text_ref`
  - `note`
  - `importance`
  - plus page, deterministic text-anchor, and precise `bbox` data in the final payload
- Shared prompt rules emphasize:
  - fewer stronger annotations
  - no filler
  - shortest exact quotes
  - concise notes that add interpretation rather than paraphrase
  - definition notes beginning with `<TERM>:`
- After validation, Python deterministically resolves each surviving `text_ref` into page-level offsets plus occurrence index, then maps that anchor back onto the PDF and stores a tighter fallback bbox (with optional fragment rects).
- Chunk annotation prompts now keep the same few-shot and system structure while adding bounded live context:
  - one representative whole-paper brief built locally from the abstract and sampled chunks
  - a rolling in-memory memory block built from earlier chunk outputs
  - small neighboring chunk snippets plus page and optional section hints
- The rolling memory is Python-process-local only, deterministically compressed, and is not persisted or exposed in the public payload contract.
- Repair and validation stages exist to recover malformed output and remove weak or duplicate annotations.

## Summary Contract
- Summary generation is Python-owned and should return concise text suitable for the “AI key points” card.
- TypeScript treats the summary as optional and falls back to abstract text when absent or when schema support is missing.

## Prompt-Only Vs Contract-Changing
- Prompt-only change:
  - adjusts wording, examples, ranking heuristics, or model choice
  - does not change returned fields or their semantics
  - usually requires Python tests and behavior review, not broad TypeScript edits
- Contract-changing change:
  - adds, removes, renames, or reinterprets fields
  - changes annotation/page/bbox semantics
  - changes chat request or response structure
  - requires synchronized updates in Python, TypeScript types, server-data, and UI consumers

## Verification
- Prompt or model changes in Python:
  - `.venv/bin/python -m unittest python_service.tests.test_annotation_prompts`
  - `python3 -m py_compile python_service/main.py`
- Contract changes:
  - all Python checks above
  - `npm run typecheck`
  - `npm run lint`
