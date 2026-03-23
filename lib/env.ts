import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().default("https://example.supabase.co"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().default("demo-anon-key"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default("demo-service-role-key"),
  SUPABASE_STORAGE_BUCKET: z.string().default("papers"),
  PYTHON_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  PYTHON_INGEST_TIMEOUT_MS: z.coerce.number().int().positive().default(900000),
  OPENAI_API_KEY: z.string().default("demo-openai-key"),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().optional()
});

export const env = envSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
  PYTHON_SERVICE_URL: process.env.PYTHON_SERVICE_URL,
  PYTHON_INGEST_TIMEOUT_MS: process.env.PYTHON_INGEST_TIMEOUT_MS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN
});
