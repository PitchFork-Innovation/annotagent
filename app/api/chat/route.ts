import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getPaperWorkspace, upsertChatHistory } from "@/lib/server-data";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";

const requestSchema = z.object({
  paperId: z.string().uuid(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1)
    })
  )
});

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Authentication required.", { status: 401 });
  }

  const payload = requestSchema.parse(await request.json());
  const workspace = await getPaperWorkspace(payload.paperId);

  if (!workspace) {
    return new Response("Paper not found", { status: 404 });
  }

  const promptContext = workspace.paper.fullText;
  const latestUserMessage = payload.messages[payload.messages.length - 1];

  const result = streamText({
    model: openai(CHAT_MODEL),
    system: [
      "You answer questions about a single arXiv paper.",
      "Use only the paper context and say when the paper does not support a claim.",
      "Be crisp, cite sections/pages when the context includes them, and explain jargon clearly.",
      "Paper context:",
      promptContext
    ].join("\n\n"),
    messages: payload.messages.map((message) => ({
      role: message.role,
      content: message.content
    })),
    onFinish: async ({ text }) => {
      if (!latestUserMessage) {
        return;
      }

      await upsertChatHistory(payload.paperId, [
        ...payload.messages,
        { role: "assistant", content: text }
      ]);
    }
  });

  return result.toDataStreamResponse();
}
