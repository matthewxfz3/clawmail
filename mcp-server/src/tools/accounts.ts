import { config } from "../config.js";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  accountExists,
} from "../clients/stalwart-mgmt.js";

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

export async function toolCreateAccount(
  localPart: string,
): Promise<{ email: string; message: string }> {
  validateLocalPart(localPart);

  const email = `${localPart}@${config.domain}`;

  // Throw if the account already exists (stalwart-mgmt also checks, but we
  // want a clear error message at this layer too).
  if (await accountExists(localPart)) {
    throw new Error(`Account already exists: ${email}`);
  }

  await createAccount(localPart);

  return {
    email,
    message: `Account created successfully: ${email}`,
  };
}

// ---------------------------------------------------------------------------
// Tool: delete_account
// ---------------------------------------------------------------------------

export async function toolDeleteAccount(
  localPart: string,
): Promise<{ message: string }> {
  validateLocalPart(localPart);

  const email = `${localPart}@${config.domain}`;

  if (!(await accountExists(localPart))) {
    throw new Error(`Account does not exist: ${email}`);
  }

  await deleteAccount(localPart);

  return {
    message: `Account deleted successfully: ${email}`,
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
