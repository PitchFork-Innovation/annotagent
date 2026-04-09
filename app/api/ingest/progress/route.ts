import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createPythonServiceToken } from "@/lib/python-auth";
import { env } from "@/lib/env";

const searchSchema = z.object({
  jobId: z.string().uuid(),
  action: z.enum(["ingest", "reprocess"]).default("ingest")
});

export async function GET(request: NextRequest) {
  const parsed = searchSchema.safeParse({
    jobId: request.nextUrl.searchParams.get("jobId"),
    action: request.nextUrl.searchParams.get("action") ?? "ingest"
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }

  const { jobId, action } = parsed.data;

  try {
    console.info("[annotagent] progress proxy request", {
      action,
      jobId
    });
    const url = new URL("/progress", env.PYTHON_SERVICE_URL);
    url.searchParams.set("jobId", jobId);
    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${createPythonServiceToken(jobId, action)}`
      }
    });
    const text = await response.text();
    console.info("[annotagent] progress proxy response", {
      action,
      jobId,
      ok: response.ok,
      status: response.status,
      body: text
    });

    if (!response.ok) {
      return NextResponse.json({
        status: "pending",
        stage: "queued",
        message: "Waiting for annotation pipeline to report progress."
      });
    }

    return new NextResponse(text, {
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    console.warn("[annotagent] progress proxy error", {
      action,
      jobId,
      error: error instanceof Error ? error.message : String(error)
    });
    return NextResponse.json({
      status: "pending",
      stage: "queued",
      message: "Waiting for annotation pipeline to report progress."
    });
  }
}
