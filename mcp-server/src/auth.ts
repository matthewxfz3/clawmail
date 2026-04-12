import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallerRole = "admin" | "user";

export interface CallerIdentity {
  apiKey: string;
  role: CallerRole;
  account?: string; // full email, required when role === "user"
}

// ---------------------------------------------------------------------------
// API key map parsing
// ---------------------------------------------------------------------------

const ApiKeyEntrySchema = z.discriminatedUnion("role", [
  z.object({ key: z.string().min(1), role: z.literal("admin") }),
  z.object({
    key: z.string().min(1),
    role: z.literal("user"),
    account: z.string().email("account must be a valid email for user keys"),
  }),
]);

/**
 * Parse the MCP_API_KEY_MAP JSON string into a Map<apiKey, CallerIdentity>.
 * Returns an empty map for empty/whitespace-only input.
 */
export function parseApiKeyMap(raw: string): Map<string, CallerIdentity> {
  const map = new Map<string, CallerIdentity>();
  if (!raw.trim()) return map;

  const parsed = JSON.parse(raw);
  const entries = z.array(ApiKeyEntrySchema).parse(parsed);

  for (const entry of entries) {
    if (map.has(entry.key)) {
      throw new Error(`Duplicate API key in MCP_API_KEY_MAP: "${entry.key}"`);
    }
    const identity: CallerIdentity = {
      apiKey: entry.key,
      role: entry.role,
    };
    if (entry.role === "user") {
      identity.account = entry.account;
    }
    map.set(entry.key, identity);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Account normalization
// ---------------------------------------------------------------------------

export function normalizeAccount(accountOrLocal: string, domain: string): string {
  return accountOrLocal.includes("@") ? accountOrLocal : `${accountOrLocal}@${domain}`;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

// create_account is intentionally absent — any authenticated caller may create
// an account (and receives a scoped token in the response).
//
// manage_token is intentionally absent — its handler implements its own inline
// authorization that allows users to manage their own tokens. Putting it here
// would block user-role callers from self-service token operations.
const ADMIN_ONLY_TOOLS = new Set([
  "delete_account",
  "list_accounts",
]);

/**
 * Check whether `caller` is allowed to invoke `toolName` against `targetAccount`.
 * Returns null if allowed, or a CallToolResult error object if denied.
 */
export function authorize(
  caller: CallerIdentity,
  toolName: string,
  targetAccount?: string,
): CallToolResult | null {
  if (caller.role === "admin") return null;

  if (ADMIN_ONLY_TOOLS.has(toolName)) {
    return {
      content: [{ type: "text", text: `Permission denied: "${toolName}" requires admin privileges.` }],
      isError: true,
    };
  }

  if (!targetAccount) {
    return {
      content: [{ type: "text", text: "Permission denied: no target account specified." }],
      isError: true,
    };
  }

  if (!caller.account) {
    return {
      content: [{ type: "text", text: "Permission denied: user key has no bound account." }],
      isError: true,
    };
  }

  if (targetAccount.toLowerCase() !== caller.account.toLowerCase()) {
    return {
      content: [{ type: "text", text: "Permission denied: you can only access your own account." }],
      isError: true,
    };
  }

  return null;
}
