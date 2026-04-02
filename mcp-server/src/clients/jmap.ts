import { config } from "../config.js";

// ---------------------------------------------------------------------------
// JMAP types
// ---------------------------------------------------------------------------

interface JmapSession {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

// JMAP method calls and responses are 3-tuples represented as arrays.
type JmapMethodCall = [
  methodName: string,
  args: Record<string, unknown>,
  clientId: string,
];

type JmapMethodResponse = [
  methodName: string,
  response: Record<string, unknown>,
  clientId: string,
];

export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  hasAttachment: boolean;
  preview: string;
  mailboxIds: string[];
}

export interface EmailDetail extends EmailSummary {
  htmlBody?: string;
  textBody?: string;
  headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function basicAuthHeader(): string {
  const credentials = `${config.stalwart.adminUser}:${config.stalwart.adminPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/** Module-level session cache (shared — we always auth as admin). */
let cachedSession: JmapSession | undefined;

/** Cache: email → opaque JMAP account ID. */
const jmapIdCache = new Map<string, string>();

/** Extract a plain-text address from a JMAP EmailAddress object or string. */
function addressToString(addr: unknown): string {
  if (typeof addr === "string") return addr;
  if (addr !== null && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    const email = typeof a["email"] === "string" ? a["email"] : "";
    const name = typeof a["name"] === "string" ? a["name"] : "";
    return name ? `${name} <${email}>` : email;
  }
  return "";
}

function addressListToStrings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map(addressToString);
}

/** Safely coerce a JMAP body-part list to its first text value. */
function firstBodyText(parts: unknown): string | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const part = parts[0] as Record<string, unknown>;
  return typeof part["value"] === "string" ? part["value"] : undefined;
}

/** Collect header:*:asText properties from a raw email object. */
function collectHeaders(raw: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    if (key.startsWith("header:") && key.endsWith(":asText")) {
      // key format: "header:<Name>:asText"
      const parts = key.split(":");
      if (parts.length >= 2) {
        const headerName = parts[1];
        const value = raw[key];
        if (typeof value === "string") {
          headers[headerName] = value;
        }
      }
    }
  }
  return headers;
}

/** Convert a raw JMAP Email object into an EmailSummary. */
function rawToSummary(raw: Record<string, unknown>): EmailSummary {
  const fromArr = raw["from"];
  const fromStr = Array.isArray(fromArr) && fromArr.length > 0
    ? addressToString(fromArr[0])
    : addressToString(fromArr);

  const mailboxIds = raw["mailboxIds"] !== null &&
    typeof raw["mailboxIds"] === "object"
    ? Object.keys(raw["mailboxIds"] as Record<string, unknown>)
    : [];

  return {
    id: typeof raw["id"] === "string" ? raw["id"] : "",
    subject: typeof raw["subject"] === "string" ? raw["subject"] : "(no subject)",
    from: fromStr,
    to: addressListToStrings(raw["to"]),
    receivedAt: typeof raw["receivedAt"] === "string" ? raw["receivedAt"] : "",
    hasAttachment: raw["hasAttachment"] === true,
    preview: typeof raw["preview"] === "string" ? raw["preview"] : "",
    mailboxIds,
  };
}

/** Convert a raw JMAP Email object into an EmailDetail. */
function rawToDetail(raw: Record<string, unknown>): EmailDetail {
  const summary = rawToSummary(raw);
  return {
    ...summary,
    htmlBody: firstBodyText(raw["htmlBody"]),
    textBody: firstBodyText(raw["textBody"]),
    headers: collectHeaders(raw),
  };
}

// ---------------------------------------------------------------------------
// JmapClient
// ---------------------------------------------------------------------------

export class JmapClient {
  /**
   * @param email  Full email address of the target account (e.g. "user@domain").
   *               Used to resolve the opaque JMAP account ID via the Principals API.
   */
  constructor(private readonly email: string) {}

  // -------------------------------------------------------------------------
  // Private: session discovery (shared admin session)
  // -------------------------------------------------------------------------

  private async getSession(): Promise<JmapSession> {
    if (cachedSession !== undefined) return cachedSession;

    const wellKnownUrl = new URL("/.well-known/jmap", config.stalwart.url).toString();

    const res = await fetch(wellKnownUrl, {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(),
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      let body: string;
      try {
        body = await res.text();
      } catch {
        body = "<unreadable body>";
      }
      throw new Error(
        `JMAP session discovery failed: HTTP ${res.status} — ${body}`,
      );
    }

    const data = (await res.json()) as {
      apiUrl?: string;
      primaryAccounts?: Record<string, string>;
    };

    if (!data.apiUrl) {
      throw new Error("JMAP session response missing apiUrl");
    }

    cachedSession = {
      apiUrl: data.apiUrl,
      primaryAccounts: data.primaryAccounts ?? {},
    };

    return cachedSession;
  }

  // -------------------------------------------------------------------------
  // Private: resolve email → opaque JMAP account ID via Principals API
  // -------------------------------------------------------------------------

  private async resolveAccountId(): Promise<string> {
    const cached = jmapIdCache.get(this.email);
    if (cached !== undefined) return cached;

    const session = await this.getSession();

    // The admin's primary account ID handles the Principals capability.
    const principalsAccountId =
      session.primaryAccounts["urn:ietf:params:jmap:principals"] ??
      session.primaryAccounts["urn:ietf:params:jmap:mail"];

    if (!principalsAccountId) {
      throw new Error("Cannot determine JMAP principals account ID from session");
    }

    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"],
        methodCalls: [
          ["Principal/get", { accountId: principalsAccountId, ids: null }, "pget"],
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`Principal/get failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { methodResponses?: Array<[string, Record<string, unknown>, string]> };
    const pResponse = (data.methodResponses ?? []).find(([, , id]) => id === "pget");
    if (!pResponse) {
      throw new Error("No Principal/get response from JMAP");
    }

    const list = (pResponse[1] as { list?: Array<Record<string, unknown>> }).list ?? [];
    const principal = list.find(
      (p) => typeof p["email"] === "string" && p["email"].toLowerCase() === this.email.toLowerCase(),
    );

    if (!principal || typeof principal["id"] !== "string") {
      throw new Error(`No JMAP principal found for email: ${this.email}`);
    }

    const jmapId = principal["id"] as string;
    jmapIdCache.set(this.email, jmapId);
    return jmapId;
  }

  // -------------------------------------------------------------------------
  // Private: core request
  // -------------------------------------------------------------------------

  private async request(calls: JmapMethodCall[]): Promise<JmapMethodResponse[]> {
    const session = await this.getSession();

    const body = JSON.stringify({
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
      ],
      methodCalls: calls,
    });

    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });

    if (!res.ok) {
      let errBody: string;
      try {
        errBody = await res.text();
      } catch {
        errBody = "<unreadable body>";
      }
      throw new Error(
        `JMAP request failed: HTTP ${res.status} — ${errBody}`,
      );
    }

    const data = (await res.json()) as {
      methodResponses?: JmapMethodResponse[];
    };

    return data.methodResponses ?? [];
  }

  // -------------------------------------------------------------------------
  // Private: mailbox lookup
  // -------------------------------------------------------------------------

  private async getMailboxId(name: string): Promise<string | null> {
    const accountId = await this.resolveAccountId();
    const responses = await this.request([
      [
        "Mailbox/query",
        {
          accountId,
          filter: { name },
        },
        "mb1",
      ],
    ]);

    const response = responses.find(([, , id]) => id === "mb1");
    if (!response) return null;

    const ids = (response[1] as { ids?: string[] }).ids ?? [];
    return ids.length > 0 ? ids[0] : null;
  }

  // -------------------------------------------------------------------------
  // Public: list all mailboxes with their totalEmails count (single request)
  // -------------------------------------------------------------------------

  async listMailboxes(): Promise<Array<{ id: string; name: string; role: string; totalEmails: number; unreadEmails: number }>> {
    const accountId = await this.resolveAccountId();
    const responses = await this.request([
      [
        "Mailbox/get",
        {
          accountId,
          ids: null, // null = all mailboxes
          properties: ["id", "name", "role", "totalEmails", "unreadEmails"],
        },
        "mbs",
      ],
    ]);

    const response = responses.find(([, , id]) => id === "mbs");
    if (!response) return [];

    const list = (response[1] as { list?: Array<Record<string, unknown>> }).list ?? [];
    return list.map((m) => ({
      id: typeof m["id"] === "string" ? m["id"] : "",
      name: typeof m["name"] === "string" ? m["name"] : "",
      role: typeof m["role"] === "string" ? m["role"] : "",
      totalEmails: typeof m["totalEmails"] === "number" ? m["totalEmails"] : 0,
      unreadEmails: typeof m["unreadEmails"] === "number" ? m["unreadEmails"] : 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Public: count emails in a folder (uses calculateTotal, no body fetch)
  // -------------------------------------------------------------------------

  async countEmails(folder = "Inbox"): Promise<number> {
    const accountId = await this.resolveAccountId();
    const mailboxId = await this.getMailboxId(folder);

    const queryFilter: Record<string, unknown> = {};
    if (mailboxId !== null) {
      queryFilter["inMailbox"] = mailboxId;
    }

    const responses = await this.request([
      [
        "Email/query",
        {
          accountId,
          filter: queryFilter,
          calculateTotal: true,
          limit: 0,
        },
        "cnt1",
      ],
    ]);

    const response = responses.find(([, , id]) => id === "cnt1");
    if (!response) return 0;
    const total = (response[1] as { total?: number }).total;
    return typeof total === "number" ? total : 0;
  }

  // -------------------------------------------------------------------------
  // Public: list emails
  // -------------------------------------------------------------------------

  async listEmails(
    folder = "Inbox",
    limit = 50,
  ): Promise<EmailSummary[]> {
    const accountId = await this.resolveAccountId();
    const mailboxId = await this.getMailboxId(folder);

    const queryFilter: Record<string, unknown> = {};
    if (mailboxId !== null) {
      queryFilter["inMailbox"] = mailboxId;
    }

    const responses = await this.request([
      [
        "Email/query",
        {
          accountId,
          filter: queryFilter,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
        },
        "c1",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "c1",
            name: "Email/query",
            path: "/ids",
          },
          properties: [
            "id",
            "subject",
            "from",
            "to",
            "receivedAt",
            "hasAttachment",
            "preview",
            "mailboxIds",
          ],
        },
        "c2",
      ],
    ]);

    const getResponse = responses.find(([, , id]) => id === "c2");
    if (!getResponse) return [];

    const list = (getResponse[1] as { list?: Record<string, unknown>[] }).list ?? [];
    return list.map(rawToSummary);
  }

  // -------------------------------------------------------------------------
  // Public: get full email
  // -------------------------------------------------------------------------

  async getEmail(emailId: string): Promise<EmailDetail> {
    const accountId = await this.resolveAccountId();
    const responses = await this.request([
      [
        "Email/get",
        {
          accountId,
          ids: [emailId],
          properties: [
            "id",
            "subject",
            "from",
            "to",
            "receivedAt",
            "hasAttachment",
            "preview",
            "mailboxIds",
            "htmlBody",
            "textBody",
            "header:*:asText",
          ],
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
        },
        "c1",
      ],
    ]);

    const response = responses.find(([, , id]) => id === "c1");
    if (!response) {
      throw new Error(`JMAP returned no response for Email/get (id: ${emailId})`);
    }

    const list = (response[1] as { list?: Record<string, unknown>[] }).list ?? [];
    if (list.length === 0) {
      throw new Error(`Email not found: ${emailId}`);
    }

    return rawToDetail(list[0]);
  }

  // -------------------------------------------------------------------------
  // Public: delete email (move to Trash)
  // -------------------------------------------------------------------------

  async deleteEmail(emailId: string): Promise<void> {
    const accountId = await this.resolveAccountId();
    const trashId = await this.getMailboxId("Trash");
    if (trashId === null) {
      throw new Error('Could not locate "Trash" mailbox for account: ' + this.email);
    }

    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          update: {
            [emailId]: {
              mailboxIds: { [trashId]: true },
            },
          },
        },
        "c1",
      ],
    ]);

    const response = responses.find(([, , id]) => id === "c1");
    if (!response) {
      throw new Error(`JMAP returned no response for Email/set (deleteEmail: ${emailId})`);
    }

    const notUpdated = (
      response[1] as { notUpdated?: Record<string, unknown> }
    ).notUpdated;

    if (notUpdated && Object.keys(notUpdated).length > 0) {
      const details = JSON.stringify(notUpdated[emailId] ?? notUpdated);
      throw new Error(`Failed to move email ${emailId} to Trash: ${details}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public: search emails
  // -------------------------------------------------------------------------

  async searchEmails(query: string): Promise<EmailSummary[]> {
    const accountId = await this.resolveAccountId();
    const responses = await this.request([
      [
        "Email/query",
        {
          accountId,
          filter: { text: query },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 50,
        },
        "c1",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "c1",
            name: "Email/query",
            path: "/ids",
          },
          properties: [
            "id",
            "subject",
            "from",
            "to",
            "receivedAt",
            "hasAttachment",
            "preview",
            "mailboxIds",
          ],
        },
        "c2",
      ],
    ]);

    const getResponse = responses.find(([, , id]) => id === "c2");
    if (!getResponse) return [];

    const list = (getResponse[1] as { list?: Record<string, unknown>[] }).list ?? [];
    return list.map(rawToSummary);
  }
}
