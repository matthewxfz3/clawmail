import { config } from "../config.js";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  accountExists,
} from "../clients/stalwart-mgmt.js";
import { createToken, listTokens, revokeToken, type TokenInfo } from "./tokens.js";

/** Local parts that cannot be deleted — reserved for system use. */
const RESERVED_LOCAL_PARTS = new Set(["clawmail-system"]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A valid local-part is 1–64 characters, consisting of alphanumeric characters,
 * hyphens, and dots.  It must not start or end with a dot or hyphen.
 */
const LOCAL_PART_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.\-]{0,62}[a-zA-Z0-9])?$|^[a-zA-Z0-9]$/;

function validateLocalPart(localPart: string): void {
  if (localPart.length === 0) {
    throw new Error("local_part must not be empty");
  }
  if (localPart.length > 64) {
    throw new Error(
      `local_part must be at most 64 characters (got ${localPart.length})`,
    );
  }
  if (!LOCAL_PART_RE.test(localPart)) {
    throw new Error(
      "local_part must contain only alphanumeric characters, dots, or hyphens, " +
        "and must not start or end with a dot or hyphen",
    );
  }
}

// ---------------------------------------------------------------------------
// Tool: create_account
// ---------------------------------------------------------------------------

export interface CreateAccountResult {
  email: string;
  /** Plaintext token — shown once, not stored. Use this for all subsequent operations. */
  token: string;
  token_info: TokenInfo;
  message: string;
}

export async function toolCreateAccount(localPart: string): Promise<CreateAccountResult> {
  validateLocalPart(localPart);

  const email = `${localPart}@${config.domain}`;

  if (await accountExists(localPart)) {
    throw new Error(`Account already exists: ${email}`);
  }

  await createAccount(localPart);

  // Auto-generate a user-scoped token for the new account.
  const { plaintext, info } = await createToken(email, "user", `auto-created with account`);

  return {
    email,
    token: plaintext,
    token_info: info,
    message: `Account created: ${email}. Save the token — it is shown only once.`,
  };
}

// ---------------------------------------------------------------------------
// Tool: delete_account
// ---------------------------------------------------------------------------

export interface DeleteAccountResult {
  message: string;
  tokens_revoked: number;
  /** Present when the token store was unreachable during deletion.
   *  Existing tokens for this account may remain valid until the cache TTL expires. */
  token_revocation_warning?: string;
}

export async function toolDeleteAccount(localPart: string): Promise<DeleteAccountResult> {
  validateLocalPart(localPart);

  if (RESERVED_LOCAL_PARTS.has(localPart)) {
    throw new Error(`Cannot delete reserved system account: ${localPart}`);
  }

  const email = `${localPart}@${config.domain}`;

  if (!(await accountExists(localPart))) {
    throw new Error(`Account does not exist: ${email}`);
  }

  // Revoke all tokens for this account before deleting the mailbox so that
  // no dangling tokens remain valid after the account is gone.
  // We use throwOnError so a JMAP outage is surfaced as a warning rather than
  // silently returning an empty list and skipping revocation.
  let tokensRevoked = 0;
  let tokenRevocationWarning: string | undefined;

  try {
    const tokens = await listTokens(email, { throwOnError: true });
    for (const t of tokens) {
      try {
        const ok = await revokeToken(t.tokenId);
        if (ok) tokensRevoked++;
      } catch (err) {
        console.warn(`[accounts] Failed to revoke token ${t.tokenId} for ${email}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[accounts] Could not list tokens for ${email} — token revocation skipped:`, err);
    tokenRevocationWarning =
      "Token revocation could not be completed because the token store was unavailable. " +
      "Existing tokens for this account may remain valid for up to 60 seconds.";
  }

  await deleteAccount(localPart);

  return {
    message: `Account deleted successfully: ${email}`,
    tokens_revoked: tokensRevoked,
    ...(tokenRevocationWarning ? { token_revocation_warning: tokenRevocationWarning } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool: list_accounts
// ---------------------------------------------------------------------------

export async function toolListAccounts(): Promise<{
  accounts: Array<{ email: string; name: string }>;
  count: number;
}> {
  const raw = await listAccounts();

  const accounts = raw.map((a) => ({
    email: a.email,
    name: a.name,
  }));

  return {
    accounts,
    count: accounts.length,
  };
}
