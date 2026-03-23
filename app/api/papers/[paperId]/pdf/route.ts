import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

export async function GET(_request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: paper } = await supabase.from("papers").select("pdf_url, arxiv_id").eq("id", paperId).maybeSingle();

  if (!paper?.pdf_url) {
    return NextResponse.json({ error: "Paper PDF not found." }, { status: 404 });
  }

  try {
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

async function fetchPdfFromCandidates(candidates: string[]) {
  const failures: string[] = [];

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/pdf",
          "User-Agent": "AnnotAgent/0.1 (+https://localhost)"
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

function buildPdfCandidates(sourceUrl: string, arxivId?: string) {
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
