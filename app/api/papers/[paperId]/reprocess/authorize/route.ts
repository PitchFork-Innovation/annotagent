import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createPythonServiceToken } from "@/lib/python-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { data: linkedPaper } = await supabase
    .from("user_papers")
    .select("paper_id")
    .eq("user_id", user.id)
    .eq("paper_id", paperId)
    .maybeSingle();

  if (!linkedPaper) {
    return NextResponse.json({ error: "Paper not found in your library." }, { status: 404 });
  }

  return NextResponse.json({
    pythonServiceUrl: env.PYTHON_SERVICE_URL,
    token: createPythonServiceToken(payload.data.jobId, "reprocess")
  });
}
