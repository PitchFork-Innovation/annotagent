import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createUploadSlot } from "@/lib/server-data";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  filename: z.string().min(1),
  declaredSize: z.number().int().positive()
});

export async function POST(request: NextRequest) {
  const payload = bodySchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid upload init request." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  if (!payload.data.filename.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF uploads are supported." }, { status: 400 });
  }

  try {
    const slot = await createUploadSlot(user.id, payload.data.declaredSize);
    return NextResponse.json(slot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create upload slot.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
