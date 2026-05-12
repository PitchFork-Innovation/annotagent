import { NextResponse } from "next/server";
import { z } from "zod";
import clientPromise from "@/lib/mongodb-client";
import { connectDB } from "@/lib/mongodb";
import { PasswordResetToken } from "@/lib/models";
import { hashPassword, hashResetToken } from "@/lib/auth/passwords";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(6),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { token, password } = parsed.data;
  const tokenHash = hashResetToken(token);

  await connectDB();
  const tokenDoc = await PasswordResetToken.findOne({ tokenHash }).lean();

  if (!tokenDoc || tokenDoc.expiresAt < new Date()) {
    return NextResponse.json(
      { error: "Reset link is invalid or has expired." },
      { status: 400 }
    );
  }

  const newHash = await hashPassword(password);
  const client = await clientPromise;
  const db = client.db();

  await db.collection("users").updateOne(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { _id: tokenDoc.userId as any },
    { $set: { passwordHash: newHash, updatedAt: new Date() } }
  );

  await PasswordResetToken.deleteOne({ tokenHash });

  return NextResponse.json({ ok: true });
}
