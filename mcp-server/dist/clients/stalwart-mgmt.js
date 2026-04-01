import { config } from "../config.js";
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function basicAuthHeader() {
    const credentials = `${config.stalwart.adminUser}:${config.stalwart.adminPassword}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
}
async function stalwartFetch(path, options = {}) {
    const url = `${config.stalwart.url}${path}`;
    const headers = new Headers(options.headers);
    headers.set("Authorization", basicAuthHeader());
    if (!headers.has("Content-Type") && options.body !== undefined) {
        headers.set("Content-Type", "application/json");
    }
    return fetch(url, { ...options, headers });
}
async function assertOk(res, context) {
    if (!res.ok) {
        let body;
        try {
            body = await res.text();
        }
        catch {
            body = "<unreadable body>";
        }
        throw new Error(`Stalwart API error (${context}): HTTP ${res.status} — ${body}`);
    }
}
// ---------------------------------------------------------------------------
// Default quota constants
// ---------------------------------------------------------------------------
const DEFAULT_QUOTA_MESSAGES = 10_000;
const DEFAULT_QUOTA_SIZE = 1_073_741_824; // 1 GiB
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Create a new individual account in Stalwart.
 * Throws if an account with the given localPart already exists.
 */
export async function createAccount(localPart) {
    if (await accountExists(localPart)) {
        throw new Error(`Account already exists: ${localPart}@${config.domain}`);
    }
    const body = JSON.stringify({
        type: "individual",
        name: localPart,
        description: `${localPart}@${config.domain}`,
        quota: {
            messages: DEFAULT_QUOTA_MESSAGES,
            size: DEFAULT_QUOTA_SIZE,
        },
    });
    const res = await stalwartFetch("/api/principal", {
        method: "POST",
        body,
    });
    await assertOk(res, `createAccount(${localPart})`);
    return { email: `${localPart}@${config.domain}` };
}
/**
 * Permanently delete an account from Stalwart.
 */
export async function deleteAccount(localPart) {
    const res = await stalwartFetch(`/api/principal/${encodeURIComponent(localPart)}`, {
        method: "DELETE",
    });
    await assertOk(res, `deleteAccount(${localPart})`);
}
/**
 * List all individual accounts managed by Stalwart.
 */
export async function listAccounts() {
    const res = await stalwartFetch("/api/principal?type=individual&page=0&limit=100", { method: "GET" });
    await assertOk(res, "listAccounts()");
    // Stalwart returns either a plain array or a paginated wrapper object.
    // Handle both shapes defensively.
    const raw = await res.json();
    const items = Array.isArray(raw)
        ? raw
        : (raw.data ?? []);
    return items.map((item) => ({
        name: String(item["name"] ?? ""),
        email: `${String(item["name"] ?? "")}@${config.domain}`,
        description: item["description"] !== undefined
            ? String(item["description"])
            : undefined,
    }));
}
/**
 * Return true if an account with the given localPart exists.
 */
export async function accountExists(localPart) {
    const res = await stalwartFetch(`/api/principal/${encodeURIComponent(localPart)}`, { method: "GET" });
    if (res.status === 404) {
        return false;
    }
    if (!res.ok) {
        let body;
        try {
            body = await res.text();
        }
        catch {
            body = "<unreadable body>";
        }
        throw new Error(`Stalwart API error (accountExists(${localPart})): HTTP ${res.status} — ${body}`);
    }
    return true;
}
//# sourceMappingURL=stalwart-mgmt.js.map