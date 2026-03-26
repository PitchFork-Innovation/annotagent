from __future__ import annotations

import json
import logging
import os
import re
import tempfile
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
- highlight notes should explain why the claim or result matters

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
                "note": "This is a key quantitative result showing a large practical speed improvement without sacrificing accuracy.",
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
                "note": "This makes the comparison fair, so the gains are not explained by using more compute than the baselines.",
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
    return json.dumps(value, ensure_ascii=True, indent=2)


def build_annotation_request_content(passage: str) -> str:
    return (
        "Annotate the following academic passage.\n"
        "Return only a JSON array matching the required schema.\n\n"
        f"Passage:\n{passage}"
    )


def build_annotation_messages(passage: str) -> list[dict[str, str]]:
    messages = [{"role": "system", "content": ANNOTATION_PROMPT}]
    for example in ANNOTATION_FEWSHOT_EXAMPLES:
        messages.append({"role": "user", "content": build_annotation_request_content(example["passage"])})
        messages.append({"role": "assistant", "content": dump_prompt_json(example["output"])})

    messages.append({"role": "user", "content": build_annotation_request_content(passage)})
    return messages


def build_repair_request_content(source_text: str, bad_output: str) -> str:
    return (
        "Original passage:\n"
        f"{source_text[:2000]}\n\n"
        "Broken annotation output:\n"
        f"{bad_output or '[empty response]'}"
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


class SummaryRequest(BaseModel):
    title: str = Field(min_length=1)
    abstract: str = Field(min_length=1)
    fullText: str = Field(min_length=1)


class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class Annotation(BaseModel):
    type: Literal["highlight", "note", "definition"]
    text_ref: str
    note: str
    importance: Literal[1, 2, 3]
    bbox: BoundingBox
    page_number: int


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

    write_progress(request.job_id, {"status": "running", "stage": "fetching_pdf", "message": "Fetching PDF from arXiv..."})
    logger.info("Fetching PDF bytes from %s", paper.pdf_url)
    pdf_bytes = await fetch_pdf_bytes(paper.pdf_url)

    write_progress(request.job_id, {"status": "running", "stage": "opening_pdf", "message": "Opening PDF for text extraction..."})
    logger.info("Opening PDF with PyMuPDF for %s", normalized_arxiv_id)
    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    write_progress(request.job_id, {"status": "running", "stage": "extracting_blocks", "message": "Extracting text blocks from PDF..."})
    logger.info("Extracting text blocks for %s", normalized_arxiv_id)
    blocks = extract_blocks(pdf_doc)
    full_text = "\n\n".join(block["text"] for block in blocks)

    write_progress(request.job_id, {"status": "running", "stage": "summarizing", "message": "Generating AI key points..."})
    logger.info("Generating paper summary for %s", normalized_arxiv_id)
    summary = summarize_paper(paper.title, paper.summary, full_text)

    write_progress(request.job_id, {"status": "running", "stage": "chunking", "message": "Chunking extracted text..."})
    logger.info("Chunking extracted text for %s", normalized_arxiv_id)
    chunks = chunk_blocks(blocks)
    logger.info(
        "Extracted %s blocks and %s chunks for %s",
        len(blocks),
        len(chunks),
        normalized_arxiv_id,
    )
    write_progress(
        request.job_id,
        {
            "status": "running",
            "stage": "annotating",
            "message": "Generating annotations with OpenAI...",
            "currentChunk": 0,
            "totalChunks": len(chunks),
        },
    )
    annotations = annotate_chunks(chunks, request.job_id)
    logger.info("Produced %s annotations for %s", len(annotations), normalized_arxiv_id)
    write_progress(
        request.job_id,
        {
            "status": "completed",
            "stage": "completed",
            "message": "Annotation generation complete.",
            "currentChunk": len(chunks),
            "totalChunks": len(chunks),
        },
    )

    return IngestResponse(
        arxivId=normalized_arxiv_id,
        title=paper.title,
        abstract=paper.summary,
        summary=summary,
        pdfUrl=paper.pdf_url,
        fullText=full_text,
        pageCount=pdf_doc.page_count,
        starterQuestions=build_starter_questions(paper.title),
        annotations=annotations,
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
    client = arxiv.Client()
    search = arxiv.Search(id_list=[arxiv_id], max_results=1)
    results = list(client.results(search))
    if not results:
        raise HTTPException(status_code=404, detail="arXiv paper not found")
    return results[0]


async def fetch_pdf_bytes(pdf_url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        response = await client.get(pdf_url)
        response.raise_for_status()
        return response.content


def extract_blocks(pdf_doc: fitz.Document) -> list[dict]:
    blocks: list[dict] = []
    for page_index in range(pdf_doc.page_count):
        page = pdf_doc.load_page(page_index)
        page_rect = page.rect
        for block in page.get_text("blocks"):
            x0, y0, x1, y1, text, *_ = block
            cleaned = " ".join(sanitize_extracted_text(text or "").split())
            if not cleaned:
                continue
            if should_skip_block(cleaned):
                continue
            blocks.append(
                {
                    "page_number": page_index + 1,
                    "text": cleaned,
                    "bbox": {
                        "x": x0 / page_rect.width,
                        "y": y0 / page_rect.height,
                        "width": (x1 - x0) / page_rect.width,
                        "height": (y1 - y0) / page_rect.height,
                    },
                }
            )
    return blocks


def sanitize_extracted_text(text: str) -> str:
    filtered: list[str] = []
    for char in text:
        code_point = ord(char)
        if char in "\n\r\t":
            filtered.append(char)
            continue
        if code_point < 32 or 0xD800 <= code_point <= 0xDFFF:
            continue
        filtered.append(char)

    return "".join(filtered)


def chunk_blocks(blocks: list[dict]) -> list[dict]:
    splitter = RecursiveCharacterTextSplitter(chunk_size=1400, chunk_overlap=120)
    chunks: list[dict] = []
    for block in blocks:
        for split_text in splitter.split_text(block["text"]):
            if should_skip_chunk(split_text):
                continue
            chunks.append(
                {
                    "page_number": block["page_number"],
                    "text": split_text,
                    "bbox": block["bbox"],
                }
            )
    return chunks


def annotate_chunks(chunks: list[dict], job_id: str | None = None) -> list[Annotation]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is missing for the Python annotation service.")

    client = OpenAI(api_key=api_key, timeout=ANNOTATION_REQUEST_TIMEOUT)
    annotations: list[Annotation] = []
    model_name = resolve_annotation_model(client, chunks[0]["text"] if chunks else "Test chunk")

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
                messages=build_annotation_messages(chunk["text"]),
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
    deduped_annotations = dedupe_annotations(annotations)
    validated_annotations = validate_annotations(client, model_name, deduped_annotations, chunks)
    return locally_validate_annotations(validated_annotations, chunks)


def resolve_annotation_model(client: OpenAI, probe_text: str) -> str:
    return resolve_chat_model(
        client,
        ANNOTATION_MODELS,
        [
            {"role": "system", "content": "Reply with []"},
            {"role": "user", "content": probe_text[:200] or "Test"},
        ],
        "annotation",
    )


def resolve_summary_model(client: OpenAI, probe_text: str) -> str:
    return resolve_chat_model(
        client,
        SUMMARY_MODELS,
        [
            {"role": "system", "content": "Reply with ok"},
            {"role": "user", "content": probe_text[:200] or "Test"},
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
    normalized = text.strip()
    fenced_match = re.search(r"```(?:markdown)?\s*([\s\S]*?)```", normalized)
    if fenced_match:
        normalized = fenced_match.group(1).strip()

    bullet_lines = [line.rstrip() for line in normalized.splitlines() if line.strip()]
    if not bullet_lines:
        return ""

    if not all(line.lstrip().startswith(("-", "*")) for line in bullet_lines):
        bullet_lines = [f"- {line.lstrip('-* ').strip()}" for line in bullet_lines[:3] if line.strip()]

    return "\n".join(bullet_lines[:3]).strip()


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
    chunks: list[dict],
) -> list[Annotation]:
    if not annotations:
        return []

    page_sources = build_page_sources(chunks)
    validation_response = client.chat.completions.create(
        model=model_name,
        max_completion_tokens=2200,
        temperature=0,
        messages=build_annotation_validation_messages(
            page_sources,
            [annotation.model_dump(mode="json") for annotation in annotations],
        ),
    )

    validated_text = extract_text_content(validation_response)
    parsed = parse_annotation_json(validated_text)
    if parsed is None:
        logger.warning(
            "Annotation validation agent returned non-JSON output; falling back to local validation. Raw preview: %.160r",
            validated_text,
        )
        return annotations

    validated_annotations: list[Annotation] = []
    for item in parsed:
        try:
            validated_annotations.append(
                Annotation(
                    type=item["type"],
                    text_ref=normalize_annotation_text_ref(item["text_ref"]),
                    note=item["note"],
                    importance=item["importance"],
                    bbox=annotations_by_page_number(annotations, item["page_number"], item["text_ref"]),
                    page_number=item["page_number"],
                )
            )
        except Exception:
            logger.warning("Skipping invalid validated annotation payload: %r", item, exc_info=True)

    return validated_annotations or annotations


def build_page_sources(chunks: list[dict]) -> dict[int, str]:
    page_sources: dict[int, list[str]] = {}
    for chunk in chunks:
        page_sources.setdefault(chunk["page_number"], []).append(chunk["text"])

    return {
        page_number: "\n".join(texts)
        for page_number, texts in page_sources.items()
    }


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


def locally_validate_annotations(annotations: list[Annotation], chunks: list[dict]) -> list[Annotation]:
    page_sources = build_page_sources(chunks)
    candidates: list[Annotation] = []

    for annotation in annotations:
        page_text = page_sources.get(annotation.page_number, "")
        annotation.text_ref = normalize_annotation_text_ref(annotation.text_ref)
        annotation.note = annotation.note.strip()
        if not annotation.text_ref or not annotation.note:
            continue
        if annotation.text_ref not in page_text:
            continue

        shortened_text_ref = shorten_text_ref(annotation, page_text)
        if not shortened_text_ref:
            continue

        annotation.text_ref = shortened_text_ref
        if text_ref_word_count(annotation.text_ref) >= annotation_word_limit(annotation.type):
            continue

        candidates.append(annotation)

    winners: dict[str, tuple[Annotation, int]] = {}
    for index, annotation in enumerate(candidates):
        key = normalize_annotation_text_ref_key(annotation.text_ref)
        if not key:
            continue

        current = winners.get(key)
        if current is None or annotation_rank(annotation, index) > annotation_rank(current[0], current[1]):
            winners[key] = (annotation, index)

    return [
        annotation
        for annotation, _ in sorted(
            winners.values(),
            key=lambda candidate: (candidate[0].page_number, candidate[1]),
        )
    ]


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
    type_priority = {
        "definition": 0,
        "note": 1,
        "highlight": 2,
    }
    return (annotation.importance, type_priority[annotation.type], -index)


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
