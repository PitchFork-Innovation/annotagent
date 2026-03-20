import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensurePaperIngested } from "@/lib/server-data";

const bodySchema = z.object({
  arxivId: z.string().min(4)
});

export async function POST(request: NextRequest) {
  const payload = bodySchema.safeParse(await request.json());

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid arXiv ID." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const paper = await ensurePaperIngested(payload.data.arxivId, user.id);
    return NextResponse.json({ paper });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper ingestion failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
