import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Unit-tests for accounts.ts  (toolDeleteAccount + toolCreateAccount)
// ---------------------------------------------------------------------------

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../config.js", () => ({
  config: { domain: "example.com" },
}));

// stalwart-mgmt — controllable per-test via mockAccountExists
const mockAccountExists = vi.fn();
const mockDeleteAccount = vi.fn().mockResolvedValue(undefined);
const mockCreateAccount = vi.fn().mockResolvedValue(undefined);
const mockListAccounts = vi.fn().mockResolvedValue([]);

vi.mock("../clients/stalwart-mgmt.js", () => ({
  accountExists: mockAccountExists,
  deleteAccount: mockDeleteAccount,
  createAccount: mockCreateAccount,
  listAccounts: mockListAccounts,
}));

// tokens — controllable per-test
const mockListTokens = vi.fn();
const mockRevokeToken = vi.fn();
const mockCreateToken = vi.fn().mockResolvedValue({
  plaintext: "tok_fakeplaintext",
  info: { tokenId: "tid-1", account: "alice@example.com", role: "user", createdAt: "2024-01-01" },
});

vi.mock("./tokens.js", () => ({
  listTokens: mockListTokens,
  revokeToken: mockRevokeToken,
  createToken: mockCreateToken,
}));

const { toolDeleteAccount, toolCreateAccount } = await import("./accounts.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteAccount.mockResolvedValue(undefined);
  mockCreateAccount.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// toolDeleteAccount
// ---------------------------------------------------------------------------

describe("toolDeleteAccount — reserved account guard", () => {
  it("throws for clawmail-system", async () => {
    await expect(toolDeleteAccount("clawmail-system")).rejects.toThrow(
      "Cannot delete reserved system account: clawmail-system",
    );
  });

  it("does not call deleteAccount for a reserved account", async () => {
    await expect(toolDeleteAccount("clawmail-system")).rejects.toThrow();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });
});

describe("toolDeleteAccount — account does not exist", () => {
  it("throws when account missing", async () => {
    mockAccountExists.mockResolvedValue(false);
    await expect(toolDeleteAccount("alice")).rejects.toThrow("Account does not exist");
  });
});

describe("toolDeleteAccount — token cleanup", () => {
  beforeEach(() => {
    mockAccountExists.mockResolvedValue(true);
  });

  it("revokes each token and returns the count", async () => {
    mockListTokens.mockResolvedValue([
      { tokenId: "tok-a" },
      { tokenId: "tok-b" },
    ]);
    mockRevokeToken.mockResolvedValue(true);

    const result = await toolDeleteAccount("alice");

    expect(mockRevokeToken).toHaveBeenCalledTimes(2);
    expect(mockRevokeToken).toHaveBeenCalledWith("tok-a");
    expect(mockRevokeToken).toHaveBeenCalledWith("tok-b");
    expect(result.tokens_revoked).toBe(2);
    expect(result.token_revocation_warning).toBeUndefined();
  });

  it("counts only successfully revoked tokens (revokeToken returns false for not-found)", async () => {
    mockListTokens.mockResolvedValue([{ tokenId: "tok-a" }, { tokenId: "tok-b" }]);
    mockRevokeToken.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await toolDeleteAccount("alice");

    expect(result.tokens_revoked).toBe(1);
  });

  it("still deletes the account if an individual revokeToken throws", async () => {
    mockListTokens.mockResolvedValue([{ tokenId: "tok-a" }]);
    mockRevokeToken.mockRejectedValue(new Error("JMAP error"));

    const result = await toolDeleteAccount("alice");

    expect(mockDeleteAccount).toHaveBeenCalledWith("alice");
    expect(result.tokens_revoked).toBe(0);
  });

  it("includes a warning (but still deletes) when JMAP is unavailable for listing", async () => {
    mockListTokens.mockRejectedValue(new Error("JMAP unavailable"));

    const result = await toolDeleteAccount("alice");

    expect(mockDeleteAccount).toHaveBeenCalledWith("alice");
    expect(result.token_revocation_warning).toMatch(/token store was unavailable/);
    expect(result.tokens_revoked).toBe(0);
  });

  it("calls listTokens with throwOnError: true", async () => {
    mockListTokens.mockResolvedValue([]);
    mockRevokeToken.mockResolvedValue(true);

    await toolDeleteAccount("alice");

    expect(mockListTokens).toHaveBeenCalledWith(
      "alice@example.com",
      { throwOnError: true },
    );
  });
});

describe("toolDeleteAccount — success response", () => {
  it("returns success message with email", async () => {
    mockAccountExists.mockResolvedValue(true);
    mockListTokens.mockResolvedValue([]);

    const result = await toolDeleteAccount("alice");

    expect(result.message).toMatch("alice@example.com");
    expect(result.tokens_revoked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toolCreateAccount
// ---------------------------------------------------------------------------

describe("toolCreateAccount", () => {
  it("throws when account already exists", async () => {
    mockAccountExists.mockResolvedValue(true);
    await expect(toolCreateAccount("alice")).rejects.toThrow("Account already exists");
  });

  it("creates account and returns token", async () => {
    mockAccountExists.mockResolvedValue(false);

    const result = await toolCreateAccount("alice");

    expect(mockCreateAccount).toHaveBeenCalledWith("alice");
    expect(result.token).toBe("tok_fakeplaintext");
    expect(result.email).toBe("alice@example.com");
  });

  it("throws for invalid local part", async () => {
    await expect(toolCreateAccount("bad local!")).rejects.toThrow();
  });
});
