import { connectDB } from "./mongodb";
import { Chat } from "./models/index";
import type { ChatMessage } from "./types";

const CHAT_TTL_MS = 24 * 60 * 60 * 1000;

export async function getChatHistory(paperId: string): Promise<ChatMessage[]> {
  await connectDB();
  const doc = await Chat.findOne({ paperId }).lean();
  if (!doc) return [];
  return (doc.messages as ChatMessage[]) ?? [];
}

export async function setChatHistory(paperId: string, messages: ChatMessage[]): Promise<void> {
  await connectDB();
  const expiresAt = new Date(Date.now() + CHAT_TTL_MS);
  await Chat.findOneAndUpdate(
    { paperId },
    { messages, expiresAt },
    { upsert: true, new: true }
  );
}
