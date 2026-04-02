import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock config before importing the module under test
// ---------------------------------------------------------------------------
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

import {
  createAccount,
  deleteAccount,
  listAccounts,
  accountExists,
  ensureDomainExists,
} from "./stalwart-mgmt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ---------------------------------------------------------------------------
// ensureDomainExists
// ---------------------------------------------------------------------------

describe("ensureDomainExists", () => {
  afterEach(() => vi.restoreAllMocks());

  it("succeeds when domain is created fresh", async () => {
    global.fetch = mockFetch(200, null);
    await expect(ensureDomainExists()).resolves.toBeUndefined();
  });

  it("succeeds when domain already exists (fieldAlreadyExists)", async () => {
    global.fetch = mockFetch(200, { error: "fieldAlreadyExists" });
    await expect(ensureDomainExists()).resolves.toBeUndefined();
  });

  it("throws on unexpected Stalwart error", async () => {
    global.fetch = mockFetch(200, { error: "someOtherError" });
    await expect(ensureDomainExists()).rejects.toThrow("someOtherError");
  });

  it("throws on HTTP error", async () => {
    global.fetch = mockFetch(500, "internal error");
    await expect(ensureDomainExists()).rejects.toThrow("HTTP 500");
  });
});

// ---------------------------------------------------------------------------
// accountExists
// ---------------------------------------------------------------------------

describe("accountExists", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true when account exists", async () => {
    global.fetch = mockFetch(200, { name: "alice", type: "individual" });
    await expect(accountExists("alice")).resolves.toBe(true);
  });

  it("returns false when Stalwart returns notFound", async () => {
    global.fetch = mockFetch(200, { error: "notFound" });
    await expect(accountExists("ghost")).resolves.toBe(false);
  });

  it("throws on HTTP error", async () => {
    global.fetch = mockFetch(401, "Unauthorized");
    await expect(accountExists("alice")).rejects.toThrow("HTTP 401");
  });
});

// ---------------------------------------------------------------------------
// createAccount
// ---------------------------------------------------------------------------

describe("createAccount", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates account and returns email", async () => {
    // ensureDomainExists → fieldAlreadyExists (ok), accountExists → notFound, createAccount → ok
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ error: "fieldAlreadyExists" }), text: () => Promise.resolve("") })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ error: "notFound" }), text: () => Promise.resolve("") })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(null), text: () => Promise.resolve("") });

    const result = await createAccount("alice");
    expect(result.email).toBe("alice@test.example.com");
  });

  it("throws if account already exists", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ error: "fieldAlreadyExists" }), text: () => Promise.resolve("") })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ name: "alice" }), text: () => Promise.resolve("") });

    await expect(createAccount("alice")).rejects.toThrow("Account already exists");
  });

  it("sends enabledPermissions: [email-receive] in POST body", async () => {
    const calls: RequestInit[] = [];
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      calls.push(opts);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ error: "fieldAlreadyExists" }), text: () => Promise.resolve("") });
    }) as typeof fetch;

    // Override the 2nd call (accountExists) to return notFound and 3rd (createAccount POST) to succeed
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ error: "fieldAlreadyExists" }), text: () => Promise.resolve("") });
      if (callCount === 2) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ error: "notFound" }), text: () => Promise.resolve("") });
      // 3rd call: the actual POST createAccount
      calls.push(opts);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null), text: () => Promise.resolve("") });
    }) as typeof fetch;

    await createAccount("bob");

    const postBody = JSON.parse(calls[0].body as string);
    expect(postBody.enabledPermissions).toContain("email-receive");
  });
});

// ---------------------------------------------------------------------------
// deleteAccount
// ---------------------------------------------------------------------------

describe("deleteAccount", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deletes account successfully (null response body)", async () => {
    global.fetch = mockFetch(200, null);
    await expect(deleteAccount("alice")).resolves.toBeUndefined();
  });

  it("throws if account not found", async () => {
    global.fetch = mockFetch(200, { error: "notFound" });
    await expect(deleteAccount("ghost")).rejects.toThrow("Account not found");
  });

  it("throws on other Stalwart errors", async () => {
    global.fetch = mockFetch(200, { error: "permissionDenied" });
    await expect(deleteAccount("alice")).rejects.toThrow("permissionDenied");
  });

  it("throws on HTTP error", async () => {
    global.fetch = mockFetch(403, "Forbidden");
    await expect(deleteAccount("alice")).rejects.toThrow("HTTP 403");
  });
});

// ---------------------------------------------------------------------------
// listAccounts
// ---------------------------------------------------------------------------

describe("listAccounts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns accounts from flat array response", async () => {
    global.fetch = mockFetch(200, {
      data: [
        { name: "alice", description: "alice@test.example.com" },
        { name: "bob" },
      ],
    });

    const result = await listAccounts();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: "alice", email: "alice@test.example.com" });
    expect(result[1]).toMatchObject({ name: "bob", email: "bob@test.example.com" });
  });

  it("returns accounts from paginated response (data.items)", async () => {
    global.fetch = mockFetch(200, {
      data: {
        items: [{ name: "charlie" }],
        total: 1,
      },
    });

    const result = await listAccounts();
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("charlie@test.example.com");
  });

  it("returns empty array when data is missing", async () => {
    global.fetch = mockFetch(200, {});
    const result = await listAccounts();
    expect(result).toEqual([]);
  });

  it("throws on HTTP error", async () => {
    global.fetch = mockFetch(500, "server error");
    await expect(listAccounts()).rejects.toThrow("HTTP 500");
  });
});
