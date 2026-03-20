import { NextRequest, NextResponse } from "next/server";
import { getPaperWorkspace } from "@/lib/server-data";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

export async function GET(_request: NextRequest, { params }: Props) {
  const { paperId } = await params;
  const workspace = await getPaperWorkspace(paperId);

  if (!workspace) {
    return NextResponse.json({ error: "Paper not found." }, { status: 404 });
  }

  return NextResponse.json(workspace);
}
