import { NextRequest, NextResponse } from "next/server";
import { applyIngestedPaper } from "@/lib/server-data";
import { ingestionPayloadSchema } from "@/lib/ingestion-schema";
import { getSessionUser } from "@/auth";

export async function POST(request: NextRequest) {
  const payload = ingestionPayloadSchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid ingestion payload." }, { status: 400 });
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const paper = await applyIngestedPaper(payload.data, user.id);
    return NextResponse.json({ paper: { id: paper._id as string } });
  } catch (error) {
    console.error("[annotagent] /api/ingest/apply failed", error);
    const message = error instanceof Error ? error.message : "Unable to save ingested paper.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
