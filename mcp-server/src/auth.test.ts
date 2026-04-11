import { describe, it, expect } from "vitest";
import { parseApiKeyMap, authorize, normalizeAccount, type CallerIdentity } from "./auth.js";

// ---------------------------------------------------------------------------
// parseApiKeyMap
// ---------------------------------------------------------------------------

describe("parseApiKeyMap", () => {
  it("parses valid JSON with admin and user keys", () => {
    const json = JSON.stringify([
      { key: "admin-key", role: "admin" },
      { key: "user-key", role: "user", account: "bob@example.com" },
    ]);
    const map = parseApiKeyMap(json);
    expect(map.get("admin-key")).toEqual({ apiKey: "admin-key", role: "admin" });
    expect(map.get("user-key")).toEqual({ apiKey: "user-key", role: "user", account: "bob@example.com" });
  });

  it("returns empty map for empty string", () => {
    expect(parseApiKeyMap("").size).toBe(0);
  });

  it("returns empty map for whitespace-only string", () => {
    expect(parseApiKeyMap("   ").size).toBe(0);
  });

  it("throws on user key missing account", () => {
    const json = JSON.stringify([{ key: "k", role: "user" }]);
    expect(() => parseApiKeyMap(json)).toThrow();
  });

  it("throws on invalid role", () => {
    const json = JSON.stringify([{ key: "k", role: "superadmin" }]);
    expect(() => parseApiKeyMap(json)).toThrow();
  });

  it("throws on duplicate keys", () => {
    const json = JSON.stringify([
      { key: "same", role: "admin" },
      { key: "same", role: "user", account: "a@b.com" },
    ]);
    expect(() => parseApiKeyMap(json)).toThrow(/duplicate/i);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseApiKeyMap("not json")).toThrow();
  });

  it("throws on empty key string", () => {
    const json = JSON.stringify([{ key: "", role: "admin" }]);
    expect(() => parseApiKeyMap(json)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// normalizeAccount
// ---------------------------------------------------------------------------

describe("normalizeAccount", () => {
  it("returns full email unchanged", () => {
    expect(normalizeAccount("bob@example.com", "example.com")).toBe("bob@example.com");
  });

  it("appends domain to local part", () => {
    expect(normalizeAccount("bob", "example.com")).toBe("bob@example.com");
  });
});

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

describe("authorize", () => {
  const admin: CallerIdentity = { apiKey: "ak", role: "admin" };
  const user: CallerIdentity = { apiKey: "uk", role: "user", account: "bob@example.com" };

  it("admin is always allowed for admin-only tools", () => {
    expect(authorize(admin, "create_account")).toBeNull();
    expect(authorize(admin, "delete_account")).toBeNull();
    expect(authorize(admin, "list_accounts")).toBeNull();
  });

  it("admin is always allowed for account-scoped tools", () => {
    expect(authorize(admin, "list_emails", "anyone@example.com")).toBeNull();
    expect(authorize(admin, "send_email", "anyone@example.com")).toBeNull();
  });

  it("user is denied admin-only tools", () => {
    const err = authorize(user, "create_account");
    expect(err).not.toBeNull();
    expect(err!.isError).toBe(true);
    expect(err!.content[0].text).toMatch(/admin/i);
  });

  it("user is denied for delete_account", () => {
    expect(authorize(user, "delete_account")).not.toBeNull();
  });

  it("user is denied for list_accounts", () => {
    expect(authorize(user, "list_accounts")).not.toBeNull();
  });

  it("user is allowed for own account", () => {
    expect(authorize(user, "list_emails", "bob@example.com")).toBeNull();
  });

  it("user is allowed for own account (case-insensitive)", () => {
    expect(authorize(user, "list_emails", "Bob@Example.COM")).toBeNull();
  });

  it("user is denied for other account", () => {
    const err = authorize(user, "list_emails", "alice@example.com");
    expect(err).not.toBeNull();
    expect(err!.isError).toBe(true);
    expect(err!.content[0].text).toMatch(/permission denied/i);
  });

  it("user with no target account on scoped tool is denied", () => {
    const err = authorize(user, "list_emails");
    expect(err).not.toBeNull();
    expect(err!.isError).toBe(true);
  });
});
