export async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (!text) {
    if (response.ok) {
      return {} as T;
    }

    throw new Error(`Request failed with status ${response.status}.`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok) {
      throw new Error(text.trim() || `Request failed with status ${response.status}.`);
    }

    throw new Error("Received an invalid response from the server.");
  }
}
