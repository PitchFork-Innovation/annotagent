import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

type LinkedPaperRow = {
  paper:
    | {
        pdf_url: string;
        arxiv_id: string | null;
        source: string | null;
        storage_path: string | null;
      }
    | Array<{
        pdf_url: string;
        arxiv_id: string | null;
        source: string | null;
        storage_path: string | null;
      }>
    | null;
};

export async function GET(_request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { data: linkedPaper } = await supabase
    .from("user_papers")
    .select("paper:papers(pdf_url, arxiv_id, source, storage_path)")
    .eq("user_id", user.id)
    .eq("paper_id", paperId)
    .maybeSingle();
  const paper = normalizeLinkedPaper((linkedPaper as LinkedPaperRow | null)?.paper);

  if (!paper?.pdf_url) {
    return NextResponse.json({ error: "Paper PDF not found." }, { status: 404 });
  }

  try {
    const cachedPdf = await fetchCachedPdf(paper);
    if (cachedPdf) {
      return new NextResponse(cachedPdf.bytes, {
        headers: {
          "Content-Type": cachedPdf.contentType,
          "Cache-Control": "private, max-age=3600"
        }
      });
    }

    if (paper.source === "upload") {
      return NextResponse.json({ error: "Uploaded PDF is missing from storage." }, { status: 404 });
    }

    const upstream = await fetchPdfFromCandidates(buildPdfCandidates(paper.pdf_url, paper.arxiv_id));

    const pdfBytes = await upstream.arrayBuffer();

    return new NextResponse(pdfBytes, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/pdf",
        "Cache-Control": "private, max-age=3600"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch PDF.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function normalizeLinkedPaper(paper: LinkedPaperRow["paper"] | undefined) {
  if (Array.isArray(paper)) {
    return paper[0] ?? null;
  }

  return paper;
}

async function fetchCachedPdf(paper: {
  arxiv_id: string | null;
  source: string | null;
  storage_path: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const objectPath =
    paper.source === "upload" ? paper.storage_path : paper.arxiv_id ? `arxiv/${paper.arxiv_id}.pdf` : null;

  if (!objectPath) {
    return null;
  }

  const { data, error } = await admin.storage.from(env.SUPABASE_STORAGE_BUCKET).download(objectPath);

  if (error || !data) {
    return null;
  }

  return {
    bytes: await data.arrayBuffer(),
    contentType: data.type || "application/pdf"
  };
}

async function fetchPdfFromCandidates(candidates: string[]) {
  const failures: string[] = [];

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/pdf",
          "User-Agent": "AnnotAgent/1.0 (+https://annotagent.vercel.app)"
        }
      });

      if (!response.ok) {
        failures.push(`${url} -> ${response.status}`);
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("pdf")) {
        failures.push(`${url} -> non-PDF content-type: ${contentType || "unknown"}`);
        continue;
      }

      return response;
    } catch (error) {
      failures.push(`${url} -> ${error instanceof Error ? error.message : "fetch failed"}`);
    }
  }

  throw new Error(failures.join(" | ") || "Unable to fetch PDF.");
}

function buildPdfCandidates(sourceUrl: string, arxivId?: string | null) {
  const candidates = new Set<string>();
  const normalizedSource = sourceUrl.replace(/^http:\/\//i, "https://");

  candidates.add(ensurePdfSuffix(normalizedSource));

  if (arxivId) {
    const normalizedId = arxivId.trim();
    candidates.add(`https://arxiv.org/pdf/${normalizedId}.pdf`);
    candidates.add(`https://export.arxiv.org/pdf/${normalizedId}.pdf`);
    candidates.add(`https://arxiv.org/pdf/${normalizedId}`);
    candidates.add(`https://export.arxiv.org/pdf/${normalizedId}`);
  }

  return Array.from(candidates);
}

function ensurePdfSuffix(url: string) {
  if (/^https:\/\/(?:export\.)?arxiv\.org\/pdf\/[^/]+$/i.test(url)) {
    return `${url}.pdf`;
  }

  return url;
}
