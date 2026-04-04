import { JmapClient } from "../clients/jmap.js";
import type { EmailSummary } from "../clients/jmap.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `Invalid label "${label}". Labels must contain only alphanumeric characters, hyphens, or underscores.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tool: add_label
// ---------------------------------------------------------------------------

export async function toolAddLabel(params: {
  account: string;
  email_id: string;
  label: string;
}): Promise<{ message: string }> {
  validateLabel(params.label);
  const client = new JmapClient(params.account);
  await client.setEmailKeyword(params.email_id, params.label, true);
  return { message: `Label "${params.label}" added to email ${params.email_id}` };
}

// ---------------------------------------------------------------------------
// Tool: remove_label
// ---------------------------------------------------------------------------

export async function toolRemoveLabel(params: {
  account: string;
  email_id: string;
  label: string;
}): Promise<{ message: string }> {
  validateLabel(params.label);
  const client = new JmapClient(params.account);
  await client.setEmailKeyword(params.email_id, params.label, false);
  return { message: `Label "${params.label}" removed from email ${params.email_id}` };
}

// ---------------------------------------------------------------------------
// Tool: list_labels
// ---------------------------------------------------------------------------

export async function toolListLabels(params: {
  account: string;
}): Promise<{ labels: string[]; count: number }> {
  const client = new JmapClient(params.account);
  const items = await client.listEmailsWithKeywords(500);
  const labelSet = new Set<string>();
  for (const item of items) {
    for (const kw of item.keywords) {
      labelSet.add(kw);
    }
  }
  const labels = [...labelSet].sort();
  return { labels, count: labels.length };
}

// ---------------------------------------------------------------------------
// Tool: search_by_label
// ---------------------------------------------------------------------------

export async function toolSearchByLabel(params: {
  account: string;
  label: string;
}): Promise<{ emails: EmailSummary[]; count: number; label: string }> {
  validateLabel(params.label);
  const client = new JmapClient(params.account);
  const emails = await client.searchByKeyword(params.label);
  return { emails, count: emails.length, label: params.label };
}
