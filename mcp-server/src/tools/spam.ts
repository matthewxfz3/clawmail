import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";

function resolveAccount(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

// ---------------------------------------------------------------------------
// Tool: mark_as_spam — move email to Junk folder
// ---------------------------------------------------------------------------

export async function toolMarkAsSpam(params: {
  account: string;
  email_id: string;
}): Promise<{ message: string }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  await client.moveEmail(params.email_id, "Junk");
  return { message: `Email ${params.email_id} moved to Junk` };
}

// ---------------------------------------------------------------------------
// Tool: mark_as_not_spam — move email from Junk back to Inbox
// ---------------------------------------------------------------------------

export async function toolMarkAsNotSpam(params: {
  account: string;
  email_id: string;
}): Promise<{ message: string }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  await client.moveEmail(params.email_id, "Inbox");
  return { message: `Email ${params.email_id} moved to Inbox` };
}
