/**
 * Minimal Secret Manager client using the REST API + GCP metadata service ADC.
 * Works on Cloud Run with no additional dependencies.
 */

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
const SM_BASE = "https://secretmanager.googleapis.com/v1";

// Simple in-process token cache — refreshed when it expires
let _cachedToken = "";
let _tokenExpiry  = 0;

async function getAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  // On Cloud Run: use the instance metadata service
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) },
  );
  if (!res.ok) throw new Error("Failed to obtain GCP access token from metadata service");

  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  _cachedToken = access_token;
  _tokenExpiry  = Date.now() + (expires_in - 60) * 1000; // 60-second buffer
  return _cachedToken;
}

/** Read the latest version of a secret. Returns null if it doesn't exist. */
export async function readSecret(name: string): Promise<string | null> {
  if (!PROJECT) return null;
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `${SM_BASE}/projects/${PROJECT}/secrets/${name}/versions/latest:access`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { payload?: { data?: string } };
    const b64 = data.payload?.data;
    return b64 ? Buffer.from(b64, "base64").toString("utf8") : null;
  } catch {
    return null;
  }
}

/** Create or update a secret with a new version. */
export async function writeSecret(name: string, value: string): Promise<void> {
  if (!PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT env var not set");
  const token = await getAccessToken();
  const secretPath = `projects/${PROJECT}/secrets/${name}`;

  // Try to create the secret (idempotent — ignores ALREADY_EXISTS)
  const createRes = await fetch(`${SM_BASE}/projects/${PROJECT}/secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: secretPath, replication: { automatic: {} } }),
  });
  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text().catch(() => "");
    // 409 = ALREADY_EXISTS, that's fine
    if (!text.includes("ALREADY_EXISTS") && !text.includes("already exists")) {
      throw new Error(`Failed to create secret "${name}": ${text}`);
    }
  }

  // Add a new version
  const payload = Buffer.from(value).toString("base64");
  const addRes = await fetch(`${SM_BASE}/${secretPath}:addSecretVersion`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { data: payload } }),
  });
  if (!addRes.ok) {
    const text = await addRes.text().catch(() => "");
    throw new Error(`Failed to write secret "${name}": ${text}`);
  }
}
