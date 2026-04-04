import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";
import type { EmailSummary } from "../clients/jmap.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterEntry {
  entryId: string;
  /** Exact address (e.g. "spam@example.com") OR domain wildcard (e.g. "@example.com") */
  address: string;
  createdAt: string;
}

export interface SpamFilterResult {
  moved: number;
  skipped: number;
  actions: Array<{
    emailId: string;
    subject: string;
    from: string;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WHITELIST_MAILBOX = "_whitelist";
const BLACKLIST_MAILBOX = "_blacklist";
const WL_PREFIX = "WL:";
const BL_PREFIX = "BL:";

const SPAM_KEYWORDS = [
  "you won",
  "you have won",
  "claim your prize",
  "free money",
  "act now",
  "lottery",
  "inheritance",
  "make money fast",
  "make money online",
  "wire transfer",
  "nigerian prince",
  "unclaimed funds",
  "get rich",
  "congratulations you",
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveAccount(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

function encodeSubject(prefix: string, entryId: string, address: string): string {
  return `${prefix}${entryId}:${address}`;
}

function parseFilterSubject(
  subject: string,
  prefix: string,
): { entryId: string; address: string } | null {
  if (!subject.startsWith(prefix)) return null;
  const rest = subject.slice(prefix.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  return { entryId: rest.slice(0, colonIdx), address: rest.slice(colonIdx + 1) };
}

/** Strip display name: "Foo Bar <foo@bar.com>" → "foo@bar.com". */
function extractAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

/** Match a sender against a filter entry address (exact or domain wildcard). */
function addressMatchesEntry(senderFrom: string, entryAddress: string): boolean {
  const sender = extractAddress(senderFrom);
  const entry = entryAddress.toLowerCase().trim();
  if (entry.startsWith("@")) {
    return sender.endsWith(entry);
  }
  return sender === entry;
}

/** Validate address contains @ and is not obviously malformed. */
function validateAddress(address: string): void {
  if (!address.includes("@")) {
    throw new Error(
      `Invalid address "${address}". Must be an email address or @domain.com for domain-wide matching.`,
    );
  }
}

type LoadedEntry = FilterEntry & { _emailId: string };

async function loadFilterEntries(
  client: JmapClient,
  mailboxName: string,
  prefix: string,
): Promise<LoadedEntry[]> {
  const items = await client.listSystemEmails(mailboxName);
  const entries: LoadedEntry[] = [];
  for (const item of items) {
    const parsed = parseFilterSubject(item.subject, prefix);
    if (!parsed) continue;
    try {
      const body = JSON.parse(item.body) as FilterEntry;
      entries.push({ ...body, _emailId: item.id });
    } catch {
      // corrupt entry — skip
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Heuristic spam detection
// ---------------------------------------------------------------------------

function detectSpamHeuristics(
  email: Pick<EmailSummary, "subject" | "from">,
): string | null {
  const subject = email.subject;
  const combined = (subject + " " + email.from).toLowerCase();

  // Check 1: uppercase ratio > 70% in subject (only if ≥6 letters)
  const letters = subject.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 6) {
    const upperCount = subject.replace(/[^A-Z]/g, "").length;
    if (upperCount / letters.length > 0.70) {
      return "subject uppercase ratio > 70%";
    }
  }

  // Check 2: 3+ consecutive ! or ?
  if (/[!?]{3,}/.test(subject)) {
    return "subject contains 3+ consecutive ! or ?";
  }

  // Check 3: 2+ spam keyword matches
  let hits = 0;
  const matched: string[] = [];
  for (const kw of SPAM_KEYWORDS) {
    if (combined.includes(kw)) {
      matched.push(kw);
      if (++hits >= 2) break;
    }
  }
  if (hits >= 2) {
    return `matched spam keywords: ${matched.join(", ")}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool: add_to_whitelist
// ---------------------------------------------------------------------------

export async function toolAddToWhitelist(params: {
  account: string;
  address: string;
}): Promise<{ entry: FilterEntry; message: string }> {
  validateAddress(params.address);
  const email = resolveAccount(params.account);
  const entryId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const entry: FilterEntry = { entryId, address: params.address, createdAt };
  const client = new JmapClient(email);
  await client.createSystemEmail(
    WHITELIST_MAILBOX,
    encodeSubject(WL_PREFIX, entryId, params.address),
    JSON.stringify(entry, null, 2),
  );
  return { entry, message: `"${params.address}" added to whitelist for ${email}` };
}

// ---------------------------------------------------------------------------
// Tool: remove_from_whitelist
// ---------------------------------------------------------------------------

export async function toolRemoveFromWhitelist(params: {
  account: string;
  entry_id: string;
}): Promise<{ message: string }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const entries = await loadFilterEntries(client, WHITELIST_MAILBOX, WL_PREFIX);
  const found = entries.find((e) => e.entryId === params.entry_id);
  if (!found) throw new Error(`Whitelist entry not found: ${params.entry_id}`);
  await client.destroyEmail(found._emailId);
  return { message: `Whitelist entry ${params.entry_id} (${found.address}) removed` };
}

// ---------------------------------------------------------------------------
// Tool: list_whitelist
// ---------------------------------------------------------------------------

export async function toolListWhitelist(params: {
  account: string;
}): Promise<{ entries: FilterEntry[]; count: number }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const loaded = await loadFilterEntries(client, WHITELIST_MAILBOX, WL_PREFIX);
  const entries = loaded.map(({ _emailId: _unused, ...e }) => e);
  return { entries, count: entries.length };
}

// ---------------------------------------------------------------------------
// Tool: add_to_blacklist
// ---------------------------------------------------------------------------

export async function toolAddToBlacklist(params: {
  account: string;
  address: string;
}): Promise<{ entry: FilterEntry; message: string }> {
  validateAddress(params.address);
  const email = resolveAccount(params.account);
  const entryId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const entry: FilterEntry = { entryId, address: params.address, createdAt };
  const client = new JmapClient(email);
  await client.createSystemEmail(
    BLACKLIST_MAILBOX,
    encodeSubject(BL_PREFIX, entryId, params.address),
    JSON.stringify(entry, null, 2),
  );
  return { entry, message: `"${params.address}" added to blacklist for ${email}` };
}

// ---------------------------------------------------------------------------
// Tool: remove_from_blacklist
// ---------------------------------------------------------------------------

export async function toolRemoveFromBlacklist(params: {
  account: string;
  entry_id: string;
}): Promise<{ message: string }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const entries = await loadFilterEntries(client, BLACKLIST_MAILBOX, BL_PREFIX);
  const found = entries.find((e) => e.entryId === params.entry_id);
  if (!found) throw new Error(`Blacklist entry not found: ${params.entry_id}`);
  await client.destroyEmail(found._emailId);
  return { message: `Blacklist entry ${params.entry_id} (${found.address}) removed` };
}

// ---------------------------------------------------------------------------
// Tool: list_blacklist
// ---------------------------------------------------------------------------

export async function toolListBlacklist(params: {
  account: string;
}): Promise<{ entries: FilterEntry[]; count: number }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const loaded = await loadFilterEntries(client, BLACKLIST_MAILBOX, BL_PREFIX);
  const entries = loaded.map(({ _emailId: _unused, ...e }) => e);
  return { entries, count: entries.length };
}

// ---------------------------------------------------------------------------
// Tool: apply_spam_filter
// ---------------------------------------------------------------------------

export async function toolApplySpamFilter(params: {
  account: string;
  folder?: string;
}): Promise<SpamFilterResult> {
  const email = resolveAccount(params.account);
  const folder = params.folder ?? "Inbox";
  const client = new JmapClient(email);

  // Load whitelist, blacklist, and inbox emails in parallel
  const [whitelistEntries, blacklistEntries, emails] = await Promise.all([
    loadFilterEntries(client, WHITELIST_MAILBOX, WL_PREFIX),
    loadFilterEntries(client, BLACKLIST_MAILBOX, BL_PREFIX),
    client.listEmails(folder, 200),
  ]);

  const result: SpamFilterResult = { moved: 0, skipped: 0, actions: [] };

  for (const emailItem of emails) {
    // 1. Whitelist — always skip
    const whitelisted = whitelistEntries.some((e) =>
      addressMatchesEntry(emailItem.from, e.address),
    );
    if (whitelisted) {
      result.skipped++;
      continue;
    }

    // 2. Blacklist — move to Junk immediately
    const blacklisted = blacklistEntries.find((e) =>
      addressMatchesEntry(emailItem.from, e.address),
    );
    if (blacklisted) {
      try {
        await client.moveEmail(emailItem.id, "Junk");
        result.moved++;
        result.actions.push({
          emailId: emailItem.id,
          subject: emailItem.subject,
          from: emailItem.from,
          reason: `blacklisted address: ${blacklisted.address}`,
        });
      } catch (err) {
        result.actions.push({
          emailId: emailItem.id,
          subject: emailItem.subject,
          from: emailItem.from,
          reason: `blacklist move failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      continue;
    }

    // 3. Heuristics
    const reason = detectSpamHeuristics(emailItem);
    if (reason !== null) {
      try {
        await client.moveEmail(emailItem.id, "Junk");
        result.moved++;
        result.actions.push({
          emailId: emailItem.id,
          subject: emailItem.subject,
          from: emailItem.from,
          reason,
        });
      } catch (err) {
        result.actions.push({
          emailId: emailItem.id,
          subject: emailItem.subject,
          from: emailItem.from,
          reason: `heuristic move failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      result.skipped++;
    }
  }

  return result;
}
