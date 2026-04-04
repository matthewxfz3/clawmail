import { config } from "../config.js";
import { readSecret } from "./secret-manager.js";

const DAILY_API = "https://api.daily.co/v1";

async function resolveApiKey(): Promise<string> {
  return config.daily.apiKey || await readSecret("daily-api-key") || "";
}

export async function isDailyConfigured(): Promise<boolean> {
  return (config.daily.apiKey || await readSecret("daily-api-key") || "").length > 0;
}

/**
 * Create a Daily.co video room that expires after the event ends.
 * Returns the room URL (e.g. https://yoursubdomain.daily.co/room-name).
 */
export async function createDailyRoom(params: {
  name: string;       // URL-safe room name (alphanumeric + dash)
  expiresAt: string;  // ISO 8601 — room auto-deletes after this time
}): Promise<string> {
  const apiKey = await resolveApiKey();
  if (!apiKey) throw new Error("DAILY_API_KEY is not configured");

  const exp = Math.floor(new Date(params.expiresAt).getTime() / 1000);

  const res = await fetch(`${DAILY_API}/rooms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
