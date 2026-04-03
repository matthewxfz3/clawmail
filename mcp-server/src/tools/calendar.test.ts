import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { domain: "test.example.com" },
}));

const mockClient = vi.hoisted(() => ({
  createSystemEmail: vi.fn(),
  listSystemEmails: vi.fn(),
  deleteEmail: vi.fn(),
}));

vi.mock("../clients/jmap.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  JmapClient: vi.fn(function () { return mockClient; } as any),
}));

import {
  toolCreateEvent,
  toolListEvents,
  toolGetEvent,
  toolUpdateEvent,
  toolDeleteEvent,
  toolCheckAvailability,
} from "./calendar.js";

const FUTURE_START = "2030-06-01T10:00:00Z";
const FUTURE_END   = "2030-06-01T11:00:00Z";

function makeEventEmail(eventId: string, title: string, start = FUTURE_START, end = FUTURE_END) {
  const event = { eventId, title, start, end, createdAt: "2026-01-01T00:00:00Z" };
  return {
    id: `email-${eventId}`,
    subject: `CAL:${eventId}:${title}`,
    body: JSON.stringify(event),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.createSystemEmail.mockResolvedValue("new-email-id");
  mockClient.listSystemEmails.mockResolvedValue([]);
  mockClient.deleteEmail.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("toolCreateEvent", () => {
  it("creates event and returns it", async () => {
    const result = await toolCreateEvent({
      account: "agent@test.example.com",
      title: "Team sync",
      start: FUTURE_START,
      end: FUTURE_END,
    });
    expect(result.event.title).toBe("Team sync");
    expect(result.event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockClient.createSystemEmail).toHaveBeenCalledOnce();
    const [mailbox, subject, body] = mockClient.createSystemEmail.mock.calls[0];
    expect(mailbox).toBe("_calendar");
    expect(subject).toContain("CAL:");
    expect(JSON.parse(body).title).toBe("Team sync");
  });

  it("rejects when end is before start", async () => {
    await expect(toolCreateEvent({
      account: "agent@test.example.com",
      title: "Bad event",
      start: FUTURE_END,
      end: FUTURE_START,
    })).rejects.toThrow("end must be after start");
  });

  it("rejects invalid ISO date", async () => {
    await expect(toolCreateEvent({
      account: "agent@test.example.com",
      title: "Bad",
      start: "not-a-date",
      end: FUTURE_END,
    })).rejects.toThrow("not a valid ISO 8601");
  });

  it("rejects empty title", async () => {
    await expect(toolCreateEvent({
      account: "agent@test.example.com",
      title: "  ",
      start: FUTURE_START,
      end: FUTURE_END,
    })).rejects.toThrow("title must not be empty");
  });
});

// ---------------------------------------------------------------------------
describe("toolListEvents", () => {
  it("returns empty list when no events", async () => {
    mockClient.listSystemEmails.mockResolvedValue([]);
    const { events, count } = await toolListEvents({ account: "agent@test.example.com" });
    expect(events).toEqual([]);
    expect(count).toBe(0);
  });

  it("parses and returns events sorted by start", async () => {
    const e1 = makeEventEmail("id-1", "First", "2030-06-02T10:00:00Z", "2030-06-02T11:00:00Z");
    const e2 = makeEventEmail("id-2", "Second", "2030-06-01T10:00:00Z", "2030-06-01T11:00:00Z");
    mockClient.listSystemEmails.mockResolvedValue([e1, e2]);

    const { events } = await toolListEvents({ account: "agent@test.example.com" });
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe("Second"); // earlier start
    expect(events[1].title).toBe("First");
  });

  it("filters by from_date", async () => {
    const past = makeEventEmail("id-old", "Old", "2030-05-01T10:00:00Z", "2030-05-01T11:00:00Z");
    const future = makeEventEmail("id-new", "New", "2030-07-01T10:00:00Z", "2030-07-01T11:00:00Z");
    mockClient.listSystemEmails.mockResolvedValue([past, future]);

    const { events } = await toolListEvents({ account: "agent@test.example.com", from_date: "2030-06-01T00:00:00Z" });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("New");
  });

  it("filters by to_date", async () => {
    const early = makeEventEmail("id-early", "Early", "2030-05-01T10:00:00Z", "2030-05-01T11:00:00Z");
    const late = makeEventEmail("id-late", "Late", "2030-08-01T10:00:00Z", "2030-08-01T11:00:00Z");
    mockClient.listSystemEmails.mockResolvedValue([early, late]);

    const { events } = await toolListEvents({ account: "agent@test.example.com", to_date: "2030-06-01T00:00:00Z" });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Early");
  });

  it("skips emails with corrupt body", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      { id: "x", subject: "CAL:bad-id:Broken", body: "not-json" },
    ]);
    const { events } = await toolListEvents({ account: "agent@test.example.com" });
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("toolGetEvent", () => {
  it("returns the event matching the given id", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeEventEmail("abc-123", "My Meeting"),
    ]);
    const event = await toolGetEvent({ account: "agent@test.example.com", event_id: "abc-123" });
    expect(event.eventId).toBe("abc-123");
    expect(event.title).toBe("My Meeting");
  });

  it("throws when event not found", async () => {
    mockClient.listSystemEmails.mockResolvedValue([]);
    await expect(toolGetEvent({ account: "agent@test.example.com", event_id: "missing" }))
      .rejects.toThrow("Event not found: missing");
  });
});

// ---------------------------------------------------------------------------
describe("toolUpdateEvent", () => {
  it("updates event title and timestamps", async () => {
    const original = makeEventEmail("ev-1", "Original");
    mockClient.listSystemEmails.mockResolvedValue([original]);

    const result = await toolUpdateEvent({
      account: "agent@test.example.com",
      event_id: "ev-1",
      title: "Updated",
      start: "2030-06-01T12:00:00Z",
      end: "2030-06-01T13:00:00Z",
    });

    expect(result.event.title).toBe("Updated");
    expect(result.event.start).toBe("2030-06-01T12:00:00Z");
    expect(mockClient.deleteEmail).toHaveBeenCalledWith("email-ev-1");
    expect(mockClient.createSystemEmail).toHaveBeenCalledOnce();
  });

  it("throws when event not found", async () => {
    mockClient.listSystemEmails.mockResolvedValue([]);
    await expect(toolUpdateEvent({ account: "a@test.example.com", event_id: "nope" }))
      .rejects.toThrow("Event not found");
  });
});

// ---------------------------------------------------------------------------
describe("toolDeleteEvent", () => {
  it("deletes the matching event email", async () => {
    mockClient.listSystemEmails.mockResolvedValue([makeEventEmail("del-1", "To Delete")]);
    const result = await toolDeleteEvent({ account: "agent@test.example.com", event_id: "del-1" });
    expect(result.message).toContain("del-1");
    expect(mockClient.deleteEmail).toHaveBeenCalledWith("email-del-1");
  });

  it("throws when event not found", async () => {
    mockClient.listSystemEmails.mockResolvedValue([]);
    await expect(toolDeleteEvent({ account: "a@test.example.com", event_id: "nope" }))
      .rejects.toThrow("Event not found");
  });
});

// ---------------------------------------------------------------------------
describe("toolCheckAvailability", () => {
  it("returns available=true when no conflicts", async () => {
    mockClient.listSystemEmails.mockResolvedValue([]);
    const result = await toolCheckAvailability({
      account: "agent@test.example.com",
      start: "2030-07-01T10:00:00Z",
      end: "2030-07-01T11:00:00Z",
    });
    expect(result.available).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("returns conflict when events overlap", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeEventEmail("c-1", "Conflict", "2030-07-01T09:30:00Z", "2030-07-01T10:30:00Z"),
    ]);
    const result = await toolCheckAvailability({
      account: "agent@test.example.com",
      start: "2030-07-01T10:00:00Z",
      end: "2030-07-01T11:00:00Z",
    });
    expect(result.available).toBe(false);
    expect(result.conflicts).toHaveLength(1);
  });

  it("returns no conflict for adjacent events", async () => {
    mockClient.listSystemEmails.mockResolvedValue([
      makeEventEmail("c-1", "Before", "2030-07-01T09:00:00Z", "2030-07-01T10:00:00Z"),
    ]);
    const result = await toolCheckAvailability({
      account: "agent@test.example.com",
      start: "2030-07-01T10:00:00Z",
      end: "2030-07-01T11:00:00Z",
    });
    expect(result.available).toBe(true);
  });
});
