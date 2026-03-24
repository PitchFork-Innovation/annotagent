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

ANNOTATION_EXAMPLES = """
GOOD vs BAD SPAN EXTRACTION EXAMPLES

These examples show how to extract MINIMAL text_ref from a larger passage.

Example 1 (highlight)

PASSAGE:
"Our method reduces inference latency by 43% compared to prior approaches while maintaining accuracy."

GOOD OUTPUT:
{
  "type": "highlight",
  "text_ref": "reduces inference latency by 43%",
  "note": "This is a key quantitative result showing a large practical speed improvement.",
  "importance": 3
}

BAD text_ref (too long):
"Our method reduces inference latency by 43% compared to prior approaches while maintaining accuracy."


Example 2 (highlight)

PASSAGE:
"We introduce a retrieval-augmented training objective that improves generalization."

GOOD OUTPUT:
{
  "type": "highlight",
  "text_ref": "retrieval-augmented training objective",
  "note": "This phrase names the paper's main methodological contribution.",
  "importance": 3
}

BAD text_ref:
"We introduce a retrieval-augmented training objective that improves generalization."


Example 3 (note)

PASSAGE:
"Under a fixed compute budget, our model outperforms all baselines."

GOOD OUTPUT:
{
  "type": "note",
  "text_ref": "fixed compute budget",
  "note": "This constraint makes the comparison fair, showing the gains are not due to using more compute.",
  "importance": 2
}

BAD text_ref:
"Under a fixed compute budget, our model outperforms all baselines."


Example 4 (note)

PASSAGE:
"Performance degrades sharply beyond 16 layers, suggesting optimization instability."

GOOD OUTPUT:
{
  "type": "note",
  "text_ref": "degrades sharply beyond 16 layers",
  "note": "This indicates a scaling limitation and potential instability in deeper models.",
  "importance": 2
}


Example 5 (definition)

PASSAGE:
"We approximate attention using the Nyström approximation to reduce complexity."

GOOD OUTPUT:
{
  "type": "definition",
  "text_ref": "Nyström approximation",
  "note": "A method for approximating large matrices using a subset of samples to reduce computation.",
  "importance": 2
}

BAD text_ref:
"approximate attention using the Nyström approximation"


Example 6 (definition)

PASSAGE:
"We evaluate performance using BLEU and ROUGE metrics."

GOOD OUTPUT:
{
  "type": "definition",
  "text_ref": "BLEU",
  "note": "A metric for evaluating generated text based on n-gram overlap with reference text.",
  "importance": 1
}
""".strip()


ANNOTATION_PROMPT = """
You are an expert research paper annotator.

Your task is to annotate an academic passage for a technically literate reader who is smart and comfortable with scientific writing, but is NOT necessarily an expert in this exact subfield.

You must return a JSON array of annotation objects.
Each object must conform exactly to this schema:
{
  "type": "highlight" | "note" | "definition",
  "text_ref": string,
  "note": string,
  "importance": 1 | 2 | 3
}

CORE GOAL
Produce only high-value annotations that materially improve reader understanding.
A strong annotation should help the reader do at least one of these:
- notice a central claim, contribution, result, or method detail
- understand a non-obvious implication, assumption, caveat, or comparison
- learn a specialized term, acronym, benchmark, dataset, or method name that would otherwise block comprehension

TARGET READER
Assume the reader:
- can follow technical prose
- knows general scientific and academic concepts
- does NOT automatically know niche jargon, specialized methods, datasets, or subfield-specific terminology

BE SELECTIVE
Prefer fewer, stronger annotations over many weak ones.
Do NOT annotate every sentence.
Do NOT annotate text just because it sounds formal or important.
Do NOT generate filler annotations.

ANNOTATION TYPES

1. highlight
Use for:
- central claim
- main contribution
- important result
- key methodological innovation
- especially important limitation or takeaway

A highlight should answer:
"Why is this statement important in the paper?"

2. note
Use for:
- non-obvious reasoning
- hidden assumptions
- implications
- caveats
- surprising comparisons
- interpretation that helps the reader understand significance

A note should add insight, not merely paraphrase.

3. definition
Use for:
- specialized jargon
- acronyms
- benchmarks
- datasets
- named methods / models
- technical terms a non-expert in the subfield likely would not know

A definition should explain the term briefly and in the context of this passage.

IMPORTANCE RUBRIC
- 3 = essential for understanding this passage; central claim/result/method or essential technical term
- 2 = meaningfully helpful clarification or supporting idea
- 1 = optional but useful context

STRICT text_ref RULES
"text_ref" must be the SHORTEST EXACT QUOTE from the passage that supports the annotation.
For definitions, it must only be the exact term being defined and strictly less than 5 words.
For notes and highlights, it must be the exact phrase or sentence that needs explanation and strictly less than 15 words unless deemed absolutely necessary.

This is critical:
- Do NOT quote whole sentences if only a phrase is needed.
- Do NOT include surrounding clauses unless they are necessary.
- For definitions, text_ref should usually be only the term itself or the shortest noun phrase containing it.
- For highlights, text_ref should usually be the exact claim/result sentence or the minimal clause containing the key claim.
- For notes, text_ref should point to the exact phrase or sentence that needs explanation.

Examples of good text_ref behavior:
- Good: "spectral bias"
- Bad: "Our model also exhibits spectral bias when trained on low-frequency signals."
- Good: "outperformed prior baselines by 6.2%"
- Bad: "In our experiments, the proposed method outperformed prior baselines by 6.2% on three benchmarks."
- Good: "contrastive pretraining"
- Bad: "We initialize the encoder with contrastive pretraining before fine-tuning on the downstream task."

ANTI-NOISE RULES
- Do NOT restate the obvious.
- Do NOT define common academic words like "optimization", "baseline", "embedding", "classifier", unless the passage uses them in a highly specialized way.
- Do NOT annotate generic background statements unless they are clearly central.
- Do NOT create multiple annotations that say nearly the same thing.
- Do NOT use note when the note is only a simpler paraphrase of the text.
- Do NOT use definition for terms a generally technical reader would already know.
- Do NOT annotate citations, section transitions, or generic framing language unless they contain a substantive claim.

NOTE WRITING RULES
- Be concise, specific, and informative.
- Add value beyond paraphrase.
- Prefer explaining significance, implication, assumption, comparison, or role in the paper.
- For definitions, define the term in plain but technically accurate language.
- For highlights, explain why the claim/result matters.
- Avoid vague notes like:
  - "This is important because it shows the method works."
  - "This term is a method used in machine learning."
  - "This means the authors got good results."

GOOD OUTPUT SHAPE
- Usually 1-6 annotations for a short-to-medium passage
- Return [] if the passage contains little worth annotating
- It is better to miss a weak annotation than include a low-value one

INTERNAL DECISION POLICY
Before writing the final JSON, internally filter candidate annotations using these questions:
1. Is this important for understanding the passage?
2. Is this non-obvious or genuinely helpful?
3. Is this grounded in a specific exact span?
4. Is this worth showing to the target reader?

Only keep annotations that are clearly useful.

FINAL RULES
- Return ONLY the JSON array
- No markdown
- No prose
- No explanation outside the JSON
- Every text_ref must be an exact substring from the passage
- text_ref must be minimal and precise
- No two objects may reuse the same normalized text_ref
- For definitions, text_ref must be under 8 words unless a longer exact quote is absolutely necessary for understanding.
- For notes and highlights, text_ref must be under 15 words unless a longer exact quote is absolutely necessary for understanding.
- If a longer text_ref is truly necessary, keep only the minimum extra words needed.

STYLE EXAMPLES
Follow these example annotations as closely as possible once they are provided:
""" + ANNOTATION_EXAMPLES + """
"""

ANNOTATION_REPAIR_PROMPT = """You fix annotation outputs into valid JSON.
Return ONLY a JSON array of objects with this schema:
{ type: 'highlight' | 'note' | 'definition', text_ref: string, note: string, importance: 1 | 2 | 3 }
Do not include markdown fences or prose.
No two objects may reuse the same normalized text_ref.
If type is 'definition', text_ref must be only the exact term being defined. If it isn't, adjust it to be.
Definitions must use text_ref under 8 words unless absolutely necessary.
Notes and highlights must use text_ref under 15 words unless absolutely necessary.
If examples are present below, follow them closely:
""" + ANNOTATION_EXAMPLES

ANNOTATION_VALIDATION_PROMPT = """
You are an annotation validation agent.

You receive:
1. page source text excerpts
2. a JSON array of annotation objects

Return ONLY a corrected JSON array of annotation objects with this exact schema:
{ "type": "highlight" | "note" | "definition", "text_ref": string, "note": string, "importance": 1 | 2 | 3, "page_number": int }

You may edit, shorten, deduplicate, or delete annotations.

Validation rules:
- Every text_ref must be an exact substring of the provided page excerpt for that page_number.
- definition text_ref must be under 5 words unless a longer exact quote is absolutely necessary for understanding.
- note and highlight text_ref must be under 15 words unless a longer exact quote is absolutely necessary for understanding.
- When a longer text_ref is truly necessary, keep only the minimum extra words needed.
- No two annotations may reuse the same normalized text_ref anywhere in the final array.
- Normalize text_ref by lowercasing, trimming whitespace, collapsing internal whitespace, and stripping surrounding punctuation.
- Prefer fewer, stronger annotations over many weak ones.
- If two annotations conflict or duplicate each other, keep the more useful one.
- Follow the example annotations below to the best of your ability.

Important behavior:
- Do not invent facts not grounded in the source excerpt.
- Do not keep an annotation just because it already exists.
- If an annotation cannot be made valid while staying useful, delete it.
- Preserve the original meaning when possible, but prioritize rule compliance.

Example annotations:
""" + ANNOTATION_EXAMPLES

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
                max_tokens=32,
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
        max_tokens=280,
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
        max_tokens=2200,
        temperature=0,
        messages=[
            {"role": "system", "content": ANNOTATION_VALIDATION_PROMPT},
            {
                "role": "user",
                "content": (
                    "Page source excerpts by page number:\n"
                    f"{json.dumps(page_sources, ensure_ascii=True)}\n\n"
                    "Annotations to validate:\n"
                    f"{json.dumps([annotation.model_dump(mode='json') for annotation in annotations], ensure_ascii=True)}"
                ),
            },
        ],
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
