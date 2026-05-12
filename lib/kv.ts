import type { ChatMessage } from "./types";

// KV_REST_API_URL and KV_REST_API_TOKEN are optional legacy Vercel KV vars.
// They are read directly from process.env (not the typed env schema) so they
// don't block startup when absent.  In Phase 2+ this module will be replaced
// by the MongoDB Chat model.

function hasRealKvRestConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return false;
  }

  const normalized = token.trim().toLowerCase();

  if (!normalized || normalized === "placeholder" || normalized === "your-kv-token") {
    return false;
  }

  return true;
}

export async function getChatHistory(paperId: string): Promise<ChatMessage[]> {
  if (!hasRealKvRestConfig()) {
    return [];
  }

  try {
    const response = await fetch(
      `${process.env.KV_REST_API_URL}/get/paper:${paperId}:chat`,
      {
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`
        },
        cache: "no-store"
      }
    );

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
    await fetch(`${process.env.KV_REST_API_URL}/set/paper:${paperId}:chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
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
