import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createPythonServiceToken } from "@/lib/python-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  jobId: z.string().uuid()
});

export async function POST(request: NextRequest) {
  const payload = bodySchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid ingest authorization request." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  return NextResponse.json({
    pythonServiceUrl: env.PYTHON_SERVICE_URL,
    token: createPythonServiceToken(payload.data.jobId, "ingest")
  });
}
