import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuleCondition {
  /** Case-insensitive substring match on the From address */
  from?: string;
  /** Case-insensitive substring match on subject */
  subject?: string;
  /** Match emails that have (true) or don't have (false) attachments */
  hasAttachment?: boolean;
  /** Match emails older than N days */
  olderThanDays?: number;
}

export interface RuleAction {
  /** Move matching emails to this folder (created if it doesn't exist) */
  moveTo?: string;
  /** Mark matching emails as read */
  markRead?: boolean;
  /** Move matching emails to Trash */
  delete?: boolean;
}

export interface MailboxRule {
  ruleId: string;
  name: string;
  condition: RuleCondition;
  action: RuleAction;
  createdAt: string;
}

export interface ApplyResult {
  matched: number;
  actions: Array<{ emailId: string; subject: string; actionTaken: string }>;
  errors: string[];
}

const RULES_MAILBOX = "_rules";
const SUBJECT_PREFIX = "RULE:";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveAccount(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

function encodeSubject(ruleId: string, name: string): string {
  return `${SUBJECT_PREFIX}${ruleId}:${name}`;
}

function parseSubject(subject: string): { ruleId: string; name: string } | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;
  const rest = subject.slice(SUBJECT_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  return { ruleId: rest.slice(0, colonIdx), name: rest.slice(colonIdx + 1) };
}

function matchesCondition(
  email: { from: string; subject: string; hasAttachment: boolean; receivedAt: string },
  condition: RuleCondition,
): boolean {
  if (condition.from !== undefined) {
    if (!email.from.toLowerCase().includes(condition.from.toLowerCase())) return false;
  }
  if (condition.subject !== undefined) {
    if (!email.subject.toLowerCase().includes(condition.subject.toLowerCase())) return false;
  }
  if (condition.hasAttachment !== undefined) {
    if (email.hasAttachment !== condition.hasAttachment) return false;
  }
  if (condition.olderThanDays !== undefined) {
    const cutoff = Date.now() - condition.olderThanDays * 24 * 60 * 60 * 1000;
    if (new Date(email.receivedAt).getTime() > cutoff) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tool: create_rule
// ---------------------------------------------------------------------------

export async function toolCreateRule(params: {
  account: string;
  name: string;
  condition: RuleCondition;
  action: RuleAction;
}): Promise<{ rule: MailboxRule; message: string }> {
  const { account, name, condition, action } = params;

  if (!name.trim()) throw new Error("name must not be empty");

  const hasAnyCondition =
    condition.from !== undefined ||
    condition.subject !== undefined ||
    condition.hasAttachment !== undefined ||
    condition.olderThanDays !== undefined;
  if (!hasAnyCondition) throw new Error("condition must have at least one field (from, subject, hasAttachment, or olderThanDays)");

  const hasAnyAction = action.moveTo !== undefined || action.markRead !== undefined || action.delete !== undefined;
  if (!hasAnyAction) throw new Error("action must have at least one field (moveTo, markRead, or delete)");

  if (condition.olderThanDays !== undefined && condition.olderThanDays <= 0) {
    throw new Error("olderThanDays must be positive");
  }

  const email = resolveAccount(account);
  const ruleId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const rule: MailboxRule = { ruleId, name, condition, action, createdAt };
  const client = new JmapClient(email);
  await client.createSystemEmail(RULES_MAILBOX, encodeSubject(ruleId, name), JSON.stringify(rule, null, 2));

  return { rule, message: `Rule "${name}" created for ${email}` };
}

// ---------------------------------------------------------------------------
// Tool: list_rules
// ---------------------------------------------------------------------------

export async function toolListRules(params: {
  account: string;
}): Promise<{ rules: MailboxRule[]; count: number }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const items = await client.listSystemEmails(RULES_MAILBOX);

  const rules: MailboxRule[] = [];
  for (const item of items) {
    if (!item.subject.startsWith(SUBJECT_PREFIX)) continue;
    try {
      rules.push(JSON.parse(item.body) as MailboxRule);
    } catch {
      // corrupt body — skip
    }
  }

  return { rules, count: rules.length };
}

// ---------------------------------------------------------------------------
// Tool: delete_rule
// ---------------------------------------------------------------------------

export async function toolDeleteRule(params: {
  account: string;
  rule_id: string;
}): Promise<{ message: string }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const items = await client.listSystemEmails(RULES_MAILBOX);

  for (const item of items) {
    const parsed = parseSubject(item.subject);
    if (parsed?.ruleId === params.rule_id) {
      await client.destroyEmail(item.id);
      return { message: `Rule ${params.rule_id} deleted` };
    }
  }
  throw new Error(`Rule not found: ${params.rule_id}`);
}

// ---------------------------------------------------------------------------
// Tool: apply_rules
// ---------------------------------------------------------------------------

export async function toolApplyRules(params: {
  account: string;
  folder?: string;
}): Promise<ApplyResult> {
  const email = resolveAccount(params.account);
  const folder = params.folder ?? "Inbox";
  const client = new JmapClient(email);

  // Load rules and emails in parallel
  const [{ rules }, emailsResult] = await Promise.all([
    toolListRules({ account: email }),
    client.listEmails(folder, 200),
  ]);

  if (rules.length === 0) return { matched: 0, actions: [], errors: [] };

  const result: ApplyResult = { matched: 0, actions: [], errors: [] };

  for (const emailItem of emailsResult) {
    for (const rule of rules) {
      if (!matchesCondition(emailItem, rule.condition)) continue;

      result.matched++;
      const { action } = rule;

      try {
        if (action.delete) {
          await client.deleteEmail(emailItem.id);
          result.actions.push({ emailId: emailItem.id, subject: emailItem.subject, actionTaken: "moved to Trash" });
        } else if (action.moveTo) {
          await client.moveEmail(emailItem.id, action.moveTo);
          result.actions.push({ emailId: emailItem.id, subject: emailItem.subject, actionTaken: `moved to ${action.moveTo}` });
        } else if (action.markRead) {
          await client.markEmailRead(emailItem.id);
          result.actions.push({ emailId: emailItem.id, subject: emailItem.subject, actionTaken: "marked as read" });
        }
      } catch (err) {
        result.errors.push(`Email ${emailItem.id} (${emailItem.subject}): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Each email is only processed by the first matching rule (first-match-wins)
      break;
    }
  }

  return result;
}
