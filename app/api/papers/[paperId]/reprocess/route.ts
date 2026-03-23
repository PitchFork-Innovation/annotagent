import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reprocessPaperAnnotations } from "@/lib/server-data";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

export async function POST(_request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const result = await reprocessPaperAnnotations(paperId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reprocess annotations.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
