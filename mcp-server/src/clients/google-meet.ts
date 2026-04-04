import { config } from "../config.js";
import { readSecret } from "./secret-manager.js";

const TOKEN_URL  = "https://oauth2.googleapis.com/token";
const MEET_API   = "https://meet.googleapis.com/v2/spaces";
const SCOPES     = "https://www.googleapis.com/auth/meetings.space.created";

/** Resolve credentials: env var first, Secret Manager fallback. */
async function resolveCreds(): Promise<{ clientId: string; clientSecret: string; refreshToken: string }> {
  const clientId     = config.googleMeet.clientId     || await readSecret("google-meet-client-id")     || "";
  const clientSecret = config.googleMeet.clientSecret || await readSecret("google-meet-client-secret") || "";
  const refreshToken = config.googleMeet.refreshToken || await readSecret("google-meet-refresh-token") || "";
  return { clientId, clientSecret, refreshToken };
}

export async function isMeetConfigured(): Promise<boolean> {
  const { clientId, clientSecret, refreshToken } = await resolveCreds();
  return clientId.length > 0 && clientSecret.length > 0 && refreshToken.length > 0;
}

/** Exchange a refresh token for a fresh access token. */
async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = await resolveCreds();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to refresh Google access token: ${text}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Create a Google Meet space and return the meeting URL.
 * e.g. "https://meet.google.com/xxx-yyy-zzz"
 */
export async function createMeetSpace(): Promise<string> {
  const accessToken = await getAccessToken();
  const res = await fetch(MEET_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Meet API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { meetingUri: string };
  return data.meetingUri;
}

// ---------------------------------------------------------------------------
// OAuth helpers (used by dashboard setup flow)
// ---------------------------------------------------------------------------

/** Build the Google authorization URL for the Meet API scope. */
export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",
    prompt:        "consent",  // always return refresh_token
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Exchange an authorization code for tokens. Returns { refreshToken, email }. */
export async function exchangeCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ refreshToken: string; email: string }> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code:          params.code,
      client_id:     params.clientId,
      client_secret: params.clientSecret,
      redirect_uri:  params.redirectUri,
      grant_type:    "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(`Token exchange failed: ${text}`);
  }
  const tokens = (await tokenRes.json()) as { refresh_token: string; access_token: string };
  if (!tokens.refresh_token) throw new Error("No refresh_token returned — ensure prompt=consent was set");

  // Fetch the authorized email for display
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const email = userRes.ok
    ? ((await userRes.json()) as { email: string }).email ?? "unknown"
    : "unknown";

  return { refreshToken: tokens.refresh_token, email };
}
