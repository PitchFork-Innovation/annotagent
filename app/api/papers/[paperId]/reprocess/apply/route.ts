import { NextRequest, NextResponse } from "next/server";
import { ingestionPayloadSchema } from "@/lib/ingestion-schema";
import { applyReprocessedPaper } from "@/lib/server-data";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

export async function POST(request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const payload = ingestionPayloadSchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid reprocess payload." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const result = await applyReprocessedPaper(paperId, user.id, payload.data);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save reprocessed annotations.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
