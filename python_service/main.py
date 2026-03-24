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
ANNOTATION_REQUEST_TIMEOUT = float(os.getenv("OPENAI_ANNOTATION_TIMEOUT_SECONDS", "45"))


ANNOTATION_PROMPT = """
You are an expert research paper annotator helping a technically literate reader understand an academic passage quickly and deeply.

Given a passage of academic text, return a JSON array of annotation objects.
Each object must conform exactly to this schema:
{ "type": "highlight" | "note" | "definition", "text_ref": string, "note": string, "importance": 1 | 2 | 3 }

Goal:
Produce high-value annotations that help a reader identify the passage's main contributions, understand non-obvious reasoning, and learn domain-specific terms that block comprehension.

Target reader:
Assume the reader is intelligent and technically literate, but not an expert in this exact subfield.

Annotation types:
- highlight:
  Use for the most important claims, results, contributions, methodological innovations, or takeaways.
  A highlight should answer: "Why is this sentence or phrase important in the paper?"
- note:
  Use for non-obvious reasoning, hidden assumptions, implications, caveats, surprising comparisons, or interpretation that would help a reader understand the passage better.
  A note should add value beyond paraphrasing.
- definition:
  Use for specialized technical terms, datasets, benchmarks, acronyms, or methods that a non-expert likely would not know.
  Define the term briefly in the context of this passage.

Importance scale:
- 3 = critical to understanding the passage; core claim, main result, essential method, or essential term
- 2 = meaningfully helpful clarification or supporting idea
- 1 = useful but optional context

Rules:
- Be selective. Prefer fewer, high-value annotations over many weak ones.
- Do NOT annotate every sentence.
- Do NOT restate obvious text in the note.
- Do NOT define common academic vocabulary that a technical reader would already know.
- Do NOT create duplicate or overlapping annotations unless they serve clearly different purposes.
- Ground every annotation in the input passage only.
- "text_ref" must be the shortest exact quote from the passage that supports the annotation.
- "note" must be concise, specific, and helpful.
- For highlights, explain significance rather than repeating the claim.
- For notes, explain what is non-obvious, why it matters, or what follows from it.
- For definitions, define the term in plain but technically accurate language.
- If a passage has little annotatable content, return a small number of annotations or an empty array.

Quality bar:
A strong annotation should make a reader say: "That helped me understand something I would have missed."

Return ONLY the JSON array. No prose, no markdown, no extra text.
"""

ANNOTATION_REPAIR_PROMPT = """You fix annotation outputs into valid JSON.
Return ONLY a JSON array of objects with this schema:
{ type: 'highlight' | 'note' | 'definition', text_ref: string, note: string, importance: 1 | 2 | 3 }
Do not include markdown fences or prose."""


class IngestRequest(BaseModel):
    arxiv_id: str = Field(min_length=4)
    job_id: str | None = None


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
    pdfUrl: str
    fullText: str
    pageCount: int
    starterQuestions: list[str]
    annotations: list[Annotation]


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
            cleaned = " ".join((text or "").split())
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
                max_tokens=700,
                temperature=0,
                messages=[
                    {"role": "system", "content": ANNOTATION_PROMPT},
                    {
                        "role": "user",
                        "content": (
                            "Annotate the following academic passage.\n"
                            "Return only a JSON array matching the required schema.\n\n"
                            f"Passage:\n{chunk['text']}"
                        ),
                    }
                ],
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
                annotations.append(
                    Annotation(
                        type=item["type"],
                        text_ref=item["text_ref"],
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

    return annotations


def resolve_annotation_model(client: OpenAI, probe_text: str) -> str:
    last_error: Exception | None = None

    for model_name in ANNOTATION_MODELS:
        try:
            logger.info("Probing annotation model availability: %s", model_name)
            client.chat.completions.create(
                model=model_name,
                max_tokens=32,
                messages=[
                    {"role": "system", "content": "Reply with []"},
                    {"role": "user", "content": probe_text[:200] or "Test"},
                ],
            )
            logger.info("Using annotation model %s", model_name)
            return model_name
        except NotFoundError as error:
            last_error = error
            logger.warning("Annotation model %s is unavailable for this OpenAI account", model_name)
            continue

    tried_models = ", ".join(ANNOTATION_MODELS)
    raise RuntimeError(
        f"No configured OpenAI annotation models are available. Tried: {tried_models}"
    ) from last_error


def extract_text_content(response) -> str:
    return response.choices[0].message.content.strip() if response.choices and response.choices[0].message.content else ""


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
        max_tokens=700,
        temperature=0,
        messages=[
            {"role": "system", "content": ANNOTATION_REPAIR_PROMPT},
            {
                "role": "user",
                "content": (
                    "Original passage:\n"
                    f"{source_text[:2000]}\n\n"
                    "Broken annotation output:\n"
                    f"{bad_output or '[empty response]'}"
                ),
            }
        ],
    )

    repaired_text = extract_text_content(repair_response)
    repaired = parse_annotation_json(repaired_text)

    if repaired is None:
        raise RuntimeError(f"OpenAI returned non-JSON annotation output: {repaired_text[:200]!r}")

    return repaired


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
