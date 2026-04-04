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
