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
import {
  toolCreateEvent,
  toolListEvents,
  toolGetEvent,
  toolUpdateEvent,
  toolDeleteEvent,
  toolCheckAvailability,
} from "./tools/calendar.js";
import { toolMarkAsSpam, toolMarkAsNotSpam } from "./tools/spam.js";
import {
  toolCreateRule,
  toolListRules,
  toolDeleteRule,
  toolApplyRules,
} from "./tools/rules.js";
import { handleDashboard } from "./dashboard.js";
import { recordCall, recordError, recordRateLimit, recordAccountCreated, recordAccountSend } from "./metrics.js";

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
      recordCall("create_account");
      if (!checkRateLimit("create_account", apiKey, config.limits.createAccountPerHour, 60 * 60 * 1000)) {
        recordRateLimit("create_account");
        return rateLimitErr("create_account");
      }
      try {
        const result = await toolCreateAccount(args.local_part);
        recordAccountCreated(result.email);
        return okContent(result);
      } catch (err) {
        recordError("create_account");
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
      recordCall("list_accounts");
      if (!checkRateLimit("list_accounts", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_accounts");
        return rateLimitErr("list_accounts");
      }
      try {
        const result = await toolListAccounts();
        return okContent(result);
      } catch (err) {
        recordError("list_accounts");
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
      recordCall("delete_account");
      if (!checkRateLimit("delete_account", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("delete_account");
        return rateLimitErr("delete_account");
      }
      try {
        const result = await toolDeleteAccount(args.local_part);
        return okContent(result);
      } catch (err) {
        recordError("delete_account");
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
      recordCall("list_emails");
      if (!checkRateLimit("list_emails", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_emails");
        return rateLimitErr("list_emails");
      }
      try {
        const result = await toolListEmails(args.account, args.folder, args.limit);
        return okContent(result);
      } catch (err) {
        recordError("list_emails");
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
      recordCall("read_email");
      if (!checkRateLimit("read_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("read_email");
        return rateLimitErr("read_email");
      }
      try {
        const result = await toolReadEmail(args.account, args.email_id);
        return okContent(result);
      } catch (err) {
        recordError("read_email");
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
      recordCall("delete_email");
      if (!checkRateLimit("delete_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("delete_email");
        return rateLimitErr("delete_email");
      }
      try {
        const result = await toolDeleteEmail(args.account, args.email_id);
        return okContent(result);
      } catch (err) {
        recordError("delete_email");
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
      recordCall("search_emails");
      if (!checkRateLimit("search_emails", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("search_emails");
        return rateLimitErr("search_emails");
      }
      try {
        const result = await toolSearchEmails(args.account, args.query);
        return okContent(result);
      } catch (err) {
        recordError("search_emails");
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
      recordCall("send_email");
      if (!checkRateLimit("send_email", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("send_email");
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
        const fromEmail = args.from_account.includes("@")
          ? args.from_account
          : `${args.from_account}@${config.domain}`;
        recordAccountSend(fromEmail);
        return okContent(result);
      } catch (err) {
        recordError("send_email");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Calendar tools ──────────────────────────────────────────────────────────

  // Tool 9: create_event
  server.tool(
    "create_event",
    "Create a calendar event for an agent account",
    {
      account: z.string().describe("The full email address of the account"),
      title: z.string().describe("Event title"),
      start: z.string().describe("Start date-time in ISO 8601 format (e.g. 2026-04-10T14:00:00Z)"),
      end: z.string().describe("End date-time in ISO 8601 format — must be after start"),
      description: z.string().optional().describe("Optional event description"),
      attendees: z.array(z.string()).optional().describe("Optional list of attendee email addresses"),
    },
    async (args) => {
      recordCall("create_event");
      if (!checkRateLimit("create_event", apiKey, 60, 60 * 60 * 1000)) {
        recordRateLimit("create_event");
        return rateLimitErr("create_event");
      }
      try {
        return okContent(await toolCreateEvent(args));
      } catch (err) {
        recordError("create_event");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 10: list_events
  server.tool(
    "list_events",
    "List calendar events for an agent account, optionally filtered by date range",
    {
      account: z.string().describe("The full email address of the account"),
      from_date: z.string().optional().describe("Only return events ending after this ISO 8601 date-time"),
      to_date: z.string().optional().describe("Only return events starting before this ISO 8601 date-time"),
    },
    async (args) => {
      recordCall("list_events");
      if (!checkRateLimit("list_events", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_events");
        return rateLimitErr("list_events");
      }
      try {
        return okContent(await toolListEvents(args));
      } catch (err) {
        recordError("list_events");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 11: get_event
  server.tool(
    "get_event",
    "Get a single calendar event by ID",
    {
      account: z.string().describe("The full email address of the account"),
      event_id: z.string().describe("The event ID returned by create_event"),
    },
    async (args) => {
      recordCall("get_event");
      if (!checkRateLimit("get_event", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("get_event");
        return rateLimitErr("get_event");
      }
      try {
        return okContent(await toolGetEvent(args));
      } catch (err) {
        recordError("get_event");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 12: update_event
  server.tool(
    "update_event",
    "Update fields of an existing calendar event",
    {
      account: z.string().describe("The full email address of the account"),
      event_id: z.string().describe("The event ID to update"),
      title: z.string().optional(),
      start: z.string().optional().describe("New start date-time in ISO 8601"),
      end: z.string().optional().describe("New end date-time in ISO 8601"),
      description: z.string().optional(),
      attendees: z.array(z.string()).optional(),
    },
    async (args) => {
      recordCall("update_event");
      if (!checkRateLimit("update_event", apiKey, 60, 60 * 60 * 1000)) {
        recordRateLimit("update_event");
        return rateLimitErr("update_event");
      }
      try {
        return okContent(await toolUpdateEvent(args));
      } catch (err) {
        recordError("update_event");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 13: delete_event
  server.tool(
    "delete_event",
    "Delete a calendar event by ID",
    {
      account: z.string().describe("The full email address of the account"),
      event_id: z.string().describe("The event ID to delete"),
    },
    async (args) => {
      recordCall("delete_event");
      if (!checkRateLimit("delete_event", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("delete_event");
        return rateLimitErr("delete_event");
      }
      try {
        return okContent(await toolDeleteEvent(args));
      } catch (err) {
        recordError("delete_event");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 14: check_availability
  server.tool(
    "check_availability",
    "Check whether a time window is free of calendar events for an account",
    {
      account: z.string().describe("The full email address of the account"),
      start: z.string().describe("Window start in ISO 8601"),
      end: z.string().describe("Window end in ISO 8601"),
    },
    async (args) => {
      recordCall("check_availability");
      if (!checkRateLimit("check_availability", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("check_availability");
        return rateLimitErr("check_availability");
      }
      try {
        return okContent(await toolCheckAvailability(args));
      } catch (err) {
        recordError("check_availability");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Spam tools ───────────────────────────────────────────────────────────────

  // Tool 15: mark_as_spam
  server.tool(
    "mark_as_spam",
    "Move an email to the Junk folder (mark as spam)",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID to mark as spam"),
    },
    async (args) => {
      recordCall("mark_as_spam");
      if (!checkRateLimit("mark_as_spam", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("mark_as_spam");
        return rateLimitErr("mark_as_spam");
      }
      try {
        return okContent(await toolMarkAsSpam(args));
      } catch (err) {
        recordError("mark_as_spam");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 16: mark_as_not_spam
  server.tool(
    "mark_as_not_spam",
    "Move an email from Junk back to Inbox (mark as not spam)",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID to move back to Inbox"),
    },
    async (args) => {
      recordCall("mark_as_not_spam");
      if (!checkRateLimit("mark_as_not_spam", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("mark_as_not_spam");
        return rateLimitErr("mark_as_not_spam");
      }
      try {
        return okContent(await toolMarkAsNotSpam(args));
      } catch (err) {
        recordError("mark_as_not_spam");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Mailbox rules tools ──────────────────────────────────────────────────────

  // Tool 17: create_rule
  server.tool(
    "create_rule",
    "Create a mailbox rule that matches emails by condition and applies an action when apply_rules is called",
    {
      account: z.string().describe("The full email address of the account"),
      name: z.string().describe("A descriptive name for this rule"),
      condition: z.object({
        from: z.string().optional().describe("Substring match on sender address (case-insensitive)"),
        subject: z.string().optional().describe("Substring match on subject (case-insensitive)"),
        hasAttachment: z.boolean().optional().describe("Match emails with (true) or without (false) attachments"),
        olderThanDays: z.number().int().min(1).optional().describe("Match emails older than N days"),
      }).describe("At least one condition field is required"),
      action: z.object({
        moveTo: z.string().optional().describe("Destination folder name (created if it doesn't exist)"),
        markRead: z.boolean().optional().describe("Mark matched emails as read"),
        delete: z.boolean().optional().describe("Move matched emails to Trash"),
      }).describe("At least one action field is required"),
    },
    async (args) => {
      recordCall("create_rule");
      if (!checkRateLimit("create_rule", apiKey, 60, 60 * 60 * 1000)) {
        recordRateLimit("create_rule");
        return rateLimitErr("create_rule");
      }
      try {
        return okContent(await toolCreateRule(args));
      } catch (err) {
        recordError("create_rule");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 18: list_rules
  server.tool(
    "list_rules",
    "List all mailbox rules for an account",
    {
      account: z.string().describe("The full email address of the account"),
    },
    async (args) => {
      recordCall("list_rules");
      if (!checkRateLimit("list_rules", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_rules");
        return rateLimitErr("list_rules");
      }
      try {
        return okContent(await toolListRules(args));
      } catch (err) {
        recordError("list_rules");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 19: delete_rule
  server.tool(
    "delete_rule",
    "Delete a mailbox rule by ID",
    {
      account: z.string().describe("The full email address of the account"),
      rule_id: z.string().describe("The rule ID to delete"),
    },
    async (args) => {
      recordCall("delete_rule");
      if (!checkRateLimit("delete_rule", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("delete_rule");
        return rateLimitErr("delete_rule");
      }
      try {
        return okContent(await toolDeleteRule(args));
      } catch (err) {
        recordError("delete_rule");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 20: apply_rules
  server.tool(
    "apply_rules",
    "Apply all mailbox rules to emails in a folder. Returns a summary of actions taken.",
    {
      account: z.string().describe("The full email address of the account"),
      folder: z.string().optional().describe("Folder to scan (default: Inbox)"),
    },
    async (args) => {
      recordCall("apply_rules");
      if (!checkRateLimit("apply_rules", apiKey, 20, 60 * 1000)) {
        recordRateLimit("apply_rules");
        return rateLimitErr("apply_rules");
      }
      try {
        return okContent(await toolApplyRules(args));
      } catch (err) {
        recordError("apply_rules");
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
