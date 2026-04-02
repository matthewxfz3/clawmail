import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.js";
import {
  toolCreateAccount,
  toolDeleteAccount,
  toolListAccounts,
} from "./tools/accounts.js";
import {
  toolListEmails,
  toolReadEmail,
  toolDeleteEmail,
  toolSearchEmails,
} from "./tools/mailbox.js";
import { toolSendEmail } from "./tools/send.js";
import { handleDashboard } from "./dashboard.js";

// ---------------------------------------------------------------------------
// Rate limiter — sliding window using timestamps per (apiKey, operation) key
// ---------------------------------------------------------------------------

const rateLimitWindows = new Map<string, number[]>();

/**
 * Returns true when the request is allowed, false when the limit is exceeded.
 * Prunes timestamps older than windowMs before checking.
 */
function checkRateLimit(
  key: string,
  apiKey: string,
  maxPerWindow: number,
  windowMs: number,
): boolean {
  const mapKey = `${apiKey}::${key}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  let timestamps = rateLimitWindows.get(mapKey);
  if (timestamps === undefined) {
    timestamps = [];
    rateLimitWindows.set(mapKey, timestamps);
  }

  // Remove timestamps outside the window.
  const pruned = timestamps.filter((t) => t > windowStart);
  rateLimitWindows.set(mapKey, pruned);

  if (pruned.length >= maxPerWindow) {
    return false; // limit exceeded
  }

  pruned.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okContent(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function errContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function rateLimitErr(tool: string) {
  return errContent(`Rate limit exceeded for tool "${tool}". Please try again later.`);
}

// ---------------------------------------------------------------------------
// MCP server factory — creates a fresh McpServer per request (stateless mode)
// ---------------------------------------------------------------------------

function createMcpServer(apiKey: string): McpServer {
  const server = new McpServer(
    { name: "clawmail", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Tool 1: create_account
  server.tool(
    "create_account",
    "Create a new email account on the mail server",
    { local_part: z.string().describe("The local part (before @) of the new email address") },
    async (args) => {
      if (!checkRateLimit("create_account", apiKey, config.limits.createAccountPerHour, 60 * 60 * 1000)) {
        return rateLimitErr("create_account");
      }
      try {
        const result = await toolCreateAccount(args.local_part);
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 2: list_accounts
  server.tool(
    "list_accounts",
    "List all email accounts on the mail server",
    {},
    async () => {
      if (!checkRateLimit("list_accounts", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        return rateLimitErr("list_accounts");
      }
      try {
        const result = await toolListAccounts();
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 3: delete_account
  server.tool(
    "delete_account",
    "Permanently delete an email account from the mail server",
    { local_part: z.string().describe("The local part (before @) of the account to delete") },
    async (args) => {
      if (!checkRateLimit("delete_account", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        return rateLimitErr("delete_account");
      }
      try {
        const result = await toolDeleteAccount(args.local_part);
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 4: list_emails
  server.tool(
    "list_emails",
    "List emails in a mailbox folder for the given account",
    {
      account: z.string().describe("The full email address of the account"),
      folder: z.string().optional().describe("Mailbox folder name (default: Inbox)"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of emails to return (1-100, default: 20)"),
    },
    async (args) => {
      if (!checkRateLimit("list_emails", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        return rateLimitErr("list_emails");
      }
      try {
        const result = await toolListEmails(args.account, args.folder, args.limit);
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 5: read_email
  server.tool(
    "read_email",
    "Retrieve the full content of a specific email",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
    },
    async (args) => {
      if (!checkRateLimit("read_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        return rateLimitErr("read_email");
      }
      try {
        const result = await toolReadEmail(args.account, args.email_id);
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 6: delete_email
  server.tool(
    "delete_email",
    "Move an email to the Trash folder",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
    },
    async (args) => {
      if (!checkRateLimit("delete_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        return rateLimitErr("delete_email");
      }
      try {
        const result = await toolDeleteEmail(args.account, args.email_id);
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 7: search_emails
  server.tool(
    "search_emails",
    "Full-text search across all emails for an account",
    {
      account: z.string().describe("The full email address of the account"),
      query: z.string().describe("Search query string"),
    },
    async (args) => {
      if (!checkRateLimit("search_emails", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        return rateLimitErr("search_emails");
      }
      try {
        const result = await toolSearchEmails(args.account, args.query);
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 8: send_email
  server.tool(
    "send_email",
    "Send an email from a local account to one or more recipients",
    {
      from_account: z.string().describe("The local part or full email address to send from"),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address(es)"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Plain-text email body (max 1 MiB)"),
      cc: z.array(z.string()).optional().describe("CC recipient email addresses"),
      bcc: z.array(z.string()).optional().describe("BCC recipient email addresses"),
    },
    async (args) => {
      if (!checkRateLimit("send_email", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        return rateLimitErr("send_email");
      }
      try {
        const result = await toolSendEmail({
          fromAccount: args.from_account,
          to: args.to,
          subject: args.subject,
          body: args.body,
          cc: args.cc,
          bcc: args.bcc,
        });
        return okContent(result);
      } catch (err) {
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server with API key auth middleware
// ---------------------------------------------------------------------------

/**
 * Authenticate the request using X-API-Key header.
 * Returns the api key string on success, or sends a 401 and returns null.
 */
function authenticate(req: IncomingMessage, res: ServerResponse): string | null {
  // config.auth.apiKeys is a Set<string>; if it's empty no key is configured
  // and we treat the server as unauthenticated (useful for dev).
  if (config.auth.apiKeys.size === 0) {
    return ""; // open — no keys configured
  }

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey !== "string" || !config.auth.apiKeys.has(apiKey)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized: missing or invalid X-API-Key header" }));
    return null;
  }

  return apiKey;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const { pathname } = new URL(req.url ?? "/", `http://localhost`);

  // Dashboard routes — no MCP auth required (uses its own session cookie)
  if (pathname.startsWith("/dashboard")) {
    await handleDashboard(req, res);
    return;
  }

  if (pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  if (req.method !== "POST" && req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const apiKey = authenticate(req, res);
  if (apiKey === null) return; // 401 already sent

  // Parse body for POST requests (raw Node.js HTTP doesn't pre-parse the body)
  let parsedBody: unknown;
  if (req.method === "POST") {
    parsedBody = await new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(undefined); }
      });
      req.on("error", reject);
    });
  }

  // Create a fresh server + transport per request (required for stateless mode).
  const mcpServer = createMcpServer(apiKey);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
    console.error("[clawmail-mcp] Unhandled transport error:", err);
  }
});

httpServer.listen(config.port, () => {
  console.log(`[clawmail-mcp] Listening on port ${config.port}`);
  console.log(`[clawmail-mcp] MCP endpoint: POST/GET http://0.0.0.0:${config.port}/mcp`);
  console.log(`[clawmail-mcp] Auth: ${config.auth.apiKeys.size > 0 ? `${config.auth.apiKeys.size} API key(s) configured` : "OPEN (no API keys set)"}`);
});
