import type { ChatMessage } from "./types";
import { env } from "./env";

function hasRealKvRestConfig() {
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) {
    return false;
  }

  const token = env.KV_REST_API_TOKEN.trim().toLowerCase();

  if (!token || token === "placeholder" || token === "your-kv-token") {
    return false;
  }

  return true;
}

export async function getChatHistory(paperId: string): Promise<ChatMessage[]> {
  if (!hasRealKvRestConfig()) {
    return [];
  }

  try {
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
  } catch {
    return [];
  }
}

export async function setChatHistory(paperId: string, messages: ChatMessage[]) {
  if (!hasRealKvRestConfig()) {
    return;
  }

  try {
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
  } catch {
    // KV persistence is optional; keep chat usable even when the endpoint is unavailable.
  }
}
