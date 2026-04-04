export const config = {
  domain: process.env.DOMAIN ?? (() => { throw new Error("DOMAIN env var required") })(),
  stalwart: {
    url: process.env.STALWART_URL ?? "http://localhost:8080",
    adminUser: process.env.STALWART_ADMIN_USER ?? "admin",
    adminPassword: process.env.STALWART_ADMIN_PASSWORD ?? (() => { throw new Error("STALWART_ADMIN_PASSWORD env var required") })(),
  },
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY ?? (() => { throw new Error("SENDGRID_API_KEY env var required") })(),
    verifiedSender: process.env.SENDGRID_VERIFIED_SENDER ?? (() => { throw new Error("SENDGRID_VERIFIED_SENDER env var required") })(),
  },
  auth: {
    // Comma-separated list of valid API keys
    apiKeys: new Set((process.env.MCP_API_KEYS ?? "").split(",").map(k => k.trim()).filter(Boolean)),
  },
  daily: {
    // Optional — if set, send_event_invite auto-creates a Daily.co video room
    apiKey: process.env.DAILY_API_KEY ?? "",
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
} as const;
