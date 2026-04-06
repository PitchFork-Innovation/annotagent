import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensurePaperIngested } from "@/lib/server-data";

export const maxDuration = 300;

const bodySchema = z.object({
  arxivId: z.string().min(4),
  jobId: z.string().uuid().optional()
});

export async function POST(request: NextRequest) {
  const payload = bodySchema.safeParse(await request.json());

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid arXiv ID." }, { status: 400 });
  }

  const arxivId = payload.data.arxivId.trim();
  const jobId = payload.data.jobId;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const paper = await ensurePaperIngested(arxivId, user.id, jobId);
    return NextResponse.json({ paper });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper ingestion failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
