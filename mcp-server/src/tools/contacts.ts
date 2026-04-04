import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Contact {
  contactId: string;
  email: string;
  name?: string;
  notes?: string;
  vip?: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTACTS_MAILBOX = "_contacts";
const CONTACT_PREFIX = "CONTACT:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEmail(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

function encodeSubject(contactEmail: string): string {
  return `${CONTACT_PREFIX}${contactEmail}`;
}

type StoredContact = Contact & { _emailId: string };

async function loadContacts(client: JmapClient): Promise<StoredContact[]> {
  const items = await client.listSystemEmails(CONTACTS_MAILBOX);
  const contacts: StoredContact[] = [];
  for (const item of items) {
    if (!item.subject.startsWith(CONTACT_PREFIX)) continue;
    try {
      const c = JSON.parse(item.body) as Contact;
      contacts.push({ ...c, _emailId: item.id });
    } catch {
      // corrupt entry — skip
    }
  }
  return contacts;
}

// ---------------------------------------------------------------------------
// Tool: manage_contact
// ---------------------------------------------------------------------------

export async function toolManageContact(params: {
  account: string;
  action: "create" | "update" | "delete";
  email: string;
  name?: string;
  notes?: string;
  vip?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<{ contact?: Contact; message: string }> {
  const { account, action, email: contactEmail } = params;
  const ownerEmail = resolveEmail(account);
  const client = new JmapClient(ownerEmail);

  switch (action) {
    case "create": {
      // Check for duplicate
      const existing = await loadContacts(client);
      if (existing.some((c) => c.email.toLowerCase() === contactEmail.toLowerCase())) {
        throw new Error(`Contact already exists for ${contactEmail}. Use action='update' to modify.`);
      }

      const now = new Date().toISOString();
      const contact: Contact = {
        contactId: crypto.randomUUID(),
        email: contactEmail,
        name: params.name,
        notes: params.notes,
        vip: params.vip,
        metadata: params.metadata,
        createdAt: now,
        updatedAt: now,
      };

      await client.createSystemEmail(
        CONTACTS_MAILBOX,
        encodeSubject(contactEmail),
        JSON.stringify(contact, null, 2),
      );

      return { contact, message: `Contact ${contactEmail} created` };
    }

    case "update": {
      const existing = await loadContacts(client);
      const found = existing.find((c) => c.email.toLowerCase() === contactEmail.toLowerCase());
      if (!found) throw new Error(`Contact not found: ${contactEmail}`);

      const { _emailId: foundEmailId, ...foundData } = found;
      const cleanContact: Contact = {
        ...foundData,
        name: params.name ?? found.name,
        notes: params.notes ?? found.notes,
        vip: params.vip ?? found.vip,
        metadata: params.metadata ?? found.metadata,
        updatedAt: new Date().toISOString(),
      };

      // Delete old entry, create new one
      await client.destroyEmail(foundEmailId);
      await client.createSystemEmail(
        CONTACTS_MAILBOX,
        encodeSubject(contactEmail),
        JSON.stringify(cleanContact, null, 2),
      );

      return { contact: cleanContact, message: `Contact ${contactEmail} updated` };
    }

    case "delete": {
      const existing = await loadContacts(client);
      const found = existing.find((c) => c.email.toLowerCase() === contactEmail.toLowerCase());
      if (!found) throw new Error(`Contact not found: ${contactEmail}`);

      await client.destroyEmail(found._emailId);  // _emailId exists on StoredContact
      return { message: `Contact ${contactEmail} deleted` };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}
