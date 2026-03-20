import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().default("https://example.supabase.co"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().default("demo-anon-key"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default("demo-service-role-key"),
  SUPABASE_STORAGE_BUCKET: z.string().default("papers"),
  PYTHON_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  ANTHROPIC_API_KEY: z.string().default("demo-anthropic-key"),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().optional()
});

export const env = envSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
  PYTHON_SERVICE_URL: process.env.PYTHON_SERVICE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN
});
