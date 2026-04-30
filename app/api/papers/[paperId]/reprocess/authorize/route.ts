import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createPythonServiceToken } from "@/lib/python-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PaperSource } from "@/lib/types";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

const bodySchema = z.object({
  jobId: z.string().uuid()
});

type LinkedPaperRow = {
  paper: {
    id: string;
    source: string | null;
    arxiv_id: string | null;
    original_filename: string | null;
    storage_path: string | null;
    title: string;
    abstract: string;
    pdf_url: string;
  } | null;
};

const SIGNED_URL_TTL_SECONDS = 60 * 15;

export async function POST(request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const payload = bodySchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid reprocess authorization request." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { data: linkedPaper } = await supabase
    .from("user_papers")
    .select(
      "paper:papers(id, source, arxiv_id, original_filename, storage_path, title, abstract, pdf_url)"
    )
    .eq("user_id", user.id)
    .eq("paper_id", paperId)
    .maybeSingle();

  const paper = (linkedPaper as LinkedPaperRow | null)?.paper;
  if (!paper) {
    return NextResponse.json({ error: "Paper not found in your library." }, { status: 404 });
  }

  const source: PaperSource = paper.source === "upload" ? "upload" : "arxiv";

  let resolvedPdfUrl = paper.pdf_url;
  if (source === "upload") {
    if (!paper.storage_path) {
      return NextResponse.json({ error: "Upload paper is missing its storage path." }, { status: 500 });
    }
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .createSignedUrl(paper.storage_path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      return NextResponse.json(
        { error: error?.message ?? "Unable to create a signed URL for the uploaded PDF." },
        { status: 500 }
      );
    }
    resolvedPdfUrl = data.signedUrl;
  }

  return NextResponse.json({
    pythonServiceUrl: env.PYTHON_SERVICE_URL,
    token: createPythonServiceToken(payload.data.jobId, "reprocess"),
    paper: {
      id: paper.id,
      source,
      arxivId: paper.arxiv_id,
      originalFilename: paper.original_filename,
      storagePath: paper.storage_path,
      title: paper.title,
      abstract: paper.abstract,
      pdfUrl: resolvedPdfUrl
    }
  });
}
