import { config } from "../config.js";

const DAILY_API = "https://api.daily.co/v1";

/**
 * Create a Daily.co video room that expires after the event ends.
 * Returns the room URL (e.g. https://yoursubdomain.daily.co/room-name).
 * Throws if DAILY_API_KEY is not configured.
 */
export async function createDailyRoom(params: {
  name: string;       // URL-safe room name (alphanumeric + dash)
  expiresAt: string;  // ISO 8601 — room auto-deletes after this time
}): Promise<string> {
  if (!config.daily.apiKey) {
    throw new Error("DAILY_API_KEY is not configured");
  }

  const exp = Math.floor(new Date(params.expiresAt).getTime() / 1000);

  const res = await fetch(`${DAILY_API}/rooms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.daily.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.name,
      privacy: "public",
      properties: { exp },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Daily.co API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { url: string };
  return data.url;
}

/** Returns true if Daily.co is configured and available for use. */
export function isDailyConfigured(): boolean {
  return config.daily.apiKey.length > 0;
}
