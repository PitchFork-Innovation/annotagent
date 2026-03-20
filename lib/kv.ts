import type { ChatMessage } from "./types";
import { env } from "./env";

export async function getChatHistory(paperId: string): Promise<ChatMessage[]> {
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) {
    return [];
  }

  const response = await fetch(`${env.KV_REST_API_URL}/get/paper:${paperId}:chat`, {
    headers: {
      Authorization: `Bearer ${env.KV_REST_API_TOKEN}`
    },
    cache: "no-store"
  });

  if (!response.ok) {
    return [];
  }

  const json = (await response.json()) as { result?: string };
  return json.result ? (JSON.parse(json.result) as ChatMessage[]) : [];
}

export async function setChatHistory(paperId: string, messages: ChatMessage[]) {
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) {
    return;
  }

  await fetch(`${env.KV_REST_API_URL}/set/paper:${paperId}:chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      value: JSON.stringify(messages),
      ex: 86400
    })
  });
}
