import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { mcpOk, mcpError, mcpCaughtError } from "./lib/errors.js";
import { idempotencyCheck, idempotencySet } from "./lib/idempotency.js";
import { JmapClient } from "./clients/jmap.js";
import { config } from "./config.js";
import { type CallerIdentity, authorize, normalizeAccount } from "./auth.js";
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
  toolMarkAsRead,
  toolMarkAsUnread,
  toolFlagEmail,
  toolBulkMoveEmails,
  toolBulkDeleteEmails,
  toolBulkAddLabel,
} from "./tools/mailbox.js";
import {
  toolCreateFolder,
  toolDeleteFolder,
  toolMoveEmail,
} from "./tools/folders.js";
import { toolSendEmail, toolSendEventInvite, toolCancelEventInvite, toolReplyToEmail, toolForwardEmail, toolRespondToInvite } from "./tools/send.js";
import {
  toolCreateEvent,
  toolUpdateEvent,
  toolDeleteEvent,
} from "./tools/calendar.js";
import { toolMarkAsSpam, toolMarkAsNotSpam } from "./tools/spam.js";
import {
  toolCreateRule,
  toolDeleteRule,
  toolApplyRules,
} from "./tools/rules.js";
import {
  toolAddToWhitelist,
  toolRemoveFromWhitelist,
  toolAddToBlacklist,
  toolRemoveFromBlacklist,
} from "./tools/filters.js";
import {
  toolAddLabel,
  toolRemoveLabel,
} from "./tools/labels.js";
import { toolConfigureAccount, getAccountSettings } from "./tools/configure.js";
import { toolManageDraft } from "./tools/drafts.js";
import { toolManageContact } from "./tools/contacts.js";
import { toolManageTemplate, toolSendBatch } from "./tools/outreach.js";
import { toolManageWebhook } from "./tools/webhooks.js";
import { toolListRules } from "./tools/rules.js";
import { toolListWhitelist, toolListBlacklist } from "./tools/filters.js";
import { toolListFolders } from "./tools/folders.js";
import { toolListLabels } from "./tools/labels.js";
import { handleDashboard } from "./dashboard.js";
import { recordCall, recordError, recordRateLimit, recordAccountCreated, recordAccountSend, recordCallEntry, recordBatchSend } from "./metrics.js";

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
// Helpers (thin aliases kept for call-site brevity)
// ---------------------------------------------------------------------------

const okContent = mcpOk;

function errContent(message: string) {
  return mcpError("TOOL_ERROR", message, false);
}

function rateLimitErr(tool: string) {
  recordCallEntry({ ts: Date.now(), tool, account: "", durationMs: 0, status: "ratelimit" });
  return mcpError(
    "RATE_LIMIT",
    `Rate limit exceeded for tool "${tool}". Please try again later.`,
    true,
  );
}

/** Wraps an async tool call to record timing and error detail in the call log. */
async function runTool<T>(toolName: string, account: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordCallEntry({ ts: start, tool: toolName, account, durationMs: Date.now() - start, status: "ok" });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordCallEntry({ ts: start, tool: toolName, account, durationMs: Date.now() - start, status: "error", errorMsg: msg });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP server factory — creates a fresh McpServer per request (stateless mode)
// ---------------------------------------------------------------------------

function createMcpServer(caller: CallerIdentity): McpServer {
  const apiKey = caller.apiKey;
  const server = new McpServer(
    { name: "clawmail", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Tool 1: create_account
  server.tool(
    "create_account",
    "Create a new email account on the mail server",
    { local_part: z.string().describe("The local part (before @) of the new email address") },
    async (args) => {
      const denied = authorize(caller, "create_account");
      if (denied) return denied;
      recordCall("create_account");
      if (!checkRateLimit("create_account", apiKey, config.limits.createAccountPerHour, 60 * 60 * 1000)) {
        recordRateLimit("create_account");
        return rateLimitErr("create_account");
      }
      try {
        return await runTool("create_account", "", async () => {
          const result = await toolCreateAccount(args.local_part);
          recordAccountCreated(result.email);
          return okContent(result);
        });
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
      const denied = authorize(caller, "list_accounts");
      if (denied) return denied;
      recordCall("list_accounts");
      if (!checkRateLimit("list_accounts", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_accounts");
        return rateLimitErr("list_accounts");
      }
      try {
        return await runTool("list_accounts", "", () => toolListAccounts().then(okContent));
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
      const denied = authorize(caller, "delete_account");
      if (denied) return denied;
      recordCall("delete_account");
      if (!checkRateLimit("delete_account", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("delete_account");
        return rateLimitErr("delete_account");
      }
      try {
        return await runTool("delete_account", "", () => toolDeleteAccount(args.local_part).then(okContent));
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
        return await runTool("list_emails", args.account, () => toolListEmails(args.account, args.folder, args.limit).then(okContent));
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
        return await runTool("read_email", args.account, () => toolReadEmail(args.account, args.email_id).then(okContent));
      } catch (err) {
        recordError("read_email");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 7: search_emails
  server.tool(
    "search_emails",
    "Full-text search across all emails for an account. Excludes Junk/spam folder by default.",
    {
      account: z.string().describe("The full email address of the account"),
      query: z.string().describe("Search query string"),
      include_spam: z.boolean().optional().describe("Include Junk/spam folder in results (default: false)"),
    },
    async (args) => {
      recordCall("search_emails");
      if (!checkRateLimit("search_emails", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("search_emails");
        return rateLimitErr("search_emails");
      }
      try {
        return await runTool("search_emails", args.account, () => toolSearchEmails(args.account, args.query, args.include_spam ?? false).then(okContent));
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
      idempotency_key: z.string().optional().describe("Unique key to prevent duplicate sends on retry. Results are cached for 24h."),
    },
    async (args) => {
      recordCall("send_email");
      if (args.idempotency_key) {
        const cached = idempotencyCheck(args.idempotency_key);
        if (cached !== undefined) return okContent(cached);
      }
      if (!checkRateLimit("send_email", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("send_email");
        return rateLimitErr("send_email");
      }
      const sendEmailFrom = args.from_account.includes("@") ? args.from_account : `${args.from_account}@${config.domain}`;
      try {
        return await runTool("send_email", sendEmailFrom, async () => {
          const result = await toolSendEmail({ fromAccount: args.from_account, to: args.to, subject: args.subject, body: args.body, cc: args.cc, bcc: args.bcc });
          recordAccountSend(sendEmailFrom);
          if (args.idempotency_key) idempotencySet(args.idempotency_key, result);
          return okContent(result);
        });
      } catch (err) {
        recordError("send_email");
        return mcpCaughtError(err, "SEND_FAILED");
      }
    },
  );

  // Tool 21: send_event_invite
  server.tool(
    "send_event_invite",
    "Send a calendar invitation email that auto-appears in Google Calendar, Outlook, Apple Calendar, and any RFC 5545-compatible app. If DAILY_API_KEY is configured, a video room is auto-created and embedded in the invite.",
    {
      from_account: z.string().describe("The local part or full email address to send from"),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address(es) — they become attendees"),
      title: z.string().describe("Event title"),
      start: z.string().describe("Event start in ISO 8601 (e.g. 2026-04-10T14:00:00Z)"),
      end: z.string().describe("Event end in ISO 8601 — must be after start"),
      description: z.string().optional().describe("Optional event description shown in the invite"),
      location: z.string().optional().describe("Optional location or video call URL"),
      uid: z.string().optional().describe("Stable event UID — reuse the same UID to send an update for an existing invite"),
      video_url: z.string().optional().describe("Explicit video call URL to embed (overrides Daily.co auto-creation)"),
    },
    async (args) => {
      recordCall("send_event_invite");
      if (!checkRateLimit("send_event_invite", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("send_event_invite");
        return rateLimitErr("send_event_invite");
      }
      const sendInviteFrom = args.from_account.includes("@") ? args.from_account : `${args.from_account}@${config.domain}`;
      try {
        return await runTool("send_event_invite", sendInviteFrom, async () => {
          const result = await toolSendEventInvite({ fromAccount: args.from_account, to: args.to, title: args.title, start: args.start, end: args.end, description: args.description, location: args.location, uid: args.uid, video_url: args.video_url });
          recordAccountSend(sendInviteFrom);
          return okContent(result);
        });
      } catch (err) {
        recordError("send_event_invite");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 22: cancel_event_invite
  server.tool(
    "cancel_event_invite",
    "Send a cancellation email (iCalendar METHOD:CANCEL) for a previously sent invite. The recipient's calendar app will automatically remove the event. Requires the same UID used when sending the original invite.",
    {
      from_account: z.string().describe("The local part or full email address of the organizer (must match the original invite sender)"),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address(es) — same as the original invite"),
      uid: z.string().describe("The event UID from the original send_event_invite response"),
      title: z.string().describe("Event title — should match the original invite"),
      start: z.string().describe("Event start in ISO 8601 — must match the original invite"),
      end: z.string().describe("Event end in ISO 8601 — must match the original invite"),
      sequence: z.number().int().min(1).optional().describe("Sequence number (default: 1). Increment if sending multiple cancellation updates for the same UID."),
    },
    async (args) => {
      recordCall("cancel_event_invite");
      if (!checkRateLimit("cancel_event_invite", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("cancel_event_invite");
        return rateLimitErr("cancel_event_invite");
      }
      try {
        return await runTool("cancel_event_invite", args.from_account, () =>
          toolCancelEventInvite({ fromAccount: args.from_account, to: args.to, uid: args.uid, title: args.title, start: args.start, end: args.end, sequence: args.sequence }).then(okContent));
      } catch (err) {
        recordError("cancel_event_invite");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Reply / Forward ──────────────────────────────────────────────────────────

  // Tool 44: reply_to_email
  server.tool(
    "reply_to_email",
    "Reply to an email with proper threading headers (In-Reply-To, References). The reply appears in the same conversation thread in the recipient's mail client.",
    {
      from_account: z.string().describe("The email account to reply from"),
      email_id: z.string().describe("The JMAP email ID of the email to reply to"),
      body: z.string().describe("Reply body text"),
      reply_all: z.boolean().optional().describe("If true, reply to all original recipients (To + CC). Default: false (reply to sender only)"),
      idempotency_key: z.string().optional().describe("Unique key to prevent duplicate sends on retry. Results are cached for 24h."),
    },
    async (args) => {
      recordCall("reply_to_email");
      if (args.idempotency_key) {
        const cached = idempotencyCheck(args.idempotency_key);
        if (cached !== undefined) return okContent(cached);
      }
      if (!checkRateLimit("reply_to_email", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("reply_to_email");
        return rateLimitErr("reply_to_email");
      }
      const replyFrom = args.from_account.includes("@") ? args.from_account : `${args.from_account}@${config.domain}`;
      try {
        return await runTool("reply_to_email", replyFrom, async () => {
          const result = await toolReplyToEmail({ fromAccount: args.from_account, email_id: args.email_id, body: args.body, reply_all: args.reply_all });
          recordAccountSend(replyFrom);
          if (args.idempotency_key) idempotencySet(args.idempotency_key, result);
          return okContent(result);
        });
      } catch (err) {
        recordError("reply_to_email");
        return mcpCaughtError(err, "SEND_FAILED");
      }
    },
  );

  // Tool 45: forward_email
  server.tool(
    "forward_email",
    "Forward an email to new recipients with a 'Fwd:' subject prefix and the original message quoted in the body.",
    {
      from_account: z.string().describe("The email account to forward from"),
      email_id: z.string().describe("The JMAP email ID of the email to forward"),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address(es) to forward to"),
      body: z.string().optional().describe("Optional introductory text to prepend before the forwarded message"),
      idempotency_key: z.string().optional().describe("Unique key to prevent duplicate sends on retry. Results are cached for 24h."),
    },
    async (args) => {
      recordCall("forward_email");
      if (args.idempotency_key) {
        const cached = idempotencyCheck(args.idempotency_key);
        if (cached !== undefined) return okContent(cached);
      }
      if (!checkRateLimit("forward_email", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("forward_email");
        return rateLimitErr("forward_email");
      }
      const forwardFrom = args.from_account.includes("@") ? args.from_account : `${args.from_account}@${config.domain}`;
      try {
        return await runTool("forward_email", forwardFrom, async () => {
          const result = await toolForwardEmail({ fromAccount: args.from_account, email_id: args.email_id, to: args.to, body: args.body });
          recordAccountSend(forwardFrom);
          if (args.idempotency_key) idempotencySet(args.idempotency_key, result);
          return okContent(result);
        });
      } catch (err) {
        recordError("forward_email");
        return mcpCaughtError(err, "SEND_FAILED");
      }
    },
  );

  // ── Consolidated tools (Phase 1) ────────────────────────────────────────────

  // Tool: update_email — merges mark_as_read/unread, flag/unflag, archive, move, delete, add_label, remove_label
  // Single email_id string → single op; array → bulk op
  server.tool(
    "update_email",
    "Update email state: mark read/unread, flag/unflag, archive, move, delete, or add/remove labels. Pass a single email_id string for one email or an array for bulk operations.",
    {
      account:   z.string().describe("The full email address of the account"),
      email_ids: z.union([z.string(), z.array(z.string())]).describe("A single JMAP email ID, or an array of IDs for bulk operations"),
      action:    z.enum(["mark_read", "mark_unread", "flag", "unflag", "archive", "move", "delete", "add_label", "remove_label"])
                  .describe("Action to perform"),
      folder:    z.string().optional().describe("Destination folder — required for action='move'"),
      label:     z.string().optional().describe("Label name — required for action='add_label' or 'remove_label'"),
    },
    async (args) => {
      recordCall("update_email");
      if (!checkRateLimit("update_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("update_email");
        return rateLimitErr("update_email");
      }
      const ids = Array.isArray(args.email_ids) ? args.email_ids : [args.email_ids];
      const isBulk = ids.length > 1;

      if (args.action === "move" && !args.folder) {
        return mcpError("VALIDATION_ERROR", "folder is required for action='move'", false);
      }
      if ((args.action === "add_label" || args.action === "remove_label") && !args.label) {
        return mcpError("VALIDATION_ERROR", "label is required for action='add_label' or 'remove_label'", false);
      }

      try {
        return await runTool("update_email", args.account, async () => {
          if (isBulk) {
            if (args.action === "move")      return okContent(await toolBulkMoveEmails(args.account, ids, args.folder!));
            if (args.action === "delete")    return okContent(await toolBulkDeleteEmails(args.account, ids));
            if (args.action === "add_label") return okContent(await toolBulkAddLabel(args.account, ids, args.label!));
            const results = await Promise.allSettled(ids.map(async (id) => {
              if (args.action === "mark_read")    return toolMarkAsRead(args.account, id);
              if (args.action === "mark_unread")  return toolMarkAsUnread(args.account, id);
              if (args.action === "flag")         return toolFlagEmail(args.account, id, true);
              if (args.action === "unflag")       return toolFlagEmail(args.account, id, false);
              if (args.action === "archive")      return toolMoveEmail({ account: args.account, email_id: id, folder: "Archive" });
              if (args.action === "remove_label") return toolRemoveLabel({ account: args.account, email_id: id, label: args.label! });
            }));
            const succeeded = results.filter((r) => r.status === "fulfilled").length;
            const failed    = results.filter((r) => r.status === "rejected").length;
            return okContent({ succeeded, failed, total: ids.length });
          } else {
            const id = ids[0];
            if (args.action === "mark_read")    return okContent(await toolMarkAsRead(args.account, id));
            if (args.action === "mark_unread")  return okContent(await toolMarkAsUnread(args.account, id));
            if (args.action === "flag")         return okContent(await toolFlagEmail(args.account, id, true));
            if (args.action === "unflag")       return okContent(await toolFlagEmail(args.account, id, false));
            if (args.action === "archive")      return okContent(await toolMoveEmail({ account: args.account, email_id: id, folder: "Archive" }));
            if (args.action === "move")         return okContent(await toolMoveEmail({ account: args.account, email_id: id, folder: args.folder! }));
            if (args.action === "delete")       return okContent(await toolDeleteEmail(args.account, id));
            if (args.action === "add_label")    return okContent(await toolAddLabel({ account: args.account, email_id: id, label: args.label! }));
            if (args.action === "remove_label") return okContent(await toolRemoveLabel({ account: args.account, email_id: id, label: args.label! }));
            return mcpError("VALIDATION_ERROR", `Unknown action: ${args.action}`, false);
          }
        });
      } catch (err) {
        recordError("update_email");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: classify_email — merges mark_as_spam + mark_as_not_spam
  server.tool(
    "classify_email",
    "Move an email to Junk (spam) or back to Inbox (not spam)",
    {
      account:  z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
      as:       z.enum(["spam", "not_spam"]).describe("'spam' moves to Junk; 'not_spam' moves to Inbox"),
    },
    async (args) => {
      recordCall("classify_email");
      if (!checkRateLimit("classify_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("classify_email");
        return rateLimitErr("classify_email");
      }
      try {
        return await runTool("classify_email", args.account, async () => {
          if (args.as === "spam")     return okContent(await toolMarkAsSpam({ account: args.account, email_id: args.email_id }));
          if (args.as === "not_spam") return okContent(await toolMarkAsNotSpam({ account: args.account, email_id: args.email_id }));
          return mcpError("VALIDATION_ERROR", `Unknown as value: ${args.as}`, false);
        });
      } catch (err) {
        recordError("classify_email");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: manage_folder — merges create_folder + delete_folder + adds rename
  server.tool(
    "manage_folder",
    "Create, delete, or rename a mailbox folder",
    {
      account:       z.string().describe("The full email address of the account"),
      action:        z.enum(["create", "delete", "rename"]).describe("Action to perform"),
      folder:        z.string().describe("Folder name (for create: the new folder name; for delete/rename: the existing folder name)"),
      new_name:      z.string().optional().describe("New name — required for action='rename'"),
      parent_folder: z.string().optional().describe("Parent folder name — optional for action='create'"),
    },
    async (args) => {
      recordCall("manage_folder");
      if (!checkRateLimit("manage_folder", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("manage_folder");
        return rateLimitErr("manage_folder");
      }
      if (args.action === "rename" && !args.new_name) {
        return mcpError("VALIDATION_ERROR", "new_name is required for action='rename'", false);
      }
      try {
        return await runTool("manage_folder", args.account, async () => {
          if (args.action === "create") return okContent(await toolCreateFolder({ account: args.account, name: args.folder, parent_folder: args.parent_folder }));
          if (args.action === "delete") return okContent(await toolDeleteFolder({ account: args.account, folder: args.folder }));
          if (args.action === "rename") {
            const jmap = new JmapClient(args.account);
            await jmap.renameMailbox(args.folder, args.new_name!);
            return okContent({ message: `Folder "${args.folder}" renamed to "${args.new_name}"` });
          }
          return mcpError("VALIDATION_ERROR", `Unknown action: ${args.action}`, false);
        });
      } catch (err) {
        recordError("manage_folder");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: manage_rule — merges create_rule + delete_rule + apply_rules
  server.tool(
    "manage_rule",
    "Create, delete, or apply mailbox rules. Rules match emails by condition and take an action (move, mark read, delete).",
    {
      account:     z.string().describe("The full email address of the account"),
      action:      z.enum(["create", "delete", "apply"]).describe("Action to perform"),
      rule_id:     z.string().optional().describe("Rule ID — required for action='delete'"),
      name:        z.string().optional().describe("Rule name — required for action='create'"),
      condition:   z.object({
        from:          z.string().optional().describe("Substring match on sender address"),
        subject:       z.string().optional().describe("Substring match on subject"),
        hasAttachment: z.boolean().optional().describe("Match emails with or without attachments"),
        olderThanDays: z.number().int().min(1).optional().describe("Match emails older than N days"),
      }).optional().describe("Match conditions — required for action='create' (at least one field)"),
      rule_action: z.object({
        moveTo:    z.string().optional().describe("Move matched emails to this folder"),
        markRead:  z.boolean().optional().describe("Mark matched emails as read"),
        delete:    z.boolean().optional().describe("Move matched emails to Trash"),
      }).optional().describe("Action to take — required for action='create' (at least one field)"),
      folder:      z.string().optional().describe("Folder to scan — optional for action='apply' (default: Inbox)"),
    },
    async (args) => {
      recordCall("manage_rule");
      if (!checkRateLimit("manage_rule", apiKey, args.action === "apply" ? 20 : config.limits.readOpsPerMinute, args.action === "apply" ? 60 * 1000 : 60 * 1000)) {
        recordRateLimit("manage_rule");
        return rateLimitErr("manage_rule");
      }
      if (args.action === "create") {
        if (!args.name) return mcpError("VALIDATION_ERROR", "name is required for action='create'", false);
        if (!args.condition) return mcpError("VALIDATION_ERROR", "condition is required for action='create'", false);
        if (!args.rule_action) return mcpError("VALIDATION_ERROR", "rule_action is required for action='create'", false);
      }
      if (args.action === "delete" && !args.rule_id) {
        return mcpError("VALIDATION_ERROR", "rule_id is required for action='delete'", false);
      }
      try {
        return await runTool("manage_rule", args.account, async () => {
          if (args.action === "create") return okContent(await toolCreateRule({ account: args.account, name: args.name!, condition: args.condition!, action: args.rule_action! }));
          if (args.action === "delete") return okContent(await toolDeleteRule({ account: args.account, rule_id: args.rule_id! }));
          if (args.action === "apply")  return okContent(await toolApplyRules({ account: args.account, folder: args.folder }));
          return mcpError("VALIDATION_ERROR", `Unknown action: ${args.action}`, false);
        });
      } catch (err) {
        recordError("manage_rule");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: manage_sender_list — merges whitelist + blacklist add/remove
  server.tool(
    "manage_sender_list",
    "Add or remove entries from the spam whitelist or blacklist. Use @domain.com to match an entire domain.",
    {
      account:  z.string().describe("The full email address of the account"),
      list:     z.enum(["whitelist", "blacklist"]).describe("Which list to modify"),
      action:   z.enum(["add", "remove"]).describe("Add a new entry or remove an existing one"),
      address:  z.string().optional().describe("Email address or @domain.com — required for action='add'"),
      entry_id: z.string().optional().describe("Entry ID from account://config/{account} — required for action='remove'"),
    },
    async (args) => {
      recordCall("manage_sender_list");
      if (!checkRateLimit("manage_sender_list", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("manage_sender_list");
        return rateLimitErr("manage_sender_list");
      }
      if (args.action === "add" && !args.address) {
        return mcpError("VALIDATION_ERROR", "address is required for action='add'", false);
      }
      if (args.action === "remove" && !args.entry_id) {
        return mcpError("VALIDATION_ERROR", "entry_id is required for action='remove'", false);
      }
      try {
        return await runTool("manage_sender_list", args.account, async () => {
          if (args.list === "whitelist") {
            if (args.action === "add")    return okContent(await toolAddToWhitelist({ account: args.account, address: args.address! }));
            if (args.action === "remove") return okContent(await toolRemoveFromWhitelist({ account: args.account, entry_id: args.entry_id! }));
          }
          if (args.list === "blacklist") {
            if (args.action === "add")    return okContent(await toolAddToBlacklist({ account: args.account, address: args.address! }));
            if (args.action === "remove") return okContent(await toolRemoveFromBlacklist({ account: args.account, entry_id: args.entry_id! }));
          }
          return mcpError("VALIDATION_ERROR", `Unknown list/action combination: ${args.list}/${args.action}`, false);
        });
      } catch (err) {
        recordError("manage_sender_list");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: manage_event — merges create_event + update_event + delete_event
  server.tool(
    "manage_event",
    "Create, update, or delete a calendar event stored in the account",
    {
      account:     z.string().describe("The full email address of the account"),
      action:      z.enum(["create", "update", "delete"]).describe("Action to perform"),
      event_id:    z.string().optional().describe("Event ID — required for action='update' or 'delete'"),
      title:       z.string().optional().describe("Event title — required for action='create'"),
      start:       z.string().optional().describe("Start in ISO 8601 — required for action='create'"),
      end:         z.string().optional().describe("End in ISO 8601 — required for action='create'"),
      description: z.string().optional(),
      attendees:   z.array(z.string()).optional().describe("Attendee email addresses"),
    },
    async (args) => {
      recordCall("manage_event");
      if (!checkRateLimit("manage_event", apiKey, 60, 60 * 60 * 1000)) {
        recordRateLimit("manage_event");
        return rateLimitErr("manage_event");
      }
      if (args.action === "create") {
        if (!args.title) return mcpError("VALIDATION_ERROR", "title is required for action='create'", false);
        if (!args.start) return mcpError("VALIDATION_ERROR", "start is required for action='create'", false);
        if (!args.end)   return mcpError("VALIDATION_ERROR", "end is required for action='create'", false);
      }
      if ((args.action === "update" || args.action === "delete") && !args.event_id) {
        return mcpError("VALIDATION_ERROR", `event_id is required for action='${args.action}'`, false);
      }
      try {
        return await runTool("manage_event", args.account, async () => {
          if (args.action === "create") return okContent(await toolCreateEvent({ account: args.account, title: args.title!, start: args.start!, end: args.end!, description: args.description, attendees: args.attendees }));
          if (args.action === "update") return okContent(await toolUpdateEvent({ account: args.account, event_id: args.event_id!, title: args.title, start: args.start, end: args.end, description: args.description, attendees: args.attendees }));
          if (args.action === "delete") return okContent(await toolDeleteEvent({ account: args.account, event_id: args.event_id! }));
          return mcpError("VALIDATION_ERROR", `Unknown action: ${args.action}`, false);
        });
      } catch (err) {
        recordError("manage_event");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: respond_to_invite — new tool: accept/decline/tentative a calendar invite
  server.tool(
    "respond_to_invite",
    "Accept, decline, or tentatively accept a calendar invitation. Call read_email first to get the uid, organizer, title, start, and end from the invite.",
    {
      from_account: z.string().describe("The email account responding to the invite"),
      email_id:     z.string().describe("The JMAP email ID of the original invite email — used for reply threading"),
      response:     z.enum(["accept", "decline", "tentative"]).describe("Your RSVP response"),
      uid:          z.string().describe("The event UID from the original invite"),
      organizer:    z.string().describe("Email address of the event organizer (the reply goes here)"),
      title:        z.string().describe("Event title from the original invite"),
      start:        z.string().describe("Event start in ISO 8601 from the original invite"),
      end:          z.string().describe("Event end in ISO 8601 from the original invite"),
    },
    async (args) => {
      recordCall("respond_to_invite");
      if (!checkRateLimit("respond_to_invite", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("respond_to_invite");
        return rateLimitErr("respond_to_invite");
      }
      try {
        return await runTool("respond_to_invite", args.from_account, () =>
          toolRespondToInvite({ fromAccount: args.from_account, email_id: args.email_id, response: args.response, uid: args.uid, organizer: args.organizer, title: args.title, start: args.start, end: args.end }).then(okContent));
      } catch (err) {
        recordError("respond_to_invite");
        return mcpCaughtError(err, "SEND_FAILED");
      }
    },
  );

  // ── Phase 2 — New feature tools ─────────────────────────────────────────────

  // Tool: configure_account — display_name, signature, vacation_reply, forwarding, suspend/reactivate
  server.tool(
    "configure_account",
    "Configure account settings: display name, email signature, vacation reply, forwarding address, or suspend/reactivate delivery.",
    {
      account: z.string().describe("The full email address or local part of the account"),
      setting: z.enum(["display_name", "signature", "vacation_reply", "forwarding", "suspend", "reactivate"])
                .describe("Which setting to change"),
      value: z.string().optional().describe("New value — required for display_name, signature, vacation_reply, forwarding. Omit to clear a setting."),
    },
    async (args) => {
      recordCall("configure_account");
      if (!checkRateLimit("configure_account", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("configure_account");
        return rateLimitErr("configure_account");
      }
      try {
        return await runTool("configure_account", args.account, () => toolConfigureAccount({ account: args.account, setting: args.setting, value: args.value }).then(okContent));
      } catch (err) {
        recordError("configure_account");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: manage_draft — create/update/send/delete/schedule a draft
  server.tool(
    "manage_draft",
    "Manage email drafts: create, update, send, delete, or schedule for future delivery. Scheduled drafts are stored and require an external trigger to deliver.",
    {
      account:   z.string().describe("The full email address of the account"),
      action:    z.enum(["create", "update", "send", "delete", "schedule"]),
      draft_id:  z.string().optional().describe("JMAP email ID of the draft — required for update, send, delete, schedule"),
      subject:   z.string().optional(),
      body:      z.string().optional(),
      to:        z.union([z.string(), z.array(z.string())]).optional().describe("Recipient(s)"),
      cc:        z.array(z.string()).optional(),
      send_at:   z.string().optional().describe("ISO 8601 date-time — required for action='schedule'"),
      idempotency_key: z.string().optional().describe("Deduplication key for send/schedule actions"),
    },
    async (args) => {
      recordCall("manage_draft");
      if (!checkRateLimit("manage_draft", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("manage_draft");
        return rateLimitErr("manage_draft");
      }
      if (["update", "send", "delete", "schedule"].includes(args.action) && !args.draft_id) {
        return mcpError("VALIDATION_ERROR", `draft_id is required for action='${args.action}'`, false);
      }
      if (args.action === "schedule" && !args.send_at) {
        return mcpError("VALIDATION_ERROR", "send_at is required for action='schedule'", false);
      }
      try {
        return await runTool("manage_draft", args.account, () =>
          toolManageDraft({ account: args.account, action: args.action, draft_id: args.draft_id, subject: args.subject, body: args.body, to: args.to, cc: args.cc, send_at: args.send_at }).then(okContent));
      } catch (err) {
        recordError("manage_draft");
        return mcpCaughtError(err, "DRAFT_ERROR");
      }
    },
  );

  // Tool: update_thread — archive/delete/mute/label an entire thread
  server.tool(
    "update_thread",
    "Apply an action to all emails in a conversation thread at once: archive, delete, mute, or add/remove a label.",
    {
      account:   z.string().describe("The full email address of the account"),
      thread_id: z.string().describe("The JMAP threadId (visible in list_emails / read_email output)"),
      action:    z.enum(["archive", "delete", "mute", "add_label", "remove_label"]),
      label:     z.string().optional().describe("Label name — required for action='add_label' or 'remove_label'"),
    },
    async (args) => {
      recordCall("update_thread");
      if (!checkRateLimit("update_thread", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("update_thread");
        return rateLimitErr("update_thread");
      }
      if ((args.action === "add_label" || args.action === "remove_label") && !args.label) {
        return mcpError("VALIDATION_ERROR", `label is required for action='${args.action}'`, false);
      }
      try {
        return await runTool("update_thread", args.account, async () => {
          const jmap = new JmapClient(args.account);
          const result = await jmap.updateThread({ threadId: args.thread_id, action: args.action, label: args.label });
          return okContent({ thread_id: args.thread_id, action: args.action, ...result });
        });
      } catch (err) {
        recordError("update_thread");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: manage_contact — create/update/delete contacts stored per-account
  server.tool(
    "manage_contact",
    "Manage contacts for an account. Contacts are stored privately per account and can be used by other tools (e.g. send_batch).",
    {
      account:  z.string().describe("The full email address of the account"),
      action:   z.enum(["create", "update", "delete"]),
      email:    z.string().describe("The contact's email address (natural key)"),
      name:     z.string().optional().describe("Display name"),
      notes:    z.string().optional().describe("Free-text notes"),
      vip:      z.boolean().optional().describe("Mark as VIP contact"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary key-value metadata"),
    },
    async (args) => {
      recordCall("manage_contact");
      if (!checkRateLimit("manage_contact", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("manage_contact");
        return rateLimitErr("manage_contact");
      }
      try {
        return await runTool("manage_contact", args.account, () =>
          toolManageContact({ account: args.account, action: args.action, email: args.email, name: args.name, notes: args.notes, vip: args.vip, metadata: args.metadata }).then(okContent));
      } catch (err) {
        recordError("manage_contact");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: manage_template — create/update/delete email templates
  server.tool(
    "manage_template",
    "Manage reusable email templates. Use {{variable_name}} placeholders in subject/body that are filled in by send_batch.",
    {
      account:     z.string().describe("The full email address of the account"),
      action:      z.enum(["create", "update", "delete"]),
      template_id: z.string().optional().describe("Template ID — required for update/delete"),
      name:        z.string().optional().describe("Template name — required for create"),
      subject:     z.string().optional().describe("Subject line with optional {{variable}} placeholders — required for create"),
      body:        z.string().optional().describe("Email body with optional {{variable}} placeholders — required for create"),
      variables:   z.array(z.string()).optional().describe("List of variable names used in subject/body (for documentation)"),
    },
    async (args) => {
      recordCall("manage_template");
      if (!checkRateLimit("manage_template", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("manage_template");
        return rateLimitErr("manage_template");
      }
      try {
        return await runTool("manage_template", args.account, () =>
          toolManageTemplate({ account: args.account, action: args.action, template_id: args.template_id, name: args.name, subject: args.subject, body: args.body, variables: args.variables }).then(okContent));
      } catch (err) {
        recordError("manage_template");
        return mcpCaughtError(err);
      }
    },
  );

  // Tool: send_batch — send a template to multiple recipients
  server.tool(
    "send_batch",
    "Send a template email to a list of recipients. Variables are substituted per-recipient. The special variable {{email}} is always available.",
    {
      account:         z.string().describe("The full email address of the account to send from"),
      template_id:     z.string().describe("Template ID from manage_template"),
      recipients:      z.array(z.string()).min(1).max(500).describe("List of recipient email addresses (max 500)"),
      variables:       z.record(z.string(), z.string()).optional().describe("Variables to substitute in the template for all recipients"),
      idempotency_key: z.string().optional().describe("Deduplication key — results cached 24h"),
    },
    async (args) => {
      recordCall("send_batch");
      if (args.idempotency_key) {
        const cached = idempotencyCheck(args.idempotency_key);
        if (cached !== undefined) return okContent(cached);
      }
      if (!checkRateLimit("send_batch", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("send_batch");
        return rateLimitErr("send_batch");
      }
      const batchFrom = args.account.includes("@") ? args.account : `${args.account}@${config.domain}`;
      try {
        return await runTool("send_batch", batchFrom, async () => {
          const result = await toolSendBatch({ account: args.account, template_id: args.template_id, recipients: args.recipients, variables: args.variables, idempotency_key: args.idempotency_key });
          recordAccountSend(batchFrom);
          recordBatchSend({ ts: Date.now(), account: batchFrom, template_id: args.template_id, total: args.recipients.length, sent: result.sent, failed: result.failed, errors: result.errors.slice(0, 20) });
          if (args.idempotency_key) idempotencySet(args.idempotency_key, result);
          return okContent(result);
        });
      } catch (err) {
        recordError("send_batch");
        return mcpCaughtError(err, "SEND_FAILED");
      }
    },
  );

  // Tool: manage_webhook — register/unregister webhooks for account events
  server.tool(
    "manage_webhook",
    "Register or unregister a webhook URL to receive notifications when account events occur (e.g. mail.received). Webhooks are stored per account.",
    {
      account:    z.string().describe("The full email address of the account"),
      action:     z.enum(["register", "unregister"]),
      url:        z.string().optional().describe("HTTPS URL to deliver events to — required for action='register'"),
      events:     z.array(z.string()).optional().describe("Event types, e.g. ['mail.received', 'mail.bounced'] — required for register"),
      secret:     z.string().optional().describe("HMAC signing secret — events will include X-Clawmail-Signature header"),
      webhook_id: z.string().optional().describe("Webhook ID — required for action='unregister'"),
    },
    async (args) => {
      recordCall("manage_webhook");
      if (!checkRateLimit("manage_webhook", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("manage_webhook");
        return rateLimitErr("manage_webhook");
      }
      if (args.action === "register" && !args.url) {
        return mcpError("VALIDATION_ERROR", "url is required for action='register'", false);
      }
      if (args.action === "unregister" && !args.webhook_id) {
        return mcpError("VALIDATION_ERROR", "webhook_id is required for action='unregister'", false);
      }
      try {
        return await runTool("manage_webhook", args.account, () =>
          toolManageWebhook({ account: args.account, action: args.action, url: args.url, events: args.events, secret: args.secret, webhook_id: args.webhook_id }).then(okContent));
      } catch (err) {
        recordError("manage_webhook");
        return mcpCaughtError(err);
      }
    },
  );

  // ── MCP Resources ───────────────────────────────────────────────────────────
  // Resources provide live, subscribable views of mailbox state.
  // Agents should prefer reading these over calling list_emails/read_email
  // for repeated polling — they save context and signal intent to the host.

  // Resource: email://inbox/{account}
  // Returns a paginated summary of the inbox (up to 50 most recent emails).
  server.resource(
    "inbox",
    new ResourceTemplate("email://inbox/{account}", { list: undefined }),
    { description: "Live view of the inbox for the given account. Returns up to 50 most recent email summaries." },
    async (uri, { account }) => {
      const jmap = new JmapClient(account as string);
      try {
        const emails = await jmap.listEmails("Inbox", 50);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ account, emails }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ account, error: message }),
          }],
        };
      }
    },
  );

  // Resource: email://thread/{account}/{thread_id}
  // Returns all emails in a thread, ordered oldest-first.
  server.resource(
    "thread",
    new ResourceTemplate("email://thread/{account}/{thread_id}", { list: undefined }),
    { description: "All emails in a conversation thread, ordered oldest-first." },
    async (uri, { account, thread_id }) => {
      const jmap = new JmapClient(account as string);
      try {
        const emails = await jmap.getThread(thread_id as string);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ account, thread_id, emails }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ account, thread_id, error: message }),
          }],
        };
      }
    },
  );

  // Resource: account://config/{account}
  // One-shot read of all account configuration: folders, rules, filters, labels, settings.
  // Use this before calling manage_rule / manage_sender_list so you have IDs for delete operations.
  server.resource(
    "account-config",
    new ResourceTemplate("account://config/{account}", { list: undefined }),
    {
      description:
        "Full configuration snapshot for an account: folders, mailbox rules, whitelist/blacklist, custom labels, and account settings (display name, signature, etc.). Read this to get entry IDs before calling manage_rule or manage_sender_list with action='delete'/'remove'.",
    },
    async (uri, { account }) => {
      const acct = account as string;
      const [foldersResult, rulesResult, whitelistResult, blacklistResult, labelsResult, settings] =
        await Promise.allSettled([
          toolListFolders({ account: acct }),
          toolListRules({ account: acct }),
          toolListWhitelist({ account: acct }),
          toolListBlacklist({ account: acct }),
          toolListLabels({ account: acct }),
          getAccountSettings(acct),
        ]);

      const payload = {
        account: acct,
        folders:   foldersResult.status   === "fulfilled" ? foldersResult.value.folders   : [],
        rules:     rulesResult.status     === "fulfilled" ? rulesResult.value.rules         : [],
        whitelist: whitelistResult.status === "fulfilled" ? whitelistResult.value.entries   : [],
        blacklist: blacklistResult.status === "fulfilled" ? blacklistResult.value.entries   : [],
        labels:    labelsResult.status    === "fulfilled" ? labelsResult.value.labels       : [],
        settings:  settings.status        === "fulfilled" ? settings.value                  : {},
      };

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server with API key auth middleware
// ---------------------------------------------------------------------------

/**
 * Authenticate the request using X-API-Key header.
 * Returns a CallerIdentity on success, or sends a 401 and returns null.
 */
function authenticate(req: IncomingMessage, res: ServerResponse): CallerIdentity | null {
  // Dev mode: no keys configured -- open access as admin
  if (config.auth.apiKeyMap.size === 0 && config.auth.apiKeys.size === 0) {
    return { apiKey: "", role: "admin" };
  }

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey !== "string") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized: missing X-API-Key header" }));
    return null;
  }

  const identity = config.auth.apiKeyMap.get(apiKey);
  if (identity) return identity;

  // Legacy fallback: check plain apiKeys set (treated as admin)
  if (config.auth.apiKeys.has(apiKey)) {
    return { apiKey, role: "admin" };
  }

  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized: invalid API key" }));
  return null;
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

  const caller = authenticate(req, res);
  if (caller === null) return; // 401 already sent

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
  const mcpServer = createMcpServer(caller);
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

export { httpServer };

httpServer.listen(config.port, () => {
  console.log(`[clawmail-mcp] Listening on port ${config.port}`);
  console.log(`[clawmail-mcp] MCP endpoint: POST/GET http://0.0.0.0:${config.port}/mcp`);
  const totalKeys = config.auth.apiKeyMap.size || config.auth.apiKeys.size;
  console.log(`[clawmail-mcp] Auth: ${totalKeys > 0 ? `${totalKeys} API key(s) configured` : "OPEN (no API keys set)"}`);
});
