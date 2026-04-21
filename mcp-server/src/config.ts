import { parseApiKeyMap, type CallerIdentity } from "./auth.js";
import * as https from "https";

// Compute domain and allowedDomains before config object
const _domain = process.env.DOMAIN ?? (() => { throw new Error("DOMAIN env var required") })();
const _extraDomains = (process.env.ALLOWED_DOMAINS ?? "")
  .split(",")
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

// TLS configuration for Stalwart connections (for self-signed certs in dev/staging)
const _skipTlsVerify = (process.env.STALWART_SKIP_TLS_VERIFY ?? "").toLowerCase() === "true";
const _httpsAgent = _skipTlsVerify
  ? new https.Agent({ rejectUnauthorized: false })
  : new https.Agent({ rejectUnauthorized: true });

export const config = {
  domain: _domain,
  allowedDomains: [...new Set([_domain.toLowerCase(), ..._extraDomains])],
  stalwart: {
    url: process.env.STALWART_URL ?? "https://localhost:8443",
    adminUser: process.env.STALWART_ADMIN_USER ?? "admin",
    adminPassword: process.env.STALWART_ADMIN_PASSWORD ?? (() => { throw new Error("STALWART_ADMIN_PASSWORD env var required") })(),
    httpsAgent: _httpsAgent,
  },
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY ?? (() => { throw new Error("SENDGRID_API_KEY env var required") })(),
    verifiedSender: process.env.SENDGRID_VERIFIED_SENDER ?? (() => { throw new Error("SENDGRID_VERIFIED_SENDER env var required") })(),
  },
  auth: {
    // Legacy: comma-separated list of valid API keys (all treated as admin)
    apiKeys: new Set((process.env.MCP_API_KEYS ?? "").split(",").map(k => k.trim()).filter(Boolean)),
    // Static admin tokens (comma-separated). These are never stored in JMAP;
    // they bypass all account scoping. Keep them secret — treat like root credentials.
    adminTokens: new Set((process.env.MCP_ADMIN_TOKENS ?? "").split(",").map(t => t.trim()).filter(Boolean)),
    // New: JSON array mapping each key to a role and optional bound account.
    // If MCP_API_KEY_MAP is set, it takes precedence. Otherwise, MCP_API_KEYS
    // keys are treated as admin for backward compatibility.
    apiKeyMap: (() => {
      const mapJson = process.env.MCP_API_KEY_MAP ?? "";
      if (mapJson.trim()) {
        try {
          return parseApiKeyMap(mapJson);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to parse MCP_API_KEY_MAP — fix the JSON or unset the variable. Detail: ${detail}`,
          );
        }
      }
      const legacyKeys = (process.env.MCP_API_KEYS ?? "").split(",").map(k => k.trim()).filter(Boolean);
      const map = new Map<string, CallerIdentity>();
      for (const key of legacyKeys) {
        map.set(key, { apiKey: key, role: "admin" });
      }
      return map;
    })(),
  },
  daily: {
    // Optional — if set, send_event_invite auto-creates a Daily.co video room
    apiKey: process.env.DAILY_API_KEY ?? "",
  },
  googleMeet: {
    // Optional — if all three are set, send_event_invite creates a Google Meet space
    clientId:     process.env.GOOGLE_MEET_CLIENT_ID     ?? "",
    clientSecret: process.env.GOOGLE_MEET_CLIENT_SECRET ?? "",
    refreshToken: process.env.GOOGLE_MEET_REFRESH_TOKEN ?? "",
  },
  dashboard: {
    user: process.env.DASHBOARD_USER ?? "admin",
    password: process.env.DASHBOARD_PASSWORD ?? "",
  },
  limits: {
    maxAttachmentBytes: parseInt(process.env.MAX_ATTACHMENT_BYTES ?? "26214400", 10),
    // Rate limits (requests per window)
    sendEmailPerMinute: 20,
    createAccountPerHour: 10,
    readOpsPerMinute: 200,
  },
  port: parseInt(process.env.PORT ?? "3000", 10),
  redis: {
    // Optional — when set, enables distributed rate limiting and idempotency.
    // Leave empty in dev; set to a Memorystore Redis URL in production.
    url: process.env.REDIS_URL ?? "",
  },
  telemetry: {
    serviceName: process.env.OTEL_SERVICE_NAME ?? "clawmail-mcp",
    logLevel: process.env.OTEL_LOG_LEVEL ?? "info",
  },
} as const;
