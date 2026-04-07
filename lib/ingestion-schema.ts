import { z } from "zod";

const highlightFragmentSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

const boundingBoxSchema = highlightFragmentSchema.extend({
  fragments: z.array(highlightFragmentSchema).optional()
});

const textAnchorSchema = z.object({
  page_text_start: z.number().int(),
  page_text_end: z.number().int(),
  occurrence_index: z.number().int().nonnegative()
});

const annotationSchema = z.object({
  page_number: z.number().int().positive(),
  type: z.enum(["highlight", "note", "definition"]),
  text_ref: z.string().min(1),
  note: z.string().min(1),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  bbox: boundingBoxSchema,
  anchor: textAnchorSchema.nullish()
});

export const ingestionPayloadSchema = z.object({
  arxivId: z.string().min(4),
  title: z.string().min(1),
  abstract: z.string(),
  summary: z.string(),
  pdfUrl: z.string().url(),
  fullText: z.string().min(1),
  pageCount: z.number().int().positive(),
  starterQuestions: z.array(z.string()),
  annotationStyle: z.enum(["default", "novice", "expert"]).optional().default("default"),
  annotations: z.array(annotationSchema)
});
