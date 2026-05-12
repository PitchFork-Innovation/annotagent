import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import clientPromise from "@/lib/mongodb-client";
import { hashPassword } from "@/lib/auth/passwords";

const schema = z.object({
  email: z.string().email(),
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
    return NextResponse.json({ error: "Invalid email or password." }, { status: 400 });
  }

  const { email, password } = parsed.data;
  const client = await clientPromise;
  const db = client.db();
  const users = db.collection("users");

  const existing = await users.findOne({ email });
  if (existing) {
    return NextResponse.json(
      { error: "An account with that email already exists." },
      { status: 409 }
    );
  }

  const userId = randomUUID();
  const now = new Date();
  const passwordHash = await hashPassword(password);

  await users.insertOne({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _id: userId as any,
    email,
    emailVerified: null,
    passwordHash,
    name: null,
    image: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.collection("accounts").insertOne({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _id: randomUUID() as any,
    userId,
    type: "credentials",
    provider: "credentials",
    providerAccountId: userId,
    createdAt: now,
    updatedAt: now,
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
