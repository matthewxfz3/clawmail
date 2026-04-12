import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Unit-test the token helpers without a real JMAP/Stalwart backend.
// We mock the JMAP client and the stalwart-mgmt module so tests run offline.
// ---------------------------------------------------------------------------

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock config — adminTokens starts empty; individual tests mutate it as needed.
const mockAdminTokens = new Set<string>();
vi.mock("../config.js", () => ({
  config: {
    domain: "example.com",
    stalwart: { url: "http://stalwart", adminUser: "admin", adminPassword: "secret" },
    auth: { adminTokens: mockAdminTokens },
  },
}));

// Mock stalwart-mgmt — system account always "exists"
vi.mock("../clients/stalwart-mgmt.js", () => ({
  ensureDomainExists: vi.fn().mockResolvedValue(undefined),
  accountExists: vi.fn().mockResolvedValue(true),
  createAccount: vi.fn().mockResolvedValue(undefined),
}));

// In-memory store for JMAP system emails
const jmapStore: Array<{ id: string; subject: string; body: string }> = [];

vi.mock("../clients/jmap.js", () => {
  return {
    JmapClient: class MockJmapClient {
      async createSystemEmail(_mailbox: string, subject: string, body: string): Promise<string> {
        const id = `email-${Math.random().toString(36).slice(2)}`;
        jmapStore.push({ id, subject, body });
        return id;
      }
      async listSystemEmails(_mailbox: string) {
        return [...jmapStore];
      }
      async destroyEmail(id: string): Promise<void> {
        const idx = jmapStore.findIndex((e) => e.id === id);
        if (idx >= 0) jmapStore.splice(idx, 1);
      }
    },
  };
});

// After mocks are declared, import the module under test.
const {
  createToken,
  resolveToken,
  listTokens,
  revokeToken,
  systemEmail,
  _resetAdminTokenHashCacheForTesting,
} = await import("./tokens.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jmapStore.length = 0;
  mockAdminTokens.clear();
  // Invalidate the pre-computed hash cache whenever the token set changes.
  _resetAdminTokenHashCacheForTesting();
});

describe("systemEmail", () => {
  it("returns clawmail-system@domain", () => {
    expect(systemEmail()).toBe("clawmail-system@example.com");
  });
});

describe("createToken", () => {
  it("returns a tok_ prefixed plaintext token", async () => {
    const { plaintext } = await createToken("alice@example.com", "user");
    expect(plaintext).toMatch(/^tok_[0-9a-f]{64}$/);
  });

  it("stores the entry in JMAP (subject starts with TOKEN:)", async () => {
    await createToken("alice@example.com", "user", "my-label");
    expect(jmapStore.length).toBe(1);
    expect(jmapStore[0].subject).toMatch(/^TOKEN:/);
  });

  it("info does not include hash", async () => {
    const { info } = await createToken("alice@example.com", "user");
    expect("hash" in info).toBe(false);
  });

  it("info includes account, role, tokenId, createdAt", async () => {
    const { info } = await createToken("alice@example.com", "user", "lbl");
    expect(info.account).toBe("alice@example.com");
    expect(info.role).toBe("user");
    expect(typeof info.tokenId).toBe("string");
    expect(typeof info.createdAt).toBe("string");
    expect(info.label).toBe("lbl");
  });
});

describe("resolveToken", () => {
  it("resolves a freshly created token", async () => {
    const { plaintext } = await createToken("bob@example.com", "user");
    const entry = await resolveToken(plaintext);
    expect(entry).not.toBeNull();
    expect(entry!.account).toBe("bob@example.com");
    expect(entry!.role).toBe("user");
  });

  it("returns null for unknown token", async () => {
    const entry = await resolveToken("tok_notreal");
    expect(entry).toBeNull();
  });

  it("returns null for empty string", async () => {
    const entry = await resolveToken("");
    expect(entry).toBeNull();
  });

  it("resolves static admin token from config.auth.adminTokens", async () => {
    mockAdminTokens.add("super-secret-admin-token");
    try {
      const entry = await resolveToken("super-secret-admin-token");
      expect(entry).not.toBeNull();
      expect(entry!.role).toBe("admin");
      expect(entry!.account).toBe("*");
    } finally {
      mockAdminTokens.delete("super-secret-admin-token");
    }
  });

  it("does not resolve static admin token when config.auth.adminTokens is empty", async () => {
    mockAdminTokens.clear();
    const entry = await resolveToken("super-secret-admin-token");
    expect(entry).toBeNull();
  });
});

describe("listTokens", () => {
  it("returns empty list when no tokens", async () => {
    const tokens = await listTokens();
    expect(tokens).toHaveLength(0);
  });

  it("lists all tokens without hash field", async () => {
    await createToken("alice@example.com", "user");
    await createToken("bob@example.com", "admin", "admin-tok");
    const tokens = await listTokens();
    expect(tokens).toHaveLength(2);
    for (const t of tokens) {
      expect("hash" in t).toBe(false);
    }
  });

  it("filters by account when provided", async () => {
    await createToken("alice@example.com", "user");
    await createToken("bob@example.com", "user");
    const tokens = await listTokens("alice@example.com");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].account).toBe("alice@example.com");
  });

  it("is case-insensitive when filtering", async () => {
    await createToken("Alice@Example.COM", "user");
    const tokens = await listTokens("alice@example.com");
    expect(tokens).toHaveLength(1);
  });
});

describe("revokeToken", () => {
  it("returns false when tokenId not found", async () => {
    const ok = await revokeToken("no-such-id");
    expect(ok).toBe(false);
  });

  it("deletes the token and returns true", async () => {
    const { info } = await createToken("carol@example.com", "user");
    expect(jmapStore).toHaveLength(1);
    const ok = await revokeToken(info.tokenId);
    expect(ok).toBe(true);
    expect(jmapStore).toHaveLength(0);
  });

  it("revoked token can no longer be resolved", async () => {
    const { plaintext, info } = await createToken("dave@example.com", "user");
    await revokeToken(info.tokenId);
    const entry = await resolveToken(plaintext);
    expect(entry).toBeNull();
  });
});
