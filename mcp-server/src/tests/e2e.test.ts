/**
 * E2E tests for the Clawmail MCP server.
 *
 * Strategy:
 *  - All external I/O (JMAP, Stalwart management API, nodemailer, Daily, Meet, metrics) is mocked
 *    via vi.mock() so tests run in isolation without a live mail server.
 *  - A real HTTP server is started on a random port (0) so the full request/response
 *    pipeline — auth, rate-limiting, validation, MCP protocol — is exercised end-to-end.
 *  - The MCP SDK's StreamableHTTPServerTransport emits Server-Sent Events (SSE); the
 *    `callTool()` helper parses the SSE stream and extracts the JSON-RPC result.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that transitively uses them.
// vi.mock() calls are hoisted by Vitest so they run before imports.
// Variables whose names start with "mock" are also hoisted (Vitest rule).
// ---------------------------------------------------------------------------

// --- config -----------------------------------------------------------------
vi.mock("../config.js", () => {
  type Identity = { apiKey: string; role: string; account?: string };
  const apiKeyMap = new Map<string, Identity>();
  apiKeyMap.set("test-key-1", { apiKey: "test-key-1", role: "admin" });
  apiKeyMap.set("user-key-1", { apiKey: "user-key-1", role: "user", account: "alice@test.example.com" });
  return {
  config: {
    domain: "test.example.com",
    stalwart: {
      url: "http://stalwart-test:8080",
      adminUser: "admin",
      adminPassword: "test-password",
    },
    sendgrid: {
      apiKey: "SG.fake",
      verifiedSender: "no-reply@test.example.com",
    },
    auth: {
      apiKeys: new Set(["test-key-1"]),
      apiKeyMap,
    },
    daily: { apiKey: "" },
    googleMeet: { clientId: "", clientSecret: "", refreshToken: "" },
    dashboard: { user: "admin", password: "pass" },
    limits: {
      maxAttachmentBytes: 26214400,
      sendEmailPerMinute: 20,
      createAccountPerHour: 10,
      readOpsPerMinute: 200,
    },
    port: 0, // random port — OS assigns one
    redis: { url: "" },
  },
};
});

// --- metrics (no-ops) -------------------------------------------------------
vi.mock("../metrics.js", () => ({
  recordCall: vi.fn(),
  recordError: vi.fn(),
  recordRateLimit: vi.fn(),
  recordAccountCreated: vi.fn(),
  recordAccountSend: vi.fn(),
  recordCallEntry: vi.fn(),
  recordBatchSend: vi.fn(),
  getMetrics: vi.fn(() => ({
    startedAt: 0, tools: {}, totalRequests: 0, totalErrors: 0,
    totalRateLimitHits: 0, inboxTotal: 0,
  })),
}));

// --- Daily.co / Google Meet (not configured) --------------------------------
vi.mock("../clients/daily.js", () => ({
  isDailyConfigured: vi.fn(() => false),
  createDailyRoom: vi.fn(),
}));

vi.mock("../clients/google-meet.js", () => ({
  isMeetConfigured: vi.fn(() => false),
  createMeetSpace: vi.fn(),
}));

// --- nodemailer -------------------------------------------------------------
const mockSendMail = vi.fn().mockResolvedValue({ messageId: "<test-msg-id@test>" });
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}));

// --- Stalwart management API ------------------------------------------------
// All methods are vi.fn() so individual tests can configure return values.
const mockStalwart = {
  createAccount:      vi.fn(),
  deleteAccount:      vi.fn(),
  listAccounts:       vi.fn(),
  patchAccount:       vi.fn(),
  ensureDomainExists: vi.fn(),
  accountExists:      vi.fn(),
};

vi.mock("../clients/stalwart-mgmt.js", () => ({
  createAccount:      (...a: unknown[]) => mockStalwart.createAccount(...a),
  deleteAccount:      (...a: unknown[]) => mockStalwart.deleteAccount(...a),
  listAccounts:       (...a: unknown[]) => mockStalwart.listAccounts(...a),
  patchAccount:       (...a: unknown[]) => mockStalwart.patchAccount(...a),
  ensureDomainExists: (...a: unknown[]) => mockStalwart.ensureDomainExists(...a),
  accountExists:      (...a: unknown[]) => mockStalwart.accountExists(...a),
}));

// --- JmapClient -------------------------------------------------------------
// NOTE: vi.fn(function() { ... }) uses a regular function — required so that
// `new JmapClient(...)` succeeds (arrow functions cannot be constructors).
const mockJmap = {
  listEmails:        vi.fn(),
  getEmail:          vi.fn(),
  searchEmails:      vi.fn(),
  deleteEmail:       vi.fn(),   // moves to Trash
  destroyEmail:      vi.fn(),   // permanent delete
  moveEmail:         vi.fn(),
  bulkMoveEmails:    vi.fn(),
  bulkDestroyEmails: vi.fn(),
  setKeyword:        vi.fn(),
  bulkSetKeyword:    vi.fn(),
  listSystemEmails:  vi.fn(),
  createSystemEmail: vi.fn(),
  createMailbox:     vi.fn(),
  deleteMailbox:     vi.fn(),
  renameMailbox:     vi.fn(),
  getThread:         vi.fn(),
  updateThread:      vi.fn(),
  saveDraft:         vi.fn(),
  updateDraft:       vi.fn(),
  addLabel:          vi.fn(),
  removeLabel:       vi.fn(),
  listMailboxes:     vi.fn(),
  // saveToSent is called fire-and-forget after every send — must return a Promise
  saveToSent:          vi.fn(),
  // search_emails calls resolveMailboxId to find the Junk folder ID
  resolveMailboxId:    vi.fn(),
  // mark_as_read calls markEmailRead; mark_as_unread / flag use setEmailKeyword
  markEmailRead:       vi.fn(),
  setEmailKeyword:     vi.fn(),
};

vi.mock("../clients/jmap.js", () => ({
  // Use a regular function (not arrow) so `new JmapClient(...)` works.
  JmapClient: vi.fn(function MockJmapClient() { return mockJmap; }),
  clearJmapCache: vi.fn(),
}));

// --- dashboard (no-op passthrough) ------------------------------------------
vi.mock("../dashboard.js", () => ({
  handleDashboard: vi.fn((_req: unknown, res: { writeHead: (n: number) => void; end: (s: string) => void }) => {
    res.writeHead(200);
    res.end("ok");
  }),
}));

// ---------------------------------------------------------------------------
// Server bootstrap — import AFTER all vi.mock() declarations.
// index.ts calls httpServer.listen() on module load; with port=0 the OS picks
// a random available port that we read back from the socket address.
// ---------------------------------------------------------------------------

let httpServer: Server;
let port: number;

beforeAll(async () => {
  const mod = await import("../index.js");
  httpServer = mod.httpServer;

  await new Promise<void>((resolve) => {
    if (httpServer.listening) {
      resolve();
    } else {
      httpServer.once("listening", resolve);
    }
  });

  port = (httpServer.address() as AddressInfo).port;
});

afterAll(() => {
  httpServer.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Re-attach default resolutions (vi.clearAllMocks clears implementations in Vitest v4).
  mockSendMail.mockResolvedValue({ messageId: "<test-msg-id@test>" });
  mockStalwart.accountExists.mockResolvedValue(false);
  // saveToSent is fire-and-forget after every send — must return a resolved Promise.
  mockJmap.saveToSent.mockResolvedValue(undefined);
  // resolveMailboxId returns null (no Junk folder) by default — overrides per test as needed.
  mockJmap.resolveMailboxId.mockResolvedValue(null);
  // markEmailRead and setEmailKeyword are no-ops by default.
  mockJmap.markEmailRead.mockResolvedValue(undefined);
  mockJmap.setEmailKeyword.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const TEST_KEY = "test-key-1";

async function mcpPost(body: unknown, apiKey?: string): Promise<{ status: number; rpc: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept":       "application/json, text/event-stream",
  };
  if (apiKey !== undefined) headers["X-API-Key"] = apiKey;

  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();

  // StreamableHTTPServerTransport sends SSE when Accept includes text/event-stream.
  // Parse the last complete "data:" line, which carries the JSON-RPC response.
  let rpc: unknown = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { rpc = JSON.parse(line.slice(6)); } catch { /* ignore partial lines */ }
    }
  }

  // Fallback: plain JSON body
  if (rpc === null) {
    try { rpc = JSON.parse(text); } catch { /* leave null */ }
  }

  return { status: res.status, rpc };
}

type ToolResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } };

/** Call an MCP tool and return the parsed { ok, data|error } payload. */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  apiKey = TEST_KEY,
): Promise<ToolResult> {
  const { rpc } = await mcpPost(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    apiKey,
  );

  const text = (rpc as { result?: { content?: Array<{ text?: string }> } })
    ?.result?.content?.[0]?.text;

  if (!text) throw new Error(`Unexpected RPC response: ${JSON.stringify(rpc)}`);
  return JSON.parse(text) as ToolResult;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("Authentication", () => {
  it("rejects requests without X-API-Key (401)", async () => {
    const { status } = await mcpPost(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    expect(status).toBe(401);
  });

  it("rejects requests with a wrong key (401)", async () => {
    const { status } = await mcpPost(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      "wrong-key",
    );
    expect(status).toBe(401);
  });

  it("accepts requests with the correct key (200)", async () => {
    const { status } = await mcpPost(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      TEST_KEY,
    );
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// tools/list — surface area check
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("returns all 26 registered tools", async () => {
    const { rpc } = await mcpPost(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      TEST_KEY,
    );

    const tools = (rpc as { result?: { tools?: Array<{ name: string }> } })?.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "cancel_event_invite",
      "classify_email",
      "configure_account",
      "create_account",
      "delete_account",
      "forward_email",
      "list_accounts",
      "list_emails",
      "manage_contact",
      "manage_draft",
      "manage_event",
      "manage_folder",
      "manage_rule",
      "manage_sender_list",
      "manage_template",
      "manage_token",
      "manage_webhook",
      "read_email",
      "reply_to_email",
      "respond_to_invite",
      "search_emails",
      "send_batch",
      "send_email",
      "send_event_invite",
      "update_email",
      "update_thread",
    ].sort());
  });
});

// ---------------------------------------------------------------------------
// Account tools
// ---------------------------------------------------------------------------

describe("create_account", () => {
  it("creates an account and returns the email address", async () => {
    mockStalwart.accountExists.mockResolvedValue(false); // account doesn't exist yet
    mockStalwart.createAccount.mockResolvedValue(undefined);

    const result = await callTool("create_account", { local_part: "alice" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { email: string }).email).toBe("alice@test.example.com");
  });

  it("surfaces Stalwart errors as tool errors", async () => {
    mockStalwart.accountExists.mockResolvedValue(false);
    mockStalwart.createAccount.mockRejectedValue(new Error("Stalwart error"));

    const result = await callTool("create_account", { local_part: "alice" });
    expect(result.ok).toBe(false);
  });

  it("rejects if account already exists", async () => {
    mockStalwart.accountExists.mockResolvedValue(true); // already exists

    const result = await callTool("create_account", { local_part: "alice" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/already exists/i);
  });
});

describe("list_accounts", () => {
  it("returns the accounts list", async () => {
    mockStalwart.listAccounts.mockResolvedValue([
      { email: "alice@test.example.com", name: "Alice" },
    ]);

    const result = await callTool("list_accounts");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { count: number }).count).toBe(1);
  });
});

describe("delete_account", () => {
  it("deletes an account", async () => {
    mockStalwart.accountExists.mockResolvedValue(true); // account must exist to delete
    mockStalwart.deleteAccount.mockResolvedValue(undefined);

    const result = await callTool("delete_account", { local_part: "alice" });
    expect(result.ok).toBe(true);
  });

  it("returns error when account does not exist", async () => {
    mockStalwart.accountExists.mockResolvedValue(false);

    const result = await callTool("delete_account", { local_part: "nobody" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/does not exist/i);
  });
});

// ---------------------------------------------------------------------------
// Mailbox read tools
// ---------------------------------------------------------------------------

describe("list_emails", () => {
  it("returns emails from inbox", async () => {
    mockJmap.listEmails.mockResolvedValue([
      { id: "e1", subject: "Hello", from: "bob@example.com", receivedAt: "2026-04-01T10:00:00Z" },
    ]);

    const result = await callTool("list_emails", { account: "alice@test.example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { emails: unknown[]; count: number; folder: string };
    expect(data.emails).toHaveLength(1);
    expect(data.folder).toBe("Inbox");
  });
});

describe("read_email", () => {
  it("returns full email content", async () => {
    mockJmap.getEmail.mockResolvedValue({
      id: "e1",
      subject: "Hello",
      from: "bob@example.com",
      body: "Hi there",
      receivedAt: "2026-04-01T10:00:00Z",
    });

    const result = await callTool("read_email", { account: "alice@test.example.com", email_id: "e1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { subject: string }).subject).toBe("Hello");
  });
});

describe("search_emails", () => {
  it("returns matching emails", async () => {
    mockJmap.searchEmails.mockResolvedValue([
      { id: "e2", subject: "Project update", from: "mgr@example.com" },
    ]);

    const result = await callTool("search_emails", { account: "alice@test.example.com", query: "project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { emails: unknown[] }).emails).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// send_email
// ---------------------------------------------------------------------------

describe("send_email", () => {
  it("sends an email and returns a message ID", async () => {
    const result = await callTool("send_email", {
      from_account: "alice",
      to: "bob@example.com",
      subject: "Test",
      body: "Hello Bob",
    });

    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it("rejects an invalid recipient address", async () => {
    const result = await callTool("send_email", {
      from_account: "alice",
      to: "not-an-email",
      subject: "Test",
      body: "body",
    });

    expect(result.ok).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("deduplicates sends with idempotency_key", async () => {
    const payload = {
      from_account: "alice",
      to: "bob@example.com",
      subject: "Dup",
      body: "body",
      idempotency_key: "idem-e2e-001",
    };

    await callTool("send_email", payload);
    await callTool("send_email", payload);

    // sendMail must only be called once despite two identical calls.
    expect(mockSendMail).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// reply_to_email / forward_email
// ---------------------------------------------------------------------------

describe("reply_to_email", () => {
  it("replies with correct threading headers", async () => {
    mockJmap.getEmail.mockResolvedValue({
      id: "e1",
      subject: "Hello",
      from: "bob@example.com",
      to: [],
      headers: { "Message-ID": "<orig@example.com>" },
      textBody: "Original body",
      receivedAt: "2026-04-01T10:00:00Z",
    });

    const result = await callTool("reply_to_email", {
      from_account: "alice@test.example.com",
      email_id: "e1",
      body: "My reply",
    });

    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
    // Threading header is set in sendMail's `headers` object, not top-level
    const sent = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    const hdrs = sent.headers as Record<string, string> | undefined;
    expect(hdrs?.["In-Reply-To"]).toBe("<orig@example.com>");
  });
});

describe("forward_email", () => {
  it("forwards with Fwd: subject prefix", async () => {
    mockJmap.getEmail.mockResolvedValue({
      id: "e1",
      subject: "Update",
      from: "boss@example.com",
      to: [],
      headers: {},
      textBody: "Here is the update",
      receivedAt: "2026-04-01T10:00:00Z",
    });

    const result = await callTool("forward_email", {
      from_account: "alice@test.example.com",
      email_id: "e1",
      to: "carol@example.com",
    });

    expect(result.ok).toBe(true);
    const sent = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(String(sent.subject)).toMatch(/^Fwd:/);
  });
});

// ---------------------------------------------------------------------------
// update_email
// ---------------------------------------------------------------------------

describe("update_email", () => {
  it("marks a single email as read", async () => {
    mockJmap.setKeyword.mockResolvedValue({ updated: 1 });
    const result = await callTool("update_email", {
      account: "alice@test.example.com",
      email_ids: "e1",
      action: "mark_read",
    });
    expect(result.ok).toBe(true);
  });

  it("moves a bulk list of emails", async () => {
    mockJmap.bulkMoveEmails.mockResolvedValue({ moved: ["e1", "e2"], failed: [] });
    const result = await callTool("update_email", {
      account: "alice@test.example.com",
      email_ids: ["e1", "e2"],
      action: "move",
      folder: "Archive",
    });
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR when folder is missing for move", async () => {
    const result = await callTool("update_email", {
      account: "alice@test.example.com",
      email_ids: "e1",
      action: "move",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when label is missing for add_label", async () => {
    const result = await callTool("update_email", {
      account: "alice@test.example.com",
      email_ids: "e1",
      action: "add_label",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// classify_email
// ---------------------------------------------------------------------------

describe("classify_email", () => {
  it("moves email to Junk (spam)", async () => {
    mockJmap.moveEmail.mockResolvedValue({ moved: true });
    const result = await callTool("classify_email", {
      account: "alice@test.example.com",
      email_id: "e1",
      as: "spam",
    });
    expect(result.ok).toBe(true);
  });

  it("moves email to Inbox (not_spam)", async () => {
    mockJmap.moveEmail.mockResolvedValue({ moved: true });
    const result = await callTool("classify_email", {
      account: "alice@test.example.com",
      email_id: "e1",
      as: "not_spam",
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// manage_folder
// ---------------------------------------------------------------------------

describe("manage_folder", () => {
  it("creates a folder", async () => {
    mockJmap.createMailbox.mockResolvedValue("mbox-1");
    const result = await callTool("manage_folder", {
      account: "alice@test.example.com",
      action: "create",
      folder: "Projects",
    });
    expect(result.ok).toBe(true);
  });

  it("deletes a folder", async () => {
    mockJmap.deleteMailbox.mockResolvedValue(undefined);
    const result = await callTool("manage_folder", {
      account: "alice@test.example.com",
      action: "delete",
      folder: "Projects",
    });
    expect(result.ok).toBe(true);
  });

  it("renames a folder", async () => {
    mockJmap.renameMailbox.mockResolvedValue(undefined);
    const result = await callTool("manage_folder", {
      account: "alice@test.example.com",
      action: "rename",
      folder: "Projects",
      new_name: "Clients",
    });
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR when new_name is missing for rename", async () => {
    const result = await callTool("manage_folder", {
      account: "alice@test.example.com",
      action: "rename",
      folder: "Projects",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// manage_rule
// ---------------------------------------------------------------------------

describe("manage_rule", () => {
  it("creates a rule", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "sys-1" });

    const result = await callTool("manage_rule", {
      account: "alice@test.example.com",
      action: "create",
      name: "Archive newsletters",
      condition: { from: "@newsletter.com" },
      rule_action: { moveTo: "Archive" },
    });
    expect(result.ok).toBe(true);
  });

  it("deletes a rule by ID", async () => {
    const ruleId = "rule-abc";
    mockJmap.listSystemEmails.mockResolvedValue([{
      id: "sys-1",
      subject: `RULE:${ruleId}:Archive newsletters`,
      body: JSON.stringify({
        ruleId,
        name: "Archive newsletters",
        condition: {},
        action: { moveTo: "Archive" },
        createdAt: "2026-01-01T00:00:00Z",
      }),
    }]);
    mockJmap.destroyEmail.mockResolvedValue(undefined);

    const result = await callTool("manage_rule", {
      account: "alice@test.example.com",
      action: "delete",
      rule_id: ruleId,
    });
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR when name is missing for create", async () => {
    const result = await callTool("manage_rule", {
      account: "alice@test.example.com",
      action: "create",
      condition: { from: "@spam.com" },
      rule_action: { delete: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when rule_id is missing for delete", async () => {
    const result = await callTool("manage_rule", {
      account: "alice@test.example.com",
      action: "delete",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// manage_sender_list
// ---------------------------------------------------------------------------

describe("manage_sender_list", () => {
  it("adds to whitelist", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "sys-2" });

    const result = await callTool("manage_sender_list", {
      account: "alice@test.example.com",
      list: "whitelist",
      action: "add",
      address: "trusted@example.com",
    });
    expect(result.ok).toBe(true);
  });

  it("adds to blacklist", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "sys-3" });

    const result = await callTool("manage_sender_list", {
      account: "alice@test.example.com",
      list: "blacklist",
      action: "add",
      address: "spam@badactor.com",
    });
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR when address is missing for add", async () => {
    const result = await callTool("manage_sender_list", {
      account: "alice@test.example.com",
      list: "whitelist",
      action: "add",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when entry_id is missing for remove", async () => {
    const result = await callTool("manage_sender_list", {
      account: "alice@test.example.com",
      list: "blacklist",
      action: "remove",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// manage_event
// ---------------------------------------------------------------------------

describe("manage_event", () => {
  it("creates an event", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "evt-sys-1" });

    const result = await callTool("manage_event", {
      account: "alice@test.example.com",
      action: "create",
      title: "Team standup",
      start: "2026-04-10T09:00:00Z",
      end: "2026-04-10T09:30:00Z",
    });
    expect(result.ok).toBe(true);
  });

  it("deletes an event", async () => {
    const eventId = "ev-abc";
    mockJmap.listSystemEmails.mockResolvedValue([{
      id: "evt-sys-1",
      subject: `CAL:${eventId}:Team standup`,  // calendar.ts uses "CAL:" prefix
      body: JSON.stringify({
        eventId,
        title: "Team standup",
        start: "2026-04-10T09:00:00Z",
        end: "2026-04-10T09:30:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    }]);
    mockJmap.destroyEmail.mockResolvedValue(undefined);

    const result = await callTool("manage_event", {
      account: "alice@test.example.com",
      action: "delete",
      event_id: eventId,
    });
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR when title is missing for create", async () => {
    const result = await callTool("manage_event", {
      account: "alice@test.example.com",
      action: "create",
      start: "2026-04-10T09:00:00Z",
      end: "2026-04-10T09:30:00Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when event_id is missing for delete", async () => {
    const result = await callTool("manage_event", {
      account: "alice@test.example.com",
      action: "delete",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// send_event_invite / cancel_event_invite / respond_to_invite
// ---------------------------------------------------------------------------

describe("send_event_invite", () => {
  it("sends an iCalendar METHOD:REQUEST invite", async () => {
    const result = await callTool("send_event_invite", {
      from_account: "alice",
      to: "bob@example.com",
      title: "Sync",
      start: "2026-04-10T15:00:00Z",
      end: "2026-04-10T15:30:00Z",
    });
    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();

    // Verify the iCalendar attachment is present.
    const sent = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    const sentStr = JSON.stringify(sent);
    expect(sentStr).toMatch(/VCALENDAR|text\/calendar|icalEvent/i);
  });
});

describe("cancel_event_invite", () => {
  it("sends a METHOD:CANCEL iCalendar email", async () => {
    const result = await callTool("cancel_event_invite", {
      from_account: "alice",
      to: "bob@example.com",
      uid: "event-uid-123",
      title: "Sync",
      start: "2026-04-10T15:00:00Z",
      end: "2026-04-10T15:30:00Z",
    });
    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });
});

describe("respond_to_invite", () => {
  it("sends a METHOD:REPLY accept response", async () => {
    mockJmap.getEmail.mockResolvedValue({
      id: "invite-1",
      headers: { "Message-ID": "<invite@example.com>" },
      subject: "Sync",
      from: "bob@example.com",
      to: [],
    });

    const result = await callTool("respond_to_invite", {
      from_account: "alice@test.example.com",
      email_id: "invite-1",
      response: "accept",
      uid: "event-uid-123",
      organizer: "bob@example.com",
      title: "Sync",
      start: "2026-04-10T15:00:00Z",
      end: "2026-04-10T15:30:00Z",
    });
    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// configure_account
// ---------------------------------------------------------------------------

describe("configure_account", () => {
  beforeEach(() => {
    // configure_account calls accountExists; default to account existing.
    mockStalwart.accountExists.mockResolvedValue(true);
  });

  it("sets display_name via Stalwart PATCH", async () => {
    mockStalwart.patchAccount.mockResolvedValue(undefined);

    const result = await callTool("configure_account", {
      account: "alice@test.example.com",
      setting: "display_name",
      value: "Alice Smith",
    });
    expect(result.ok).toBe(true);
    expect(mockStalwart.patchAccount).toHaveBeenCalledOnce();
  });

  it("stores signature in JMAP system mailbox", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "sys-sig" });

    const result = await callTool("configure_account", {
      account: "alice@test.example.com",
      setting: "signature",
      value: "Best,\nAlice",
    });
    expect(result.ok).toBe(true);
    expect(mockJmap.createSystemEmail).toHaveBeenCalledOnce();
  });

  it("suspends an account via Stalwart PATCH", async () => {
    mockStalwart.patchAccount.mockResolvedValue(undefined);

    const result = await callTool("configure_account", {
      account: "alice@test.example.com",
      setting: "suspend",
    });
    expect(result.ok).toBe(true);
    expect(mockStalwart.patchAccount).toHaveBeenCalledOnce();
  });

  it("returns error when account does not exist", async () => {
    mockStalwart.accountExists.mockResolvedValue(false);

    const result = await callTool("configure_account", {
      account: "nobody@test.example.com",
      setting: "display_name",
      value: "Ghost",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// manage_draft
// ---------------------------------------------------------------------------

describe("manage_draft", () => {
  it("creates a draft and returns draft_id", async () => {
    mockJmap.saveDraft.mockResolvedValue("draft-email-id-1");

    const result = await callTool("manage_draft", {
      account: "alice@test.example.com",
      action: "create",
      subject: "Draft subject",
      body: "Draft body",
      to: "bob@example.com",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { draft_id: string }).draft_id).toBe("draft-email-id-1");
  });

  it("sends a draft via send_email", async () => {
    mockJmap.getEmail.mockResolvedValue({
      id: "draft-1",
      subject: "Ready to send",
      textBody: "Draft body content",
      to: ["carol@example.com"],   // EmailDetail.to is string[]
      headers: {},
      from: "alice@test.example.com",
    });
    mockJmap.destroyEmail.mockResolvedValue(undefined);

    const result = await callTool("manage_draft", {
      account: "alice@test.example.com",
      action: "send",
      draft_id: "draft-1",
    });
    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it("deletes a draft", async () => {
    mockJmap.destroyEmail.mockResolvedValue(undefined);

    const result = await callTool("manage_draft", {
      account: "alice@test.example.com",
      action: "delete",
      draft_id: "draft-1",
    });
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR when draft_id is missing for send", async () => {
    const result = await callTool("manage_draft", {
      account: "alice@test.example.com",
      action: "send",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when send_at is missing for schedule", async () => {
    const result = await callTool("manage_draft", {
      account: "alice@test.example.com",
      action: "schedule",
      draft_id: "draft-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// update_thread
// ---------------------------------------------------------------------------

describe("update_thread", () => {
  it("archives all emails in a thread", async () => {
    mockJmap.updateThread.mockResolvedValue({ affected: 3 });

    const result = await callTool("update_thread", {
      account: "alice@test.example.com",
      thread_id: "thread-abc",
      action: "archive",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { affected: number }).affected).toBe(3);
  });

  it("returns VALIDATION_ERROR when label is missing for add_label", async () => {
    const result = await callTool("update_thread", {
      account: "alice@test.example.com",
      thread_id: "thread-abc",
      action: "add_label",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// manage_contact
// ---------------------------------------------------------------------------

describe("manage_contact", () => {
  it("creates a contact", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "contact-sys-1" });

    const result = await callTool("manage_contact", {
      account: "alice@test.example.com",
      action: "create",
      email: "bob@example.com",
      name: "Bob Builder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contact = (result.data as { contact: { email: string } }).contact;
    expect(contact.email).toBe("bob@example.com");
  });

  it("returns error when creating a duplicate contact", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([{
      id: "existing-1",
      subject: "CONTACT:bob@example.com",
      body: JSON.stringify({
        contactId: "c1", email: "bob@example.com",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }),
    }]);

    const result = await callTool("manage_contact", {
      account: "alice@test.example.com",
      action: "create",
      email: "bob@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/already exists/i);
  });

  it("updates a contact", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([{
      id: "existing-1",
      subject: "CONTACT:bob@example.com",
      body: JSON.stringify({
        contactId: "c1", email: "bob@example.com", name: "Bob",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }),
    }]);
    mockJmap.destroyEmail.mockResolvedValue(undefined);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "contact-sys-2" });

    const result = await callTool("manage_contact", {
      account: "alice@test.example.com",
      action: "update",
      email: "bob@example.com",
      name: "Bob Builder",
      vip: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { contact: { vip: boolean } }).contact.vip).toBe(true);
  });

  it("deletes a contact", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([{
      id: "existing-1",
      subject: "CONTACT:bob@example.com",
      body: JSON.stringify({
        contactId: "c1", email: "bob@example.com",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }),
    }]);
    mockJmap.destroyEmail.mockResolvedValue(undefined);

    const result = await callTool("manage_contact", {
      account: "alice@test.example.com",
      action: "delete",
      email: "bob@example.com",
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// manage_template + send_batch
// ---------------------------------------------------------------------------

describe("manage_template", () => {
  it("creates a template", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "tmpl-sys-1" });

    const result = await callTool("manage_template", {
      account: "alice@test.example.com",
      action: "create",
      name: "Welcome",
      subject: "Welcome to {{company}}!",
      body: "Hi {{first_name}}, welcome aboard.",
      variables: ["company", "first_name"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tmpl = (result.data as { template: { name: string; templateId: string } }).template;
    expect(tmpl.name).toBe("Welcome");
    expect(typeof tmpl.templateId).toBe("string");
  });
});

describe("send_batch", () => {
  const TEMPLATE_ID = "tmpl-abc-123";

  function setupTemplateMock() {
    mockJmap.listSystemEmails.mockResolvedValue([{
      id: "tmpl-sys-1",
      subject: `TEMPLATE:${TEMPLATE_ID}:Welcome`,
      body: JSON.stringify({
        templateId: TEMPLATE_ID,
        name: "Welcome",
        subject: "Welcome {{first_name}}!",
        body: "Hi {{first_name}}, greetings from {{company}}.",
        variables: ["first_name", "company"],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    }]);
  }

  it("sends to all recipients with variable substitution", async () => {
    setupTemplateMock();

    const result = await callTool("send_batch", {
      account: "alice@test.example.com",
      template_id: TEMPLATE_ID,
      recipients: ["bob@example.com", "carol@example.com"],
      variables: { first_name: "Friend", company: "Acme" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { sent: number; failed: number; errors: string[] };
    expect(data.sent).toBe(2);
    expect(data.failed).toBe(0);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it("reports per-recipient failures without aborting the batch", async () => {
    setupTemplateMock();
    mockSendMail
      .mockResolvedValueOnce({ messageId: "<ok@test>" })
      .mockRejectedValueOnce(new Error("SMTP timeout"));

    const result = await callTool("send_batch", {
      account: "alice@test.example.com",
      template_id: TEMPLATE_ID,
      recipients: ["bob@example.com", "carol@example.com"],
      variables: { first_name: "Friend", company: "Acme" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { sent: number; failed: number; errors: string[] };
    expect(data.sent).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.errors[0]).toContain("carol@example.com");
  });

  it("returns error when template is not found", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);

    const result = await callTool("send_batch", {
      account: "alice@test.example.com",
      template_id: "nonexistent-id",
      recipients: ["bob@example.com"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// manage_webhook
// ---------------------------------------------------------------------------

describe("manage_webhook", () => {
  it("registers a webhook and returns its ID", async () => {
    mockJmap.listSystemEmails.mockResolvedValue([]);
    mockJmap.createSystemEmail.mockResolvedValue({ id: "wh-sys-1" });

    const result = await callTool("manage_webhook", {
      account: "alice@test.example.com",
      action: "register",
      url: "https://hooks.example.com/mail",
      events: ["mail.received"],
      secret: "s3cr3t",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wh = (result.data as { webhook: { webhookId: string; url: string } }).webhook;
    expect(wh.url).toBe("https://hooks.example.com/mail");
    expect(typeof wh.webhookId).toBe("string");
  });

  it("unregisters a webhook", async () => {
    const webhookId = "wh-uuid-123";
    mockJmap.listSystemEmails.mockResolvedValue([{
      id: "wh-sys-1",
      subject: `WEBHOOK:${webhookId}`,
      body: JSON.stringify({
        webhookId,
        url: "https://hooks.example.com/mail",
        events: ["mail.received"],
        createdAt: "2026-01-01T00:00:00Z",
      }),
    }]);
    mockJmap.destroyEmail.mockResolvedValue(undefined);

    const result = await callTool("manage_webhook", {
      account: "alice@test.example.com",
      action: "unregister",
      webhook_id: webhookId,
    });
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR when url is missing for register", async () => {
    const result = await callTool("manage_webhook", {
      account: "alice@test.example.com",
      action: "register",
      events: ["mail.received"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when webhook_id is missing for unregister", async () => {
    const result = await callTool("manage_webhook", {
      account: "alice@test.example.com",
      action: "unregister",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// MCP Resources
// ---------------------------------------------------------------------------

describe("Resources", () => {
  async function readResource(uri: string): Promise<unknown> {
    const { rpc } = await mcpPost(
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } },
      TEST_KEY,
    );
    const contents = (rpc as { result?: { contents?: Array<{ text?: string }> } })
      ?.result?.contents ?? [];
    const text = contents[0]?.text;
    if (!text) throw new Error(`No resource content: ${JSON.stringify(rpc)}`);
    return JSON.parse(text);
  }

  it("email://inbox/{account} returns inbox emails", async () => {
    mockJmap.listEmails.mockResolvedValue([
      { id: "e1", subject: "Hello", from: "bob@example.com", receivedAt: "2026-04-01T10:00:00Z" },
    ]);

    const data = await readResource("email://inbox/alice@test.example.com");
    expect((data as { emails: unknown[] }).emails).toHaveLength(1);
  });

  it("email://inbox/{account} degrades gracefully on JMAP error", async () => {
    mockJmap.listEmails.mockRejectedValue(new Error("JMAP timeout"));

    const data = await readResource("email://inbox/alice@test.example.com");
    expect((data as { error: string }).error).toContain("JMAP timeout");
  });

  it("email://thread/{account}/{thread_id} returns thread emails", async () => {
    mockJmap.getThread.mockResolvedValue([
      { id: "e1", subject: "Thread msg 1" },
      { id: "e2", subject: "Re: Thread msg 1" },
    ]);

    const data = await readResource("email://thread/alice@test.example.com/thread-xyz");
    expect((data as { emails: unknown[] }).emails).toHaveLength(2);
  });

  it("account://config/{account} returns all config sections", async () => {
    mockJmap.listMailboxes.mockResolvedValue([
      { id: "m1", name: "Inbox", role: "inbox", totalEmails: 5, unreadEmails: 1 },
    ]);
    // listSystemEmails is called multiple times: rules, whitelist, blacklist, labels, settings
    mockJmap.listSystemEmails.mockResolvedValue([]);

    const data = await readResource("account://config/alice@test.example.com");
    expect(data).toMatchObject({
      account: "alice@test.example.com",
      folders: expect.any(Array),
      rules: expect.any(Array),
      whitelist: expect.any(Array),
      blacklist: expect.any(Array),
      labels: expect.any(Array),
      settings: expect.any(Object),
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP routing edge cases
// ---------------------------------------------------------------------------

describe("HTTP routing", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://localhost:${port}/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": TEST_KEY },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns 405 for PUT on /mcp", async () => {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-API-Key": TEST_KEY },
      body: "{}",
    });
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Authorization — permission levels (admin vs user keys)
// ---------------------------------------------------------------------------

const USER_KEY = "user-key-1"; // bound to alice@test.example.com

describe("Authorization", () => {
  describe("admin-only tools", () => {
    it("admin key can call list_accounts", async () => {
      mockStalwart.listAccounts.mockResolvedValue([]);
      const result = await callTool("list_accounts", {}, TEST_KEY);
      expect(result.ok).toBe(true);
    });

    it("user key is denied list_accounts", async () => {
      const { rpc } = await mcpPost(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_accounts", arguments: {} } },
        USER_KEY,
      );
      const content = (rpc as { result?: { content?: Array<{ text?: string }>; isError?: boolean } })?.result;
      expect(content?.isError).toBe(true);
      expect(content?.content?.[0]?.text).toMatch(/admin/i);
    });

    it("user key CAN call create_account (open to all authenticated callers)", async () => {
      // create_account no longer requires admin — any authenticated caller can create an account.
      // The call may fail due to the mock setup (Stalwart error), but it should NOT be a permission denial.
      const { rpc } = await mcpPost(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_account", arguments: { local_part: "bob" } } },
        USER_KEY,
      );
      const content = (rpc as { result?: { content?: Array<{ text?: string }>; isError?: boolean } })?.result;
      // Should not be a "requires admin privileges" denial
      if (content?.isError) {
        const text = content?.content?.[0]?.text ?? "";
        expect(text).not.toMatch(/requires admin/i);
        expect(text).not.toMatch(/permission denied/i);
      }
    });

    it("user key is denied delete_account", async () => {
      const { rpc } = await mcpPost(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_account", arguments: { local_part: "bob" } } },
        USER_KEY,
      );
      const content = (rpc as { result?: { content?: Array<{ text?: string }>; isError?: boolean } })?.result;
      expect(content?.isError).toBe(true);
      expect(content?.content?.[0]?.text).toMatch(/admin/i);
    });
  });

  describe("account-scoped tools", () => {
    it("user key can access own account (list_emails)", async () => {
      mockJmap.listEmails.mockResolvedValue([]);
      const result = await callTool("list_emails", { account: "alice@test.example.com" }, USER_KEY);
      expect(result.ok).toBe(true);
    });

    it("user key is denied access to other account (list_emails)", async () => {
      const { rpc } = await mcpPost(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_emails", arguments: { account: "bob@test.example.com" } } },
        USER_KEY,
      );
      const content = (rpc as { result?: { content?: Array<{ text?: string }>; isError?: boolean } })?.result;
      expect(content?.isError).toBe(true);
      expect(content?.content?.[0]?.text).toMatch(/permission denied/i);
    });

    it("user key can send_email from own account (local part)", async () => {
      const result = await callTool("send_email", {
        from_account: "alice",
        to: "bob@example.com",
        subject: "Test",
        body: "Hello",
      }, USER_KEY);
      expect(result.ok).toBe(true);
    });

    it("user key is denied send_email from other account", async () => {
      const { rpc } = await mcpPost(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_email", arguments: {
          from_account: "bob",
          to: "carol@example.com",
          subject: "Test",
          body: "Hello",
        } } },
        USER_KEY,
      );
      const content = (rpc as { result?: { content?: Array<{ text?: string }>; isError?: boolean } })?.result;
      expect(content?.isError).toBe(true);
      expect(content?.content?.[0]?.text).toMatch(/permission denied/i);
    });

    it("admin key can access any account", async () => {
      mockJmap.listEmails.mockResolvedValue([]);
      const result = await callTool("list_emails", { account: "anyone@test.example.com" }, TEST_KEY);
      expect(result.ok).toBe(true);
    });

    it("user key can configure_account with local-part form", async () => {
      mockStalwart.accountExists.mockResolvedValue(true);
      mockStalwart.patchAccount.mockResolvedValue(undefined);

      const result = await callTool("configure_account", {
        account: "alice",
        setting: "display_name",
        value: "Alice",
      }, USER_KEY);
      expect(result.ok).toBe(true);
    });

    it("user key is denied configure_account for other account (local-part)", async () => {
      const { rpc } = await mcpPost(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "configure_account", arguments: {
          account: "bob",
          setting: "display_name",
          value: "Bob",
        } } },
        USER_KEY,
      );
      const content = (rpc as { result?: { content?: Array<{ text?: string }>; isError?: boolean } })?.result;
      expect(content?.isError).toBe(true);
      expect(content?.content?.[0]?.text).toMatch(/permission denied/i);
    });
  });
});
