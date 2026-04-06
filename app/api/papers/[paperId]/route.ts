import { NextRequest, NextResponse } from "next/server";
import { getPaperWorkspace } from "@/lib/server-data";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

export async function GET(_request: NextRequest, { params }: Props) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { paperId } = await params;
  const workspace = await getPaperWorkspace(paperId);

  if (!workspace) {
    return NextResponse.json({ error: "Paper not found." }, { status: 404 });
  }

  return NextResponse.json(workspace);
}
