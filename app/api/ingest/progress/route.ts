import { NextRequest, NextResponse } from "next/server";
import { createPythonServiceToken } from "@/lib/python-auth";
import { env } from "@/lib/env";

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");

  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }

  try {
    const url = new URL("/progress", env.PYTHON_SERVICE_URL);
    url.searchParams.set("jobId", jobId);
    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${createPythonServiceToken(jobId, "ingest")}`
      }
    });
    const text = await response.text();

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
  } catch {
    return NextResponse.json({
      status: "pending",
      stage: "queued",
      message: "Waiting for annotation pipeline to report progress."
    });
  }
}
