import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

function getProgressFilePath(jobId: string) {
  return path.join(os.tmpdir(), "annotagent-progress", `${jobId}.json`);
}

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");

  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }

  try {
    const content = await fs.readFile(getProgressFilePath(jobId), "utf8");
    return NextResponse.json(JSON.parse(content));
  } catch {
    return NextResponse.json({
      status: "pending",
      stage: "queued",
      message: "Waiting for annotation pipeline to report progress."
    });
  }
}
