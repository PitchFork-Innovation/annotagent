# Python ingestion service

This service implements the PRD's extraction pipeline:

- resolve arXiv ID via the `arxiv` client
- fetch the paper PDF
- extract page text blocks and bounding boxes with PyMuPDF
- split text into paragraph-scale chunks
- call OpenAI `gpt-4o-mini` for structured annotation JSON
- validate annotations with Pydantic before returning them

Run locally:

```bash
python3 -m venv .venv
.venv/bin/pip install -r python_service/requirements.txt
.venv/bin/python python_service/main.py
```
