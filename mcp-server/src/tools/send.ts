import { config } from "../config.js";

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

function validateAddressList(
  addresses: string[],
  fieldName: string,
): void {
  for (const addr of addresses) {
    if (!isValidEmail(addr)) {
      throw new Error(
        `Invalid email address in ${fieldName}: "${addr}"`,
      );
    }
  }
}

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// JMAP helpers (inline — avoids importing the full JmapClient which assumes
// accountId === email, whereas for send we drive everything ourselves)
// ---------------------------------------------------------------------------

function basicAuthHeader(): string {
  const credentials = `${config.stalwart.adminUser}:${config.stalwart.adminPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

interface JmapSession {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

type JmapMethodCall = [string, Record<string, unknown>, string];
type JmapMethodResponse = [string, Record<string, unknown>, string];

// Module-level session cache for send operations.
const sessionCache = new Map<string, JmapSession>();

async function getSession(accountId: string): Promise<JmapSession> {
  const cached = sessionCache.get(accountId);
  if (cached !== undefined) return cached;

  const wellKnownUrl = new URL("/.well-known/jmap", config.stalwart.url).toString();
  const res = await fetch(wellKnownUrl, {
    method: "GET",
    headers: { Authorization: basicAuthHeader(), Accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`JMAP session discovery failed: HTTP ${res.status} — ${body}`);
  }

  const data = (await res.json()) as { apiUrl?: string; primaryAccounts?: Record<string, string> };
  if (!data.apiUrl) throw new Error("JMAP session response missing apiUrl");

  const session: JmapSession = {
    apiUrl: data.apiUrl,
    primaryAccounts: data.primaryAccounts ?? {},
  };
  sessionCache.set(accountId, session);
  return session;
}

async function jmapRequest(
  accountId: string,
  calls: JmapMethodCall[],
): Promise<JmapMethodResponse[]> {
  const session = await getSession(accountId);

  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
      methodCalls: calls,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`JMAP request failed: HTTP ${res.status} — ${body}`);
  }

  const data = (await res.json()) as { methodResponses?: JmapMethodResponse[] };
  return data.methodResponses ?? [];
}

/** Get the JMAP mailbox ID for a named mailbox. */
async function getMailboxId(accountId: string, name: string): Promise<string | null> {
  const responses = await jmapRequest(accountId, [
    [
      "Mailbox/query",
      { accountId, filter: { name } },
      "mb1",
    ],
  ]);
  const r = responses.find(([, , id]) => id === "mb1");
  if (!r) return null;
  const ids = ((r[1] as { ids?: string[] }).ids) ?? [];
  return ids[0] ?? null;
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
  const localPart = fromEmail.split("@")[0];
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

  // The JMAP accountId for Stalwart is the full email address.
  const accountId = fromEmail;

  // --- Find Drafts mailbox ---
  const draftsId = await getMailboxId(accountId, "Drafts");
  if (!draftsId) {
    throw new Error(`Could not locate "Drafts" mailbox for account: ${accountId}`);
  }

  // --- Helper to build JMAP EmailAddress objects ---
  function toEmailAddress(addr: string): { email: string; name?: string } {
    const trimmed = addr.trim();
    // Handle "Name <email>" format.
    const match = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
    if (match) {
      return { name: match[1].trim(), email: match[2].trim() };
    }
    return { email: trimmed };
  }

  const queuedAt = new Date().toISOString();

  // --- Step 1: Create draft via Email/set ---
  const createCallId = "create1";
  const draftEmailKey = "draft1";

  const createCall: JmapMethodCall = [
    "Email/set",
    {
      accountId,
      create: {
        [draftEmailKey]: {
          mailboxIds: { [draftsId]: true },
          keywords: { $draft: true },
          from: [toEmailAddress(fromEmail)],
          to: toList.map(toEmailAddress),
          ...(cc.length > 0 ? { cc: cc.map(toEmailAddress) } : {}),
          ...(bcc.length > 0 ? { bcc: bcc.map(toEmailAddress) } : {}),
          subject,
          bodyValues: {
            bodyText: { value: body, charset: "utf-8" },
          },
          textBody: [
            {
              partId: "bodyText",
              type: "text/plain",
            },
          ],
        },
      },
    },
    createCallId,
  ];

  const createResponses = await jmapRequest(accountId, [createCall]);
  const createResponse = createResponses.find(([, , id]) => id === createCallId);

  if (!createResponse) {
    throw new Error("JMAP returned no response for draft Email/set");
  }

  const createResult = createResponse[1] as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, unknown>;
  };

  if (createResult.notCreated && Object.keys(createResult.notCreated).length > 0) {
    const details = JSON.stringify(createResult.notCreated[draftEmailKey] ?? createResult.notCreated);
    throw new Error(`Failed to create draft email: ${details}`);
  }

  const createdEmail = createResult.created?.[draftEmailKey];
  if (!createdEmail?.id) {
    throw new Error("JMAP Email/set create response missing email id");
  }
  const draftEmailId = createdEmail.id;

  // --- Step 2: Submit via EmailSubmission/set ---
  const submitCallId = "submit1";
  const submissionKey = "submission1";

  // Build the SMTP envelope recipients.
  const envelopeToList = [
    ...toList,
    ...cc,
    ...bcc,
  ].map((addr) => ({ email: toEmailAddress(addr).email }));

  const submitCall: JmapMethodCall = [
    "EmailSubmission/set",
    {
      accountId,
      create: {
        [submissionKey]: {
          emailId: draftEmailId,
          envelope: {
            mailFrom: { email: fromEmail },
            rcptTo: envelopeToList,
          },
        },
      },
      onSuccessDestroyEmail: [draftEmailId],
    },
    submitCallId,
  ];

  const submitResponses = await jmapRequest(accountId, [submitCall]);
  const submitResponse = submitResponses.find(([, , id]) => id === submitCallId);

  if (!submitResponse) {
    throw new Error("JMAP returned no response for EmailSubmission/set");
  }

  const submitResult = submitResponse[1] as {
    created?: Record<string, unknown>;
    notCreated?: Record<string, unknown>;
  };

  if (submitResult.notCreated && Object.keys(submitResult.notCreated).length > 0) {
    const details = JSON.stringify(submitResult.notCreated[submissionKey] ?? submitResult.notCreated);
    throw new Error(`Email submission failed: ${details}`);
  }

  const recipientCount = toList.length + cc.length + bcc.length;
  const toDisplay = toList.join(", ");

  return {
    message: `Email sent successfully from ${fromEmail} to ${toDisplay}` +
      (recipientCount > toList.length ? ` (and ${recipientCount - toList.length} more)` : ""),
    queued_at: queuedAt,
  };
}
