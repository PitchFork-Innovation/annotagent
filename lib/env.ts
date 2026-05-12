import { z } from "zod";

const envSchema = z.object({
  PYTHON_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  PYTHON_SERVICE_SHARED_SECRET: z.string().default("dev-python-shared-secret"),
  PYTHON_INGEST_TIMEOUT_MS: z.coerce.number().int().positive().default(900000),
  OPENAI_API_KEY: z.string().default("demo-openai-key"),
  MONGODB_URI: z.string().default("mongodb://localhost:27017/annotagent"),
  NEXTAUTH_SECRET: z.string().default("dev-nextauth-secret"),
  NEXTAUTH_URL: z.string().url().default("http://localhost:3000"),
  RESEND_API_KEY: z.string().default("re_demo"),
  RESEND_FROM_EMAIL: z.string().email().default("noreply@example.com"),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().default("demo-key-id"),
  AWS_SECRET_ACCESS_KEY: z.string().default("demo-secret"),
  S3_BUCKET: z.string().default("annotagent-papers"),
});

export const env = envSchema.parse({
  PYTHON_SERVICE_URL: process.env.PYTHON_SERVICE_URL,
  PYTHON_SERVICE_SHARED_SECRET: process.env.PYTHON_SERVICE_SHARED_SECRET,
  PYTHON_INGEST_TIMEOUT_MS: process.env.PYTHON_INGEST_TIMEOUT_MS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  MONGODB_URI: process.env.MONGODB_URI,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  AWS_REGION: process.env.AWS_REGION,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  S3_BUCKET: process.env.S3_BUCKET,
});
