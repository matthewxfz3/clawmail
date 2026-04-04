import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    domain: "test.example.com",
    stalwart: {
      url: "http://stalwart-test:8080",
      adminUser: "admin",
      adminPassword: "test-password",
    },
  },
}));

import { JmapClient, clearJmapCache } from "./jmap.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_API_URL = "http://stalwart-test:8080/jmap";

/** Impersonation session response — what Stalwart returns when impersonation works. */
function impersonateSession(accountId = "acc-abc") {
  return {
    apiUrl: FAKE_API_URL,
    primaryAccounts: {
      "urn:ietf:params:jmap:mail": accountId,
    },
  };
}

function jmapResponse(methodResponses: unknown[]) {
  return { ok: true, status: 200, json: () => Promise.resolve({ methodResponses }), text: () => Promise.resolve("") };
}

function httpResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

// Clear module-level caches between tests by making the first fetch call
// always return a fresh session (impersonation succeeds).
function setupFreshSession(accountId = "acc-abc", extraCalls: Array<() => unknown> = []) {
  let callCount = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(httpResponse(200, impersonateSession(accountId)));
    }
    const next = extraCalls.shift();
    if (next) return next();
    return Promise.resolve(httpResponse(200, { methodResponses: [] }));
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// listEmails
// ---------------------------------------------------------------------------

describe("JmapClient.listEmails", () => {
  beforeEach(() => clearJmapCache());
  afterEach(() => vi.restoreAllMocks());

  it("returns email summaries from JMAP response", async () => {
    const emailList = [
      {
        id: "em1",
        subject: "Hello",
        from: [{ name: "Sender", email: "sender@example.com" }],
        to: [{ email: "alice@test.example.com" }],
        receivedAt: "2026-01-01T00:00:00Z",
        hasAttachment: false,
        preview: "Hi there",
        mailboxIds: { "mb-inbox": true },
      },
    ];

    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      // Mailbox/query → ids
      if (call === 2) return Promise.resolve(jmapResponse([["Mailbox/query", { ids: ["mb-inbox"] }, "mb1"]]));
      // Email/query → ids + Email/get → list
      if (call === 3) return Promise.resolve(jmapResponse([
        ["Email/query", { ids: ["em1"] }, "c1"],
        ["Email/get", { list: emailList }, "c2"],
      ]));
      return Promise.resolve(jmapResponse([]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    const emails = await client.listEmails();

    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe("em1");
    expect(emails[0].subject).toBe("Hello");
    expect(emails[0].from).toBe("Sender <sender@example.com>");
    expect(emails[0].hasAttachment).toBe(false);
  });

  it("returns empty array when JMAP returns no response", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      return Promise.resolve(jmapResponse([]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    const emails = await client.listEmails();
    expect(emails).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getEmail
// ---------------------------------------------------------------------------

describe("JmapClient.getEmail", () => {
  beforeEach(() => clearJmapCache());
  afterEach(() => vi.restoreAllMocks());

  it("returns email detail including textBody", async () => {
    const raw = {
      id: "em1",
      subject: "Test Subject",
      from: [{ email: "a@b.com" }],
      to: [{ email: "c@d.com" }],
      receivedAt: "2026-01-01T00:00:00Z",
      hasAttachment: false,
      preview: "",
      mailboxIds: {},
      textBody: [{ value: "Hello world" }],
      htmlBody: [],
    };

    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      return Promise.resolve(jmapResponse([["Email/get", { list: [raw] }, "c1"]]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    const email = await client.getEmail("em1");
    expect(email.subject).toBe("Test Subject");
    expect(email.textBody).toBe("Hello world");
    expect(email.htmlBody).toBeUndefined();
  });

  it("throws when email not found", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      return Promise.resolve(jmapResponse([["Email/get", { list: [] }, "c1"]]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    await expect(client.getEmail("missing")).rejects.toThrow("Email not found");
  });
});

// ---------------------------------------------------------------------------
// deleteEmail
// ---------------------------------------------------------------------------

describe("JmapClient.deleteEmail", () => {
  beforeEach(() => clearJmapCache());
  afterEach(() => vi.restoreAllMocks());

  it("moves email to Trash successfully", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      // getMailboxIdByRole("trash") → Mailbox/get
      if (call === 2)
        return Promise.resolve(
          jmapResponse([
            [
              "Mailbox/get",
              { list: [{ id: "trash-id", name: "Trash", role: "trash", totalEmails: 0, unreadEmails: 0 }] },
              "mbs",
            ],
          ]),
        );
      // Email/set → success
      if (call === 3) return Promise.resolve(jmapResponse([["Email/set", { updated: { em1: {} }, notUpdated: {} }, "c1"]]));
      return Promise.resolve(jmapResponse([]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    await expect(client.deleteEmail("em1")).resolves.toBeUndefined();
  });

  it("throws when Trash mailbox not found", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      // getMailboxIdByRole("trash") → Mailbox/get returns empty list
      if (call === 2) return Promise.resolve(jmapResponse([["Mailbox/get", { list: [] }, "mbs"]]));
      // fallback getMailboxId("Trash") → Mailbox/query returns no ids
      return Promise.resolve(jmapResponse([["Mailbox/query", { ids: [] }, "mb1"]]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    await expect(client.deleteEmail("em1")).rejects.toThrow("Trash");
  });

  it("throws when Email/set returns notUpdated", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      // getMailboxIdByRole("trash") → Mailbox/get
      if (call === 2)
        return Promise.resolve(
          jmapResponse([
            [
              "Mailbox/get",
              { list: [{ id: "trash-id", name: "Trash", role: "trash", totalEmails: 0, unreadEmails: 0 }] },
              "mbs",
            ],
          ]),
        );
      return Promise.resolve(jmapResponse([["Email/set", { notUpdated: { em1: { type: "notFound" } } }, "c1"]]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    await expect(client.deleteEmail("em1")).rejects.toThrow("Failed to move email");
  });
});

// ---------------------------------------------------------------------------
// searchEmails
// ---------------------------------------------------------------------------

describe("JmapClient.searchEmails", () => {
  beforeEach(() => clearJmapCache());
  afterEach(() => vi.restoreAllMocks());

  it("returns matching emails", async () => {
    const emailList = [
      {
        id: "em2",
        subject: "Meeting notes",
        from: [{ email: "boss@example.com" }],
        to: [{ email: "alice@test.example.com" }],
        receivedAt: "2026-01-02T00:00:00Z",
        hasAttachment: false,
        preview: "See attached",
        mailboxIds: {},
      },
    ];

    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      return Promise.resolve(jmapResponse([
        ["Email/query", { ids: ["em2"] }, "c1"],
        ["Email/get", { list: emailList }, "c2"],
      ]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    const results = await client.searchEmails("meeting");
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe("Meeting notes");
  });
});

// ---------------------------------------------------------------------------
// countEmails
// ---------------------------------------------------------------------------

describe("JmapClient.countEmails", () => {
  beforeEach(() => clearJmapCache());
  afterEach(() => vi.restoreAllMocks());

  it("returns total from Email/query calculateTotal response", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      // getMailboxId("Inbox")
      if (call === 2) return Promise.resolve(jmapResponse([["Mailbox/query", { ids: ["inbox-id"] }, "mb1"]]));
      // Email/query with calculateTotal
      if (call === 3) return Promise.resolve(jmapResponse([["Email/query", { ids: [], total: 42 }, "cnt1"]]));
      return Promise.resolve(jmapResponse([]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    const count = await client.countEmails("Inbox");
    expect(count).toBe(42);
  });

  it("returns 0 when no response", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      return Promise.resolve(jmapResponse([]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    expect(await client.countEmails()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listMailboxes
// ---------------------------------------------------------------------------

describe("JmapClient.listMailboxes", () => {
  beforeEach(() => clearJmapCache());
  afterEach(() => vi.restoreAllMocks());

  it("returns mailbox list with counts", async () => {
    const mailboxList = [
      { id: "inbox-id", name: "Inbox", role: "inbox", totalEmails: 5, unreadEmails: 2 },
      { id: "trash-id", name: "Trash", role: "trash", totalEmails: 1, unreadEmails: 0 },
    ];

    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(httpResponse(200, impersonateSession()));
      return Promise.resolve(jmapResponse([["Mailbox/get", { list: mailboxList }, "mbs"]]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    const mailboxes = await client.listMailboxes();
    expect(mailboxes).toHaveLength(2);
    expect(mailboxes[0]).toMatchObject({ name: "Inbox", totalEmails: 5, unreadEmails: 2 });
  });
});

// ---------------------------------------------------------------------------
// Session fallback: impersonation fails → admin + Principal/get
// ---------------------------------------------------------------------------

describe("JmapClient session strategy fallback", () => {
  beforeEach(() => clearJmapCache());
  afterEach(() => vi.restoreAllMocks());

  it("falls back to admin+Principal/get when impersonation returns no accountId", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      // Strategy 1: impersonation — returns session but no mail accountId
      if (call === 1) return Promise.resolve(httpResponse(200, { apiUrl: FAKE_API_URL, primaryAccounts: {} }));
      // Strategy 2: admin session
      if (call === 2) return Promise.resolve(httpResponse(200, {
        apiUrl: FAKE_API_URL,
        primaryAccounts: {
          "urn:ietf:params:jmap:principals": "admin-id",
          "urn:ietf:params:jmap:mail": "admin-id",
        },
      }));
      // Principal/get
      if (call === 3) return Promise.resolve(jmapResponse([["Principal/get", {
        list: [{ id: "user-acc-id", email: "alice@test.example.com" }],
      }, "pget"]]));
      // Mailbox/get
      return Promise.resolve(jmapResponse([["Mailbox/get", { list: [] }, "mbs"]]));
    }) as typeof fetch;

    const client = new JmapClient("alice@test.example.com");
    const mailboxes = await client.listMailboxes();
    expect(Array.isArray(mailboxes)).toBe(true);
    // Verify Principal/get was called (call 3)
    expect(call).toBeGreaterThanOrEqual(3);
  });
});
