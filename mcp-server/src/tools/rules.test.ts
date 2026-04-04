import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { domain: "test.example.com" },
}));

const mockClient = vi.hoisted(() => ({
  createSystemEmail: vi.fn(),
  listSystemEmails: vi.fn(),
  destroyEmail: vi.fn(),
  deleteEmail: vi.fn(),
  moveEmail: vi.fn(),
  markEmailRead: vi.fn(),
  listEmails: vi.fn(),
}));

vi.mock("../clients/jmap.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  JmapClient: vi.fn(function () { return mockClient; } as any),
}));

import {
  toolCreateRule,
  toolListRules,
  toolDeleteRule,
  toolApplyRules,
} from "./rules.js";

import type { RuleCondition, RuleAction } from "./rules.js";

function makeRuleEmail(ruleId: string, name: string, condition: RuleCondition = { from: "spam@" }, action: RuleAction = { delete: true }) {
  const rule = { ruleId, name, condition, action, createdAt: "2026-01-01T00:00:00Z" };
  return { id: `email-${ruleId}`, subject: `RULE:${ruleId}:${name}`, body: JSON.stringify(rule) };
}

function makeEmailSummary(id: string, from: string, subject: string, hasAttachment = false, receivedAt = "2026-01-01T00:00:00Z") {
  return { id, from, subject, hasAttachment, receivedAt, to: [], preview: "", mailboxIds: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.createSystemEmail.mockResolvedValue("new-id");
  mockClient.listSystemEmails.mockResolvedValue([]);
  mockClient.listEmails.mockResolvedValue([]);
  mockClient.destroyEmail.mockResolvedValue(undefined);
  mockClient.deleteEmail.mockResolvedValue(undefined);
  mockClient.moveEmail.mockResolvedValue(undefined);
  mockClient.markEmailRead.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("toolCreateRule", () => {
  it("creates a rule and stores it", async () => {
    const result = await toolCreateRule({
      account: "agent@test.example.com",
      name: "Block newsletters",
      condition: { from: "newsletter@" },
      action: { moveTo: "Newsletters" },
    });
    expect(result.rule.name).toBe("Block newsletters");
    expect(result.rule.ruleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockClient.createSystemEmail).toHaveBeenCalledOnce();
    const [mailbox, subject] = mockClient.createSystemEmail.mock.calls[0];
    expect(mailbox).toBe("_rules");
    expect(subject).toContain("RULE:");
  });

  it("rejects empty name", async () => {
    await expect(toolCreateRule({
      account: "a@test.example.com", name: "",
      condition: { from: "x" }, action: { delete: true },
    })).rejects.toThrow("name must not be empty");
  });

  it("rejects empty condition", async () => {
    await expect(toolCreateRule({
      account: "a@test.example.com", name: "r",
      condition: {}, action: { delete: true },
    })).rejects.toThrow("condition must have at least one field");
  });

  it("rejects empty action", async () => {
    await expect(toolCreateRule({
      account: "a@test.example.com", name: "r",
      condition: { from: "x" }, action: {},
    })).rejects.toThrow("action must have at least one field");
  });
});

// ---------------------------------------------------------------------------
describe("toolListRules", () => {
  it("returns empty list when no rules", async () => {
    const { rules, count } = await toolListRules({ account: "agent@test.example.com" });
    expect(rules).toEqual([]);
    expect(count).toBe(0);
  });

  it("returns parsed rules", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeRuleEmail("r-1", "Rule One"),
      makeRuleEmail("r-2", "Rule Two", { subject: "invoice" }, { markRead: true }),
    ]);
    const { rules, count } = await toolListRules({ account: "agent@test.example.com" });
    expect(count).toBe(2);
    expect(rules[0].name).toBe("Rule One");
    expect(rules[1].condition.subject).toBe("invoice");
  });

  it("skips entries with corrupt body", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      { id: "x", subject: "RULE:bad-id:Broken", body: "not-json" },
    ]);
    const { rules } = await toolListRules({ account: "a@test.example.com" });
    expect(rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("toolDeleteRule", () => {
  it("deletes the matching rule email", async () => {
    mockClient.listSystemEmails.mockResolvedValue([makeRuleEmail("del-r", "Delete me")]);
    const result = await toolDeleteRule({ account: "agent@test.example.com", rule_id: "del-r" });
    expect(result.message).toContain("del-r");
    expect(mockClient.destroyEmail).toHaveBeenCalledWith("email-del-r");
  });

  it("throws when rule not found", async () => {
    await expect(toolDeleteRule({ account: "a@test.example.com", rule_id: "nope" }))
      .rejects.toThrow("Rule not found");
  });
});

// ---------------------------------------------------------------------------
describe("toolApplyRules — condition matching", () => {
  it("matches by from substring", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeRuleEmail("r-1", "Spam rule", { from: "spammer@evil" }, { delete: true }),
    ]);
    mockClient.listEmails.mockResolvedValue([
      makeEmailSummary("e-1", "Spammer <spammer@evil.com>", "Win a prize"),
      makeEmailSummary("e-2", "legit@good.com", "Real email"),
    ]);

    const result = await toolApplyRules({ account: "agent@test.example.com" });
    expect(result.matched).toBe(1);
    expect(result.actions[0].emailId).toBe("e-1");
    expect(result.actions[0].actionTaken).toBe("moved to Trash");
    expect(mockClient.deleteEmail).toHaveBeenCalledWith("e-1");
    expect(mockClient.deleteEmail).not.toHaveBeenCalledWith("e-2");
  });

  it("matches by subject substring (case-insensitive)", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeRuleEmail("r-1", "Invoice rule", { subject: "invoice" }, { moveTo: "Finance" }),
    ]);
    mockClient.listEmails.mockResolvedValue([
      makeEmailSummary("e-1", "billing@co.com", "Your INVOICE #1234"),
      makeEmailSummary("e-2", "friend@co.com", "How are you"),
    ]);

    const result = await toolApplyRules({ account: "agent@test.example.com" });
    expect(result.matched).toBe(1);
    expect(mockClient.moveEmail).toHaveBeenCalledWith("e-1", "Finance");
  });

  it("matches by hasAttachment", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeRuleEmail("r-1", "No-attach rule", { hasAttachment: false }, { markRead: true }),
    ]);
    mockClient.listEmails.mockResolvedValue([
      makeEmailSummary("e-1", "a@b.com", "No attach", false),
      makeEmailSummary("e-2", "a@b.com", "Has attach", true),
    ]);

    const result = await toolApplyRules({ account: "agent@test.example.com" });
    expect(result.matched).toBe(1);
    expect(mockClient.markEmailRead).toHaveBeenCalledWith("e-1");
  });

  it("matches olderThanDays", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const newDate = new Date().toISOString();
    mockClient.listSystemEmails.mockResolvedValue([
      makeRuleEmail("r-1", "Old rule", { olderThanDays: 7 }, { delete: true }),
    ]);
    mockClient.listEmails.mockResolvedValue([
      makeEmailSummary("e-old", "a@b.com", "Old", false, oldDate),
      makeEmailSummary("e-new", "a@b.com", "New", false, newDate),
    ]);

    const result = await toolApplyRules({ account: "agent@test.example.com" });
    expect(result.matched).toBe(1);
    expect(mockClient.deleteEmail).toHaveBeenCalledWith("e-old");
  });

  it("applies first-match-wins (one rule per email)", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeRuleEmail("r-1", "Rule A", { from: "x@y.com" }, { moveTo: "FolderA" }),
      makeRuleEmail("r-2", "Rule B", { from: "x@y.com" }, { moveTo: "FolderB" }),
    ]);
    mockClient.listEmails.mockResolvedValue([
      makeEmailSummary("e-1", "x@y.com", "Hello"),
    ]);

    const result = await toolApplyRules({ account: "agent@test.example.com" });
    expect(result.matched).toBe(1);
    expect(mockClient.moveEmail).toHaveBeenCalledOnce();
    expect(mockClient.moveEmail).toHaveBeenCalledWith("e-1", "FolderA");
  });

  it("returns 0 matched when no rules exist", async () => {
    mockClient.listSystemEmails.mockResolvedValue([]);
    mockClient.listEmails.mockResolvedValue([makeEmailSummary("e-1", "a@b.com", "Hi")]);
    const result = await toolApplyRules({ account: "agent@test.example.com" });
    expect(result.matched).toBe(0);
  });

  it("records errors without throwing", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeRuleEmail("r-1", "Fail rule", { from: "bad@" }, { delete: true }),
    ]);
    mockClient.listEmails.mockResolvedValue([
      makeEmailSummary("e-1", "bad@sender.com", "oops"),
    ]);
    mockClient.deleteEmail.mockRejectedValue(new Error("JMAP error"));

    const result = await toolApplyRules({ account: "agent@test.example.com" });
    expect(result.matched).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("JMAP error");
  });
});
