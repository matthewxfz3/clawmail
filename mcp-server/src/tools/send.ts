import nodemailer from "nodemailer";
import { config } from "../config.js";
import { JmapClient } from "../clients/jmap.js";
import { randomUUID } from "node:crypto";
import { createDailyRoom, isDailyConfigured } from "../clients/daily.js";
import { createMeetSpace, isMeetConfigured } from "../clients/google-meet.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendEmailParams {
  fromAccount: string;
  to: string | string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// RFC 5322 simplified pattern: user@domain
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(addr: string): boolean {
  return EMAIL_RE.test(addr.trim());
}

function validateAddressList(addresses: string[], fieldName: string): void {
  for (const addr of addresses) {
    if (!isValidEmail(addr)) {
      throw new Error(`Invalid email address in ${fieldName}: "${addr}"`);
    }
  }
}

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// Reusable SMTP transporter (SendGrid relay)
// ---------------------------------------------------------------------------

let _transporter: nodemailer.Transporter | undefined;

function getTransporter(): nodemailer.Transporter {
  if (_transporter === undefined) {
    _transporter = nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      secure: false,
      auth: {
        user: "apikey",
        pass: config.sendgrid.apiKey,
      },
    });
  }
  return _transporter;
}

// ---------------------------------------------------------------------------
// Tool: send_email
// ---------------------------------------------------------------------------

export async function toolSendEmail(
  params: SendEmailParams,
): Promise<{ message: string; queued_at: string }> {
  const { fromAccount, to, subject, body, cc = [], bcc = [] } = params;

  // --- Validate from address ---
  const fromEmail = fromAccount.includes("@")
    ? fromAccount
    : `${fromAccount}@${config.domain}`;

  if (!isValidEmail(fromEmail)) {
    throw new Error(`Invalid from_account: "${fromAccount}"`);
  }

  // Ensure the sender belongs to our domain.
  const domain = fromEmail.split("@")[1];
  if (domain.toLowerCase() !== config.domain.toLowerCase()) {
    throw new Error(
      `from_account must belong to the configured domain "${config.domain}", got "${domain}"`,
    );
  }

  // --- Validate recipients ---
  const toList = Array.isArray(to) ? to : [to];
  validateAddressList(toList, "to");
  validateAddressList(cc, "cc");
  validateAddressList(bcc, "bcc");

  // --- Validate body size ---
  const bodySizeBytes = Buffer.byteLength(body, "utf8");
  if (bodySizeBytes > MAX_BODY_BYTES) {
    throw new Error(
      `Body exceeds maximum size of 1 MiB (got ${bodySizeBytes} bytes)`,
    );
  }

  // --- Validate subject ---
  if (!subject || subject.trim().length === 0) {
    throw new Error("subject must not be empty");
  }

  const queuedAt = new Date().toISOString();

  // SendGrid domain authentication covers all @domain addresses, so any agent
  // address can be used directly as From — no Reply-To relay needed.
  // Fall back to the verified sender only for addresses outside our domain.
  const fromDomain = fromEmail.split("@")[1].toLowerCase();
  const useVerifiedSender = fromDomain !== config.domain.toLowerCase();
  const VERIFIED_SENDER = config.sendgrid.verifiedSender;

  await getTransporter().sendMail({
    from: useVerifiedSender
      ? `"${fromEmail} via Clawmail" <${VERIFIED_SENDER}>`
      : fromEmail,
    replyTo: useVerifiedSender ? fromEmail : undefined,
    to: toList.join(", "),
    cc: cc.length > 0 ? cc.join(", ") : undefined,
    bcc: bcc.length > 0 ? bcc.join(", ") : undefined,
    subject,
    text: body,
  });

  // Save a copy to the sender's Sent folder via JMAP.
  // Fire-and-forget: don't fail the send if this errors.
  new JmapClient(fromEmail).saveToSent({
    from: fromEmail,
    to: toList,
    cc: cc.length > 0 ? cc : undefined,
    subject,
    body,
    sentAt: queuedAt,
  }).catch((err) => {
    console.warn(`[send] saveToSent failed for ${fromEmail}:`, err instanceof Error ? err.message : String(err));
  });

  const recipientCount = toList.length + cc.length + bcc.length;
  const toDisplay = toList.join(", ");

  return {
    message: `Email sent successfully from ${fromEmail} to ${toDisplay}` +
      (recipientCount > toList.length ? ` (and ${recipientCount - toList.length} more)` : ""),
    queued_at: queuedAt,
  };
}

// ---------------------------------------------------------------------------
// iCalendar helpers (RFC 5545)
// ---------------------------------------------------------------------------

function toICalDate(iso: string): string {
  // "2026-04-05T10:00:00.000Z" → "20260405T100000Z"
  return new Date(iso).toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
}

function icalEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function foldLine(line: string): string {
  // RFC 5545 §3.1: fold lines longer than 75 octets
  if (line.length <= 75) return line;
  const chunks: string[] = [line.slice(0, 75)];
  let i = 75;
  while (i < line.length) {
    chunks.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join("\r\n");
}

function buildIcs(params: {
  uid: string;
  organizer: string;
  attendees: string[];
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  createdAt: string;
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Clawmail//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    foldLine(`UID:${params.uid}`),
    foldLine(`DTSTART:${toICalDate(params.start)}`),
    foldLine(`DTEND:${toICalDate(params.end)}`),
    foldLine(`DTSTAMP:${toICalDate(params.createdAt)}`),
    foldLine(`SUMMARY:${icalEscape(params.title)}`),
    foldLine(`ORGANIZER;CN=${icalEscape(params.organizer)}:mailto:${params.organizer}`),
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
  ];

  for (const att of params.attendees) {
    lines.push(foldLine(`ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE;CN=${icalEscape(att)}:mailto:${att}`));
  }

  if (params.description) {
    lines.push(foldLine(`DESCRIPTION:${icalEscape(params.description)}`));
  }
  if (params.location) {
    lines.push(foldLine(`LOCATION:${icalEscape(params.location)}`));
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Tool: send_event_invite
// ---------------------------------------------------------------------------

export interface SendEventInviteParams {
  fromAccount: string;
  to: string | string[];
  title: string;
  start: string;   // ISO 8601
  end: string;     // ISO 8601
  description?: string;
  location?: string;
  /** Stable UID for this event — reuse the same UID when sending updates */
  uid?: string;
  /**
   * Explicit video URL to embed in the invite.
   * If omitted and DAILY_API_KEY is configured, a Daily.co room is auto-created.
   */
  video_url?: string;
}

export async function toolSendEventInvite(
  params: SendEventInviteParams,
): Promise<{ message: string; queued_at: string; uid: string; video_url: string | null }> {
  const { fromAccount, to, title, start, end, description, location } = params;

  // Resolve + validate from
  const fromEmail = fromAccount.includes("@")
    ? fromAccount
    : `${fromAccount}@${config.domain}`;

  if (!isValidEmail(fromEmail)) {
    throw new Error(`Invalid from_account: "${fromAccount}"`);
  }

  const domain = fromEmail.split("@")[1];
  if (domain.toLowerCase() !== config.domain.toLowerCase()) {
    throw new Error(
      `from_account must belong to the configured domain "${config.domain}", got "${domain}"`,
    );
  }

  // Validate dates
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (isNaN(startMs)) throw new Error(`start is not a valid ISO 8601 date-time: "${start}"`);
  if (isNaN(endMs))   throw new Error(`end is not a valid ISO 8601 date-time: "${end}"`);
  if (endMs <= startMs) throw new Error("end must be after start");

  if (!title.trim()) throw new Error("title must not be empty");

  const toList = Array.isArray(to) ? to : [to];
  validateAddressList(toList, "to");

  const uid = params.uid ?? `${randomUUID()}@${config.domain}`;
  const queuedAt = new Date().toISOString();

  // Resolve video URL — priority: explicit > Google Meet > Daily.co > none
  let resolvedLocation = params.video_url ?? params.location;
  if (!resolvedLocation) {
    if (isMeetConfigured()) {
      resolvedLocation = await createMeetSpace();
    } else if (isDailyConfigured()) {
      const roomName = `clawmail-${uid.split("@")[0].slice(0, 24)}`;
      resolvedLocation = await createDailyRoom({ name: roomName, expiresAt: end });
    }
  }

  // Build iCalendar payload
  const icsContent = buildIcs({
    uid,
    organizer: fromEmail,
    attendees: toList,
    title,
    start,
    end,
    description,
    location: resolvedLocation,
    createdAt: queuedAt,
  });

  // Human-readable body for non-calendar clients
  const textBody = [
    `You are invited to: ${title}`,
    `When: ${new Date(start).toUTCString()} – ${new Date(end).toUTCString()}`,
    resolvedLocation ? `Video call: ${resolvedLocation}` : "",
    description ? `\n${description}` : "",
    "",
    "This invitation is attached as a calendar file (.ics).",
  ].filter((l) => l !== undefined).join("\n").trim();

  const fromDomain2 = fromEmail.split("@")[1].toLowerCase();
  const useVerifiedSender = fromDomain2 !== config.domain.toLowerCase();
  const VERIFIED_SENDER = config.sendgrid.verifiedSender;

  await getTransporter().sendMail({
    from: useVerifiedSender
      ? `"${fromEmail} via Clawmail" <${VERIFIED_SENDER}>`
      : fromEmail,
    replyTo: useVerifiedSender ? fromEmail : undefined,
    to: toList.join(", "),
    subject: `Invitation: ${title}`,
    text: textBody,
    icalEvent: {
      method: "REQUEST",
      content: icsContent,
    },
    // Also attach as a downloadable .ics file for clients that don't inline-parse
    attachments: [
      {
        filename: "invite.ics",
        content: icsContent,
        contentType: "application/ics",
      },
    ],
  });

  return {
    message: `Calendar invite "${title}" sent from ${fromEmail} to ${toList.join(", ")}`,
    queued_at: queuedAt,
    uid,
    video_url: resolvedLocation ?? null,
  };
}
