import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reprocessPaperAnnotations } from "@/lib/server-data";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

const bodySchema = z.object({
  jobId: z.string().uuid().optional()
});

export async function POST(request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const payload = bodySchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid reprocess request." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const result = await reprocessPaperAnnotations(paperId, user.id, payload.data.jobId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reprocess annotations.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
