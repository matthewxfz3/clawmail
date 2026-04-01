export const config = {
    domain: process.env.DOMAIN ?? (() => { throw new Error("DOMAIN env var required"); })(),
    stalwart: {
        url: process.env.STALWART_URL ?? "http://localhost:8080",
        adminUser: process.env.STALWART_ADMIN_USER ?? "admin",
        adminPassword: process.env.STALWART_ADMIN_PASSWORD ?? (() => { throw new Error("STALWART_ADMIN_PASSWORD env var required"); })(),
    },
    auth: {
        // Comma-separated list of valid API keys
        apiKeys: new Set((process.env.MCP_API_KEYS ?? "").split(",").map(k => k.trim()).filter(Boolean)),
    },
    limits: {
        maxAttachmentBytes: parseInt(process.env.MAX_ATTACHMENT_BYTES ?? "26214400", 10),
        // Rate limits (requests per window)
        sendEmailPerMinute: 20,
        createAccountPerHour: 10,
        readOpsPerMinute: 200,
    },
    port: parseInt(process.env.PORT ?? "3000", 10),
};
//# sourceMappingURL=config.js.map