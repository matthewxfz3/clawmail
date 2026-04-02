import nodemailer from "nodemailer";
import { config } from "../config.js";
import { JmapClient } from "../clients/jmap.js";

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

  // SendGrid requires a verified sender identity.
  // Set SENDGRID_VERIFIED_SENDER to a verified address; the agent address
  // is placed in Reply-To so recipients can reply correctly.
  const VERIFIED_SENDER = config.sendgrid.verifiedSender;
  const useVerifiedSender = fromEmail.toLowerCase() !== VERIFIED_SENDER.toLowerCase();

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
