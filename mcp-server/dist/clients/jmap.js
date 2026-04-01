import { config } from "../config.js";
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function basicAuthHeader() {
    const credentials = `${config.stalwart.adminUser}:${config.stalwart.adminPassword}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
}
/** Module-level session cache keyed by accountId (email). */
const sessionCache = new Map();
/** Extract a plain-text address from a JMAP EmailAddress object or string. */
function addressToString(addr) {
    if (typeof addr === "string")
        return addr;
    if (addr !== null && typeof addr === "object") {
        const a = addr;
        const email = typeof a["email"] === "string" ? a["email"] : "";
        const name = typeof a["name"] === "string" ? a["name"] : "";
        return name ? `${name} <${email}>` : email;
    }
    return "";
}
function addressListToStrings(list) {
    if (!Array.isArray(list))
        return [];
    return list.map(addressToString);
}
/** Safely coerce a JMAP body-part list to its first text value. */
function firstBodyText(parts) {
    if (!Array.isArray(parts) || parts.length === 0)
        return undefined;
    const part = parts[0];
    return typeof part["value"] === "string" ? part["value"] : undefined;
}
/** Collect header:*:asText properties from a raw email object. */
function collectHeaders(raw) {
    const headers = {};
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
function rawToSummary(raw) {
    const fromArr = raw["from"];
    const fromStr = Array.isArray(fromArr) && fromArr.length > 0
        ? addressToString(fromArr[0])
        : addressToString(fromArr);
    const mailboxIds = raw["mailboxIds"] !== null &&
        typeof raw["mailboxIds"] === "object"
        ? Object.keys(raw["mailboxIds"])
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
function rawToDetail(raw) {
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
    accountId;
    constructor(accountId) {
        this.accountId = accountId;
    }
    // -------------------------------------------------------------------------
    // Private: session discovery
    // -------------------------------------------------------------------------
    async getSession() {
        const cached = sessionCache.get(this.accountId);
        if (cached !== undefined)
            return cached;
        const wellKnownUrl = new URL("/.well-known/jmap", config.stalwart.url).toString();
        const res = await fetch(wellKnownUrl, {
            method: "GET",
            headers: {
                Authorization: basicAuthHeader(),
                Accept: "application/json",
            },
        });
        if (!res.ok) {
            let body;
            try {
                body = await res.text();
            }
            catch {
                body = "<unreadable body>";
            }
            throw new Error(`JMAP session discovery failed: HTTP ${res.status} — ${body}`);
        }
        const data = (await res.json());
        if (!data.apiUrl) {
            throw new Error("JMAP session response missing apiUrl");
        }
        const session = {
            apiUrl: data.apiUrl,
            primaryAccounts: data.primaryAccounts ?? {},
        };
        sessionCache.set(this.accountId, session);
        return session;
    }
    // -------------------------------------------------------------------------
    // Private: core request
    // -------------------------------------------------------------------------
    async request(calls) {
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
            let errBody;
            try {
                errBody = await res.text();
            }
            catch {
                errBody = "<unreadable body>";
            }
            throw new Error(`JMAP request failed: HTTP ${res.status} — ${errBody}`);
        }
        const data = (await res.json());
        return data.methodResponses ?? [];
    }
    // -------------------------------------------------------------------------
    // Private: mailbox lookup
    // -------------------------------------------------------------------------
    async getMailboxId(name) {
        const responses = await this.request([
            [
                "Mailbox/query",
                {
                    accountId: this.accountId,
                    filter: { name },
                },
                "mb1",
            ],
        ]);
        const response = responses.find(([, , id]) => id === "mb1");
        if (!response)
            return null;
        const ids = response[1].ids ?? [];
        return ids.length > 0 ? ids[0] : null;
    }
    // -------------------------------------------------------------------------
    // Public: list emails
    // -------------------------------------------------------------------------
    async listEmails(folder = "Inbox", limit = 50) {
        const mailboxId = await this.getMailboxId(folder);
        const queryFilter = {};
        if (mailboxId !== null) {
            queryFilter["inMailbox"] = mailboxId;
        }
        const responses = await this.request([
            [
                "Email/query",
                {
                    accountId: this.accountId,
                    filter: queryFilter,
                    sort: [{ property: "receivedAt", isAscending: false }],
                    limit,
                },
                "c1",
            ],
            [
                "Email/get",
                {
                    accountId: this.accountId,
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
        if (!getResponse)
            return [];
        const list = getResponse[1].list ?? [];
        return list.map(rawToSummary);
    }
    // -------------------------------------------------------------------------
    // Public: get full email
    // -------------------------------------------------------------------------
    async getEmail(emailId) {
        const responses = await this.request([
            [
                "Email/get",
                {
                    accountId: this.accountId,
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
        const list = response[1].list ?? [];
        if (list.length === 0) {
            throw new Error(`Email not found: ${emailId}`);
        }
        return rawToDetail(list[0]);
    }
    // -------------------------------------------------------------------------
    // Public: delete email (move to Trash)
    // -------------------------------------------------------------------------
    async deleteEmail(emailId) {
        const trashId = await this.getMailboxId("Trash");
        if (trashId === null) {
            throw new Error('Could not locate "Trash" mailbox for account: ' + this.accountId);
        }
        const responses = await this.request([
            [
                "Email/set",
                {
                    accountId: this.accountId,
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
        const notUpdated = response[1].notUpdated;
        if (notUpdated && Object.keys(notUpdated).length > 0) {
            const details = JSON.stringify(notUpdated[emailId] ?? notUpdated);
            throw new Error(`Failed to move email ${emailId} to Trash: ${details}`);
        }
    }
    // -------------------------------------------------------------------------
    // Public: search emails
    // -------------------------------------------------------------------------
    async searchEmails(query) {
        const responses = await this.request([
            [
                "Email/query",
                {
                    accountId: this.accountId,
                    filter: { text: query },
                    sort: [{ property: "receivedAt", isAscending: false }],
                    limit: 50,
                },
                "c1",
            ],
            [
                "Email/get",
                {
                    accountId: this.accountId,
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
        if (!getResponse)
            return [];
        const list = getResponse[1].list ?? [];
        return list.map(rawToSummary);
    }
}
//# sourceMappingURL=jmap.js.map