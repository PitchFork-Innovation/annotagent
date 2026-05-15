import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createPythonServiceToken } from "@/lib/python-auth";
import { getSessionUser } from "@/auth";
import { connectDB } from "@/lib/mongodb";
import { Paper, UserPaper } from "@/lib/models";
import { createPresignedGetUrl } from "@/lib/s3";
import type { PaperSource } from "@/lib/types";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

const bodySchema = z.object({
  jobId: z.string().uuid()
});

export async function POST(request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const payload = bodySchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid reprocess authorization request." }, { status: 400 });
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  await connectDB();

  const linked = await UserPaper.exists({ userId: user.id, paperId });
  if (!linked) {
    return NextResponse.json({ error: "Paper not found in your library." }, { status: 404 });
  }

  const paper = await Paper.findById(paperId, {
    source: 1,
    arxivId: 1,
    originalFilename: 1,
    storagePath: 1,
    title: 1,
    abstract: 1,
    pdfUrl: 1,
  }).lean();

  if (!paper) {
    return NextResponse.json({ error: "Paper not found in your library." }, { status: 404 });
  }

  const source: PaperSource = paper.source === "upload" ? "upload" : "arxiv";

  let resolvedPdfUrl = paper.pdfUrl as string;
  if (source === "upload") {
    if (!paper.storagePath) {
      return NextResponse.json({ error: "Upload paper is missing its storage path." }, { status: 500 });
    }
    try {
      resolvedPdfUrl = await createPresignedGetUrl(paper.storagePath as string);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create a signed URL for the uploaded PDF.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return NextResponse.json({
    pythonServiceUrl: env.PYTHON_SERVICE_URL,
    token: createPythonServiceToken(payload.data.jobId, "reprocess"),
    paper: {
      id: paper._id,
      source,
      arxivId: (paper.arxivId as string | null) ?? null,
      originalFilename: (paper.originalFilename as string | null) ?? null,
      storagePath: (paper.storagePath as string | null) ?? null,
      title: paper.title as string,
      abstract: paper.abstract as string,
      pdfUrl: resolvedPdfUrl
    }
  });
}
