import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";
import { validateTimezone } from "../lib/timezone.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  eventId: string;
  title: string;
  start: string;  // ISO 8601
  end: string;    // ISO 8601
  description?: string;
  attendees?: string[];
  timezone?: string;  // IANA timezone name (e.g. "America/Los_Angeles"), defaults to UTC
  createdAt: string;
}

// The JMAP mailbox used to store calendar events as structured emails.
const CALENDAR_MAILBOX = "_calendar";

// Subject prefix so system emails are clearly identifiable.
const SUBJECT_PREFIX = "CAL:";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveAccount(account: string): string {
  return account.includes("@") ? account : `${account}@${config.domain}`;
}

function encodeSubject(eventId: string, title: string): string {
  // Embed eventId in subject for lookup without fetching body.
  // Format: "CAL:<eventId>:<title>" — colons in title are safe (we split on first two only)
  return `${SUBJECT_PREFIX}${eventId}:${title}`;
}

function parseSubject(subject: string): { eventId: string; title: string } | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;
  const rest = subject.slice(SUBJECT_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  return { eventId: rest.slice(0, colonIdx), title: rest.slice(colonIdx + 1) };
}

function validateIso(value: string, fieldName: string): void {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new Error(`${fieldName} is not a valid ISO 8601 date-time: "${value}"`);
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function toolCreateEvent(params: {
  account: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  attendees?: string[];
  timezone?: string;
}): Promise<{ event: CalendarEvent; message: string }> {
  const { account, title, start, end, description, attendees, timezone } = params;

  if (!title.trim()) throw new Error("title must not be empty");
  validateIso(start, "start");
  validateIso(end, "end");
  if (new Date(end) <= new Date(start)) throw new Error("end must be after start");
  if (timezone) validateTimezone(timezone);

  const email = resolveAccount(account);
  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const event: CalendarEvent = { eventId, title, start, end, description, attendees, timezone, createdAt };
  const body = JSON.stringify(event, null, 2);
  const subject = encodeSubject(eventId, title);

  const client = new JmapClient(email);
  await client.createSystemEmail(CALENDAR_MAILBOX, subject, body);

  return { event, message: `Event "${title}" created for ${email}` };
}

export async function toolListEvents(params: {
  account: string;
  from_date?: string;
  to_date?: string;
}): Promise<{ events: CalendarEvent[]; count: number }> {
  const { account, from_date, to_date } = params;

  if (from_date) validateIso(from_date, "from_date");
  if (to_date) validateIso(to_date, "to_date");

  const email = resolveAccount(account);
  const client = new JmapClient(email);
  const items = await client.listSystemEmails(CALENDAR_MAILBOX);

  let events: CalendarEvent[] = [];
  for (const item of items) {
    if (!item.subject.startsWith(SUBJECT_PREFIX)) continue;
    try {
      const ev = JSON.parse(item.body) as CalendarEvent;
      events.push(ev);
    } catch {
      // corrupt body — skip
    }
  }

  // Filter by date range if provided
  if (from_date) {
    const from = new Date(from_date).getTime();
    events = events.filter((e) => new Date(e.end).getTime() >= from);
  }
  if (to_date) {
    const to = new Date(to_date).getTime();
    events = events.filter((e) => new Date(e.start).getTime() <= to);
  }

  // Sort chronologically
  events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return { events, count: events.length };
}

export async function toolGetEvent(params: {
  account: string;
  event_id: string;
}): Promise<CalendarEvent> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const items = await client.listSystemEmails(CALENDAR_MAILBOX);

  for (const item of items) {
    const parsed = parseSubject(item.subject);
    if (parsed?.eventId === params.event_id) {
      return JSON.parse(item.body) as CalendarEvent;
    }
  }
  throw new Error(`Event not found: ${params.event_id}`);
}

export async function toolUpdateEvent(params: {
  account: string;
  event_id: string;
  title?: string;
  start?: string;
  end?: string;
  description?: string;
  attendees?: string[];
  timezone?: string;
}): Promise<{ event: CalendarEvent; message: string }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const items = await client.listSystemEmails(CALENDAR_MAILBOX);

  let emailId: string | undefined;
  let existing: CalendarEvent | undefined;
  for (const item of items) {
    const parsed = parseSubject(item.subject);
    if (parsed?.eventId === params.event_id) {
      emailId = item.id;
      existing = JSON.parse(item.body) as CalendarEvent;
      break;
    }
  }
  if (!emailId || !existing) throw new Error(`Event not found: ${params.event_id}`);

  // Validate timezone if provided
  if (params.timezone) validateTimezone(params.timezone);

  // Merge updates
  const updated: CalendarEvent = {
    ...existing,
    title:       params.title       ?? existing.title,
    start:       params.start       ?? existing.start,
    end:         params.end         ?? existing.end,
    description: params.description ?? existing.description,
    attendees:   params.attendees   ?? existing.attendees,
    timezone:    params.timezone    ?? existing.timezone,
  };

  if (params.start) validateIso(updated.start, "start");
  if (params.end)   validateIso(updated.end,   "end");
  if (new Date(updated.end) <= new Date(updated.start)) throw new Error("end must be after start");

  // Permanently destroy old record, create new one
  await client.destroyEmail(emailId);
  const subject = encodeSubject(updated.eventId, updated.title);
  await client.createSystemEmail(CALENDAR_MAILBOX, subject, JSON.stringify(updated, null, 2));

  return { event: updated, message: `Event "${updated.title}" updated` };
}

export async function toolDeleteEvent(params: {
  account: string;
  event_id: string;
}): Promise<{ message: string }> {
  const email = resolveAccount(params.account);
  const client = new JmapClient(email);
  const items = await client.listSystemEmails(CALENDAR_MAILBOX);

  for (const item of items) {
    const parsed = parseSubject(item.subject);
    if (parsed?.eventId === params.event_id) {
      await client.destroyEmail(item.id);
      return { message: `Event ${params.event_id} deleted` };
    }
  }
  throw new Error(`Event not found: ${params.event_id}`);
}

export async function toolCheckAvailability(params: {
  account: string;
  start: string;
  end: string;
}): Promise<{ available: boolean; conflicts: CalendarEvent[] }> {
  validateIso(params.start, "start");
  validateIso(params.end,   "end");
  if (new Date(params.end) <= new Date(params.start)) throw new Error("end must be after start");

  const { events } = await toolListEvents({ account: params.account });
  const reqStart = new Date(params.start).getTime();
  const reqEnd   = new Date(params.end).getTime();

  const conflicts = events.filter((e) => {
    const evStart = new Date(e.start).getTime();
    const evEnd   = new Date(e.end).getTime();
    // Overlap: events overlap if one starts before the other ends
    return evStart < reqEnd && evEnd > reqStart;
  });

  return { available: conflicts.length === 0, conflicts };
}
