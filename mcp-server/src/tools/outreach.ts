import { JmapClient } from "../clients/jmap.js";
import { toolSendEmail } from "./send.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  templateId: string;
  name: string;
  subject: string;
  body: string;
  /** Variable names used in subject/body, e.g. ["first_name", "company"] */
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMPLATES_MAILBOX = "_templates";
const TEMPLATE_PREFIX = "TEMPLATE:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEmail(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

function encodeSubject(templateId: string, name: string): string {
  return `${TEMPLATE_PREFIX}${templateId}:${name}`;
}

type StoredTemplate = EmailTemplate & { _emailId: string };

async function loadTemplates(client: JmapClient): Promise<StoredTemplate[]> {
  const items = await client.listSystemEmails(TEMPLATES_MAILBOX);
  const templates: StoredTemplate[] = [];
  for (const item of items) {
    if (!item.subject.startsWith(TEMPLATE_PREFIX)) continue;
    try {
      const t = JSON.parse(item.body) as EmailTemplate;
      templates.push({ ...t, _emailId: item.id });
    } catch {
      // corrupt entry — skip
    }
  }
  return templates;
}

/** Replace {{variable_name}} placeholders in a template string. */
function applyVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

// ---------------------------------------------------------------------------
// Tool: manage_template
// ---------------------------------------------------------------------------

export async function toolManageTemplate(params: {
  account: string;
  action: "create" | "update" | "delete";
  template_id?: string;
  name?: string;
  subject?: string;
  body?: string;
  variables?: string[];
}): Promise<{ template?: EmailTemplate; message: string }> {
  const { account, action } = params;
  const email = resolveEmail(account);
  const client = new JmapClient(email);

  switch (action) {
    case "create": {
      if (!params.name?.trim()) throw new Error("name is required for action='create'");
      if (!params.subject?.trim()) throw new Error("subject is required for action='create'");
      if (!params.body?.trim()) throw new Error("body is required for action='create'");

      const now = new Date().toISOString();
      const template: EmailTemplate = {
        templateId: crypto.randomUUID(),
        name: params.name,
        subject: params.subject,
        body: params.body,
        variables: params.variables ?? [],
        createdAt: now,
        updatedAt: now,
      };

      await client.createSystemEmail(
        TEMPLATES_MAILBOX,
        encodeSubject(template.templateId, template.name),
        JSON.stringify(template, null, 2),
      );

      return { template, message: `Template "${template.name}" created (id: ${template.templateId})` };
    }

    case "update": {
      if (!params.template_id) throw new Error("template_id is required for action='update'");

      const all = await loadTemplates(client);
      const found = all.find((t) => t.templateId === params.template_id);
      if (!found) throw new Error(`Template not found: ${params.template_id}`);

      const { _emailId: foundEmailId, ...foundData } = found;
      const cleanTemplate: EmailTemplate = {
        ...foundData,
        name: params.name ?? found.name,
        subject: params.subject ?? found.subject,
        body: params.body ?? found.body,
        variables: params.variables ?? found.variables,
        updatedAt: new Date().toISOString(),
      };

      await client.destroyEmail(foundEmailId);
      await client.createSystemEmail(
        TEMPLATES_MAILBOX,
        encodeSubject(cleanTemplate.templateId, cleanTemplate.name),
        JSON.stringify(cleanTemplate, null, 2),
      );

      return { template: cleanTemplate, message: `Template "${cleanTemplate.name}" updated` };
    }

    case "delete": {
      if (!params.template_id) throw new Error("template_id is required for action='delete'");

      const all = await loadTemplates(client);
      const found = all.find((t) => t.templateId === params.template_id);
      if (!found) throw new Error(`Template not found: ${params.template_id}`);

      await client.destroyEmail(found._emailId);
      return { message: `Template ${params.template_id} deleted` };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool: send_batch
// ---------------------------------------------------------------------------

export async function toolSendBatch(params: {
  account: string;
  template_id: string;
  recipients: string[];
  variables?: Record<string, string>;
  idempotency_key?: string;
}): Promise<{ sent: number; failed: number; errors: string[] }> {
  const { account, template_id, recipients, variables = {} } = params;
  const email = resolveEmail(account);
  const client = new JmapClient(email);

  const all = await loadTemplates(client);
  const template = all.find((t) => t.templateId === template_id);
  if (!template) throw new Error(`Template not found: ${template_id}`);

  if (recipients.length === 0) throw new Error("recipients must not be empty");

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const recipient of recipients) {
    const recipientVars = { ...variables, email: recipient };
    const subject = applyVariables(template.subject, recipientVars);
    const body = applyVariables(template.body, recipientVars);

    try {
      await toolSendEmail({
        fromAccount: email,
        to: recipient,
        subject,
        body,
      });
      sent++;
    } catch (err) {
      failed++;
      errors.push(`${recipient}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { sent, failed, errors };
}
