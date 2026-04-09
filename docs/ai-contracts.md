# AI Contracts

## Purpose
- Centralize the model defaults, prompt boundaries, and structured-output expectations used across chat, summaries, and annotations.

## When To Read This
- Read before changing model names, prompt wording, output schemas, or the boundary between prompt-only tweaks and contract changes.

## Source Of Truth Code Areas
- `app/api/chat/route.ts`
- `python_service/main.py`
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
- Annotation generation now has two pathways:
  - `validated`: includes the post-generation LLM validation pass
  - `direct`: skips the LLM validation pass but keeps deterministic local cleanup

## Annotation Style Contract
- An `annotation_style` field (`"default"` | `"novice"` | `"expert"`) flows from the client through the Python request body and back in the response as `annotationStyle`.
- The style is persisted in the `papers.annotation_style` column and returned on `PaperRecord` as `annotationStyle` so the workspace can pre-populate the reprocess dropdown.
- Style injection replaces only the "Target reader" section of `ANNOTATION_SHARED_RULES`. All other shared rules (annotation types, text_ref rules, note writing rules, anti-noise rules) are style-invariant.
- Style blocks are defined as constants (`ANNOTATION_STYLE_DEFAULT`, `ANNOTATION_STYLE_NOVICE`, `ANNOTATION_STYLE_EXPERT`) and selected via `build_annotation_shared_rules(style)`.
- `ANNOTATION_PROMPT`, `ANNOTATION_REPAIR_PROMPT`, and `ANNOTATION_VALIDATION_PROMPT` are built via functions that accept the style parameter; pre-built default constants remain available for backward compat.
- Style is threaded through: endpoint → `run_annotation_pipeline` → `annotate_chunks` → `build_annotation_messages` / `validate_annotations` → `build_annotation_validation_messages`.
- **Default**: technically literate reader unfamiliar with the specific subfield. Balanced annotation density. Equivalent to the pre-style behavior.
- **Novice**: non-technical reader new to scientific writing. Define all technical terms including general vocabulary (embedding, gradient, baseline, etc.). Higher annotation density.
- **Expert**: active practitioner in the subfield. Focus on novelty discovery — novel methods, surprising results, field implications, prior-work comparisons, and non-obvious limitations. Skip definitions for standard subfield terminology. Lower annotation density.
- Adding a new style requires: new constant in `python_service/main.py`, entry in `ANNOTATION_STYLES` dict, enum update in `IngestRequest`/`ReprocessRequest`/`IngestResponse`, and matching update to the `AnnotationStyle` union in `lib/types.ts`, `lib/ingestion-schema.ts`, and both UI dropdowns.

## Annotation Pathway Contract
- An `annotation_pathway` field (`"validated"` | `"direct"`) flows from the client to Python on ingest and reprocess requests.
- `validated` runs the current full pipeline including the validation agent.
- `direct` skips only the validation agent. Deduplication, deterministic local validation, text anchors, bbox refinement, and response validation still apply.
- Pathway is not part of the persisted paper contract. It is not returned in `IngestResponse`, not stored on `papers`, and not exposed on `PaperRecord`.

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
  - `python3 -m py_compile python_service/main.py`
- Contract changes:
  - all Python checks above
  - `npm run typecheck`
  - `npm run lint`
