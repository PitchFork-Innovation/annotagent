import { NextResponse } from "next/server";
import { z } from "zod";
import { Resend } from "resend";
import clientPromise from "@/lib/mongodb-client";
import { connectDB } from "@/lib/mongodb";
import { PasswordResetToken } from "@/lib/models";
import { generateResetToken, hashResetToken } from "@/lib/auth/passwords";
import { env } from "@/lib/env";

const schema = z.object({ email: z.string().email() });
const resend = new Resend(env.RESEND_API_KEY);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true });

  const { email } = parsed.data;
  const client = await clientPromise;
  const db = client.db();
  const user = await db.collection("users").findOne({ email });

  if (!user) return NextResponse.json({ ok: true });

  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await connectDB();
  await PasswordResetToken.create({ tokenHash, userId: String(user._id), expiresAt });

  const resetUrl = `${env.NEXTAUTH_URL}/reset-password?token=${token}`;

  try {
    await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: email,
      subject: "Reset your Annotagent password",
      html: `<p>Click to reset your password (link expires in 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
    });
  } catch {
    // Email failure is non-fatal; token is still stored
  }

  return NextResponse.json({ ok: true });
}
