import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth";
import { connectDB } from "@/lib/mongodb";
import { Paper, UserPaper } from "@/lib/models";
import { downloadObject } from "@/lib/s3";

type Props = {
  params: Promise<{ paperId: string }>;
};

export async function GET(_request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  await connectDB();
  const linked = await UserPaper.exists({ userId: user.id, paperId });
  if (!linked) {
    return NextResponse.json({ error: "Paper PDF not found." }, { status: 404 });
  }

  const paper = await Paper.findById(paperId, {
    pdfUrl: 1, arxivId: 1, source: 1, storagePath: 1,
  }).lean();

  if (!paper?.pdfUrl) {
    return NextResponse.json({ error: "Paper PDF not found." }, { status: 404 });
  }

  try {
    const cached = await fetchCachedPdf({
      arxivId: (paper.arxivId as string | null) ?? null,
      source: paper.source as string | null,
      storagePath: (paper.storagePath as string | null) ?? null,
    });
    if (cached) {
      return new NextResponse(cached.bytes, {
        headers: {
          "Content-Type": cached.contentType,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    if (paper.source === "upload") {
      return NextResponse.json({ error: "Uploaded PDF is missing from storage." }, { status: 404 });
    }

    const upstream = await fetchPdfFromCandidates(
      buildPdfCandidates(paper.pdfUrl as string, (paper.arxivId as string | null) ?? null)
    );
    const pdfBytes = await upstream.arrayBuffer();
    return new NextResponse(pdfBytes, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/pdf",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch PDF.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

async function fetchCachedPdf(paper: {
  arxivId: string | null;
  source: string | null;
  storagePath: string | null;
}): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const objectPath =
    paper.source === "upload"
      ? paper.storagePath
      : paper.arxivId
        ? `arxiv/${paper.arxivId}.pdf`
        : null;
  if (!objectPath) return null;
  return downloadObject(objectPath);
}

async function fetchPdfFromCandidates(candidates: string[]) {
  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/pdf",
          "User-Agent": "AnnotAgent/1.0 (+https://annotagent.vercel.app)",
        },
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
