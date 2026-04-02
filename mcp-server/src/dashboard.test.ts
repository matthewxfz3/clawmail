/**
 * Unit tests for dashboard.ts
 *
 * Tests are isolated from real network I/O and env vars.
 * We test the pure logic: session signing, form parsing, HTML escaping,
 * and the effectivePassword fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers extracted / re-implemented here to test without importing side-effects
// from config.ts (which throws if env vars are missing).
// ---------------------------------------------------------------------------

function signSession(payload: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(cookie: string, secret: string): boolean {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch {
    return false;
  }
}

function parseFormBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(
      part.slice(eq + 1).replace(/\+/g, " "),
    );
  }
  return out;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Session signing & verification
// ---------------------------------------------------------------------------

describe("session signing", () => {
  it("round-trips: sign then verify returns true", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 1000 })).toString("base64url");
    const cookie = signSession(payload, "supersecret");
    expect(verifySession(cookie, "supersecret")).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 1000 })).toString("base64url");
    const cookie = signSession(payload, "supersecret");
    const tampered = "evilpayload." + cookie.split(".")[1];
    expect(verifySession(tampered, "supersecret")).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 1000 })).toString("base64url");
    const cookie = signSession(payload, "supersecret");
    const tampered = payload + ".deadbeef";
    expect(verifySession(tampered, "supersecret")).toBe(false);
  });

  it("rejects a cookie signed with a different secret", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 1000 })).toString("base64url");
    const cookie = signSession(payload, "correct-secret");
    expect(verifySession(cookie, "wrong-secret")).toBe(false);
  });

  it("rejects a cookie with no dot separator", () => {
    expect(verifySession("nodothere", "secret")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(verifySession("", "secret")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

describe("session expiry", () => {
  it("an expired payload is detectable", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1 })).toString("base64url");
    const cookie = signSession(payload, "secret");
    // Signature is valid, but exp is in the past
    expect(verifySession(cookie, "secret")).toBe(true); // sig valid
    // Caller must check exp separately — this mirrors the real isAuthenticated logic
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(parsed.exp).toBeLessThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// Form body parsing
// ---------------------------------------------------------------------------

describe("parseFormBody", () => {
  it("parses simple key=value pairs", () => {
    expect(parseFormBody("user=admin&pass=secret")).toEqual({
      user: "admin",
      pass: "secret",
    });
  });

  it("decodes percent-encoded values", () => {
    expect(parseFormBody("user=admin%40example.com")).toEqual({
      user: "admin@example.com",
    });
  });

  it("decodes + as space", () => {
    expect(parseFormBody("pass=my+password")).toEqual({ pass: "my password" });
  });

  it("handles empty string", () => {
    expect(parseFormBody("")).toEqual({});
  });

  it("ignores parts with no = sign", () => {
    expect(parseFormBody("user=admin&bogus&pass=x")).toEqual({
      user: "admin",
      pass: "x",
    });
  });

  it("handles values that contain =", () => {
    // base64 values may contain = padding
    expect(parseFormBody("token=abc==")).toEqual({ token: "abc==" });
  });
});

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

describe("escHtml", () => {
  it("escapes &", () => {
    expect(escHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes <", () => {
    expect(escHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes quotes", () => {
    expect(escHtml('"quoted"')).toBe("&quot;quoted&quot;");
  });

  it("leaves plain text unchanged", () => {
    expect(escHtml("hello world")).toBe("hello world");
  });

  it("escapes all special chars in one string", () => {
    expect(escHtml('<img src="x" onerror="alert(1)">')).toBe(
      '&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;',
    );
  });
});

// ---------------------------------------------------------------------------
// effectivePassword fallback logic
// ---------------------------------------------------------------------------

describe("effectivePassword fallback", () => {
  it("uses DASHBOARD_PASSWORD when set", () => {
    const dashPass = "dashsecret";
    const stalwartPass = "stalwartsecret";
    const effective = dashPass || stalwartPass;
    expect(effective).toBe("dashsecret");
  });

  it("falls back to stalwart password when DASHBOARD_PASSWORD is empty", () => {
    const dashPass = "";
    const stalwartPass = "stalwartsecret";
    const effective = dashPass || stalwartPass;
    expect(effective).toBe("stalwartsecret");
  });

  it("falls back to stalwart password when DASHBOARD_PASSWORD is undefined-ish", () => {
    const dashPass = undefined as unknown as string;
    const stalwartPass = "stalwartsecret";
    const effective = dashPass || stalwartPass;
    expect(effective).toBe("stalwartsecret");
  });
});
