import { patchAccount, accountExists } from "../clients/stalwart-mgmt.js";
import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_MAILBOX = "_settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveLocalPart(account: string): string {
  return account.includes("@") ? account.split("@")[0] : account;
}

function resolveEmail(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

// ---------------------------------------------------------------------------
// Tool: configure_account
// ---------------------------------------------------------------------------

export type AccountSetting =
  | "display_name"
  | "signature"
  | "vacation_reply"
  | "forwarding"
  | "suspend"
  | "reactivate";

export async function toolConfigureAccount(params: {
  account: string;
  setting: AccountSetting;
  value?: string;
}): Promise<{ message: string; setting: AccountSetting }> {
  const { account, setting, value } = params;
  const localPart = resolveLocalPart(account);
  const email = resolveEmail(account);

  if (!(await accountExists(localPart))) {
    throw new Error(`Account not found: ${email}`);
  }

  switch (setting) {
    case "display_name": {
      if (!value?.trim()) throw new Error("value is required for setting='display_name'");
      await patchAccount(localPart, [{ action: "set", field: "description", value }]);
      return { message: `Display name for ${email} set to "${value}"`, setting };
    }

    case "suspend": {
      await patchAccount(localPart, [
        { action: "removeItem", field: "enabledPermissions", value: "email-receive" },
      ]);
      return { message: `Account ${email} suspended — inbound delivery disabled`, setting };
    }

    case "reactivate": {
      await patchAccount(localPart, [
        { action: "addItem", field: "enabledPermissions", value: "email-receive" },
      ]);
      return { message: `Account ${email} reactivated — inbound delivery enabled`, setting };
    }

    case "signature":
    case "vacation_reply":
    case "forwarding": {
      const client = new JmapClient(email);
      const subject = `SETTING:${setting}`;

      // Delete any existing entry for this setting
      const existing = await client.listSystemEmails(SETTINGS_MAILBOX).catch(() => []);
      for (const item of existing) {
        if (item.subject === subject) {
          await client.destroyEmail(item.id).catch(() => {});
        }
      }

      if (value?.trim()) {
        await client.createSystemEmail(SETTINGS_MAILBOX, subject, value);
        return { message: `${setting} for ${email} updated`, setting };
      }
      return { message: `${setting} for ${email} cleared`, setting };
    }

    default: {
      const _exhaustive: never = setting;
      throw new Error(`Unknown setting: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: read all settings for an account (used by account://config Resource)
// ---------------------------------------------------------------------------

export async function getAccountSettings(email: string): Promise<Record<string, string>> {
  const client = new JmapClient(email);
  const items = await client.listSystemEmails(SETTINGS_MAILBOX).catch(() => []);
  const settings: Record<string, string> = {};
  for (const item of items) {
    if (item.subject.startsWith("SETTING:")) {
      const key = item.subject.slice("SETTING:".length);
      settings[key] = item.body;
    }
  }
  return settings;
}
