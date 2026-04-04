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
  toolMarkAsRead,
  toolMarkAsUnread,
  toolFlagEmail,
  toolBulkMoveEmails,
  toolBulkDeleteEmails,
  toolBulkAddLabel,
} from "./tools/mailbox.js";
import {
  toolListFolders,
  toolCreateFolder,
  toolDeleteFolder,
  toolMoveEmail,
} from "./tools/folders.js";
import { toolSendEmail, toolSendEventInvite, toolCancelEventInvite, toolReplyToEmail, toolForwardEmail } from "./tools/send.js";
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
import {
  toolAddToWhitelist,
  toolRemoveFromWhitelist,
  toolListWhitelist,
  toolAddToBlacklist,
  toolRemoveFromBlacklist,
  toolListBlacklist,
  toolApplySpamFilter,
} from "./tools/filters.js";
import {
  toolAddLabel,
  toolRemoveLabel,
  toolListLabels,
  toolSearchByLabel,
} from "./tools/labels.js";
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
        const result = await toolSearchEmails(args.account, args.query, args.include_spam ?? false);
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
      try {
        const result = await toolSendEventInvite({
          fromAccount: args.from_account,
          to: args.to,
          title: args.title,
          start: args.start,
          end: args.end,
          description: args.description,
          location: args.location,
          uid: args.uid,
          video_url: args.video_url,
        });
        const fromEmail = args.from_account.includes("@")
          ? args.from_account
          : `${args.from_account}@${config.domain}`;
        recordAccountSend(fromEmail);
        return okContent(result);
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
        const result = await toolCancelEventInvite({
          fromAccount: args.from_account,
          to: args.to,
          uid: args.uid,
          title: args.title,
          start: args.start,
          end: args.end,
          sequence: args.sequence,
        });
        return okContent(result);
      } catch (err) {
        recordError("cancel_event_invite");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Whitelist / Blacklist / Spam filter ─────────────────────────────────────

  // Tool 23: add_to_whitelist
  server.tool(
    "add_to_whitelist",
    "Add an email address or domain to the spam whitelist. Whitelisted senders are never moved to Junk by apply_spam_filter. Use @domain.com to whitelist an entire domain.",
    {
      account: z.string().describe("The full email address of the account"),
      address: z.string().describe("Email address (e.g. friend@example.com) or domain (e.g. @example.com) to whitelist"),
    },
    async (args) => {
      recordCall("add_to_whitelist");
      if (!checkRateLimit("add_to_whitelist", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("add_to_whitelist");
        return rateLimitErr("add_to_whitelist");
      }
      try {
        return okContent(await toolAddToWhitelist(args));
      } catch (err) {
        recordError("add_to_whitelist");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 24: remove_from_whitelist
  server.tool(
    "remove_from_whitelist",
    "Remove an entry from the spam whitelist by entry ID",
    {
      account: z.string().describe("The full email address of the account"),
      entry_id: z.string().describe("The entry ID from list_whitelist"),
    },
    async (args) => {
      recordCall("remove_from_whitelist");
      if (!checkRateLimit("remove_from_whitelist", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("remove_from_whitelist");
        return rateLimitErr("remove_from_whitelist");
      }
      try {
        return okContent(await toolRemoveFromWhitelist(args));
      } catch (err) {
        recordError("remove_from_whitelist");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 25: list_whitelist
  server.tool(
    "list_whitelist",
    "List all whitelist entries for an account",
    {
      account: z.string().describe("The full email address of the account"),
    },
    async (args) => {
      recordCall("list_whitelist");
      if (!checkRateLimit("list_whitelist", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_whitelist");
        return rateLimitErr("list_whitelist");
      }
      try {
        return okContent(await toolListWhitelist(args));
      } catch (err) {
        recordError("list_whitelist");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 26: add_to_blacklist
  server.tool(
    "add_to_blacklist",
    "Add an email address or domain to the spam blacklist. Blacklisted senders are immediately moved to Junk when apply_spam_filter is run. Use @domain.com to blacklist an entire domain.",
    {
      account: z.string().describe("The full email address of the account"),
      address: z.string().describe("Email address (e.g. spam@evil.com) or domain (e.g. @evil.com) to blacklist"),
    },
    async (args) => {
      recordCall("add_to_blacklist");
      if (!checkRateLimit("add_to_blacklist", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("add_to_blacklist");
        return rateLimitErr("add_to_blacklist");
      }
      try {
        return okContent(await toolAddToBlacklist(args));
      } catch (err) {
        recordError("add_to_blacklist");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 27: remove_from_blacklist
  server.tool(
    "remove_from_blacklist",
    "Remove an entry from the spam blacklist by entry ID",
    {
      account: z.string().describe("The full email address of the account"),
      entry_id: z.string().describe("The entry ID from list_blacklist"),
    },
    async (args) => {
      recordCall("remove_from_blacklist");
      if (!checkRateLimit("remove_from_blacklist", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("remove_from_blacklist");
        return rateLimitErr("remove_from_blacklist");
      }
      try {
        return okContent(await toolRemoveFromBlacklist(args));
      } catch (err) {
        recordError("remove_from_blacklist");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 28: list_blacklist
  server.tool(
    "list_blacklist",
    "List all blacklist entries for an account",
    {
      account: z.string().describe("The full email address of the account"),
    },
    async (args) => {
      recordCall("list_blacklist");
      if (!checkRateLimit("list_blacklist", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_blacklist");
        return rateLimitErr("list_blacklist");
      }
      try {
        return okContent(await toolListBlacklist(args));
      } catch (err) {
        recordError("list_blacklist");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 29: apply_spam_filter
  server.tool(
    "apply_spam_filter",
    "Scan a folder and move spam to Junk based on whitelist (skip), blacklist (always move), and heuristics (uppercase subject, repeated punctuation, spam keywords). Returns a summary of actions taken.",
    {
      account: z.string().describe("The full email address of the account"),
      folder: z.string().optional().describe("Folder to scan (default: Inbox)"),
    },
    async (args) => {
      recordCall("apply_spam_filter");
      if (!checkRateLimit("apply_spam_filter", apiKey, 20, 60 * 1000)) {
        recordRateLimit("apply_spam_filter");
        return rateLimitErr("apply_spam_filter");
      }
      try {
        return okContent(await toolApplySpamFilter(args));
      } catch (err) {
        recordError("apply_spam_filter");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Labels ───────────────────────────────────────────────────────────────────

  // Tool 30: add_label
  server.tool(
    "add_label",
    "Add a custom label (JMAP keyword) to an email for indexing and retrieval. Labels persist on the email and can be searched with search_by_label.",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
      label: z.string().describe("Label name (alphanumeric, hyphens, underscores only — e.g. 'invoice', 'follow-up', 'urgent')"),
    },
    async (args) => {
      recordCall("add_label");
      if (!checkRateLimit("add_label", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("add_label");
        return rateLimitErr("add_label");
      }
      try {
        return okContent(await toolAddLabel(args));
      } catch (err) {
        recordError("add_label");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 31: remove_label
  server.tool(
    "remove_label",
    "Remove a custom label from an email",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
      label: z.string().describe("Label name to remove"),
    },
    async (args) => {
      recordCall("remove_label");
      if (!checkRateLimit("remove_label", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("remove_label");
        return rateLimitErr("remove_label");
      }
      try {
        return okContent(await toolRemoveLabel(args));
      } catch (err) {
        recordError("remove_label");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 32: list_labels
  server.tool(
    "list_labels",
    "List all unique custom labels in use across an account's emails (scans up to 500 most recent emails)",
    {
      account: z.string().describe("The full email address of the account"),
    },
    async (args) => {
      recordCall("list_labels");
      if (!checkRateLimit("list_labels", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_labels");
        return rateLimitErr("list_labels");
      }
      try {
        return okContent(await toolListLabels(args));
      } catch (err) {
        recordError("list_labels");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 33: search_by_label
  server.tool(
    "search_by_label",
    "Find all emails that have a specific label applied",
    {
      account: z.string().describe("The full email address of the account"),
      label: z.string().describe("Label name to search for"),
    },
    async (args) => {
      recordCall("search_by_label");
      if (!checkRateLimit("search_by_label", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("search_by_label");
        return rateLimitErr("search_by_label");
      }
      try {
        return okContent(await toolSearchByLabel(args));
      } catch (err) {
        recordError("search_by_label");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Read/Flag state ──────────────────────────────────────────────────────────

  // Tool 34: mark_as_read
  server.tool(
    "mark_as_read",
    "Mark an email as read ($seen keyword). Use after an agent has processed an email to track what has been handled.",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
    },
    async (args) => {
      recordCall("mark_as_read");
      if (!checkRateLimit("mark_as_read", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("mark_as_read");
        return rateLimitErr("mark_as_read");
      }
      try {
        return okContent(await toolMarkAsRead(args.account, args.email_id));
      } catch (err) {
        recordError("mark_as_read");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 35: mark_as_unread
  server.tool(
    "mark_as_unread",
    "Mark an email as unread (clears $seen keyword). Useful to flag emails that need follow-up attention.",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
    },
    async (args) => {
      recordCall("mark_as_unread");
      if (!checkRateLimit("mark_as_unread", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("mark_as_unread");
        return rateLimitErr("mark_as_unread");
      }
      try {
        return okContent(await toolMarkAsUnread(args.account, args.email_id));
      } catch (err) {
        recordError("mark_as_unread");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 36: flag_email
  server.tool(
    "flag_email",
    "Flag or unflag an email ($flagged keyword). Use flagged=true to mark emails that need follow-up; false to remove the flag.",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
      flagged: z.boolean().describe("true to flag the email, false to unflag it"),
    },
    async (args) => {
      recordCall("flag_email");
      if (!checkRateLimit("flag_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("flag_email");
        return rateLimitErr("flag_email");
      }
      try {
        return okContent(await toolFlagEmail(args.account, args.email_id, args.flagged));
      } catch (err) {
        recordError("flag_email");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Folder management ────────────────────────────────────────────────────────

  // Tool 37: list_folders
  server.tool(
    "list_folders",
    "List all mailbox folders for an account with email counts. Includes Inbox, Sent, Trash, Junk, and any custom folders.",
    {
      account: z.string().describe("The full email address of the account"),
    },
    async (args) => {
      recordCall("list_folders");
      if (!checkRateLimit("list_folders", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("list_folders");
        return rateLimitErr("list_folders");
      }
      try {
        return okContent(await toolListFolders(args));
      } catch (err) {
        recordError("list_folders");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 38: create_folder
  server.tool(
    "create_folder",
    "Create a new mailbox folder. Optionally nest it under an existing folder.",
    {
      account: z.string().describe("The full email address of the account"),
      name: z.string().describe("Folder name to create"),
      parent_folder: z.string().optional().describe("Name of an existing folder to nest this under (optional)"),
    },
    async (args) => {
      recordCall("create_folder");
      if (!checkRateLimit("create_folder", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("create_folder");
        return rateLimitErr("create_folder");
      }
      try {
        return okContent(await toolCreateFolder(args));
      } catch (err) {
        recordError("create_folder");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 39: delete_folder
  server.tool(
    "delete_folder",
    "Delete a mailbox folder. The folder should be empty before deleting (move emails out first).",
    {
      account: z.string().describe("The full email address of the account"),
      folder: z.string().describe("Name of the folder to delete"),
    },
    async (args) => {
      recordCall("delete_folder");
      if (!checkRateLimit("delete_folder", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("delete_folder");
        return rateLimitErr("delete_folder");
      }
      try {
        return okContent(await toolDeleteFolder(args));
      } catch (err) {
        recordError("delete_folder");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 40: move_email
  server.tool(
    "move_email",
    "Move an email to a different folder. Use list_folders to see available folder names.",
    {
      account: z.string().describe("The full email address of the account"),
      email_id: z.string().describe("The JMAP email ID"),
      folder: z.string().describe("Destination folder name (e.g. 'Inbox', 'Archive', 'Projects')"),
    },
    async (args) => {
      recordCall("move_email");
      if (!checkRateLimit("move_email", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("move_email");
        return rateLimitErr("move_email");
      }
      try {
        return okContent(await toolMoveEmail(args));
      } catch (err) {
        recordError("move_email");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Bulk operations ──────────────────────────────────────────────────────────

  // Tool 41: bulk_move_emails
  server.tool(
    "bulk_move_emails",
    "Move multiple emails to a folder in a single JMAP call. More efficient than calling move_email repeatedly.",
    {
      account: z.string().describe("The full email address of the account"),
      email_ids: z.array(z.string()).min(1).max(100).describe("List of JMAP email IDs to move (max 100)"),
      folder: z.string().describe("Destination folder name"),
    },
    async (args) => {
      recordCall("bulk_move_emails");
      if (!checkRateLimit("bulk_move_emails", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("bulk_move_emails");
        return rateLimitErr("bulk_move_emails");
      }
      try {
        return okContent(await toolBulkMoveEmails(args.account, args.email_ids, args.folder));
      } catch (err) {
        recordError("bulk_move_emails");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 42: bulk_delete_emails
  server.tool(
    "bulk_delete_emails",
    "Move multiple emails to Trash in a single JMAP call. More efficient than calling delete_email repeatedly.",
    {
      account: z.string().describe("The full email address of the account"),
      email_ids: z.array(z.string()).min(1).max(100).describe("List of JMAP email IDs to delete (max 100)"),
    },
    async (args) => {
      recordCall("bulk_delete_emails");
      if (!checkRateLimit("bulk_delete_emails", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("bulk_delete_emails");
        return rateLimitErr("bulk_delete_emails");
      }
      try {
        return okContent(await toolBulkDeleteEmails(args.account, args.email_ids));
      } catch (err) {
        recordError("bulk_delete_emails");
        return errContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Tool 43: bulk_add_label
  server.tool(
    "bulk_add_label",
    "Apply a label to multiple emails in a single JMAP call. More efficient than calling add_label repeatedly.",
    {
      account: z.string().describe("The full email address of the account"),
      email_ids: z.array(z.string()).min(1).max(100).describe("List of JMAP email IDs to label (max 100)"),
      label: z.string().describe("Label name to apply (alphanumeric, hyphens, underscores only)"),
    },
    async (args) => {
      recordCall("bulk_add_label");
      if (!checkRateLimit("bulk_add_label", apiKey, config.limits.readOpsPerMinute, 60 * 1000)) {
        recordRateLimit("bulk_add_label");
        return rateLimitErr("bulk_add_label");
      }
      try {
        return okContent(await toolBulkAddLabel(args.account, args.email_ids, args.label));
      } catch (err) {
        recordError("bulk_add_label");
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
    },
    async (args) => {
      recordCall("reply_to_email");
      if (!checkRateLimit("reply_to_email", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("reply_to_email");
        return rateLimitErr("reply_to_email");
      }
      try {
        const result = await toolReplyToEmail({
          fromAccount: args.from_account,
          email_id: args.email_id,
          body: args.body,
          reply_all: args.reply_all,
        });
        const fromEmail = args.from_account.includes("@")
          ? args.from_account
          : `${args.from_account}@${config.domain}`;
        recordAccountSend(fromEmail);
        return okContent(result);
      } catch (err) {
        recordError("reply_to_email");
        return errContent(err instanceof Error ? err.message : String(err));
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
    },
    async (args) => {
      recordCall("forward_email");
      if (!checkRateLimit("forward_email", apiKey, config.limits.sendEmailPerMinute, 60 * 1000)) {
        recordRateLimit("forward_email");
        return rateLimitErr("forward_email");
      }
      try {
        const result = await toolForwardEmail({
          fromAccount: args.from_account,
          email_id: args.email_id,
          to: args.to,
          body: args.body,
        });
        const fromEmail = args.from_account.includes("@")
          ? args.from_account
          : `${args.from_account}@${config.domain}`;
        recordAccountSend(fromEmail);
        return okContent(result);
      } catch (err) {
        recordError("forward_email");
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
