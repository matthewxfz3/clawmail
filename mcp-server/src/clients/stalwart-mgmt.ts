import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function basicAuthHeader(): string {
  const credentials = `${config.stalwart.adminUser}:${config.stalwart.adminPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

async function stalwartFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${config.stalwart.url}${path}`;
  const headers = new Headers(options.headers as HeadersInit | undefined);
  headers.set("Authorization", basicAuthHeader());
  if (!headers.has("Content-Type") && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  // Use custom HTTPS agent for TLS certificate handling (allows self-signed certs if configured)
  const fetchOptions: any = { ...options, headers };
  if (config.stalwart.url.startsWith("https://")) {
    fetchOptions.dispatcher = config.stalwart.httpsAgent;
  }
  return fetch(url, fetchOptions);
}

async function assertOk(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch {
      body = "<unreadable body>";
    }
    throw new Error(
      `Stalwart API error (${context}): HTTP ${res.status} — ${body}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Default quota constant
// ---------------------------------------------------------------------------

const DEFAULT_QUOTA_BYTES = 1_073_741_824; // 1 GiB disk quota

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the mail domain principal exists in Stalwart.
 * Safe to call multiple times — silently ignores duplicate errors.
 */
export async function ensureDomainExists(domain: string = config.domain): Promise<void> {
  const res = await stalwartFetch("/api/principal", {
    method: "POST",
    body: JSON.stringify({ type: "domain", name: domain }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to ensure domain exists: HTTP ${res.status} — ${body}`);
  }
  const json: unknown = await res.json();
  // Stalwart returns HTTP 200 with {"error":"fieldAlreadyExists"} if the domain exists.
  if (
    json !== null &&
    typeof json === "object" &&
    "error" in json &&
    (json as { error: unknown }).error !== "fieldAlreadyExists"
  ) {
    throw new Error(`Failed to ensure domain exists: ${JSON.stringify(json)}`);
  }
}

/**
 * Create a new individual account in Stalwart.
 * Throws if an account with the given localPart already exists.
 */
export async function createAccount(
  localPart: string,
  domain: string = config.domain,
): Promise<{ email: string }> {
  await ensureDomainExists(domain);

  if (await accountExists(localPart)) {
    throw new Error(
      `Account already exists: ${localPart}@${domain}`,
    );
  }

  const email = `${localPart}@${domain}`;
  const body = JSON.stringify({
    type: "individual",
    name: localPart,
    description: email,
    emails: [email],
    quota: DEFAULT_QUOTA_BYTES,
    // Stalwart v0.15 requires this permission to accept inbound SMTP delivery.
    enabledPermissions: ["email-receive"],
  });

  const res = await stalwartFetch("/api/principal", {
    method: "POST",
    body,
  });

  await assertOk(res, `createAccount(${localPart})`);

  return { email };
}

/**
 * Permanently delete an account from Stalwart.
 */
export async function deleteAccount(localPart: string): Promise<void> {
  const res = await stalwartFetch(`/api/principal/${encodeURIComponent(localPart)}`, {
    method: "DELETE",
  });

  await assertOk(res, `deleteAccount(${localPart})`);

  // Stalwart returns HTTP 200 with {"error":"notFound"} if the account doesn't exist.
  const json: unknown = await res.json().catch(() => null);
  if (
    json !== null &&
    typeof json === "object" &&
    "error" in json
  ) {
    const err = (json as { error: unknown }).error;
    if (err === "notFound") {
      throw new Error(`Account not found: ${localPart}@${config.domain}`);
    }
    throw new Error(`Stalwart error deleting account: ${JSON.stringify(json)}`);
  }
}

/**
 * List all individual accounts managed by Stalwart.
 */
export async function listAccounts(): Promise<
  Array<{ name: string; email: string; description?: string }>
> {
  const res = await stalwartFetch(
    "/api/principal?type=individual&page=0&limit=100",
    { method: "GET" },
  );

  await assertOk(res, "listAccounts()");

  // Stalwart returns { data: { items: [...], total: N } } for paginated queries.
  const raw: unknown = await res.json();
  const data = (raw as { data?: unknown }).data;
  const items: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : Array.isArray((data as { items?: unknown } | undefined)?.items)
    ? ((data as { items: Array<Record<string, unknown>> }).items)
    : [];

  return items.map((item) => {
    // Try to get actual email from Stalwart response (stored in emails array)
    const storedEmails = item["emails"] as string[] | undefined;
    const email = storedEmails?.[0] ?? `${String(item["name"] ?? "")}@${config.domain}`;
    return {
      name: String(item["name"] ?? ""),
      email,
      description:
        item["description"] !== undefined
          ? String(item["description"])
          : undefined,
    };
  });
}

/**
 * Patch fields on an existing principal using Stalwart's PATCH endpoint.
 * Each operation is one of: { action: "set"|"addItem"|"removeItem", field, value }
 */
export async function patchAccount(
  localPart: string,
  operations: Array<{ action: "set" | "addItem" | "removeItem"; field: string; value: unknown }>,
): Promise<void> {
  const res = await stalwartFetch(`/api/principal/${encodeURIComponent(localPart)}`, {
    method: "PATCH",
    body: JSON.stringify(operations),
  });
  await assertOk(res, `patchAccount(${localPart})`);
  const json: unknown = await res.json().catch(() => null);
  if (json !== null && typeof json === "object" && "error" in json) {
    throw new Error(`Stalwart error patching account: ${JSON.stringify(json)}`);
  }
}

/**
 * Return true if an account with the given localPart exists.
 * Stalwart returns HTTP 200 with {"error":"notFound"} for missing principals.
 */
export async function accountExists(localPart: string): Promise<boolean> {
  const res = await stalwartFetch(
    `/api/principal/${encodeURIComponent(localPart)}`,
    { method: "GET" },
  );

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch {
      body = "<unreadable body>";
    }
    throw new Error(
      `Stalwart API error (accountExists(${localPart})): HTTP ${res.status} — ${body}`,
    );
  }

  const json: unknown = await res.json();
  // Stalwart returns HTTP 200 with {"error":"notFound"} when the principal doesn't exist.
  if (
    json !== null &&
    typeof json === "object" &&
    "error" in json &&
    (json as { error: unknown }).error === "notFound"
  ) {
    return false;
  }

  return true;
}
