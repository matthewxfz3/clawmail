import { JmapClient } from "../clients/jmap.js";
import type { EmailSummary, EmailDetail } from "../clients/jmap.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function buildClient(account: string): JmapClient {
  return new JmapClient(account);
}

// ---------------------------------------------------------------------------
// Tool: list_emails
// ---------------------------------------------------------------------------

export async function toolListEmails(
  account: string,
  folder?: string,
  limit?: number,
): Promise<{ emails: EmailSummary[]; count: number; folder: string }> {
  const effectiveFolder = folder ?? "Inbox";
  const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const client = buildClient(account);
  const emails = await client.listEmails(effectiveFolder, effectiveLimit);

  return {
    emails,
    count: emails.length,
    folder: effectiveFolder,
  };
}

// ---------------------------------------------------------------------------
// Tool: read_email
// ---------------------------------------------------------------------------

export async function toolReadEmail(
  account: string,
  emailId: string,
): Promise<EmailDetail> {
  const client = buildClient(account);
  return client.getEmail(emailId);
}

// ---------------------------------------------------------------------------
// Tool: delete_email
// ---------------------------------------------------------------------------

export async function toolDeleteEmail(
  account: string,
  emailId: string,
): Promise<{ message: string }> {
  const client = buildClient(account);
  await client.deleteEmail(emailId);
  return { message: `Email ${emailId} moved to Trash` };
}

// ---------------------------------------------------------------------------
// Tool: mark_as_read
// ---------------------------------------------------------------------------

export async function toolMarkAsRead(
  account: string,
  emailId: string,
): Promise<{ message: string }> {
  const client = buildClient(account);
  await client.markEmailRead(emailId);
  return { message: `Email ${emailId} marked as read` };
}

// ---------------------------------------------------------------------------
// Tool: mark_as_unread
// ---------------------------------------------------------------------------

export async function toolMarkAsUnread(
  account: string,
  emailId: string,
): Promise<{ message: string }> {
  const client = buildClient(account);
  await client.setEmailKeyword(emailId, "$seen", false);
  return { message: `Email ${emailId} marked as unread` };
}

// ---------------------------------------------------------------------------
// Tool: flag_email
// ---------------------------------------------------------------------------

export async function toolFlagEmail(
  account: string,
  emailId: string,
  flagged: boolean,
): Promise<{ message: string }> {
  const client = buildClient(account);
  await client.setEmailKeyword(emailId, "$flagged", flagged);
  return { message: `Email ${emailId} ${flagged ? "flagged" : "unflagged"}` };
}

// ---------------------------------------------------------------------------
// Tool: bulk_move_emails
// ---------------------------------------------------------------------------

export async function toolBulkMoveEmails(
  account: string,
  emailIds: string[],
  folder: string,
): Promise<{ moved: number; failed: number; failed_ids: string[] }> {
  if (emailIds.length === 0) return { moved: 0, failed: 0, failed_ids: [] };
  const client = buildClient(account);
  const result = await client.bulkMoveEmails(emailIds, folder);
  return { moved: result.moved.length, failed: result.failed.length, failed_ids: result.failed };
}

// ---------------------------------------------------------------------------
// Tool: bulk_delete_emails
// ---------------------------------------------------------------------------

export async function toolBulkDeleteEmails(
  account: string,
  emailIds: string[],
): Promise<{ deleted: number; failed: number; failed_ids: string[] }> {
  if (emailIds.length === 0) return { deleted: 0, failed: 0, failed_ids: [] };
  const client = buildClient(account);
  const result = await client.bulkDestroyEmails(emailIds);
  return { deleted: result.deleted.length, failed: result.failed.length, failed_ids: result.failed };
}

// ---------------------------------------------------------------------------
// Tool: bulk_add_label
// ---------------------------------------------------------------------------

const LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function toolBulkAddLabel(
  account: string,
  emailIds: string[],
  label: string,
): Promise<{ updated: number; failed: number; failed_ids: string[] }> {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`Invalid label "${label}". Labels must contain only alphanumeric characters, hyphens, or underscores.`);
  }
  if (emailIds.length === 0) return { updated: 0, failed: 0, failed_ids: [] };
  const client = buildClient(account);
  const result = await client.bulkSetKeyword(emailIds, label, true);
  return { updated: result.updated.length, failed: result.failed.length, failed_ids: result.failed };
}

// ---------------------------------------------------------------------------
// Tool: search_emails
// ---------------------------------------------------------------------------

export async function toolSearchEmails(
  account: string,
  query: string,
  includeSpam = false,
): Promise<{ emails: EmailSummary[]; count: number; query: string }> {
  const client = buildClient(account);
  let excludeMailboxes: string[] | undefined;
  if (!includeSpam) {
    const junkId = await client.resolveMailboxId("Junk");
    if (junkId !== null) excludeMailboxes = [junkId];
  }
  const emails = await client.searchEmails(query, { excludeMailboxes });
  return {
    emails,
    count: emails.length,
    query,
  };
}
