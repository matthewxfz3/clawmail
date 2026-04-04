import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Scheduled drafts that are awaiting send_at delivery are stored in this
// system mailbox. The MCP server does not have a background scheduler, so
// delivery requires an external cron / Cloud Scheduler calling a trigger.
const SCHEDULED_MAILBOX = "_scheduled";
const SCHEDULED_PREFIX = "SCHEDULED:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEmail(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

// ---------------------------------------------------------------------------
// Tool: manage_draft
// ---------------------------------------------------------------------------

export async function toolManageDraft(params: {
  account: string;
  action: "create" | "update" | "send" | "delete" | "schedule";
  draft_id?: string;
  subject?: string;
  body?: string;
  to?: string | string[];
  cc?: string[];
  send_at?: string;
}): Promise<{ draft_id?: string; message: string; queued_at?: string }> {
  const { account, action } = params;
  const email = resolveEmail(account);
  const client = new JmapClient(email);

  const toList = params.to
    ? Array.isArray(params.to) ? params.to : [params.to]
    : undefined;

  switch (action) {
    case "create": {
      const draftId = await client.saveDraft({
        to: toList,
        cc: params.cc,
        subject: params.subject,
        body: params.body,
      });
      return { draft_id: draftId, message: `Draft created (id: ${draftId})` };
    }

    case "update": {
      if (!params.draft_id) throw new Error("draft_id is required for action='update'");
      const newId = await client.updateDraft(params.draft_id, {
        to: toList,
        cc: params.cc,
        subject: params.subject,
        body: params.body,
      });
      return { draft_id: newId, message: `Draft updated (new id: ${newId})` };
    }

    case "send": {
      if (!params.draft_id) throw new Error("draft_id is required for action='send'");
      const draft = await client.getEmail(params.draft_id);

      if (draft.to.length === 0) throw new Error("Draft has no recipients — add to addresses before sending");

      // Send via nodemailer (same path as toolSendEmail)
      const { toolSendEmail } = await import("./send.js");
      const result = await toolSendEmail({
        fromAccount: email,
        to: draft.to,
        subject: draft.subject,
        body: draft.textBody ?? draft.htmlBody?.replace(/<[^>]+>/g, "") ?? "",
      });

      // Delete the draft
      await client.destroyEmail(params.draft_id).catch(() => {});

      return { message: `Draft sent and deleted`, queued_at: result.queued_at };
    }

    case "delete": {
      if (!params.draft_id) throw new Error("draft_id is required for action='delete'");
      await client.destroyEmail(params.draft_id);
      return { message: `Draft ${params.draft_id} deleted` };
    }

    case "schedule": {
      if (!params.draft_id) throw new Error("draft_id is required for action='schedule'");
      if (!params.send_at) throw new Error("send_at is required for action='schedule'");
      const sendAt = new Date(params.send_at);
      if (isNaN(sendAt.getTime())) throw new Error(`send_at is not a valid ISO 8601 date-time: "${params.send_at}"`);

      const draft = await client.getEmail(params.draft_id);

      // Store a scheduled delivery record — external cron reads this mailbox
      // and delivers when send_at passes.
      const record = JSON.stringify({
        draft_id: params.draft_id,
        account: email,
        to: draft.to,
        subject: draft.subject,
        body: draft.textBody ?? draft.htmlBody?.replace(/<[^>]+>/g, "") ?? "",
        send_at: params.send_at,
        scheduled_at: new Date().toISOString(),
      });

      await client.createSystemEmail(
        SCHEDULED_MAILBOX,
        `${SCHEDULED_PREFIX}${params.draft_id}`,
        record,
      );

      return {
        draft_id: params.draft_id,
        message: `Draft ${params.draft_id} scheduled to send at ${params.send_at}`,
        queued_at: params.send_at,
      };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}
