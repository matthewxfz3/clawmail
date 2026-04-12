# CLAUDE.md — Clawmail

This file is the entry point for AI agents contributing to this repo. Read it before touching any code.

---

## What this project is

Clawmail is an **MCP (Model Context Protocol) server** that gives AI agents email capabilities: create accounts, list/read/send/delete emails. It is deployed on GCP and wraps [Stalwart Mail Server](https://stalw.art) — an all-in-one SMTP+IMAP+JMAP server.

**The key insight:** agents don't interact with SMTP or IMAP directly. They call MCP tools (`create_account`, `send_email`, etc.), and the MCP server translates those into Stalwart's Management REST API + JMAP.

---

## Repo map

```
clawmail/
├── CLAUDE.md                    ← you are here
├── README.md                    ← user-facing overview
├── mcp-server/                  ← TypeScript MCP service (Cloud Run)
│   └── src/
│       ├── index.ts             ← HTTP server, auth middleware, rate limiter
│       ├── config.ts            ← all env vars in one place
│       ├── auth.ts              ← API key parsing, CallerIdentity, role-based authorization
│       ├── metrics.ts           ← in-memory tool call metrics
│       ├── dashboard.ts         ← web dashboard (overview, inboxes, metrics)
│       ├── clients/
│       │   ├── stalwart-mgmt.ts ← Stalwart Management REST API client
│       │   └── jmap.ts          ← JMAP client (mailbox read/search/delete)
│       ├── lib/
│       │   ├── errors.ts        ← structured error envelope
│       │   └── idempotency.ts   ← idempotency key cache
│       └── tools/
│           ├── accounts.ts      ← create_account, list_accounts, delete_account
│           ├── tokens.ts        ← token CRUD (createToken, resolveToken, revokeToken)
│           ├── mailbox.ts       ← list_emails, read_email, search_emails
│           ├── send.ts          ← send_email, reply, forward (via SendGrid SMTP)
│           ├── calendar.ts      ← manage_event, send/cancel/respond_to_invite
│           ├── configure.ts     ← configure_account settings
│           ├── contacts.ts      ← manage_contact
│           ├── drafts.ts        ← manage_draft
│           ├── filters.ts       ← manage_filter
│           ├── folders.ts       ← manage_folder
│           ├── labels.ts        ← update_email labels
│           ├── outreach.ts      ← manage_template, send_batch
│           ├── rules.ts         ← manage_rule
│           ├── spam.ts          ← classify_email, manage_sender_list
│           └── webhooks.ts      ← manage_webhook
├── stalwart/
│   ├── config.toml              ← Stalwart server config (env-var substitution)
│   └── docker-compose.yml       ← local dev stack (Stalwart + PostgreSQL)
├── infra/                       ← Terraform (GCP: Cloud Run, Cloud SQL, GCS, etc.)
│   ├── main.tf                  ← provider + variables
│   ├── cloudrun.tf              ← MCP server Cloud Run service + secrets
│   ├── compute.tf               ← Stalwart VM + firewall rules
│   ├── dns.tf                   ← Cloud DNS zone + MX/SPF/DMARC records
│   ├── sql.tf                   ← Cloud SQL PostgreSQL
│   ├── storage.tf               ← GCS bucket
│   ├── secrets.tf               ← Secret Manager secrets
│   └── artifact_registry.tf     ← Docker image registry
└── docs/
    ├── deployment-gcp.md        ← GCP deployment and monitoring guide
    ├── debugging-inbound-delivery.md ← inbound email debugging log
    └── planning/architecture.md ← original architecture plan (may be slightly stale)
```

---

## Two-layer authentication model

Clawmail uses **two independent auth layers**:

| Layer | Header / Param | Purpose |
|-------|---------------|---------|
| **Service auth** | `X-API-Key` header | Proves you are allowed to connect to this MCP endpoint. Shared across agents. |
| **Account auth** | `token` tool parameter | Per-account credential returned by `create_account`. Proves "I own this account." |

**Agent flow:**

```
1. Agent connects with X-API-Key in headers          (service auth)
2. Agent calls create_account({ local_part: "bot" })  (open to all authenticated callers)
3. Server returns { email: "bot@domain.com", token: "tok_abc..." }
4. Agent calls list_emails({ token: "tok_abc..." })    (no X-API-Key needed per tool)
5. Agent calls send_email({ token: "tok_abc...", to: "user@gmail.com", ... })
```

**Admin tokens** (`MCP_ADMIN_TOKENS` env var): comma-separated static tokens that work for any account and bypass all scoping. Treat like root credentials.

**Token storage**: persisted as JMAP emails in the `_tokens` system mailbox of the `clawmail-system@{domain}` service account. SHA-256 hashed — plaintext never stored. In-memory cache with 60-second TTL.

**`clawmail-system` account**: reserved system account used to store tokens. Do NOT delete it via `delete_account`.

---

## Non-obvious things you must know

### 1. Stalwart Management API returns HTTP 200 for errors

Stalwart's REST API (`/api/principal/...`) returns `HTTP 200` with a JSON error body for "not found" and "already exists" cases — **not** 4xx. Always check the JSON body:

```typescript
// ❌ Wrong — Stalwart always returns 200
if (res.status === 404) return null;

// ✅ Correct
const json = await res.json();
if (json?.error === "notFound") return null;
if (json?.error === "fieldAlreadyExists") return; // idempotent
```

See `stalwart-mgmt.ts` for all the patterns.

### 2. JMAP account IDs are opaque hashes, not email addresses

When you call JMAP (`/jmap/`), the `accountId` field is an internal opaque ID like `"e"` or `"d333333"` — **not** the user's email address. Passing an email as `accountId` causes a `{"type":"notRequest","detail":"trailing characters"}` error from Stalwart's JSON parser because `@` terminates its parsing.

Resolution flow (already implemented in `jmap.ts`):
1. Authenticate as admin → get JMAP session
2. Call `Principal/get` with the principals accountId (from `session.primaryAccounts["urn:ietf:params:jmap:principals"]`)
3. Find the principal whose `email` matches → use its `id` as the JMAP accountId
4. Cache per email to avoid repeated lookups

### 3. Admin JMAP session only sees admin's own account

When authenticated as admin, `/.well-known/jmap` only returns the admin's own mail account. Reading/writing other users' mailboxes requires resolving their account ID via the Principals API (see #2), then passing that ID to JMAP calls. The admin CAN access other accounts' mailboxes using their opaque ID — it just doesn't show up in the session automatically.

### 4. Email sending uses SendGrid SMTP, not JMAP

JMAP `EmailSubmission/set` requires the authenticated user to have an Identity object for the sender address. Admin can't create identities for other accounts' email addresses. So `send_email` uses **nodemailer → `smtp.sendgrid.net:587`** directly, bypassing Stalwart for outbound.

The `from` field in the email is set to the agent's address via `Reply-To`; the SMTP envelope uses a SendGrid-verified sender (`SENDGRID_VERIFIED_SENDER` env var).

### 5. MCP transport must be created per-request (stateless mode)

```typescript
// ❌ Wrong — causes "Transport already started" on 2nd request
const transport = new StreamableHTTPServerTransport(...); // module level
httpServer.on("request", (req, res) => transport.handleRequest(req, res, body));

// ✅ Correct — fresh server + transport per request
httpServer.on("request", async (req, res) => {
  const caller = authenticate(req, config);  // returns CallerIdentity
  const mcpServer = createMcpServer(caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
});
```

### 6. Stalwart config section names matter

- `[authentication.fallback-admin]` — admin credentials for the **HTTP Management API** (`/api/*`). This is what makes `curl -u admin:pass http://stalwart:8080/api/...` work.
- `[authentication.master]` — IMAP/SMTP **master user** impersonation (different feature). These are not interchangeable.

### 7. Stalwart quota is a flat integer, not an object

```typescript
// ❌ Wrong
quota: { messages: 10000, size: 1073741824 }

// ✅ Correct — u64 bytes
quota: 1073741824  // 1 GiB
```

### 8. Domain principal must exist before creating accounts

Creating an `individual` principal for `agent@domain.com` fails with `{"error":"notFound","item":"domain.com"}` if the domain principal doesn't exist. Call `ensureDomainExists()` first — it's idempotent (handles `fieldAlreadyExists`).

### 9. API key permission levels (admin vs user)

Each API key maps to a role via the `MCP_API_KEY_MAP` env var (JSON array):

```json
[
  { "key": "admin-key-abc", "role": "admin" },
  { "key": "user-key-xyz", "role": "user", "account": "agent@fridaymailer.com" }
]
```

- **admin**: full access to all tools and all accounts
- **user**: full mailbox access but only for their own bound account; cannot call `delete_account` or `list_accounts`; _can_ call `create_account` (open to all authenticated callers)

Authorization is enforced by `authorize()` in `src/auth.ts`, called at the top of every tool and resource handler in `index.ts`.

Backward compatible: if only `MCP_API_KEYS` is set (legacy comma-separated format), all keys are treated as admin. Dev mode (no keys set): open access as admin.

---

## Local development

```bash
# 1. Start Stalwart + PostgreSQL
cd stalwart
cp .env.example .env   # edit with real values
docker-compose up -d

# 2. Start MCP server
cd mcp-server
cp .env.example .env   # edit with real values
npm install
npm run dev            # runs on http://localhost:3000/mcp

# 3. Test a tool call
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}'
```

Note: the `X-API-Key` header is not required when `MCP_API_KEYS` is empty (dev mode).

---

## Deploying changes to Cloud Run

```bash
cd mcp-server
npm run build   # verify TypeScript compiles

# Build + push image
docker buildx build --platform linux/amd64 \
  -t us-west1-docker.pkg.dev/<PROJECT_ID>/clawmail/mcp-server:latest \
  --push .

# Deploy
gcloud run services update clawmail-mcp \
  --region us-west1 \
  --project <PROJECT_ID> \
  --image us-west1-docker.pkg.dev/<PROJECT_ID>/clawmail/mcp-server:latest
```

The live endpoint is available via `gcloud run services describe clawmail-mcp --region us-west1 --project $GCP_PROJECT --format 'value(status.url)'`.

---

## Key environment variables

| Variable | Where set | Purpose |
|----------|-----------|---------|
| `DOMAIN` | Cloud Run | Mail domain (e.g. `mail.example.com`) |
| `STALWART_URL` | Cloud Run | Internal URL to Stalwart JMAP/Management API |
| `STALWART_ADMIN_PASSWORD` | Secret Manager `stalwart-admin-password` | Stalwart HTTP Basic Auth |
| `SENDGRID_API_KEY` | Secret Manager `sendgrid-api-key` | SMTP password for `smtp.sendgrid.net` |
| `SENDGRID_VERIFIED_SENDER` | Cloud Run (plain env) | Verified FROM address for outbound email |
| `MCP_API_KEYS` | Secret Manager `mcp-api-key` | Comma-separated valid API keys (legacy — all treated as admin) |
| `MCP_API_KEY_MAP` | Secret Manager `mcp-api-key-map` | JSON array mapping keys to roles and accounts |
| `MCP_ADMIN_TOKENS` | Secret Manager (optional) | Comma-separated static admin tokens (bypass all account scoping; treat as root credentials) |

---

## GCP project

- **Project:** set in `GCP_PROJECT` env / Terraform variables
- **Region:** `us-west1`
- **Stalwart VM IP:** stored in Terraform state / GCE console (static IP reserved in `infra/compute.tf`)
- **Stalwart ports accessible:** `8080` (JMAP + Management API, VPC-internal + Cloud Run), `25` (inbound SMTP), `143`/`993` (IMAP)
- **Port 587 (SMTP submission):** NOT exposed in production docker-compose — outbound send goes via SendGrid directly from the MCP server instead

---

## Known limitations / future work

- **Spam filter:** Inbound emails may land in Junk Mail. SendGrid domain auth (DKIM/DMARC alignment) is now configured — spam scoring should improve. See `docs/debugging-inbound-delivery.md` for history.
- **Inbound SMTP testing:** Port 25 times out from residential IPs (ISP blocks) but works from external mail servers via the published MX record.
- **User JMAP auth:** Direct HTTP Basic Auth for regular accounts returns 401. Workaround implemented: master-user impersonation (`user*admin:pass`) in `jmap.ts` gives a session scoped to the target user.
- **Test coverage:** 220 unit and integration tests. Key test files: `auth.test.ts` (role-based authorization), `tokens.test.ts` (token CRUD), `accounts.test.ts` (account lifecycle and token cleanup), `stalwart-mgmt.test.ts`, `jmap.test.ts`, and `tests/e2e.test.ts` (all 26 tools, 3 resources, and authorization). Run with `cd mcp-server && npx vitest run`.
