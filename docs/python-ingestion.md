# Python Ingestion

## Purpose
- Explain the FastAPI service that turns an arXiv ID into extracted paper content, structured annotations, and summaries.

## When To Read This
- Read before changing extraction logic, annotation prompts, summary generation, model defaults, or reprocess progress behavior.

## Source Of Truth Code Areas
- `python_service/main.py`
- `python_service/requirements.txt`
- `lib/types.ts`
- `lib/server-data.ts`

## Pipeline Overview
- Resolve arXiv metadata and source URLs.
- Fetch the paper PDF.
- Extract text blocks and bounding boxes with PyMuPDF.
- Clean extracted text and split it into paragraph-scale chunks.
- Build stable page-level text sources and offsets from the extracted blocks before chunking so annotations can be anchored to a deterministic page text stream.
- Infer lightweight section hints from heading-like blocks when possible.
- Build a representative whole-paper brief from sampled chunks across the paper.
- Send chunks through OpenAI annotation generation prompts.
- Inject bounded live context into each chunk request:
  - representative paper brief
  - rolling in-memory annotation memory from earlier chunks
  - adjacent chunk snippets plus page and optional section metadata
- Maintain and compress the rolling memory deterministically in Python so prompt context stays concise without extra OpenAI calls.
- Repair malformed annotation output when needed.
- Deduplicate annotations across the full paper, then optionally run the LLM validation pathway before deterministic local cleanup.
- Resolve validated `text_ref` strings into deterministic page-text anchors, then back onto the PDF with PyMuPDF so stored bounding boxes are term- or phrase-level rather than chunk-level whenever possible.
- Generate a paper summary for the frontend summary card and stored `ai_summary`.
- Emit progress updates keyed by `jobId` so the Next.js app can poll status.
- On hosted multi-instance deployments, persist progress through shared Redis when `KV_REDIS_URL` is configured, or through shared KV REST when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are configured; local temp files remain a development fallback.

## Annotation Contract
- Types:
  - `highlight`: central claim, key result, major method detail, or major limitation
  - `note`: implication, assumption, caveat, comparison, or interpretation beyond paraphrase
  - `definition`: jargon, acronym, dataset, benchmark, or named method a technical reader may not know
- `text_ref` must be the shortest exact quote supporting the annotation.
- Definitions should usually quote only the term itself and stay under 8 words.
- Highlights and notes should usually stay under 15 words.
- Brevity matters because frontend overlays and duplicate detection work better with short exact references.
- Each returned annotation must remain consistent with page number and bounding box placement.
- Final annotations should also carry a deterministic text anchor for repeated-term disambiguation: page-text start, page-text end, and occurrence index on that page.
- Final stored `bbox` values should be refined from the exact surviving `text_ref` on that PDF page when search succeeds; chunk-level boxes are only a fallback.

## Model And Env Controls
- Defaults currently fall back to `gpt-4o-mini` for annotations and summaries unless env overrides are set.
- Key env knobs used here include:
  - `OPENAI_API_KEY`
  - `OPENAI_ANNOTATION_MODELS`
  - `OPENAI_SUMMARY_MODELS`
  - `OPENAI_ANNOTATION_TIMEOUT_SECONDS`
- The Next.js side also depends on `PYTHON_SERVICE_URL` and `PYTHON_INGEST_TIMEOUT_MS` when calling this service.

## Annotation Style
- `/ingest` and `/reprocess` accept an optional `annotation_style` field (`"default"` | `"novice"` | `"expert"`, defaults to `"default"`).
- The style is passed through `run_annotation_pipeline` → `annotate_chunks` → all prompt-building functions.
- `build_annotation_shared_rules(style)` selects the matching style block and injects it in place of the "Target reader" section. All other rules in `ANNOTATION_SHARED_RULES` are unchanged.
- `build_annotation_prompt`, `build_annotation_repair_prompt`, and `build_annotation_validation_prompt` are functions that call `build_annotation_shared_rules(style)` internally.
- The chosen style is returned in the `IngestResponse` as `annotationStyle` and stored in `papers.annotation_style`.
- See `docs/ai-contracts.md` for the full style semantics.

## Annotation Pathway
- `/ingest` and `/reprocess` also accept an optional `annotation_pathway` field (`"validated"` | `"direct"`, defaults to `"validated"`).
- `validated` preserves the current behavior: dedupe, run the LLM validation pass, then run deterministic local validation, text-anchor assignment, and bbox refinement.
- `direct` skips only the LLM validation pass. JSON repair, dedupe, deterministic local validation, text-anchor assignment, and bbox refinement still run.
- Pathway is a request-time control only. Unlike `annotation_style`, it is not returned in `IngestResponse` and is not stored in Supabase.

## Cross-Boundary Rules
- Python owns the ingest response contract, but TypeScript consumes it. Keep `IngestionPayload` in `lib/types.ts` synchronized with Python output.
- If annotation shape, page numbering, summary fields, or style fields change, update both Python and TypeScript in the same change.
- Keep prompt rules aligned with few-shot examples and validation logic in `python_service/main.py`.

## Common Change Patterns
- Annotation quality issue: inspect shared prompt rules, few-shot examples, repair flow, and validation flow before changing extraction.
- Late-paper context issue: inspect the annotation brief sampling, rolling-memory helpers, local context windowing, and memory compression path before increasing annotation count or model size.
- Annotation throughput issue: prefer tightening deterministic brief generation, rolling-memory caps, and local-context window sizes before adding new model-side context logic.
- Missing or bad highlights: prefer prompt/validation fixes before broadening annotation count.
- Style not applied correctly: confirm `annotation_style` is passed from the UI through the Python request body; confirm `build_annotation_shared_rules` is called in all three prompt-building functions; confirm style is threaded through `validate_annotations`.
- Pathway behaving incorrectly: confirm `annotation_pathway` is passed from the UI through the Python request body; confirm `annotate_chunks` only skips `validate_annotations` for the `direct` pathway and still runs local validation and bbox refinement.
- Reprocess behavior bug: inspect progress writing, `/api/ingest/progress`, and replacement semantics in `reprocessPaperAnnotations`.
- Summary changes: inspect both Python `/summarize` behavior and the `ensurePaperSummary` fallback path in TypeScript.

## Verification
- `python3 -m py_compile python_service/main.py`
- If the payload contract changed, also run `npm run typecheck`
