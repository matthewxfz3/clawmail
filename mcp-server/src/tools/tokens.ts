import crypto, { timingSafeEqual } from "node:crypto";
import { JmapClient } from "../clients/jmap.js";
import { config } from "../config.js";
import { accountExists, ensureDomainExists } from "../clients/stalwart-mgmt.js";
import { createAccount } from "../clients/stalwart-mgmt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Local part of the dedicated system account used to store tokens. */
const SYSTEM_ACCOUNT_LOCAL = "clawmail-system";

const TOKENS_MAILBOX = "_tokens";
const TOKEN_PREFIX = "TOKEN:";

/** Token cache TTL. Revocations propagate within this window. */
const CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenEntry {
  /** Stable UUID — used for revocation */
  tokenId: string;
  /** SHA-256 hex of the plaintext token. Never returned to callers. */
  hash: string;
  /** Full email address the token grants access to, or "*" for admin tokens. */
  account: string;
  role: "admin" | "user";
  label?: string;
  createdAt: string;
}

export type TokenInfo = Omit<TokenEntry, "hash">;

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { entry: TokenEntry; loadedAt: number }>();

// ---------------------------------------------------------------------------
// System account — stores tokens in its _tokens mailbox
// ---------------------------------------------------------------------------

let systemAccountReady: Promise<void> | null = null;

export function systemEmail(): string {
  return `${SYSTEM_ACCOUNT_LOCAL}@${config.domain}`;
}

async function doEnsureSystemAccount(): Promise<void> {
  await ensureDomainExists();
  if (!(await accountExists(SYSTEM_ACCOUNT_LOCAL))) {
    await createAccount(SYSTEM_ACCOUNT_LOCAL);
    console.log(`[tokens] Created system account: ${systemEmail()}`);
  }
}

/**
 * Returns a JmapClient for the system account, creating the account if needed.
 * The creation is attempted only once per process lifetime; retried if it failed.
 */
export async function getSystemClient(): Promise<JmapClient> {
  if (systemAccountReady === null) {
    systemAccountReady = doEnsureSystemAccount().catch((err) => {
      // Allow retry on next call.
      systemAccountReady = null;
      throw err;
    });
  }
  await systemAccountReady;
  return new JmapClient(systemEmail());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

function generatePlaintext(): string {
  return "tok_" + crypto.randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Token CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new token for `account`.
 * Returns the plaintext token (shown **once**) and the stored entry (without plaintext).
 */
export async function createToken(
  account: string,
  role: "admin" | "user",
  label?: string,
): Promise<{ plaintext: string; info: TokenInfo }> {
  const plaintext = generatePlaintext();
  const hash = hashToken(plaintext);

  const entry: TokenEntry = {
    tokenId: crypto.randomUUID(),
    hash,
    account,
    role,
    label,
    createdAt: new Date().toISOString(),
  };

  const client = await getSystemClient();
  await client.createSystemEmail(
    TOKENS_MAILBOX,
    `${TOKEN_PREFIX}${entry.tokenId}`,
    JSON.stringify(entry, null, 2),
  );

  cache.set(hash, { entry, loadedAt: Date.now() });

  const { hash: _h, ...info } = entry;
  return { plaintext, info };
}

/**
 * Timing-safe check whether `candidate`'s hash matches any entry in
 * `precomputedHashes`. The caller is responsible for pre-computing the hashes
 * so this hot path never re-hashes stable values.
 *
 * All entries are always compared (no early exit on match) to prevent a
 * timing oracle leaking whether a match occurred in the first or last slot.
 */
function timingSafeTokenMatch(candidate: string, precomputedHashes: readonly Buffer[]): boolean {
  const candidateHash = Buffer.from(hashToken(candidate), "hex");
  let matched = false;
  for (const tHash of precomputedHashes) {
    if (timingSafeEqual(candidateHash, tHash)) matched = true;
  }
  return matched;
}

/**
 * Hashes of `config.auth.adminTokens`, computed exactly once on first access.
 * Admin tokens are static for the process lifetime so there is no need to
 * re-hash them on every `resolveToken` call.
 */
let _adminTokenHashes: Buffer[] | null = null;

function getAdminTokenHashes(): Buffer[] {
  if (_adminTokenHashes === null) {
    _adminTokenHashes = [...config.auth.adminTokens].map((t) =>
      Buffer.from(hashToken(t), "hex"),
    );
  }
  return _adminTokenHashes;
}

/**
 * Invalidates the pre-computed admin token hash cache.
 * **For testing only** — call this whenever the config mock's `adminTokens`
 * set is mutated between test cases.
 */
export function _resetAdminTokenHashCacheForTesting(): void {
  _adminTokenHashes = null;
}

/**
 * Look up a token by its plaintext value.
 * Returns the matching TokenEntry, or null if invalid / not found.
 *
 * Also checks static admin tokens configured via `MCP_ADMIN_TOKENS` using
 * a timing-safe comparison to prevent enumeration attacks.
 */
export async function resolveToken(plaintext: string): Promise<TokenEntry | null> {
  if (!plaintext) return null;

  // Static admin tokens from config (never stored, checked first for speed).
  // Uses timing-safe comparison — all entries are always compared.
  if (config.auth.adminTokens.size > 0 && timingSafeTokenMatch(plaintext, getAdminTokenHashes())) {
    return {
      tokenId: "static-admin",
      hash: "",
      account: "*",
      role: "admin",
      createdAt: "static",
    };
  }

  const hash = hashToken(plaintext);

  // Return from cache if fresh.
  const cached = cache.get(hash);
  if (cached !== undefined && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.entry;
  }

  // Reload tokens from JMAP and merge into cache.
  // We merge rather than clear to avoid evicting freshly created tokens that
  // haven't yet propagated to JMAP (write vs. list consistency window).
  // Explicitly revoked tokens are removed from cache immediately in revokeToken().
  try {
    const client = await getSystemClient();
    const items = await client.listSystemEmails(TOKENS_MAILBOX);
    const now = Date.now();
    const freshHashes = new Set<string>();

    for (const item of items) {
      if (!item.subject.startsWith(TOKEN_PREFIX)) continue;
      try {
        const e = JSON.parse(item.body) as TokenEntry;
        cache.set(e.hash, { entry: e, loadedAt: now });
        freshHashes.add(e.hash);
      } catch {
        // corrupt entry — skip
      }
    }

    // Evict entries no longer in JMAP that have also exceeded their TTL.
    // This handles tokens revoked by another process that already deleted them
    // from cache (cache.delete is called in revokeToken), plus any drift.
    for (const [h, c] of cache) {
      if (!freshHashes.has(h) && now - c.loadedAt >= CACHE_TTL_MS) {
        cache.delete(h);
      }
    }
  } catch (err) {
    console.warn("[tokens] Failed to reload tokens from JMAP:", err);
  }

  return cache.get(hash)?.entry ?? null;
}

/**
 * List tokens for an account (or all tokens if no account given).
 * Hash is never included in the returned objects.
 *
 * @param account  Optional email address to filter by (case-insensitive).
 * @param options.throwOnError  When true, propagates JMAP errors instead of
 *   swallowing them. Use this when a missing result would be misleading to the
 *   caller (e.g. during account deletion where an empty list means "skip cleanup").
 */
export async function listTokens(
  account?: string,
  options: { throwOnError?: boolean } = {},
): Promise<TokenInfo[]> {
  const { throwOnError = false } = options;
  try {
    const client = await getSystemClient();
    const items = await client.listSystemEmails(TOKENS_MAILBOX);
    const entries: TokenEntry[] = [];
    for (const item of items) {
      if (!item.subject.startsWith(TOKEN_PREFIX)) continue;
      try {
        entries.push(JSON.parse(item.body) as TokenEntry);
      } catch {
        // corrupt
      }
    }
    const filtered = account
      ? entries.filter((e) => e.account.toLowerCase() === account.toLowerCase())
      : entries;

    return filtered.map(({ hash: _h, ...info }) => info);
  } catch (err) {
    if (throwOnError) throw err;
    console.warn("[tokens] Failed to list tokens:", err);
    return [];
  }
}

/**
 * Revoke a token by its tokenId.
 * Returns true if found and deleted, false if the tokenId was not found.
 * Throws on JMAP / system errors so callers can distinguish "not found"
 * from a transient infrastructure failure.
 */
export async function revokeToken(tokenId: string): Promise<boolean> {
  const client = await getSystemClient();
  const items = await client.listSystemEmails(TOKENS_MAILBOX);
  for (const item of items) {
    if (!item.subject.startsWith(TOKEN_PREFIX)) continue;
    let entry: TokenEntry;
    try {
      entry = JSON.parse(item.body) as TokenEntry;
    } catch {
      // Corrupt entry — skip without aborting the scan.
      console.warn("[tokens] Skipping corrupt token entry:", item.id);
      continue;
    }
    if (entry.tokenId === tokenId) {
      await client.destroyEmail(item.id);
      cache.delete(entry.hash);
      return true;
    }
  }
  return false;
}
