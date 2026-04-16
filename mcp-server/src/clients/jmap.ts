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

/**
 * Master-user impersonation header.
 * Format: "targetEmail*adminUser:adminPassword"
 * This gives back a JMAP session scoped to targetEmail so we can read their
 * mail directly — no cross-account ACL needed.
 */
function impersonateAuthHeader(targetEmail: string): string {
  const credentials = `${targetEmail}*${config.stalwart.adminUser}:${config.stalwart.adminPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/** Cache TTL: 5 minutes. Cloud Run instances are long-lived so we need expiry. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Module-level admin session cache. */
let cachedSession: JmapSession | undefined;
let cachedSessionAt = 0;

/** Per-user context cache: email → { apiUrl, accountId, authHeader, cachedAt } */
interface UserContext {
  apiUrl: string;
  accountId: string;
  authHeader: string;
  cachedAt: number;
}
const userContextCache = new Map<string, UserContext>();

/** Cache: email → opaque JMAP account ID (admin-resolved fallback). */
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
  // Private: resolve per-user JMAP context (impersonation-first)
  // -------------------------------------------------------------------------

  /**
   * Strategy 1 — master-user impersonation:
   *   Authenticate as "email*admin:adminpass".
   *   If Stalwart supports it, the session comes back scoped to the target
   *   user, so primaryAccounts["urn:ietf:params:jmap:mail"] is their own
   *   account ID and all subsequent requests are fully authorised.
   *
   * Strategy 2 — admin auth + Principal/get (fallback):
   *   Original approach. Works for management ops but Stalwart may refuse
   *   cross-account Email queries with accountNotFound.
   */
  private async getUserContext(): Promise<UserContext> {
    const cached = userContextCache.get(this.email);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;

    const wellKnownUrl = new URL("/.well-known/jmap", config.stalwart.url).toString();

    // ── Strategy 1: impersonation ────────────────────────────────────────────
    const impersonateAuth = impersonateAuthHeader(this.email);
    try {
      const fetchOptions: any = {
        method: "GET",
        headers: { Authorization: impersonateAuth, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      };
      if (config.stalwart.url.startsWith("https://")) {
        fetchOptions.dispatcher = config.stalwart.httpsAgent;
      }
      const res = await fetch(wellKnownUrl, fetchOptions);
      if (res.ok) {
        const data = (await res.json()) as {
          apiUrl?: string;
          primaryAccounts?: Record<string, string>;
        };
        const apiUrl = data.apiUrl;
        const accountId = data.primaryAccounts?.["urn:ietf:params:jmap:mail"];
        if (apiUrl && accountId) {
          console.log(`[jmap] strategy=impersonate email=${this.email} accountId=${accountId}`);
          const ctx: UserContext = { apiUrl, accountId, authHeader: impersonateAuth, cachedAt: Date.now() };
          userContextCache.set(this.email, ctx);
          return ctx;
        }
        console.warn(`[jmap] impersonate ok but missing apiUrl/accountId for ${this.email}, falling back`);
      }
    } catch (err) {
      console.warn(`[jmap] impersonate failed for ${this.email}:`, err);
    }

    // ── Strategy 2: admin session + Principal/get ────────────────────────────
    console.log(`[jmap] strategy=admin-principal email=${this.email}`);
    const adminSession = await this.getAdminSession();
    const accountId = await this.resolveAccountIdViaAdmin(adminSession);
    const ctx: UserContext = { apiUrl: adminSession.apiUrl, accountId, authHeader: basicAuthHeader(), cachedAt: Date.now() };
    userContextCache.set(this.email, ctx);
    return ctx;
  }

  // ── Admin session (shared, cached) ────────────────────────────────────────

  private async getAdminSession(): Promise<JmapSession> {
    if (cachedSession !== undefined && Date.now() - cachedSessionAt < CACHE_TTL_MS) return cachedSession;

    const wellKnownUrl = new URL("/.well-known/jmap", config.stalwart.url).toString();
    const fetchOptions: any = {
      method: "GET",
      headers: { Authorization: basicAuthHeader(), Accept: "application/json" },
    };
    if (config.stalwart.url.startsWith("https://")) {
      fetchOptions.dispatcher = config.stalwart.httpsAgent;
    }
    const res = await fetch(wellKnownUrl, fetchOptions);

    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable body>");
      throw new Error(`JMAP admin session discovery failed: HTTP ${res.status} — ${body}`);
    }

    const data = (await res.json()) as {
      apiUrl?: string;
      primaryAccounts?: Record<string, string>;
    };

    if (!data.apiUrl) throw new Error("JMAP session response missing apiUrl");

    cachedSession = { apiUrl: data.apiUrl, primaryAccounts: data.primaryAccounts ?? {} };
    cachedSessionAt = Date.now();
    return cachedSession;
  }

  private async resolveAccountIdViaAdmin(session: JmapSession): Promise<string> {
    const cached = jmapIdCache.get(this.email);
    if (cached !== undefined) return cached;

    const principalsAccountId =
      session.primaryAccounts["urn:ietf:params:jmap:principals"] ??
      session.primaryAccounts["urn:ietf:params:jmap:mail"];

    if (!principalsAccountId) {
      throw new Error("Cannot determine JMAP principals account ID from session");
    }

    const fetchOptions: any = {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"],
        methodCalls: [["Principal/get", { accountId: principalsAccountId, ids: null }, "pget"]],
      }),
    };
    if (config.stalwart.url.startsWith("https://")) {
      fetchOptions.dispatcher = config.stalwart.httpsAgent;
    }
    const res = await fetch(session.apiUrl, fetchOptions);

    if (!res.ok) throw new Error(`Principal/get failed: HTTP ${res.status}`);

    const data = (await res.json()) as { methodResponses?: Array<[string, Record<string, unknown>, string]> };
    const pResponse = (data.methodResponses ?? []).find(([, , id]) => id === "pget");
    if (!pResponse) throw new Error("No Principal/get response from JMAP");

    const list = (pResponse[1] as { list?: Array<Record<string, unknown>> }).list ?? [];

    // Primary match: exact email comparison.
    // Fallback: match by local part only — handles accounts whose stored email still
    // has an old domain (e.g. after a domain migration like duckdns → fridaymailer.com).
    const localPart = this.email.split("@")[0].toLowerCase();
    const principal =
      list.find((p) => typeof p["email"] === "string" && p["email"].toLowerCase() === this.email.toLowerCase()) ??
      list.find((p) => typeof p["name"] === "string" && p["name"].toLowerCase() === localPart);

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
    const ctx = await this.getUserContext();

    const body = JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: calls,
    });

    const fetchOptions: any = {
      method: "POST",
      headers: {
        Authorization: ctx.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    };
    if (config.stalwart.url.startsWith("https://")) {
      fetchOptions.dispatcher = config.stalwart.httpsAgent;
    }
    const res = await fetch(ctx.apiUrl, fetchOptions);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "<unreadable body>");
      throw new Error(`JMAP request failed: HTTP ${res.status} — ${errBody}`);
    }

    const data = (await res.json()) as {
      methodResponses?: JmapMethodResponse[];
    };

    return data.methodResponses ?? [];
  }

  /** Convenience: return just the accountId from the user context. */
  private async getAccountId(): Promise<string> {
    return (await this.getUserContext()).accountId;
  }

  // -------------------------------------------------------------------------
  // Private: mailbox lookup
  // -------------------------------------------------------------------------

  private async getMailboxId(name: string): Promise<string | null> {
    const accountId = await this.getAccountId();
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

  /** Find a mailbox by its JMAP role (e.g. "trash", "junk", "sent", "inbox").
   *  More reliable than name-based lookup since folder names vary by mail client. */
  private async getMailboxIdByRole(role: string): Promise<string | null> {
    const mailboxes = await this.listMailboxes();
    const found = mailboxes.find((m) => m.role.toLowerCase() === role.toLowerCase());
    return found ? found.id : null;
  }

  // -------------------------------------------------------------------------
  // Public: list all mailboxes with their totalEmails count (single request)
  // -------------------------------------------------------------------------

  async listMailboxes(): Promise<Array<{ id: string; name: string; role: string; totalEmails: number; unreadEmails: number }>> {
    const accountId = await this.getAccountId();
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
    const accountId = await this.getAccountId();
    const mailboxId = await this.getMailboxId(folder);
    if (mailboxId === null) return 0;

    const queryFilter: Record<string, unknown> = { inMailbox: mailboxId };

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
    const accountId = await this.getAccountId();
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
    const accountId = await this.getAccountId();
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
  // Public: get all emails in a thread
  // -------------------------------------------------------------------------

  /**
   * Return all emails belonging to a thread, ordered oldest-first.
   * @param threadId  The JMAP threadId (returned in EmailSummary or EmailDetail headers).
   */
  async getThread(threadId: string): Promise<EmailDetail[]> {
    const accountId = await this.getAccountId();
    const responses = await this.request([
      [
        "Email/query",
        {
          accountId,
          filter: { threadId },
          sort: [{ property: "receivedAt", isAscending: true }],
        },
        "tq1",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "tq1",
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
            "htmlBody",
            "textBody",
            "header:*:asText",
          ],
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
        },
        "tg1",
      ],
    ]);

    const getResponse = responses.find(([, , id]) => id === "tg1");
    if (!getResponse) return [];
    const list = (getResponse[1] as { list?: Record<string, unknown>[] }).list ?? [];
    return list.map(rawToDetail);
  }

  // -------------------------------------------------------------------------
  // Public: delete email (move to Trash)
  // -------------------------------------------------------------------------

  async deleteEmail(emailId: string): Promise<void> {
    const accountId = await this.getAccountId();
    const trashId = await this.getMailboxIdByRole("trash") ?? await this.getMailboxId("Trash");
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

  async searchEmails(
    query: string,
    opts?: { excludeMailboxes?: string[] },
  ): Promise<EmailSummary[]> {
    const accountId = await this.getAccountId();
    const filter: Record<string, unknown> = { text: query };
    if (opts?.excludeMailboxes && opts.excludeMailboxes.length > 0) {
      filter["inMailboxOtherThan"] = opts.excludeMailboxes;
    }
    const responses = await this.request([
      [
        "Email/query",
        {
          accountId,
          filter,
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

  // -------------------------------------------------------------------------
  // Public: resolve a mailbox name to its JMAP ID (exposed for tools)
  // -------------------------------------------------------------------------

  async resolveMailboxId(name: string): Promise<string | null> {
    return this.getMailboxId(name);
  }

  // -------------------------------------------------------------------------
  // Public: set or clear a custom keyword (label) on an email
  // value=true adds the keyword, value=false removes it (sets to null in patch)
  // -------------------------------------------------------------------------

  async setEmailKeyword(emailId: string, keyword: string, value: boolean): Promise<void> {
    const accountId = await this.getAccountId();
    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          update: { [emailId]: { [`keywords/${keyword}`]: value ? true : null } },
        },
        "kw1",
      ],
    ]);
    const resp = responses.find(([, , id]) => id === "kw1");
    const notUpdated = (resp?.[1] as { notUpdated?: Record<string, unknown> })?.notUpdated;
    if (notUpdated?.[emailId]) {
      throw new Error(`setEmailKeyword failed for ${emailId}: ${JSON.stringify(notUpdated[emailId])}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public: return the custom (non-system) keywords on a single email
  // -------------------------------------------------------------------------

  async getEmailKeywords(emailId: string): Promise<string[]> {
    const accountId = await this.getAccountId();
    const responses = await this.request([
      ["Email/get", { accountId, ids: [emailId], properties: ["keywords"] }, "gk1"],
    ]);
    const resp = responses.find(([, , id]) => id === "gk1");
    const list = (resp?.[1] as { list?: Array<Record<string, unknown>> })?.list ?? [];
    if (list.length === 0) throw new Error(`Email not found: ${emailId}`);
    const keywords = list[0]["keywords"];
    if (!keywords || typeof keywords !== "object") return [];
    return Object.keys(keywords as Record<string, unknown>).filter((k) => !k.startsWith("$"));
  }

  // -------------------------------------------------------------------------
  // Public: search emails by JMAP keyword (label)
  // -------------------------------------------------------------------------

  async searchByKeyword(keyword: string): Promise<EmailSummary[]> {
    const accountId = await this.getAccountId();
    const responses = await this.request([
      [
        "Email/query",
        {
          accountId,
          filter: { hasKeyword: keyword },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 200,
        },
        "kq1",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "kq1", name: "Email/query", path: "/ids" },
          properties: ["id", "subject", "from", "to", "receivedAt", "hasAttachment", "preview", "mailboxIds"],
        },
        "kg1",
      ],
    ]);
    const getResponse = responses.find(([, , id]) => id === "kg1");
    const list = (getResponse?.[1] as { list?: Record<string, unknown>[] })?.list ?? [];
    return list.map(rawToSummary);
  }

  // -------------------------------------------------------------------------
  // Public: fetch emails with their custom keyword lists (for label inventory)
  // -------------------------------------------------------------------------

  async listEmailsWithKeywords(limit = 500): Promise<Array<{ id: string; keywords: string[] }>> {
    const accountId = await this.getAccountId();
    const responses = await this.request([
      [
        "Email/query",
        { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit },
        "lkq1",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "lkq1", name: "Email/query", path: "/ids" },
          properties: ["id", "keywords"],
        },
        "lkg1",
      ],
    ]);
    const getResponse = responses.find(([, , id]) => id === "lkg1");
    const list = (getResponse?.[1] as { list?: Record<string, unknown>[] })?.list ?? [];
    return list.map((item) => {
      const kws = item["keywords"];
      const keys = kws && typeof kws === "object"
        ? Object.keys(kws as Record<string, unknown>).filter((k) => !k.startsWith("$"))
        : [];
      return { id: String(item["id"] ?? ""), keywords: keys };
    });
  }

  // -------------------------------------------------------------------------
  // Public: permanently destroy an email (no Trash involved)
  // Used for system emails (calendar events, rules) where Trash is irrelevant.
  // -------------------------------------------------------------------------

  async destroyEmail(emailId: string): Promise<void> {
    const accountId = await this.getAccountId();
    const responses = await this.request([
      [
        "Email/set",
        { accountId, destroy: [emailId] },
        "de1",
      ],
    ]);
    const resp = responses.find(([, , id]) => id === "de1");
    const notDestroyed = (resp?.[1] as { notDestroyed?: Record<string, unknown> })?.notDestroyed;
    if (notDestroyed?.[emailId]) {
      throw new Error(`Failed to destroy email ${emailId}: ${JSON.stringify(notDestroyed[emailId])}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public: ensure a mailbox exists, create it if not — returns mailbox id
  // -------------------------------------------------------------------------

  async ensureMailbox(name: string): Promise<string> {
    const existing = await this.getMailboxId(name);
    if (existing !== null) return existing;

    const accountId = await this.getAccountId();
    const responses = await this.request([
      [
        "Mailbox/set",
        {
          accountId,
          create: {
            mb1: { name, parentId: null },
          },
        },
        "mbc1",
      ],
    ]);

    const response = responses.find(([, , id]) => id === "mbc1");
    const created = (response?.[1] as { created?: Record<string, { id?: string }> })?.created;
    const newId = created?.["mb1"]?.id;
    if (!newId) {
      // May have lost a race — try fetching again
      const retry = await this.getMailboxId(name);
      if (retry !== null) return retry;
      throw new Error(`Failed to create mailbox "${name}" for ${this.email}`);
    }
    return newId;
  }

  // -------------------------------------------------------------------------
  // Public: move email to a different mailbox folder
  // -------------------------------------------------------------------------

  async moveEmail(emailId: string, targetFolder: string): Promise<void> {
    const accountId = await this.getAccountId();
    const targetId = await this.getMailboxId(targetFolder);
    if (targetId === null) {
      throw new Error(`Mailbox not found: "${targetFolder}" for ${this.email}`);
    }

    // Get current mailboxIds so we can replace them
    const getResponses = await this.request([
      ["Email/get", { accountId, ids: [emailId], properties: ["mailboxIds"] }, "eg1"],
    ]);
    const getResp = getResponses.find(([, , id]) => id === "eg1");
    const emailList = (getResp?.[1] as { list?: Array<Record<string, unknown>> })?.list ?? [];
    if (emailList.length === 0) throw new Error(`Email not found: ${emailId}`);

    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          update: {
            [emailId]: { mailboxIds: { [targetId]: true } },
          },
        },
        "mv1",
      ],
    ]);

    const resp = responses.find(([, , id]) => id === "mv1");
    const notUpdated = (resp?.[1] as { notUpdated?: Record<string, unknown> })?.notUpdated;
    if (notUpdated?.[emailId]) {
      throw new Error(`Failed to move email ${emailId}: ${JSON.stringify(notUpdated[emailId])}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public: mark an email as read ($seen keyword)
  // -------------------------------------------------------------------------

  async markEmailRead(emailId: string): Promise<void> {
    const accountId = await this.getAccountId();
    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          update: { [emailId]: { "keywords/$seen": true } },
        },
        "mr1",
      ],
    ]);
    const resp = responses.find(([, , id]) => id === "mr1");
    const notUpdated = (resp?.[1] as { notUpdated?: Record<string, unknown> })?.notUpdated;
    if (notUpdated?.[emailId]) {
      console.warn(`[jmap] markEmailRead failed for ${emailId}:`, JSON.stringify(notUpdated[emailId]));
    }
  }

  // -------------------------------------------------------------------------
  // Public: create a system email in a named mailbox (calendar events, rules)
  // -------------------------------------------------------------------------

  async createSystemEmail(mailboxName: string, subject: string, body: string): Promise<string> {
    const accountId = await this.getAccountId();
    const mailboxId = await this.ensureMailbox(mailboxName);
    const now = new Date().toISOString();

    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          create: {
            sys1: {
              mailboxIds: { [mailboxId]: true },
              keywords: { "$seen": true },
              from: [{ email: this.email }],
              to: [{ email: this.email }],
              subject,
              sentAt: now,
              bodyValues: { body: { value: body, isEncodingProblem: false, isTruncated: false } },
              textBody: [{ partId: "body", type: "text/plain" }],
            },
          },
        },
        "sys1",
      ],
    ]);

    const resp = responses.find(([, , id]) => id === "sys1");
    const created = (resp?.[1] as { created?: Record<string, { id?: string }> })?.created;
    const emailId = created?.["sys1"]?.id;
    if (!emailId) {
      const notCreated = (resp?.[1] as { notCreated?: Record<string, unknown> })?.notCreated;
      throw new Error(`Failed to create system email in ${mailboxName}: ${JSON.stringify(notCreated?.["sys1"] ?? "unknown error")}`);
    }
    return emailId;
  }

  // -------------------------------------------------------------------------
  // Public: list system emails from a named mailbox with subject+body
  // -------------------------------------------------------------------------

  async listSystemEmails(mailboxName: string): Promise<Array<{ id: string; subject: string; body: string }>> {
    const accountId = await this.getAccountId();
    const mailboxId = await this.getMailboxId(mailboxName);
    if (mailboxId === null) return []; // mailbox doesn't exist yet → no items

    const responses = await this.request([
      [
        "Email/query",
        {
          accountId,
          filter: { inMailbox: mailboxId },
          sort: [{ property: "receivedAt", isAscending: true }],
          limit: 500,
        },
        "sq1",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "sq1", name: "Email/query", path: "/ids" },
          properties: ["id", "subject", "textBody", "bodyValues"],
          fetchTextBodyValues: true,
        },
        "sg1",
      ],
    ]);

    const getResp = responses.find(([, , id]) => id === "sg1");
    const list = (getResp?.[1] as { list?: Record<string, unknown>[] })?.list ?? [];

    return list.map((item) => {
      const subject = typeof item["subject"] === "string" ? item["subject"] : "";
      // JMAP stores body text in bodyValues[partId], not inline in textBody parts
      const textParts = Array.isArray(item["textBody"]) ? item["textBody"] as Array<Record<string, unknown>> : [];
      const bodyValues = item["bodyValues"] as Record<string, Record<string, unknown>> | undefined;
      const partId = textParts.length > 0 ? String(textParts[0]["partId"] ?? "body") : "body";
      const body = typeof bodyValues?.[partId]?.["value"] === "string"
        ? bodyValues[partId]["value"] as string
        : "";
      return { id: String(item["id"] ?? ""), subject, body };
    });
  }

  // -------------------------------------------------------------------------
  // Public: save a sent message copy to the Sent folder
  // -------------------------------------------------------------------------

  async saveToSent(params: {
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    sentAt: string;
  }): Promise<void> {
    const accountId = await this.getAccountId();
    const sentId = await this.getMailboxIdByRole("sent") ?? await this.getMailboxId("Sent");
    if (sentId === null) {
      // Sent folder doesn't exist — skip silently rather than failing the send
      console.warn(`[jmap] saveToSent: no Sent mailbox found for ${this.email}`);
      return;
    }

    const toAddresses = params.to.map((e) => ({ email: e }));
    const ccAddresses = (params.cc ?? []).map((e) => ({ email: e }));

    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          create: {
            sent1: {
              mailboxIds: { [sentId]: true },
              keywords: { "$seen": true },
              from: [{ email: params.from }],
              to: toAddresses,
              ...(ccAddresses.length > 0 ? { cc: ccAddresses } : {}),
              subject: params.subject,
              sentAt: params.sentAt,
              bodyValues: { body: { value: params.body, isEncodingProblem: false, isTruncated: false } },
              textBody: [{ partId: "body", type: "text/plain" }],
            },
          },
        },
        "sv1",
      ],
    ]);

    const response = responses.find(([, , id]) => id === "sv1");
    if (!response) return;

    const notCreated = (response[1] as { notCreated?: Record<string, unknown> }).notCreated;
    if (notCreated?.["sent1"]) {
      console.warn(`[jmap] saveToSent failed for ${this.email}:`, JSON.stringify(notCreated["sent1"]));
    }
  }

  // -------------------------------------------------------------------------
  // Public: bulk move multiple emails to a folder in one JMAP call
  // -------------------------------------------------------------------------

  async bulkMoveEmails(emailIds: string[], targetFolder: string): Promise<{ moved: string[]; failed: string[] }> {
    if (emailIds.length === 0) return { moved: [], failed: [] };
    const accountId = await this.getAccountId();
    const targetId = await this.getMailboxId(targetFolder);
    if (targetId === null) throw new Error(`Mailbox not found: "${targetFolder}"`);

    const update: Record<string, unknown> = {};
    for (const id of emailIds) {
      update[id] = { mailboxIds: { [targetId]: true } };
    }

    const responses = await this.request([
      ["Email/set", { accountId, update }, "bm1"],
    ]);
    const resp = responses.find(([, , id]) => id === "bm1");
    const notUpdated = (resp?.[1] as { notUpdated?: Record<string, unknown> })?.notUpdated ?? {};
    const failed = Object.keys(notUpdated);
    const moved = emailIds.filter((id) => !failed.includes(id));
    return { moved, failed };
  }

  // -------------------------------------------------------------------------
  // Public: bulk destroy (trash) multiple emails in one JMAP call
  // -------------------------------------------------------------------------

  async bulkDestroyEmails(emailIds: string[]): Promise<{ deleted: string[]; failed: string[] }> {
    if (emailIds.length === 0) return { deleted: [], failed: [] };
    const accountId = await this.getAccountId();
    const trashId = await this.getMailboxIdByRole("trash") ?? await this.getMailboxId("Trash");
    if (trashId === null) throw new Error("Trash mailbox not found");

    const update: Record<string, unknown> = {};
    for (const id of emailIds) {
      update[id] = { mailboxIds: { [trashId]: true } };
    }

    const responses = await this.request([
      ["Email/set", { accountId, update }, "bd1"],
    ]);
    const resp = responses.find(([, , id]) => id === "bd1");
    const notUpdated = (resp?.[1] as { notUpdated?: Record<string, unknown> })?.notUpdated ?? {};
    const failed = Object.keys(notUpdated);
    const deleted = emailIds.filter((id) => !failed.includes(id));
    return { deleted, failed };
  }

  // -------------------------------------------------------------------------
  // Public: bulk set/clear a keyword on multiple emails in one JMAP call
  // -------------------------------------------------------------------------

  async bulkSetKeyword(emailIds: string[], keyword: string, value: boolean): Promise<{ updated: string[]; failed: string[] }> {
    if (emailIds.length === 0) return { updated: [], failed: [] };
    const accountId = await this.getAccountId();

    const update: Record<string, unknown> = {};
    for (const id of emailIds) {
      update[id] = { [`keywords/${keyword}`]: value ? true : null };
    }

    const responses = await this.request([
      ["Email/set", { accountId, update }, "bk1"],
    ]);
    const resp = responses.find(([, , id]) => id === "bk1");
    const notUpdated = (resp?.[1] as { notUpdated?: Record<string, unknown> })?.notUpdated ?? {};
    const failed = Object.keys(notUpdated);
    const updated = emailIds.filter((id) => !failed.includes(id));
    return { updated, failed };
  }

  // -------------------------------------------------------------------------
  // Public: delete a mailbox by name
  // -------------------------------------------------------------------------

  async deleteMailbox(name: string): Promise<void> {
    const mailboxId = await this.getMailboxId(name);
    if (mailboxId === null) throw new Error(`Mailbox not found: "${name}"`);

    const accountId = await this.getAccountId();
    const responses = await this.request([
      ["Mailbox/set", { accountId, destroy: [mailboxId] }, "mbd1"],
    ]);
    const resp = responses.find(([, , id]) => id === "mbd1");
    const notDestroyed = (resp?.[1] as { notDestroyed?: Record<string, unknown> })?.notDestroyed;
    if (notDestroyed?.[mailboxId]) {
      throw new Error(`Failed to delete mailbox "${name}": ${JSON.stringify(notDestroyed[mailboxId])}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public: create a mailbox, optionally nested under a parent
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Public: apply an action to every email in a thread
  // -------------------------------------------------------------------------

  async updateThread(params: {
    threadId: string;
    action: "archive" | "delete" | "mute" | "add_label" | "remove_label";
    label?: string;
  }): Promise<{ affected: number }> {
    const emails = await this.getThread(params.threadId);
    if (emails.length === 0) return { affected: 0 };
    const ids = emails.map((e) => e.id);

    if (params.action === "archive") {
      const result = await this.bulkMoveEmails(ids, "Archive");
      return { affected: result.moved.length };
    }
    if (params.action === "delete") {
      const result = await this.bulkDestroyEmails(ids);
      return { affected: result.deleted.length };
    }
    if (params.action === "mute") {
      const result = await this.bulkSetKeyword(ids, "$muted", true);
      return { affected: result.updated.length };
    }
    if (params.action === "add_label") {
      if (!params.label) throw new Error("label is required for action='add_label'");
      const result = await this.bulkSetKeyword(ids, params.label, true);
      return { affected: result.updated.length };
    }
    if (params.action === "remove_label") {
      if (!params.label) throw new Error("label is required for action='remove_label'");
      const result = await this.bulkSetKeyword(ids, params.label, false);
      return { affected: result.updated.length };
    }
    throw new Error(`Unknown action: ${params.action}`);
  }

  // -------------------------------------------------------------------------
  // Public: save a new draft to the Drafts mailbox
  // -------------------------------------------------------------------------

  async saveDraft(params: {
    to?: string[];
    cc?: string[];
    subject?: string;
    body?: string;
  }): Promise<string> {
    const accountId = await this.getAccountId();
    const draftsId = await this.ensureMailbox("Drafts");
    const now = new Date().toISOString();

    const toAddresses = (params.to ?? []).map((a) => ({ email: a }));
    const ccAddresses = (params.cc ?? []).map((a) => ({ email: a }));

    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          create: {
            draft1: {
              mailboxIds: { [draftsId]: true },
              keywords: { "$draft": true },
              from: [{ email: this.email }],
              ...(toAddresses.length > 0 ? { to: toAddresses } : {}),
              ...(ccAddresses.length > 0 ? { cc: ccAddresses } : {}),
              subject: params.subject ?? "",
              sentAt: now,
              bodyValues: {
                body: { value: params.body ?? "", isEncodingProblem: false, isTruncated: false },
              },
              textBody: [{ partId: "body", type: "text/plain" }],
            },
          },
        },
        "ds1",
      ],
    ]);

    const resp = responses.find(([, , id]) => id === "ds1");
    const created = (resp?.[1] as { created?: Record<string, { id?: string }> })?.created;
    const newId = created?.["draft1"]?.id;
    if (!newId) {
      const notCreated = (resp?.[1] as { notCreated?: Record<string, unknown> })?.notCreated;
      throw new Error(`Failed to create draft: ${JSON.stringify(notCreated?.["draft1"] ?? "unknown")}`);
    }
    return newId;
  }

  // -------------------------------------------------------------------------
  // Public: update fields on an existing draft (destroy + recreate pattern)
  // The caller is responsible for tracking the returned new ID.
  // -------------------------------------------------------------------------

  async updateDraft(
    emailId: string,
    patch: { to?: string[]; cc?: string[]; subject?: string; body?: string },
  ): Promise<string> {
    const accountId = await this.getAccountId();
    const draftsId = await this.ensureMailbox("Drafts");

    // Read current draft
    const current = await this.getEmail(emailId);
    const now = new Date().toISOString();

    const toAddresses = (patch.to ?? current.to).map((a) => ({ email: a }));
    const ccAddresses = (patch.cc ?? []).map((a) => ({ email: a }));
    const subject = patch.subject ?? current.subject;
    const body = patch.body ?? current.textBody ?? current.htmlBody ?? "";

    // Destroy old + create new in one batch
    const responses = await this.request([
      [
        "Email/set",
        {
          accountId,
          destroy: [emailId],
          create: {
            draft1: {
              mailboxIds: { [draftsId]: true },
              keywords: { "$draft": true },
              from: [{ email: this.email }],
              ...(toAddresses.length > 0 ? { to: toAddresses } : {}),
              ...(ccAddresses.length > 0 ? { cc: ccAddresses } : {}),
              subject,
              sentAt: now,
              bodyValues: {
                body: { value: body, isEncodingProblem: false, isTruncated: false },
              },
              textBody: [{ partId: "body", type: "text/plain" }],
            },
          },
        },
        "du1",
      ],
    ]);

    const resp = responses.find(([, , id]) => id === "du1");
    const created = (resp?.[1] as { created?: Record<string, { id?: string }> })?.created;
    const newId = created?.["draft1"]?.id;
    if (!newId) {
      const notCreated = (resp?.[1] as { notCreated?: Record<string, unknown> })?.notCreated;
      throw new Error(`Failed to update draft: ${JSON.stringify(notCreated?.["draft1"] ?? "unknown")}`);
    }
    return newId;
  }

  async renameMailbox(name: string, newName: string): Promise<void> {
    const mailboxId = await this.getMailboxId(name);
    if (mailboxId === null) throw new Error(`Mailbox not found: "${name}"`);
    const accountId = await this.getAccountId();
    const responses = await this.request([
      ["Mailbox/set", { accountId, update: { [mailboxId]: { name: newName } } }, "mbr1"],
    ]);
    const resp = responses.find(([, , id]) => id === "mbr1");
    const notUpdated = (resp?.[1] as { notUpdated?: Record<string, unknown> })?.notUpdated;
    if (notUpdated?.[mailboxId]) {
      throw new Error(`Failed to rename mailbox "${name}": ${JSON.stringify(notUpdated[mailboxId])}`);
    }
  }

  async createMailbox(name: string, parentName?: string): Promise<string> {
    const accountId = await this.getAccountId();
    let parentId: string | null = null;
    if (parentName) {
      parentId = await this.getMailboxId(parentName);
      if (parentId === null) throw new Error(`Parent folder not found: "${parentName}"`);
    }

    const responses = await this.request([
      [
        "Mailbox/set",
        {
          accountId,
          create: { mbc1: { name, parentId } },
        },
        "mbc1",
      ],
    ]);
    const resp = responses.find(([, , id]) => id === "mbc1");
    const created = (resp?.[1] as { created?: Record<string, { id?: string }> })?.created;
    const newId = created?.["mbc1"]?.id;
    if (!newId) {
      const notCreated = (resp?.[1] as { notCreated?: Record<string, unknown> })?.notCreated;
      throw new Error(`Failed to create folder "${name}": ${JSON.stringify(notCreated?.["mbc1"] ?? "unknown error")}`);
    }
    return newId;
  }
}

/** Reset all module-level caches. For use in tests only. */
export function clearJmapCache(): void {
  cachedSession = undefined;
  cachedSessionAt = 0;
  userContextCache.clear();
  jmapIdCache.clear();
}
