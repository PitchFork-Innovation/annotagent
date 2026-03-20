from __future__ import annotations

import json
import os
from typing import Literal

import arxiv
import fitz
import httpx
from anthropic import Anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel, Field


ANNOTATION_PROMPT = """You are an expert research paper annotator. Given a passage of academic text, return a JSON array of annotation objects.
Each object must conform to this schema:
{ type: 'highlight' | 'note' | 'definition', text_ref: string, note: string, importance: 1 | 2 | 3 }

Rules:
highlight = key claim, result, or contribution.
note = explanation of a non-obvious statement.
definition = a domain-specific term that a non-expert would not know.
importance 3 = must-read, 1 = nice-to-have.
Return ONLY the JSON array, no prose."""


class IngestRequest(BaseModel):
    arxiv_id: str = Field(min_length=4)


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
    paper = resolve_arxiv_paper(request.arxiv_id)
    pdf_bytes = await fetch_pdf_bytes(paper.pdf_url)
    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    blocks = extract_blocks(pdf_doc)
    full_text = "\n\n".join(block["text"] for block in blocks)
    chunks = chunk_blocks(blocks)
    annotations = annotate_chunks(chunks)

    return IngestResponse(
        arxivId=request.arxiv_id,
        title=paper.title,
        abstract=paper.summary,
        pdfUrl=paper.pdf_url,
        fullText=full_text,
        pageCount=pdf_doc.page_count,
        starterQuestions=build_starter_questions(paper.title),
        annotations=annotations,
    )


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
            chunks.append(
                {
                    "page_number": block["page_number"],
                    "text": split_text,
                    "bbox": block["bbox"],
                }
            )
    return chunks


def annotate_chunks(chunks: list[dict]) -> list[Annotation]:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return build_fallback_annotations(chunks)

    client = Anthropic(api_key=api_key)
    annotations: list[Annotation] = []

    for chunk in chunks:
        response = client.messages.create(
            model="claude-3-5-haiku-latest",
            max_tokens=700,
            system=ANNOTATION_PROMPT,
            messages=[{"role": "user", "content": chunk["text"]}],
        )

        text = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
        parsed = json.loads(text)
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

    return annotations


def build_fallback_annotations(chunks: list[dict]) -> list[Annotation]:
    annotations: list[Annotation] = []
    for chunk in chunks[:18]:
        chunk_text = chunk["text"]
        sentences = [segment.strip() for segment in chunk_text.split(".") if segment.strip()]
        if not sentences:
            continue

        annotations.append(
            Annotation(
                type="highlight",
                text_ref=sentences[0][:160],
                note=f"Key passage surfaced from page {chunk['page_number']} pending Claude annotation.",
                importance=2,
                bbox=BoundingBox(**chunk["bbox"]),
                page_number=chunk["page_number"],
            )
        )

        if len(sentences) > 1:
            annotations.append(
                Annotation(
                    type="note",
                    text_ref=sentences[1][:160],
                    note="This section likely explains methodology or context. Configure Anthropic to replace this fallback note.",
                    importance=1,
                    bbox=BoundingBox(**chunk["bbox"]),
                    page_number=chunk["page_number"],
                )
            )
    return annotations


def build_starter_questions(title: str) -> list[str]:
    return [
        f"What is the main contribution of '{title}'?",
        "Which assumptions are most important for interpreting the results?",
        "What terms or concepts would a non-expert need defined first?",
        "What are the paper's biggest limitations or open questions?",
    ]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
