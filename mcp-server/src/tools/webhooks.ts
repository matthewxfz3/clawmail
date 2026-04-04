import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Webhook {
  webhookId: string;
  url: string;
  /** Event types to deliver, e.g. ["mail.received", "mail.bounced"] */
  events: string[];
  /** HMAC-SHA256 signing secret — included as X-Clawmail-Signature header */
  secret?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Webhooks are stored per-account in a system mailbox.
// Delivery is handled by the server when matching events occur.
const WEBHOOKS_MAILBOX = "_webhooks";
const WEBHOOK_PREFIX = "WEBHOOK:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEmail(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

type StoredWebhook = Webhook & { _emailId: string };

async function loadWebhooks(client: JmapClient): Promise<StoredWebhook[]> {
  const items = await client.listSystemEmails(WEBHOOKS_MAILBOX);
  const webhooks: StoredWebhook[] = [];
  for (const item of items) {
    if (!item.subject.startsWith(WEBHOOK_PREFIX)) continue;
    try {
      const w = JSON.parse(item.body) as Webhook;
      webhooks.push({ ...w, _emailId: item.id });
    } catch {
      // corrupt entry — skip
    }
  }
  return webhooks;
}

// ---------------------------------------------------------------------------
// Tool: manage_webhook
// ---------------------------------------------------------------------------

export async function toolManageWebhook(params: {
  account: string;
  action: "register" | "unregister";
  url?: string;
  events?: string[];
  secret?: string;
  webhook_id?: string;
}): Promise<{ webhook?: Webhook; message: string }> {
  const { account, action } = params;
  const email = resolveEmail(account);
  const client = new JmapClient(email);

  switch (action) {
    case "register": {
      if (!params.url?.trim()) throw new Error("url is required for action='register'");
      if (!params.events || params.events.length === 0) {
        throw new Error("events is required for action='register' (e.g. ['mail.received'])");
      }

      // Validate URL format
      try {
        new URL(params.url);
      } catch {
        throw new Error(`Invalid webhook URL: "${params.url}"`);
      }

      const webhook: Webhook = {
        webhookId: crypto.randomUUID(),
        url: params.url,
        events: params.events,
        secret: params.secret,
        createdAt: new Date().toISOString(),
      };

      await client.createSystemEmail(
        WEBHOOKS_MAILBOX,
        `${WEBHOOK_PREFIX}${webhook.webhookId}`,
        JSON.stringify(webhook, null, 2),
      );

      return {
        webhook,
        message: `Webhook registered for events [${params.events.join(", ")}] → ${params.url} (id: ${webhook.webhookId})`,
      };
    }

    case "unregister": {
      if (!params.webhook_id) throw new Error("webhook_id is required for action='unregister'");

      const all = await loadWebhooks(client);
      const found = all.find((w) => w.webhookId === params.webhook_id);
      if (!found) throw new Error(`Webhook not found: ${params.webhook_id}`);

      await client.destroyEmail(found._emailId);
      return { message: `Webhook ${params.webhook_id} unregistered` };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: load all webhooks for an account (used for event delivery)
// ---------------------------------------------------------------------------

export async function getAccountWebhooks(account: string): Promise<Webhook[]> {
  const email = resolveEmail(account);
  const client = new JmapClient(email);
  const stored = await loadWebhooks(client).catch(() => []);
  return stored.map(({ _emailId: _unused, ...w }) => w);
}
