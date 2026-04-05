from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Literal

import arxiv
import fitz
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langchain_text_splitters import RecursiveCharacterTextSplitter
from openai import NotFoundError, OpenAI
from pydantic import BaseModel, Field


ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env.local")
load_dotenv(ROOT_DIR / ".env")

if not logging.getLogger().handlers:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

logger = logging.getLogger("annotagent.python_service")

DEFAULT_ANNOTATION_MODELS = "gpt-4o-mini"
ANNOTATION_MODELS = [
    model.strip()
    for model in os.getenv("OPENAI_ANNOTATION_MODELS", DEFAULT_ANNOTATION_MODELS).split(",")
    if model.strip()
]
DEFAULT_SUMMARY_MODELS = DEFAULT_ANNOTATION_MODELS
SUMMARY_MODELS = [
    model.strip()
    for model in os.getenv("OPENAI_SUMMARY_MODELS", DEFAULT_SUMMARY_MODELS).split(",")
    if model.strip()
]
ANNOTATION_REQUEST_TIMEOUT = float(os.getenv("OPENAI_ANNOTATION_TIMEOUT_SECONDS", "45"))
ARXIV_METADATA_DELAY_SECONDS = float(os.getenv("ARXIV_METADATA_DELAY_SECONDS", "3.0"))
ARXIV_METADATA_RETRIES = int(os.getenv("ARXIV_METADATA_RETRIES", "6"))
ARXIV_METADATA_BACKOFF_SECONDS = float(os.getenv("ARXIV_METADATA_BACKOFF_SECONDS", "5.0"))
ANNOTATION_BRIEF_SAMPLE_COUNT = int(os.getenv("ANNOTATION_BRIEF_SAMPLE_COUNT", "7"))
ANNOTATION_BRIEF_SAMPLE_CHAR_LIMIT = int(os.getenv("ANNOTATION_BRIEF_SAMPLE_CHAR_LIMIT", "360"))
ANNOTATION_BRIEF_MAX_BULLETS = int(os.getenv("ANNOTATION_BRIEF_MAX_BULLETS", "4"))
ANNOTATION_DETERMINISTIC_BRIEF = os.getenv("ANNOTATION_DETERMINISTIC_BRIEF", "1") != "0"
ROLLING_MEMORY_CHAR_BUDGET = int(os.getenv("ROLLING_MEMORY_CHAR_BUDGET", "1400"))
LOCAL_CONTEXT_CHAR_WINDOW = int(os.getenv("LOCAL_CONTEXT_CHAR_WINDOW", "180"))
PAPER_STATE_LIMIT = int(os.getenv("ROLLING_MEMORY_PAPER_STATE_LIMIT", "4"))
DEFINED_TERMS_LIMIT = int(os.getenv("ROLLING_MEMORY_DEFINED_TERMS_LIMIT", "12"))
COVERED_TOPICS_LIMIT = int(os.getenv("ROLLING_MEMORY_COVERED_TOPICS_LIMIT", "12"))
RECENT_ANNOTATIONS_LIMIT = int(os.getenv("ROLLING_MEMORY_RECENT_ANNOTATIONS_LIMIT", "5"))
BLOCKED_TEXT_REFS_LIMIT = 24
CHUNK_SIZE = 1400
CHUNK_OVERLAP = 120

ANNOTATION_SCHEMA = (
    '{ "type": "highlight" | "note" | "definition", "text_ref": string, '
    '"note": string, "importance": 1 | 2 | 3 }'
)
ANNOTATION_VALIDATION_SCHEMA = (
    '{ "type": "highlight" | "note" | "definition", "text_ref": string, '
    '"note": string, "importance": 1 | 2 | 3, "page_number": int }'
)
ANNOTATION_SHARED_RULES = """
Target reader:
- technically literate and comfortable with scientific writing
- not guaranteed to know this exact subfield's jargon, datasets, or named methods

Core goal:
- produce only high-value annotations that materially improve understanding
- prefer fewer, stronger annotations over many weak ones
- it is better to miss a weak annotation than include filler

Annotation types:
- highlight: central claim, main contribution, key result, important method detail, or major limitation
- note: non-obvious implication, assumption, caveat, comparison, or interpretation that adds insight beyond paraphrase
- definition: specialized jargon, acronym, benchmark, dataset, or named method a technical non-expert may not know

text_ref rules:
- text_ref must be the SHORTEST EXACT QUOTE from the passage that supports the annotation
- definition text_ref must be only the exact term being defined and under 8 words
- note and highlight text_ref should be under 15 words unless absolutely necessary
- do not quote whole sentences if a shorter phrase works
- do not include surrounding clauses unless needed

Note writing rules:
- be concise, specific, and informative
- add significance, implication, assumption, comparison, or role in the paper
- do not merely paraphrase the quoted text
- definition notes must begin with the exact term from text_ref in the form "<TERM>: <brief explanation>"
- highlight notes should explain why the claim or result matters, DO NOT JUST DESCRIBE EFFECTIVENESS WITHOUT SPECIFIC CONTEXT

Anti-noise rules:
- do not annotate every sentence
- do not define common terms like optimization, baseline, embedding, or classifier unless used in a highly specialized way
- do not annotate generic framing, citations, or section transitions unless they contain a substantive claim
- do not emit duplicate annotations or multiple annotations with the same normalized text_ref
- return [] if the passage contains little worth annotating
""".strip()

ANNOTATION_FEWSHOT_EXAMPLES = [
    {
        "passage": "Our method reduces inference latency by 43% compared to prior approaches while maintaining accuracy.",
        "output": [
            {
                "type": "highlight",
                "text_ref": "reduces inference latency by 43%",
                "note": "Moves the Pareto frontier of latency vs accuracy, indicating a genuine algorithmic or architectural improvement rather than a simple engineering optimization.",
                "importance": 3,
            }
        ],
    },
    {
        "passage": "Under a fixed compute budget, our model outperforms all baselines.",
        "output": [
            {
                "type": "note",
                "text_ref": "fixed compute budget",
                "note": "The new architecture prescribes a method to outperform state-of-the-art models without increasing cost.",
                "importance": 2,
            }
        ],
    },
    {
        "passage": "We approximate attention using the Nystrom approximation to reduce complexity.",
        "output": [
            {
                "type": "definition",
                "text_ref": "Nystrom approximation",
                "note": "Nystrom approximation: a technique that approximates a large matrix using a smaller subset of samples to reduce computation.",
                "importance": 2,
            }
        ],
    },
    {
        "passage": (
            "We introduce a retrieval-augmented training objective that improves generalization. "
            "Under a fixed compute budget, it outperforms prior baselines by 3.1 BLEU on long-form translation."
        ),
        "output": [
            {
                "type": "highlight",
                "text_ref": "retrieval-augmented training objective",
                "note": "This names the paper's main methodological contribution, which is the basis for the downstream gains.",
                "importance": 3,
            },
            {
                "type": "note",
                "text_ref": "fixed compute budget",
                "note": "This comparison is more convincing because the improvement is not coming from extra compute.",
                "importance": 2,
            },
            {
                "type": "definition",
                "text_ref": "BLEU",
                "note": "BLEU: a machine translation metric based on n-gram overlap with reference translations.",
                "importance": 1,
            },
        ],
    },
    {
        "passage": (
            "Section 2 reviews related work on sequence modeling. "
            "We follow standard notation and defer implementation details to the appendix."
        ),
        "output": [],
    },
]

ANNOTATION_REPAIR_FEWSHOT_EXAMPLES = [
    {
        "source_text": "We evaluate performance using BLEU and ROUGE metrics.",
        "broken_output": """[
  {
    "type": "definition",
    "text_ref": "performance using BLEU and ROUGE metrics",
    "note": "A metric for evaluating generated text based on overlap with references.",
    "importance": 1
  }
]""",
        "output": [
            {
                "type": "definition",
                "text_ref": "BLEU",
                "note": "BLEU: a metric for evaluating generated text using n-gram overlap with reference text.",
                "importance": 1,
            }
        ],
    },
    {
        "source_text": "Under a fixed compute budget, our model outperforms all baselines.",
        "broken_output": """Here are the annotations:
[
  {
    "type": "note",
    "text_ref": "Under a fixed compute budget, our model outperforms all baselines.",
    "note": "This means the model does better.",
    "importance": 2
  },
  {
    "type": "note",
    "text_ref": "fixed compute budget",
    "note": "This makes the comparison fair because the gains are not from spending more compute.",
    "importance": 2
  }
]""",
        "output": [
            {
                "type": "note",
                "text_ref": "fixed compute budget",
                "note": "This makes the comparison fair because the gains are not from spending more compute than the baselines.",
                "importance": 2,
            }
        ],
    },
]

ANNOTATION_VALIDATION_FEWSHOT_EXAMPLES = [
    {
        "page_sources": {
            3: "Our method reduces inference latency by 43% compared to prior approaches while maintaining accuracy."
        },
        "annotations": [
            {
                "type": "highlight",
                "text_ref": "Our method reduces inference latency by 43% compared to prior approaches",
                "note": "This is a strong efficiency result.",
                "importance": 3,
                "page_number": 3,
            },
            {
                "type": "highlight",
                "text_ref": "reduces inference latency by 43%",
                "note": "This is the core speedup claim.",
                "importance": 3,
                "page_number": 3,
            },
        ],
        "output": [
            {
                "type": "highlight",
                "text_ref": "reduces inference latency by 43%",
                "note": "This is the core quantitative efficiency result, so it is the most important claim to keep.",
                "importance": 3,
                "page_number": 3,
            }
        ],
    },
    {
        "page_sources": {
            5: "We approximate attention using the Nystrom approximation to reduce complexity."
        },
        "annotations": [
            {
                "type": "definition",
                "text_ref": "approximate attention using the Nystrom approximation",
                "note": "A method for making attention cheaper.",
                "importance": 2,
                "page_number": 5,
            },
            {
                "type": "note",
                "text_ref": "spectral bias",
                "note": "This is important background.",
                "importance": 1,
                "page_number": 5,
            },
        ],
        "output": [
            {
                "type": "definition",
                "text_ref": "Nystrom approximation",
                "note": "Nystrom approximation: a technique for approximating a large matrix from a smaller subset so attention is cheaper to compute.",
                "importance": 2,
                "page_number": 5,
            }
        ],
    },
]

ANNOTATION_PROMPT = f"""
You are an expert research paper annotator.

Return ONLY a JSON array that exactly matches this schema:
{ANNOTATION_SCHEMA}

Follow the shared rules below and emulate the few-shot examples as closely as possible.

{ANNOTATION_SHARED_RULES}

Final requirements:
- every text_ref must be an exact substring from the passage
- every text_ref must be minimal and precise
- no markdown, no prose, no explanation outside the JSON array
""".strip()

ANNOTATION_REPAIR_PROMPT = f"""
You repair annotation outputs into valid JSON arrays for the annotation task.

Return ONLY a JSON array that exactly matches this schema:
{ANNOTATION_SCHEMA}

Follow the same annotation behavior and style as the few-shot examples.

Additional repair requirements:
- remove any prose, markdown fences, or commentary
- rewrite or delete invalid annotations rather than preserving bad structure
- if type is definition, text_ref must be only the exact term being defined and the note must begin with that term
- if two annotations reuse the same normalized text_ref, keep the stronger one
- prefer deleting a weak annotation over keeping filler
""".strip()

ANNOTATION_VALIDATION_PROMPT = f"""
You are an annotation validation agent.

Return ONLY a corrected JSON array that exactly matches this schema:
{ANNOTATION_VALIDATION_SCHEMA}

You may shorten, rewrite, deduplicate, or delete annotations.
Follow the shared rules below and emulate the few-shot examples as closely as possible.

{ANNOTATION_SHARED_RULES}

Validation requirements:
- every text_ref must be an exact substring of the provided page excerpt for that page_number
- preserve the original meaning when possible, but prioritize rule compliance
- do not invent facts not grounded in the source excerpt
- if an annotation cannot be made valid while staying useful, delete it
""".strip()

def dump_prompt_json(value: object) -> str:
    return json.dumps(sanitize_prompt_value(value), ensure_ascii=True, indent=2)


def build_annotation_request_content(
    passage: str,
    *,
    paper_brief: str | None = None,
    rolling_memory: str | None = None,
    local_context: str | None = None,
    page_number: int | None = None,
    section_hint: str | None = None,
) -> str:
    sanitized_passage = sanitize_prompt_text(passage)
    if not any([paper_brief, rolling_memory, local_context, page_number is not None, section_hint]):
        return (
            "Annotate the following academic passage.\n"
            "Return only a JSON array matching the required schema.\n\n"
            f"Passage:\n{sanitized_passage}"
        )

    sections = [
        "Annotate the following academic passage.\nReturn only a JSON array matching the required schema."
    ]
    if paper_brief:
        sections.append(f"Paper brief:\n{sanitize_prompt_text(paper_brief)}")
    if rolling_memory:
        sections.append(f"Rolling memory:\n{sanitize_prompt_text(rolling_memory)}")

    context_parts: list[str] = []
    if page_number is not None:
        context_parts.append(f"Page: {page_number}")
    if section_hint:
        context_parts.append(f"Section hint: {sanitize_prompt_text(section_hint)}")
    if local_context:
        context_parts.append(sanitize_prompt_text(local_context))
    if context_parts:
        sections.append(f"Local context:\n" + "\n\n".join(context_parts))

    sections.append(f"Passage:\n{sanitized_passage}")
    return "\n\n".join(sections)


def build_annotation_messages(
    passage: str,
    *,
    paper_brief: str | None = None,
    rolling_memory: str | None = None,
    local_context: str | None = None,
    page_number: int | None = None,
    section_hint: str | None = None,
) -> list[dict[str, str]]:
    messages = [{"role": "system", "content": ANNOTATION_PROMPT}]
    for example in ANNOTATION_FEWSHOT_EXAMPLES:
        messages.append({"role": "user", "content": build_annotation_request_content(example["passage"])})
        messages.append({"role": "assistant", "content": dump_prompt_json(example["output"])})

    messages.append(
        {
            "role": "user",
            "content": build_annotation_request_content(
                passage,
                paper_brief=paper_brief,
                rolling_memory=rolling_memory,
                local_context=local_context,
                page_number=page_number,
                section_hint=section_hint,
            ),
        }
    )
    return messages


def build_repair_request_content(source_text: str, bad_output: str) -> str:
    return (
        "Original passage:\n"
        f"{sanitize_prompt_text(source_text)[:2000]}\n\n"
        "Broken annotation output:\n"
        f"{sanitize_prompt_text(bad_output or '[empty response]')}"
    )


def build_annotation_repair_messages(source_text: str, bad_output: str) -> list[dict[str, str]]:
    messages = [{"role": "system", "content": ANNOTATION_REPAIR_PROMPT}]
    for example in ANNOTATION_REPAIR_FEWSHOT_EXAMPLES:
        messages.append(
            {
                "role": "user",
                "content": build_repair_request_content(example["source_text"], example["broken_output"]),
            }
        )
        messages.append({"role": "assistant", "content": dump_prompt_json(example["output"])})

    messages.append({"role": "user", "content": build_repair_request_content(source_text, bad_output)})
    return messages


def build_validation_request_content(page_sources: dict[int, str], annotations: list[dict[str, object]]) -> str:
    return (
        "Page source excerpts by page number:\n"
        f"{dump_prompt_json(page_sources)}\n\n"
        "Annotations to validate:\n"
        f"{dump_prompt_json(annotations)}"
    )


def build_annotation_validation_messages(
    page_sources: dict[int, str],
    annotations: list[dict[str, object]],
) -> list[dict[str, str]]:
    messages = [{"role": "system", "content": ANNOTATION_VALIDATION_PROMPT}]
    for example in ANNOTATION_VALIDATION_FEWSHOT_EXAMPLES:
        messages.append(
            {
                "role": "user",
                "content": build_validation_request_content(example["page_sources"], example["annotations"]),
            }
        )
        messages.append({"role": "assistant", "content": dump_prompt_json(example["output"])})

    messages.append({"role": "user", "content": build_validation_request_content(page_sources, annotations)})
    return messages


SUMMARY_PROMPT = """
You are an expert research assistant summarizing an academic paper for a technically literate reader.

Write exactly 3 concise markdown bullet points that capture:
- the paper's main contribution or thesis
- the key method or mechanism
- the most important result, implication, or limitation

Rules:
- Return ONLY the bullet list. No heading, no intro sentence, no code fences.
- Each bullet should be 1 sentence.
- Keep the bullets specific and concrete.
- You may use inline or block LaTeX when it clarifies math.
- Prefer the paper's core ideas over implementation trivia.
"""


class IngestRequest(BaseModel):
    arxiv_id: str = Field(min_length=4)
    job_id: str | None = None


class ReprocessRequest(BaseModel):
    arxiv_id: str = Field(min_length=4)
    title: str = Field(min_length=1)
    abstract: str = ""
    pdf_url: str = Field(min_length=1)
    job_id: str | None = None


class SummaryRequest(BaseModel):
    title: str = Field(min_length=1)
    abstract: str = Field(min_length=1)
    fullText: str = Field(min_length=1)


class HighlightFragment(BaseModel):
    x: float
    y: float
    width: float
    height: float


class BoundingBox(HighlightFragment):
    fragments: list[HighlightFragment] = Field(default_factory=list)


class TextAnchor(BaseModel):
    page_text_start: int
    page_text_end: int
    occurrence_index: int


class Annotation(BaseModel):
    type: Literal["highlight", "note", "definition"]
    text_ref: str
    note: str
    importance: Literal[1, 2, 3]
    bbox: BoundingBox
    page_number: int
    anchor: TextAnchor | None = None


class MemoryListItem(BaseModel):
    text: str
    importance: Literal[1, 2, 3]
    order: int = 0


class MemoryRecentAnnotation(BaseModel):
    type: Literal["highlight", "note", "definition"]
    text_ref: str
    note: str
    importance: Literal[1, 2, 3]
    page_number: int
    order: int = 0


class RollingMemoryState(BaseModel):
    paper_state: list[MemoryListItem] = Field(default_factory=list)
    defined_terms: list[str] = Field(default_factory=list)
    covered_topics: list[MemoryListItem] = Field(default_factory=list)
    recent_annotations: list[MemoryRecentAnnotation] = Field(default_factory=list)
    blocked_text_refs: list[str] = Field(default_factory=list)


class IngestResponse(BaseModel):
    arxivId: str
    title: str
    abstract: str
    summary: str
    pdfUrl: str
    fullText: str
    pageCount: int
    starterQuestions: list[str]
    annotations: list[Annotation]


class SummaryResponse(BaseModel):
    summary: str


app = FastAPI(title="ArXiv Annotation Agent Python Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/summarize", response_model=SummaryResponse)
def summarize(request: SummaryRequest) -> SummaryResponse:
    summary = summarize_paper(request.title, request.abstract, request.fullText)
    return SummaryResponse(summary=summary)


@app.post("/ingest", response_model=IngestResponse)
async def ingest(request: IngestRequest) -> IngestResponse:
    normalized_arxiv_id = normalize_arxiv_id(request.arxiv_id)
    write_progress(request.job_id, {"status": "running", "stage": "resolving", "message": "Resolving arXiv metadata..."})
    logger.info("Starting ingest for arXiv ID %s", normalized_arxiv_id)
    logger.info("Trying annotation models %s", ", ".join(ANNOTATION_MODELS))

    logger.info("Resolving arXiv paper metadata for %s", normalized_arxiv_id)
    paper = resolve_arxiv_paper(normalized_arxiv_id)

    return await run_annotation_pipeline(
        arxiv_id=normalized_arxiv_id,
        title=paper.title,
        abstract=paper.summary,
        pdf_url=paper.pdf_url,
        job_id=request.job_id,
        pdf_progress_message="Fetching PDF from arXiv...",
        pdf_source_label="arXiv",
    )


@app.post("/reprocess", response_model=IngestResponse)
async def reprocess(request: ReprocessRequest) -> IngestResponse:
    normalized_arxiv_id = normalize_arxiv_id(request.arxiv_id)
    logger.info("Starting annotation reprocess for arXiv ID %s", normalized_arxiv_id)

    return await run_annotation_pipeline(
        arxiv_id=normalized_arxiv_id,
        title=request.title,
        abstract=request.abstract,
        pdf_url=request.pdf_url,
        job_id=request.job_id,
        pdf_progress_message="Fetching cached PDF...",
        pdf_source_label="cached storage",
    )


def normalize_arxiv_id(arxiv_id: str) -> str:
    candidate = arxiv_id.strip()
    candidate = re.sub(r"^https?://(?:www\.|export\.)?arxiv\.org/", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"^(abs|pdf)/", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"[?#].*$", "", candidate)
    candidate = candidate.strip("/")
    candidate = re.sub(r"\.pdf$", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"^arxiv:", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"v\d+$", "", candidate, flags=re.IGNORECASE)
    return candidate


def resolve_arxiv_paper(arxiv_id: str):
    client = arxiv.Client(
        page_size=1,
        delay_seconds=ARXIV_METADATA_DELAY_SECONDS,
        num_retries=1,
    )
    search = arxiv.Search(id_list=[arxiv_id], max_results=1)
    last_rate_limit_error: arxiv.HTTPError | None = None

    for attempt in range(1, ARXIV_METADATA_RETRIES + 1):
        try:
            results = list(client.results(search))
            if not results:
                raise HTTPException(status_code=404, detail="arXiv paper not found")
            return results[0]
        except arxiv.HTTPError as error:
            if not is_arxiv_rate_limit_error(error):
                raise

            last_rate_limit_error = error
            if attempt == ARXIV_METADATA_RETRIES:
                break

            sleep_seconds = ARXIV_METADATA_BACKOFF_SECONDS * attempt
            logger.warning(
                "arXiv metadata lookup hit HTTP 429 for %s on attempt %s/%s; retrying in %.1fs",
                arxiv_id,
                attempt,
                ARXIV_METADATA_RETRIES,
                sleep_seconds,
            )
            time.sleep(sleep_seconds)

    logger.error(
        "arXiv metadata lookup exhausted retries for %s after repeated HTTP 429 responses: %s",
        arxiv_id,
        last_rate_limit_error,
    )
    raise HTTPException(
        status_code=503,
        detail="arXiv rate limited the metadata lookup. Please wait a minute and try again.",
    )


def is_arxiv_rate_limit_error(error: arxiv.HTTPError) -> bool:
    return "HTTP 429" in str(error)


async def fetch_pdf_bytes(pdf_url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        response = await client.get(pdf_url)
        response.raise_for_status()
        return response.content


async def run_annotation_pipeline(
    *,
    arxiv_id: str,
    title: str,
    abstract: str,
    pdf_url: str,
    job_id: str | None,
    pdf_progress_message: str,
    pdf_source_label: str,
) -> IngestResponse:
    write_progress(job_id, {"status": "running", "stage": "fetching_pdf", "message": pdf_progress_message})
    logger.info("Fetching PDF bytes from %s for %s", pdf_source_label, arxiv_id)
    pdf_bytes = await fetch_pdf_bytes(pdf_url)

    write_progress(job_id, {"status": "running", "stage": "opening_pdf", "message": "Opening PDF for text extraction..."})
    logger.info("Opening PDF with PyMuPDF for %s", arxiv_id)
    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    write_progress(job_id, {"status": "running", "stage": "extracting_blocks", "message": "Extracting text blocks from PDF..."})
    logger.info("Extracting text blocks for %s", arxiv_id)
    blocks = extract_blocks(pdf_doc)
    full_text = "\n\n".join(block["text"] for block in blocks)

    write_progress(job_id, {"status": "running", "stage": "summarizing", "message": "Generating AI key points..."})
    logger.info("Generating paper summary for %s", arxiv_id)
    summary = summarize_paper(title, abstract, full_text)

    write_progress(job_id, {"status": "running", "stage": "chunking", "message": "Chunking extracted text..."})
    logger.info("Chunking extracted text for %s", arxiv_id)
    chunks = chunk_blocks(blocks)
    page_sources = build_page_sources(blocks)
    logger.info(
        "Extracted %s blocks and %s chunks for %s",
        len(blocks),
        len(chunks),
        arxiv_id,
    )
    write_progress(
        job_id,
        {
            "status": "running",
            "stage": "annotating",
            "message": "Generating annotations with OpenAI...",
            "currentChunk": 0,
            "totalChunks": len(chunks),
        },
    )
    annotations = annotate_chunks(chunks, blocks, page_sources, pdf_doc, title=title, abstract=abstract, job_id=job_id)
    logger.info("Produced %s annotations for %s", len(annotations), arxiv_id)
    write_progress(
        job_id,
        {
            "status": "completed",
            "stage": "completed",
            "message": "Annotation generation complete.",
            "currentChunk": len(chunks),
            "totalChunks": len(chunks),
        },
    )

    return IngestResponse(
        arxivId=arxiv_id,
        title=title,
        abstract=abstract,
        summary=summary,
        pdfUrl=pdf_url,
        fullText=full_text,
        pageCount=pdf_doc.page_count,
        starterQuestions=build_starter_questions(title),
        annotations=annotations,
    )


def extract_blocks(pdf_doc: fitz.Document) -> list[dict]:
    blocks: list[dict] = []
    current_section_hint: str | None = None
    for page_index in range(pdf_doc.page_count):
        page = pdf_doc.load_page(page_index)
        page_rect = page.rect
        page_text_offset = 0
        for block in page.get_text("blocks"):
            x0, y0, x1, y1, text, *_ = block
            cleaned = " ".join(sanitize_extracted_text(text or "").split())
            if not cleaned:
                continue
            if should_skip_block(cleaned):
                continue
            inferred_section_hint = infer_section_hint(cleaned)
            if inferred_section_hint:
                current_section_hint = inferred_section_hint

            if page_text_offset:
                page_text_offset += 1

            page_text_start = page_text_offset
            page_text_end = page_text_start + len(cleaned)
            blocks.append(
                {
                    "page_number": page_index + 1,
                    "text": cleaned,
                    "section_hint": current_section_hint,
                    "page_text_start": page_text_start,
                    "page_text_end": page_text_end,
                    "bbox": {
                        "x": x0 / page_rect.width,
                        "y": y0 / page_rect.height,
                        "width": (x1 - x0) / page_rect.width,
                        "height": (y1 - y0) / page_rect.height,
                    },
                }
            )
            page_text_offset = page_text_end
    return blocks


def sanitize_extracted_text(text: str) -> str:
    return sanitize_prompt_text(text)


def sanitize_prompt_text(text: str) -> str:
    filtered: list[str] = []
    for char in text:
        code_point = ord(char)
        if char in "\n\r\t":
            filtered.append(char)
            continue
        if code_point < 32 or 0x7F <= code_point <= 0x9F or 0xD800 <= code_point <= 0xDFFF:
            continue
        if 0xFDD0 <= code_point <= 0xFDEF or (code_point & 0xFFFE) == 0xFFFE:
            continue
        filtered.append(char)

    return "".join(filtered)


def sanitize_prompt_value(value: object) -> object:
    if isinstance(value, str):
        return sanitize_prompt_text(value)
    if isinstance(value, list):
        return [sanitize_prompt_value(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize_prompt_value(item) for key, item in value.items()}
    return value


def chunk_blocks(blocks: list[dict]) -> list[dict]:
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    chunks: list[dict] = []
    for block in blocks:
        search_from = 0
        for split_text in splitter.split_text(block["text"]):
            if should_skip_chunk(split_text):
                continue

            chunk_start_in_block = find_split_text_start(block["text"], split_text, search_from)
            chunk_end_in_block = chunk_start_in_block + len(split_text)
            search_from = max(chunk_start_in_block + 1, chunk_end_in_block - CHUNK_OVERLAP)
            chunks.append(
                {
                    "page_number": block["page_number"],
                    "text": split_text,
                    "section_hint": block.get("section_hint"),
                    "page_text_start": block["page_text_start"] + chunk_start_in_block,
                    "page_text_end": block["page_text_start"] + chunk_end_in_block,
                    "bbox": block["bbox"],
                }
            )
    return chunks


def annotate_chunks(
    chunks: list[dict],
    blocks: list[dict],
    page_sources: dict[int, str],
    pdf_doc: fitz.Document,
    *,
    title: str,
    abstract: str,
    job_id: str | None = None,
) -> list[Annotation]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is missing for the Python annotation service.")

    client = OpenAI(api_key=api_key, timeout=ANNOTATION_REQUEST_TIMEOUT)
    annotations: list[Annotation] = []
    rolling_memory = RollingMemoryState()
    model_name = resolve_annotation_model(client, chunks[0]["text"] if chunks else "Test chunk")
    annotation_brief = generate_annotation_brief(title, abstract, chunks)
    rolling_memory_text = ""

    for index, chunk in enumerate(chunks, start=1):
        try:
            write_progress(
                job_id,
                {
                    "status": "running",
                    "stage": "annotating",
                    "message": f"Annotating chunk {index} of {len(chunks)}...",
                    "currentChunk": index,
                    "totalChunks": len(chunks),
                    "pageNumber": chunk["page_number"],
                },
            )
            logger.info(
                "Annotating chunk %s/%s on page %s with model %s",
                index,
                len(chunks),
                chunk["page_number"],
                model_name,
            )
            response = client.chat.completions.create(
                model=model_name,
                max_completion_tokens=700,
                temperature=0,
                messages=build_annotation_messages(
                    chunk["text"],
                    paper_brief=annotation_brief,
                    rolling_memory=rolling_memory_text or None,
                    local_context=build_chunk_neighbor_context(chunks, index - 1),
                    page_number=chunk["page_number"],
                    section_hint=chunk.get("section_hint"),
                ),
            )

            text = extract_text_content(response)
            parsed = parse_annotation_json(text)

            if parsed is None:
                logger.warning(
                    "Primary annotation response was not valid JSON for chunk %s/%s on page %s; attempting repair. Raw preview: %.160r",
                    index,
                    len(chunks),
                    chunk["page_number"],
                    text,
                )
                parsed = repair_annotation_json(client, model_name, text, chunk["text"], index, len(chunks))

            logger.debug(
                "OpenAI annotation succeeded for chunk %s/%s on page %s chunk starting %.80r",
                index,
                len(chunks),
                chunk["page_number"],
                chunk["text"],
            )
            logger.info(
                "Chunk %s/%s on page %s produced %s raw annotations: %s",
                index,
                len(chunks),
                chunk["page_number"],
                len(parsed),
                format_annotation_debug_items(parsed),
            )
            memory_candidates = filter_chunk_annotations_for_memory(parsed, chunk["text"], chunk["page_number"])
            if memory_candidates:
                rolling_memory = update_rolling_memory(rolling_memory, memory_candidates)
                rolling_memory_text = render_rolling_memory(rolling_memory)
            for item in parsed:
                normalized_text_ref = normalize_annotation_text_ref(item["text_ref"])
                if not normalized_text_ref:
                    continue

                annotations.append(
                    Annotation(
                        type=item["type"],
                        text_ref=normalized_text_ref,
                        note=item["note"],
                        importance=item["importance"],
                        bbox=BoundingBox(**chunk["bbox"]),
                        page_number=chunk["page_number"],
                        anchor=resolve_text_anchor_for_chunk(
                            page_sources.get(chunk["page_number"], ""),
                            normalized_text_ref,
                            chunk["page_text_start"],
                            chunk["page_text_end"],
                        ),
                    )
                )
        except Exception as error:
            logger.exception(
                "OpenAI annotation failed for chunk %s/%s on page %s starting %.120r using model %s. Error: %s",
                index,
                len(chunks),
                chunk["page_number"],
                chunk["text"],
                model_name,
                error,
            )
            raise RuntimeError(
                f"OpenAI annotation failed on page {chunk['page_number']} with model {model_name}: {error}"
            ) from error

    write_progress(
        job_id,
        {
            "status": "running",
            "stage": "validating",
            "message": "Validating annotations...",
            "currentChunk": len(chunks),
            "totalChunks": len(chunks),
        },
    )
    logger.info("Collected %s annotations before dedupe: %s", len(annotations), summarize_annotations(annotations))
    deduped_annotations = dedupe_annotations(annotations)
    logger.info(
        "After dedupe: %s annotations remain (%s removed): %s",
        len(deduped_annotations),
        len(annotations) - len(deduped_annotations),
        summarize_annotations(deduped_annotations),
    )
    validated_annotations = validate_annotations(client, model_name, deduped_annotations, page_sources)
    logger.info(
        "After LLM validation: %s annotations remain: %s",
        len(validated_annotations),
        summarize_annotations(validated_annotations),
    )
    final_annotations = locally_validate_annotations(validated_annotations, page_sources)
    final_annotations = assign_text_anchors(final_annotations, page_sources, blocks)
    final_annotations = refine_annotation_bboxes(final_annotations, pdf_doc)
    logger.info(
        "After local validation: %s annotations remain (%s removed): %s",
        len(final_annotations),
        len(validated_annotations) - len(final_annotations),
        summarize_annotations(final_annotations),
    )
    return final_annotations


def resolve_annotation_model(client: OpenAI, probe_text: str) -> str:
    safe_probe_text = sanitize_prompt_text(probe_text)
    return resolve_chat_model(
        client,
        ANNOTATION_MODELS,
        [
            {"role": "system", "content": "Reply with []"},
            {"role": "user", "content": safe_probe_text[:200] or "Test"},
        ],
        "annotation",
    )


def resolve_summary_model(client: OpenAI, probe_text: str) -> str:
    safe_probe_text = sanitize_prompt_text(probe_text)
    return resolve_chat_model(
        client,
        SUMMARY_MODELS,
        [
            {"role": "system", "content": "Reply with ok"},
            {"role": "user", "content": safe_probe_text[:200] or "Test"},
        ],
        "summary",
    )


def resolve_chat_model(client: OpenAI, model_names: list[str], probe_messages: list[dict], label: str) -> str:
    last_error: Exception | None = None

    for model_name in model_names:
        try:
            logger.info("Probing %s model availability: %s", label, model_name)
            client.chat.completions.create(
                model=model_name,
                max_completion_tokens=32,
                messages=probe_messages,
            )
            logger.info("Using %s model %s", label, model_name)
            return model_name
        except NotFoundError as error:
            last_error = error
            logger.warning("%s model %s is unavailable for this OpenAI account", label.capitalize(), model_name)
            continue

    tried_models = ", ".join(model_names)
    raise RuntimeError(
        f"No configured OpenAI {label} models are available. Tried: {tried_models}"
    ) from last_error


def summarize_paper(title: str, abstract: str, full_text: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is missing for the Python annotation service.")

    client = OpenAI(api_key=api_key, timeout=ANNOTATION_REQUEST_TIMEOUT)
    model_name = resolve_summary_model(client, f"{title}\n{abstract}")
    source_text = truncate_summary_source(full_text)
    response = client.chat.completions.create(
        model=model_name,
        max_completion_tokens=280,
        temperature=0.2,
        messages=[
            {"role": "system", "content": SUMMARY_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Title:\n{title}\n\n"
                    f"Abstract:\n{abstract}\n\n"
                    "Extracted paper text:\n"
                    f"{source_text}"
                ),
            },
        ],
    )

    summary = normalize_summary_markdown(extract_text_content(response))
    if not summary:
        raise RuntimeError("Summary generation returned an empty response.")

    return summary


def extract_text_content(response) -> str:
    return response.choices[0].message.content.strip() if response.choices and response.choices[0].message.content else ""


def normalize_summary_markdown(text: str) -> str:
    return normalize_markdown_bullets(text, max_bullets=3)


def normalize_markdown_bullets(text: str, *, max_bullets: int) -> str:
    normalized = text.strip()
    fenced_match = re.search(r"```(?:markdown)?\s*([\s\S]*?)```", normalized)
    if fenced_match:
        normalized = fenced_match.group(1).strip()

    bullet_lines = [line.rstrip() for line in normalized.splitlines() if line.strip()]
    if not bullet_lines:
        return ""

    if not all(line.lstrip().startswith(("-", "*")) for line in bullet_lines):
        bullet_lines = [f"- {line.lstrip('-* ').strip()}" for line in bullet_lines[:max_bullets] if line.strip()]

    return "\n".join(bullet_lines[:max_bullets]).strip()


def generate_annotation_brief(title: str, abstract: str, chunks: list[dict]) -> str:
    abstract_bullets = normalize_markdown_bullets(abstract, max_bullets=2)
    sampled_bullets = build_deterministic_annotation_brief_lines(chunks) if ANNOTATION_DETERMINISTIC_BRIEF else []
    title_line = shorten_memory_text(title, 140)

    lines: list[str] = []
    if title_line:
        lines.append(f"- Paper: {title_line}")
    if abstract_bullets:
        lines.extend(abstract_bullets.splitlines()[:2])
    lines.extend(sampled_bullets)

    deduped: list[str] = []
    seen: set[str] = set()
    for line in lines:
        normalized = normalize_annotation_text_ref(line)
        key = normalize_annotation_text_ref_key(normalized)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(normalized)
        if len(deduped) >= ANNOTATION_BRIEF_MAX_BULLETS:
            break

    return "\n".join(deduped)


def build_annotation_brief_source(chunks: list[dict], sample_count: int = ANNOTATION_BRIEF_SAMPLE_COUNT) -> str:
    indices = select_representative_indices(len(chunks), sample_count)
    excerpts: list[str] = []
    for index in indices:
        chunk = chunks[index]
        excerpt = shorten_memory_text(chunk["text"], ANNOTATION_BRIEF_SAMPLE_CHAR_LIMIT)
        section_hint = chunk.get("section_hint")
        label = f"[sample {index + 1} | page {chunk['page_number']}"
        if section_hint:
            label += f" | section {section_hint}"
        label += "]"
        excerpts.append(f"{label}\n{excerpt}")
    return "\n\n".join(excerpts)


def build_deterministic_annotation_brief_lines(chunks: list[dict]) -> list[str]:
    if not chunks:
        return []

    indices = select_representative_indices(len(chunks), min(3, ANNOTATION_BRIEF_MAX_BULLETS))
    lines: list[str] = []
    labels = ("Early context", "Middle context", "Late context")
    for position, index in enumerate(indices):
        chunk = chunks[index]
        section_hint = chunk.get("section_hint")
        label = labels[min(position, len(labels) - 1)]
        prefix = f"{label} ({section_hint})" if section_hint else label
        lines.append(f"- {prefix}: {shorten_words(chunk['text'], 22)}")
    return lines


def select_representative_indices(total: int, sample_count: int) -> list[int]:
    if total <= 0 or sample_count <= 0:
        return []
    if total <= sample_count:
        return list(range(total))

    target = min(total, sample_count)
    positions = {round(step * (total - 1) / (target - 1)) for step in range(target)}
    indices = sorted(positions)
    candidate = 0
    while len(indices) < target and candidate < total:
        if candidate not in positions:
            indices.append(candidate)
        candidate += 1
    return sorted(indices[:target])


def build_chunk_neighbor_context(chunks: list[dict], index: int, window_chars: int = LOCAL_CONTEXT_CHAR_WINDOW) -> str:
    parts: list[str] = []
    if index > 0:
        parts.append(f"Previous chunk tail:\n{tail_text(chunks[index - 1]['text'], window_chars)}")
    if index + 1 < len(chunks):
        parts.append(f"Next chunk head:\n{head_text(chunks[index + 1]['text'], window_chars)}")
    return "\n\n".join(parts)


def head_text(text: str, limit: int) -> str:
    normalized = normalize_annotation_text_ref(text)
    return shorten_memory_text(normalized, limit)


def tail_text(text: str, limit: int) -> str:
    normalized = normalize_annotation_text_ref(text)
    if len(normalized) <= limit:
        return normalized
    return f"...{normalized[-limit:].lstrip()}"


def filter_chunk_annotations_for_memory(
    items: list[dict],
    chunk_text: str,
    page_number: int,
) -> list["MemoryRecentAnnotation"]:
    winners: dict[str, MemoryRecentAnnotation] = {}

    for index, item in enumerate(items):
        try:
            annotation_type = item["type"]
            text_ref = normalize_annotation_text_ref(str(item["text_ref"]))
            note = normalize_annotation_text_ref(str(item["note"]))
            importance = int(item["importance"])
            if annotation_type not in {"highlight", "note", "definition"}:
                continue
            if importance not in {1, 2, 3}:
                continue
            if not text_ref or not note or text_ref not in chunk_text:
                continue

            candidate = MemoryRecentAnnotation(
                type=annotation_type,
                text_ref=text_ref,
                note=note,
                importance=importance,
                page_number=page_number,
                order=index,
            )
            key = normalize_annotation_text_ref_key(text_ref)
            current = winners.get(key)
            if current is None or memory_recent_annotation_rank(candidate) > memory_recent_annotation_rank(current):
                winners[key] = candidate
        except Exception:
            continue

    return sorted(winners.values(), key=lambda item: (item.page_number, item.order))


def update_rolling_memory(
    memory: "RollingMemoryState",
    new_annotations: list["MemoryRecentAnnotation"],
) -> "RollingMemoryState":
    next_order = memory_max_order(memory)
    for item in new_annotations:
        next_order += 1
        item.order = next_order
        memory.recent_annotations.append(item)
        memory.blocked_text_refs.append(normalize_annotation_text_ref(item.text_ref))
        if item.type == "definition":
            memory.defined_terms.append(item.text_ref)

        topic_text = build_memory_topic(item)
        if topic_text:
            upsert_memory_list_item(memory.covered_topics, topic_text, item.importance, item.order)

        paper_state_text = build_paper_state_bullet(item)
        if paper_state_text:
            upsert_memory_list_item(memory.paper_state, paper_state_text, item.importance, item.order)

    return compact_rolling_memory(memory)


def compact_rolling_memory(memory: "RollingMemoryState") -> "RollingMemoryState":
    memory.paper_state = compact_memory_list_items(memory.paper_state, PAPER_STATE_LIMIT)
    memory.covered_topics = compact_memory_list_items(memory.covered_topics, COVERED_TOPICS_LIMIT)
    memory.defined_terms = compact_unique_strings(memory.defined_terms, DEFINED_TERMS_LIMIT)
    memory.recent_annotations = compact_recent_annotations(memory.recent_annotations, RECENT_ANNOTATIONS_LIMIT)

    allowed_blocked_keys = {normalize_annotation_text_ref_key(item.text_ref) for item in memory.recent_annotations}
    allowed_blocked_keys.update(normalize_annotation_text_ref_key(term) for term in memory.defined_terms)
    deduped_blocked: list[str] = []
    seen_blocked: set[str] = set()
    for value in reversed(memory.blocked_text_refs):
        normalized = normalize_annotation_text_ref(value)
        key = normalize_annotation_text_ref_key(normalized)
        if not key or key in seen_blocked or key not in allowed_blocked_keys:
            continue
        seen_blocked.add(key)
        deduped_blocked.append(normalized)
        if len(deduped_blocked) >= BLOCKED_TEXT_REFS_LIMIT:
            break
    memory.blocked_text_refs = list(reversed(deduped_blocked))
    return memory


def compact_memory_list_items(items: list["MemoryListItem"], limit: int) -> list["MemoryListItem"]:
    winners: dict[str, MemoryListItem] = {}
    for item in items:
        normalized_text = shorten_memory_text(item.text, 160)
        key = normalize_annotation_text_ref_key(normalized_text)
        if not key:
            continue
        candidate = MemoryListItem(text=normalized_text, importance=item.importance, order=item.order)
        current = winners.get(key)
        if current is None or memory_list_item_rank(candidate) > memory_list_item_rank(current):
            winners[key] = candidate

    selected = sorted(winners.values(), key=memory_list_item_rank, reverse=True)[:limit]
    return sorted(selected, key=memory_list_item_rank, reverse=True)


def compact_unique_strings(values: list[str], limit: int) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for value in reversed(values):
        normalized = normalize_annotation_text_ref(value)
        key = normalize_annotation_text_ref_key(normalized)
        if not key or key in seen:
            continue
        seen.add(key)
        selected.append(normalized)
        if len(selected) >= limit:
            break
    return list(reversed(selected))


def compact_recent_annotations(
    items: list["MemoryRecentAnnotation"],
    limit: int,
) -> list["MemoryRecentAnnotation"]:
    winners: dict[str, MemoryRecentAnnotation] = {}
    for item in items:
        key = normalize_annotation_text_ref_key(item.text_ref)
        if not key:
            continue
        current = winners.get(key)
        if current is None or memory_recent_annotation_rank(item) > memory_recent_annotation_rank(current):
            winners[key] = item

    selected = sorted(winners.values(), key=memory_recent_annotation_rank, reverse=True)[:limit]
    return sorted(selected, key=lambda item: item.order, reverse=True)


def upsert_memory_list_item(
    items: list["MemoryListItem"],
    text: str,
    importance: int,
    order: int,
) -> None:
    normalized_text = shorten_memory_text(text, 160)
    key = normalize_annotation_text_ref_key(normalized_text)
    if not key:
        return

    candidate = MemoryListItem(text=normalized_text, importance=importance, order=order)
    for index, current in enumerate(items):
        if normalize_annotation_text_ref_key(current.text) != key:
            continue
        if memory_list_item_rank(candidate) > memory_list_item_rank(current):
            items[index] = candidate
        return

    items.append(candidate)


def build_memory_topic(item: "MemoryRecentAnnotation") -> str:
    return shorten_words(item.text_ref, 6)


def build_paper_state_bullet(item: "MemoryRecentAnnotation") -> str | None:
    if item.type == "definition":
        return None
    if item.type == "highlight":
        return f"{item.text_ref}: {shorten_words(item.note, 14)}"
    if item.importance >= 2:
        return shorten_words(item.note, 12)
    return None


def render_rolling_memory(memory: "RollingMemoryState", char_budget: int = ROLLING_MEMORY_CHAR_BUDGET) -> str:
    working = compact_rolling_memory(memory.model_copy(deep=True))
    while True:
        rendered = render_rolling_memory_sections(working)
        if len(rendered) <= char_budget or not has_trim_candidates(working):
            return rendered
        trim_rolling_memory(working)


def render_rolling_memory_sections(memory: "RollingMemoryState") -> str:
    sections: list[str] = []
    if memory.paper_state:
        sections.append(
            "Paper so far:\n" + "\n".join(f"- {item.text}" for item in memory.paper_state)
        )
    if memory.defined_terms:
        sections.append(
            "Already defined:\n" + "\n".join(f"- {term}" for term in memory.defined_terms)
        )
    if memory.covered_topics:
        sections.append(
            "Already covered:\n" + "\n".join(f"- {item.text}" for item in memory.covered_topics)
        )
    if memory.recent_annotations:
        sections.append(
            "Recent strong annotations:\n"
            + "\n".join(f"- {render_recent_annotation(item)}" for item in memory.recent_annotations)
        )
    return "\n\n".join(sections)


def render_recent_annotation(item: "MemoryRecentAnnotation") -> str:
    return (
        f"p{item.page_number} {item.type} ({item.importance}) "
        f"\"{item.text_ref}\": {shorten_words(item.note, 10)}"
    )


def has_trim_candidates(memory: "RollingMemoryState") -> bool:
    return bool(memory.recent_annotations or memory.covered_topics or memory.paper_state or memory.defined_terms)


def trim_rolling_memory(memory: "RollingMemoryState") -> None:
    if memory.recent_annotations:
        memory.recent_annotations.pop()
        return

    covered_index = lowest_priority_index(memory.covered_topics)
    if covered_index is not None:
        memory.covered_topics.pop(covered_index)
        return

    paper_state_index = lowest_priority_index(memory.paper_state)
    if paper_state_index is not None:
        memory.paper_state.pop(paper_state_index)
        return

    if memory.defined_terms:
        memory.defined_terms.pop(0)


def lowest_priority_index(items: list["MemoryListItem"]) -> int | None:
    if not items:
        return None
    return min(range(len(items)), key=lambda index: memory_list_item_rank(items[index]))


def shorten_words(text: str, max_words: int) -> str:
    normalized = normalize_annotation_text_ref(text)
    words = normalized.split()
    if len(words) <= max_words:
        return normalized
    return " ".join(words[:max_words]).rstrip(".,;:") + "..."


def shorten_memory_text(text: str, limit: int) -> str:
    normalized = normalize_annotation_text_ref(text)
    if len(normalized) <= limit:
        return normalized
    truncated = normalized[:limit].rsplit(" ", 1)[0].strip()
    return f"{truncated}..."


def memory_max_order(memory: "RollingMemoryState") -> int:
    values = [0]
    values.extend(item.order for item in memory.paper_state)
    values.extend(item.order for item in memory.covered_topics)
    values.extend(item.order for item in memory.recent_annotations)
    return max(values)


def memory_list_item_rank(item: "MemoryListItem") -> tuple[int, int]:
    return (item.importance, item.order)


def memory_recent_annotation_rank(item: "MemoryRecentAnnotation") -> tuple[int, int, int]:
    return (item.importance, annotation_type_priority(item.type), item.order)


def parse_annotation_json(text: str):
    if not text:
        return None

    normalized = text.strip()

    fenced_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", normalized)
    if fenced_match:
        normalized = fenced_match.group(1).strip()

    array_match = re.search(r"\[[\s\S]*\]", normalized)
    if array_match:
        normalized = array_match.group(0)

    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        return None

    return parsed if isinstance(parsed, list) else None


def repair_annotation_json(
    client: OpenAI,
    model_name: str,
    bad_output: str,
    source_text: str,
    chunk_index: int,
    total_chunks: int,
):
    logger.info(
        "Attempting annotation JSON repair for chunk %s/%s with model %s",
        chunk_index,
        total_chunks,
        model_name,
    )
    repair_response = client.chat.completions.create(
        model=model_name,
        max_completion_tokens=700,
        temperature=0,
        messages=build_annotation_repair_messages(source_text, bad_output),
    )

    repaired_text = extract_text_content(repair_response)
    repaired = parse_annotation_json(repaired_text)

    if repaired is None:
        raise RuntimeError(f"OpenAI returned non-JSON annotation output: {repaired_text[:200]!r}")

    return repaired


def validate_annotations(
    client: OpenAI,
    model_name: str,
    annotations: list[Annotation],
    page_sources: dict[int, str],
) -> list[Annotation]:
    if not annotations:
        return []

    validated_annotations: list[Annotation] = []
    for page_number, page_annotations in annotations_grouped_by_page(annotations).items():
        page_source = page_sources.get(page_number, "")
        logger.info(
            "Validating page %s with %s candidate annotations",
            page_number,
            len(page_annotations),
        )
        validation_response = client.chat.completions.create(
            model=model_name,
            max_completion_tokens=1800,
            temperature=0,
            messages=build_annotation_validation_messages(
                {page_number: page_source},
                [serialize_annotation_for_validation(annotation) for annotation in page_annotations],
            ),
        )

        validated_text = extract_text_content(validation_response)
        parsed = parse_annotation_json(validated_text)
        if parsed is None:
            logger.warning(
                "Annotation validation agent returned non-JSON output for page %s; keeping pre-validation page annotations. Raw preview: %.160r",
                page_number,
                validated_text,
            )
            validated_annotations.extend(page_annotations)
            continue

        page_validated_annotations: list[Annotation] = []
        for item in parsed:
            try:
                page_validated_annotations.append(
                    Annotation(
                        type=item["type"],
                        text_ref=normalize_annotation_text_ref(item["text_ref"]),
                        note=item["note"],
                        importance=item["importance"],
                        bbox=annotations_by_page_number(page_annotations, item["page_number"], item["text_ref"]),
                        page_number=item["page_number"],
                        anchor=annotation_anchor_by_page_number(page_annotations, item["page_number"], item["text_ref"]),
                    )
                )
            except Exception:
                logger.warning("Skipping invalid validated annotation payload: %r", item, exc_info=True)

        logger.info(
            "Page %s validation kept %s of %s annotations",
            page_number,
            len(page_validated_annotations),
            len(page_annotations),
        )
        validated_annotations.extend(page_validated_annotations or page_annotations)

    return validated_annotations or annotations


def build_page_sources(blocks: list[dict]) -> dict[int, str]:
    page_sources: dict[int, list[str]] = {}
    for block in blocks:
        page_sources.setdefault(block["page_number"], []).append(block["text"])

    return {
        page_number: "\n".join(texts)
        for page_number, texts in page_sources.items()
    }


def serialize_annotation_for_validation(annotation: Annotation) -> dict[str, object]:
    return {
        "type": annotation.type,
        "text_ref": annotation.text_ref,
        "note": annotation.note,
        "importance": annotation.importance,
        "page_number": annotation.page_number,
    }


def find_split_text_start(block_text: str, split_text: str, search_from: int) -> int:
    start = block_text.find(split_text, max(search_from - CHUNK_OVERLAP, 0))
    if start != -1:
        return start

    fallback = block_text.find(split_text)
    if fallback != -1:
        return fallback

    return max(min(search_from, len(block_text)), 0)


def resolve_text_anchor_for_chunk(
    page_text: str,
    text_ref: str,
    chunk_page_text_start: int,
    chunk_page_text_end: int,
) -> TextAnchor | None:
    occurrences = find_text_occurrences(page_text, text_ref)
    if not occurrences:
        return None

    target_center = (chunk_page_text_start + chunk_page_text_end) / 2
    best_index, best_span = min(
        enumerate(occurrences),
        key=lambda item: (
            0 if spans_overlap(item[1], (chunk_page_text_start, chunk_page_text_end)) else 1,
            abs(span_center(item[1]) - target_center),
            item[0],
        ),
    )
    return TextAnchor(
        page_text_start=best_span[0],
        page_text_end=best_span[1],
        occurrence_index=best_index,
    )


def assign_text_anchors(
    annotations: list[Annotation],
    page_sources: dict[int, str],
    blocks: list[dict],
) -> list[Annotation]:
    blocks_by_page = blocks_grouped_by_page(blocks)

    for annotation in annotations:
        page_text = page_sources.get(annotation.page_number, "")
        page_blocks = blocks_by_page.get(annotation.page_number, [])
        resolved_anchor = resolve_text_anchor_for_annotation(annotation, page_text, page_blocks)
        if resolved_anchor is not None:
            annotation.anchor = resolved_anchor

    return annotations


def resolve_text_anchor_for_annotation(
    annotation: Annotation,
    page_text: str,
    page_blocks: list[dict],
) -> TextAnchor | None:
    occurrences = find_text_occurrences(page_text, annotation.text_ref)
    if not occurrences:
        return None

    hinted_span = None
    if annotation.anchor is not None:
        hinted_span = (annotation.anchor.page_text_start, annotation.anchor.page_text_end)

    current_bbox = annotation.bbox
    target_center = (current_bbox.x + (current_bbox.width / 2), current_bbox.y + (current_bbox.height / 2))

    ranked_occurrences = []
    for occurrence_index, span in enumerate(occurrences):
        span_bbox = resolve_span_bbox_from_blocks(span, page_blocks)
        span_center = (
            span_bbox["x"] + (span_bbox["width"] / 2),
            span_bbox["y"] + (span_bbox["height"] / 2),
        ) if span_bbox is not None else (0.0, 0.0)

        ranked_occurrences.append(
            (
                (
                    0 if hinted_span is not None and spans_overlap(span, hinted_span) else 1,
                    abs(span_center_value(span) - span_center_value(hinted_span)) if hinted_span is not None else 0,
                    0 if span_bbox is not None else 1,
                    rect_center_distance_2d(span_center, target_center) if span_bbox is not None else 0,
                    occurrence_index,
                ),
                occurrence_index,
                span,
            )
        )

    _, best_occurrence_index, best_span = min(ranked_occurrences, key=lambda item: item[0])
    return TextAnchor(
        page_text_start=best_span[0],
        page_text_end=best_span[1],
        occurrence_index=best_occurrence_index,
    )


def find_text_occurrences(page_text: str, text_ref: str) -> list[tuple[int, int]]:
    if not page_text or not text_ref:
        return []

    matches: list[tuple[int, int]] = []
    start = 0
    while start < len(page_text):
        index = page_text.find(text_ref, start)
        if index == -1:
            break
        matches.append((index, index + len(text_ref)))
        start = index + 1
    return matches


def blocks_grouped_by_page(blocks: list[dict]) -> dict[int, list[dict]]:
    grouped: dict[int, list[dict]] = {}
    for block in blocks:
        grouped.setdefault(block["page_number"], []).append(block)
    return grouped


def resolve_span_bbox_from_blocks(span: tuple[int, int], page_blocks: list[dict]) -> dict[str, float] | None:
    overlapping_blocks = [
        block
        for block in page_blocks
        if spans_overlap(span, (block["page_text_start"], block["page_text_end"]))
    ]

    if not overlapping_blocks:
        return None

    left = min(block["bbox"]["x"] for block in overlapping_blocks)
    top = min(block["bbox"]["y"] for block in overlapping_blocks)
    right = max(block["bbox"]["x"] + block["bbox"]["width"] for block in overlapping_blocks)
    bottom = max(block["bbox"]["y"] + block["bbox"]["height"] for block in overlapping_blocks)
    return {
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


def spans_overlap(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


def span_center(span: tuple[int, int]) -> float:
    return (span[0] + span[1]) / 2


def span_center_value(span: tuple[int, int] | None) -> float:
    if span is None:
        return 0
    return span_center(span)


def rect_center_distance_2d(left: tuple[float, float], right: tuple[float, float]) -> float:
    return ((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2) ** 0.5


def annotations_by_page_number(
    annotations: list[Annotation],
    page_number: int,
    text_ref: str,
) -> BoundingBox:
    normalized_text_ref = normalize_annotation_text_ref(text_ref)
    for annotation in annotations:
        if annotation.page_number == page_number and normalize_annotation_text_ref(annotation.text_ref) == normalized_text_ref:
            return annotation.bbox

    for annotation in annotations:
        if annotation.page_number == page_number:
            return annotation.bbox

    return annotations[0].bbox


def annotation_anchor_by_page_number(
    annotations: list[Annotation],
    page_number: int,
    text_ref: str,
) -> TextAnchor | None:
    normalized_text_ref = normalize_annotation_text_ref(text_ref)
    for annotation in annotations:
        if (
            annotation.page_number == page_number
            and normalize_annotation_text_ref(annotation.text_ref) == normalized_text_ref
            and annotation.anchor is not None
        ):
            return annotation.anchor

    for annotation in annotations:
        if annotation.page_number == page_number and annotation.anchor is not None:
            return annotation.anchor

    return None


def annotations_grouped_by_page(annotations: list[Annotation]) -> dict[int, list[Annotation]]:
    grouped: dict[int, list[Annotation]] = {}
    for annotation in annotations:
        grouped.setdefault(annotation.page_number, []).append(annotation)
    return grouped


def truncate_summary_source(full_text: str, limit: int = 12000) -> str:
    normalized = full_text.strip()
    if len(normalized) <= limit:
        return normalized

    truncated = normalized[:limit].rsplit(" ", 1)[0].strip()
    return f"{truncated}\n\n[truncated]"


def normalize_annotation_text_ref(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalize_annotation_text_ref_key(value: str) -> str:
    normalized = normalize_annotation_text_ref(value).lower()
    return normalized.strip(" \t\n\r.,;:!?\"'`()[]{}")


def annotation_word_limit(annotation_type: str) -> int:
    return 8 if annotation_type == "definition" else 15


def text_ref_word_count(text_ref: str) -> int:
    return len(re.findall(r"\S+", text_ref))


def locally_validate_annotations(annotations: list[Annotation], page_sources: dict[int, str]) -> list[Annotation]:
    candidates: list[Annotation] = []
    drop_reasons: Counter[str] = Counter()

    for annotation in annotations:
        page_text = page_sources.get(annotation.page_number, "")
        annotation.text_ref = normalize_annotation_text_ref(annotation.text_ref)
        annotation.note = annotation.note.strip()
        if not annotation.text_ref or not annotation.note:
            drop_reasons["missing_text_ref_or_note"] += 1
            continue
        if annotation.text_ref not in page_text:
            drop_reasons["text_ref_not_on_page"] += 1
            continue

        shortened_text_ref = shorten_text_ref(annotation, page_text)
        if not shortened_text_ref:
            drop_reasons["unable_to_shorten_within_limit"] += 1
            continue

        annotation.text_ref = shortened_text_ref
        if text_ref_word_count(annotation.text_ref) >= annotation_word_limit(annotation.type):
            drop_reasons["text_ref_exceeds_word_limit"] += 1
            continue

        candidates.append(annotation)

    winners: dict[str, tuple[Annotation, int]] = {}
    duplicate_drops = 0
    for index, annotation in enumerate(candidates):
        key = normalize_annotation_text_ref_key(annotation.text_ref)
        if not key:
            drop_reasons["empty_normalized_key"] += 1
            continue

        current = winners.get(key)
        if current is None:
            winners[key] = (annotation, index)
            continue

        duplicate_drops += 1
        if annotation_rank(annotation, index) > annotation_rank(current[0], current[1]):
            winners[key] = (annotation, index)

    if duplicate_drops:
        drop_reasons["duplicate_text_ref"] += duplicate_drops

    if drop_reasons:
        logger.info("Local validation drop reasons: %s", format_counter(drop_reasons))
    else:
        logger.info("Local validation drop reasons: none")

    validated = [
        annotation
        for annotation, _ in sorted(
            winners.values(),
            key=lambda candidate: (candidate[0].page_number, candidate[1]),
        )
    ]
    logger.info("Local validation survivors by type/importance: %s", summarize_annotations(validated))
    return validated


def refine_annotation_bboxes(annotations: list[Annotation], pdf_doc: fitz.Document) -> list[Annotation]:
    refined_count = 0

    for annotation in annotations:
        refined_bbox = resolve_precise_annotation_bbox(annotation, pdf_doc)
        if refined_bbox is None:
            continue

        annotation.bbox = refined_bbox
        refined_count += 1

    logger.info("Refined %s/%s annotation bounding boxes using PDF text search", refined_count, len(annotations))
    return annotations


def resolve_precise_annotation_bbox(annotation: Annotation, pdf_doc: fitz.Document) -> BoundingBox | None:
    if annotation.page_number < 1 or annotation.page_number > pdf_doc.page_count:
        return None

    query = normalize_annotation_text_ref(annotation.text_ref)
    if not query:
        return None

    page = pdf_doc.load_page(annotation.page_number - 1)
    matches = search_page_for_text_ref(page, query)
    if not matches:
        return None

    best_match: fitz.Rect
    if annotation.anchor is not None and annotation.anchor.occurrence_index < len(matches):
        best_match = matches[annotation.anchor.occurrence_index]
    else:
        context_rect = denormalize_bbox(annotation.bbox, page.rect)
        best_match = min(matches, key=lambda rect: search_match_rank(rect, context_rect))
    fragment = normalize_rect(best_match, page.rect)
    return BoundingBox(
        x=fragment.x,
        y=fragment.y,
        width=fragment.width,
        height=fragment.height,
        fragments=[fragment],
    )


def search_page_for_text_ref(page: fitz.Page, text_ref: str) -> list[fitz.Rect]:
    queries = [text_ref]
    stripped = text_ref.strip("()[]{}\"'.,;: ")
    if stripped and stripped != text_ref:
        queries.append(stripped)

    for query in queries:
        try:
            matches = page.search_for(query)
        except Exception:
            logger.warning("PyMuPDF search_for failed for page %s query %.80r", page.number + 1, query, exc_info=True)
            return []

        if matches:
            return matches

    return []


def denormalize_bbox(bbox: BoundingBox, page_rect: fitz.Rect) -> fitz.Rect:
    return fitz.Rect(
        page_rect.x0 + (bbox.x * page_rect.width),
        page_rect.y0 + (bbox.y * page_rect.height),
        page_rect.x0 + ((bbox.x + bbox.width) * page_rect.width),
        page_rect.y0 + ((bbox.y + bbox.height) * page_rect.height),
    )


def normalize_rect(rect: fitz.Rect, page_rect: fitz.Rect) -> HighlightFragment:
    return HighlightFragment(
        x=(rect.x0 - page_rect.x0) / page_rect.width,
        y=(rect.y0 - page_rect.y0) / page_rect.height,
        width=(rect.x1 - rect.x0) / page_rect.width,
        height=(rect.y1 - rect.y0) / page_rect.height,
    )


def search_match_rank(match_rect: fitz.Rect, context_rect: fitz.Rect) -> tuple[int, float, float, float, float]:
    return (
        0 if rects_intersect(match_rect, context_rect) else 1,
        rect_center_distance(match_rect, context_rect),
        rect_area(match_rect),
        match_rect.y0,
        match_rect.x0,
    )


def rects_intersect(left: fitz.Rect, right: fitz.Rect) -> bool:
    return left.x0 <= right.x1 and right.x0 <= left.x1 and left.y0 <= right.y1 and right.y0 <= left.y1


def rect_center_distance(left: fitz.Rect, right: fitz.Rect) -> float:
    left_center_x = (left.x0 + left.x1) / 2
    left_center_y = (left.y0 + left.y1) / 2
    right_center_x = (right.x0 + right.x1) / 2
    right_center_y = (right.y0 + right.y1) / 2
    return ((left_center_x - right_center_x) ** 2 + (left_center_y - right_center_y) ** 2) ** 0.5


def rect_area(rect: fitz.Rect) -> float:
    return max(rect.x1 - rect.x0, 0) * max(rect.y1 - rect.y0, 0)


def shorten_text_ref(annotation: Annotation, page_text: str) -> str | None:
    text_ref = normalize_annotation_text_ref(annotation.text_ref)
    limit = annotation_word_limit(annotation.type)
    if text_ref_word_count(text_ref) < limit:
        return text_ref

    words = text_ref.split()
    candidates = [text_ref]
    if annotation.type == "definition":
        candidates.extend(extract_definition_candidates(text_ref))
    else:
        candidates.extend(extract_ngram_candidates(words, limit - 1))

    seen: set[str] = set()
    for candidate in candidates:
        normalized_candidate = normalize_annotation_text_ref(candidate)
        if normalized_candidate in seen:
            continue
        seen.add(normalized_candidate)
        if not normalized_candidate or normalized_candidate not in page_text:
            continue
        if text_ref_word_count(normalized_candidate) < limit:
            return normalized_candidate

    return text_ref if text_ref_word_count(text_ref) < limit else None


def extract_definition_candidates(text_ref: str) -> list[str]:
    candidates: list[str] = []
    stripped = text_ref.strip("()[]{}\"'.,;: ")
    if stripped and stripped != text_ref:
        candidates.append(stripped)

    tokens = stripped.split()
    for size in range(min(len(tokens), 7), 0, -1):
        window = " ".join(tokens[:size]).strip("()[]{}\"'.,;: ")
        if window:
            candidates.append(window)

    return sorted(candidates, key=lambda value: (text_ref_word_count(value), len(value)))


def extract_ngram_candidates(words: list[str], max_words: int) -> list[str]:
    candidates: list[str] = []
    upper_bound = min(len(words), max_words)
    for size in range(upper_bound, 0, -1):
        for start in range(0, len(words) - size + 1):
            candidate = " ".join(words[start : start + size]).strip("()[]{}\"'.,;: ")
            if candidate:
                candidates.append(candidate)

    return sorted(candidates, key=lambda value: (text_ref_word_count(value), len(value)))


def dedupe_annotations(annotations: list[Annotation]) -> list[Annotation]:
    winners: dict[str, tuple[Annotation, int]] = {}

    for index, annotation in enumerate(annotations):
        normalized_text_ref = normalize_annotation_text_ref(annotation.text_ref)
        key = normalize_annotation_text_ref_key(normalized_text_ref)
        if not key:
            continue

        current = winners.get(key)
        if current is None or annotation_rank(annotation, index) > annotation_rank(current[0], current[1]):
            annotation.text_ref = normalized_text_ref
            winners[key] = (annotation, index)

    return [
        annotation
        for annotation, _ in sorted(
            winners.values(),
            key=lambda candidate: (candidate[0].page_number, candidate[1]),
        )
    ]


def annotation_rank(annotation: Annotation, index: int) -> tuple[int, int, int]:
    return (annotation.importance, annotation_type_priority(annotation.type), -index)


def annotation_type_priority(annotation_type: str) -> int:
    type_priority = {
        "definition": 0,
        "note": 1,
        "highlight": 2,
    }
    return type_priority[annotation_type]


def summarize_annotations(annotations: list[Annotation]) -> str:
    if not annotations:
        return "none"

    by_type = Counter(annotation.type for annotation in annotations)
    by_importance = Counter(str(annotation.importance) for annotation in annotations)
    preview = ", ".join(
        f"p{annotation.page_number}:{annotation.type}:{annotation.importance}:{annotation.text_ref[:48]}"
        for annotation in annotations[:6]
    )
    parts = [
        f"types={format_counter(by_type)}",
        f"importance={format_counter(by_importance)}",
        f"preview=[{preview}]",
    ]
    if len(annotations) > 6:
        parts.append(f"+{len(annotations) - 6} more")
    return " ".join(parts)


def format_annotation_debug_items(items: list[dict]) -> str:
    if not items:
        return "none"

    return "; ".join(
        f"{item.get('type', '?')}:{item.get('importance', '?')}:{normalize_annotation_text_ref(str(item.get('text_ref', '')))[:60]}"
        for item in items[:6]
    ) + (f" (+{len(items) - 6} more)" if len(items) > 6 else "")


def format_counter(counter: Counter[str]) -> str:
    if not counter:
        return "none"

    return ", ".join(f"{key}={value}" for key, value in counter.most_common())


def infer_section_hint(text: str) -> str | None:
    normalized = normalize_annotation_text_ref(text)
    lowered = normalized.lower()
    common_headings = {
        "abstract",
        "introduction",
        "background",
        "related work",
        "method",
        "methods",
        "approach",
        "model",
        "experiments",
        "results",
        "discussion",
        "limitations",
        "conclusion",
        "conclusions",
        "appendix",
    }
    if lowered in common_headings:
        return normalized.title()

    numbered_match = re.match(r"^(?:\d+(?:\.\d+)*)\s+([A-Za-z][A-Za-z0-9 ,:/-]{1,60})$", normalized)
    if numbered_match:
        return normalize_annotation_text_ref(numbered_match.group(1)).title()

    if len(normalized) > 60:
        return None

    words = normalized.split()
    if not 1 <= len(words) <= 8:
        return None

    alpha_words = [word for word in words if any(char.isalpha() for char in word)]
    if not alpha_words:
        return None

    title_like_ratio = sum(word[:1].isupper() for word in alpha_words) / len(alpha_words)
    if title_like_ratio >= 0.8 and normalized[-1:] not in {".", "?", "!"}:
        return normalized

    return None


def should_skip_block(text: str) -> bool:
    lowered = text.lower()

    boilerplate_markers = [
        "provided proper attribution is provided",
        "arxiv:",
        "@google.com",
        "@cs.toronto.edu",
        "conference on neural information processing systems",
    ]
    if any(marker in lowered for marker in boilerplate_markers):
        return True

    return False


def should_skip_chunk(text: str) -> bool:
    normalized = text.strip()
    if len(normalized) < 80:
        return True

    alpha_chars = sum(character.isalpha() for character in normalized)
    if alpha_chars < 40:
        return True

    words = normalized.split()
    long_words = [word for word in words if len(word) > 3]
    if len(long_words) < 12:
        return True

    lowered = normalized.lower()
    if lowered.startswith("attention is all you need"):
        return True
    if lowered.startswith("2 background") or lowered.startswith("3 model architecture"):
        return True

    return False


def write_progress(job_id: str | None, payload: dict) -> None:
    if not job_id:
        return

    progress_dir = Path(tempfile.gettempdir()) / "annotagent-progress"
    progress_dir.mkdir(parents=True, exist_ok=True)
    progress_path = progress_dir / f"{job_id}.json"
    progress_path.write_text(json.dumps(payload), encoding="utf-8")


def build_starter_questions(title: str) -> list[str]:
    return [
        f"What is the main contribution of '{title}'?",
        "Which assumptions are most important for interpreting the results?",
        "What terms or concepts would a non-expert need defined first?",
        "What are the paper's biggest limitations or open questions?",
    ]


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
