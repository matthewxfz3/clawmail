# Claude Mail (Clawmail) — Architecture & Implementation Plan

## Confirmed Choices
- **Email scope**: External + internal (agents can email any address; Mailgun relay required)
- **Domain**: User has a domain ready — Phase 1 just needs DNS record configuration
- **MCP language**: TypeScript

---

## Context

Clawmail is a greenfield project to build an MCP (Model Context Protocol) service that provides email capabilities for AI agents, deployed on Google Cloud. The system needs to:
- Provision ad-hoc email accounts on a pre-configured domain (e.g., `agent-xyz@mail.clawmail.ai`)
- Manage inboxes programmatically
- Send and receive emails on behalf of agents
- Expose all this via the MCP protocol so any MCP-compatible AI agent can use it as a tool

The key challenge is GCP blocks outbound SMTP port 25, so we need a relay for sending. Inbound port 25 reception works fine.

---

## Recommended Open Source Stack

### Core Email Server: Stalwart Mail Server
**Why Stalwart over alternatives (Mailu, Mailcow, Postal, Haraka, Maddy):**
- All-in-one: SMTP + IMAP + **JMAP** in a single binary/container
- **Management REST API** for programmatic account creation (no web UI needed)
- **JMAP protocol** (RFC 8621) — JSON-based API designed for agent-driven mailbox access, unlike IMAP which requires persistent TCP connections
- Virtual users by design (no system accounts)
- PostgreSQL backend (Cloud SQL compatible)
- S3-compatible object storage (GCS works via its S3 interoperability layer)
- Actively maintained, Rust-based (performant, memory-safe)

### MCP Service Layer: TypeScript + `@modelcontextprotocol/sdk`
- Official Anthropic SDK, best support and documentation
- Streamable HTTP transport (2025 standard, supports Cloud Run)
- Cloud Run deployment: stateless, auth via Cloud IAM

### Outbound SMTP Relay: Mailgun (or SendGrid)
- GCP blocks outbound port 25 — this is non-negotiable
- Use Mailgun (port 587/2525) as the SMTP relay for sending external emails
- Stalwart can be configured to use Mailgun as its outbound relay

### Infrastructure
| Component | GCP Service |
|-----------|------------|
| Stalwart Mail Server | Compute Engine VM (stateful, needs persistent disk + static IP) |
| MCP Server | Cloud Run (stateless, auto-scales) |
| Email data store | Cloud SQL (PostgreSQL) |
| Blob storage (attachments) | GCS (via S3 interop API) |
| Secrets | Secret Manager |
| DNS & MX records | Cloud DNS |
| IaC | Terraform |

---

## System Architecture

```
Internet
  │
  ├── inbound SMTP (port 25) ──────────────────────────────────┐
  │                                                             ▼
  │                                              ┌─────────────────────────┐
  │                                              │   Stalwart Mail Server  │
  │                                              │   (Compute Engine VM)   │
  │                                              │                         │
  │                                              │  - SMTP (in: 25)        │
  │                                              │  - IMAP (143/993)       │
  │                                              │  - JMAP (HTTP/8080)     │
  │                                              │  - Mgmt REST API        │
  │                                              └─────────┬───────────────┘
  │                                                        │
  │                                                ┌───────▼────────┐
  │                                                │  Cloud SQL     │
  │                                                │  (PostgreSQL)  │
  │                                                └────────────────┘
  │
  ├── MCP Clients (AI Agents)
  │       │
  │       ▼ HTTP (Streamable HTTP / SSE)
  │  ┌─────────────────────────────┐
  │  │   MCP Server                │
  │  │   (Cloud Run, TypeScript)   │
  │  │                             │
  │  │  Tools:                     │
  │  │  - create_account           │
  │  │  - list_emails              │
  │  │  - read_email               │
  │  │  - send_email               │
  │  │  - delete_email             │
  │  │  - search_emails            │
  │  └──────────┬──────────────────┘
  │             │  Internal HTTP
  │             ▼
  │        Stalwart Mgmt API + JMAP
  │
  └── outbound SMTP ──► Mailgun relay (port 587) ──► External recipients
```

---

## Project Structure

```
clawmail/
├── infra/                   # Terraform IaC
│   ├── main.tf              # GCP provider, project config
│   ├── compute.tf           # Compute Engine VM for Stalwart
│   ├── sql.tf               # Cloud SQL PostgreSQL
│   ├── cloudrun.tf          # MCP server Cloud Run service
│   ├── dns.tf               # Cloud DNS zone, MX/SPF/DKIM/DMARC records
│   ├── storage.tf           # GCS bucket for attachments
│   └── secrets.tf           # Secret Manager secrets
│
├── stalwart/                # Stalwart configuration
│   ├── config.toml          # Main Stalwart config (domain, storage, relay)
│   └── docker-compose.yml   # Local dev / VM deployment
│
└── mcp-server/              # MCP service (TypeScript)
    ├── src/
    │   ├── index.ts         # MCP server entry point
    │   ├── tools/
    │   │   ├── accounts.ts  # create_account, list_accounts, delete_account
    │   │   ├── mailbox.ts   # list_emails, read_email, delete_email, search_emails
    │   │   └── send.ts      # send_email, reply_email
    │   ├── clients/
    │   │   ├── stalwart-mgmt.ts  # Stalwart Management REST API client
    │   │   └── jmap.ts           # JMAP client for mailbox operations
    │   └── config.ts        # Domain name, Stalwart URL, auth config
    ├── Dockerfile
    ├── package.json
    └── tsconfig.json
```

---

## Implementation Phases

### Phase 1: Infrastructure Setup
1. Terraform: GCP project, VPC, Cloud SQL (PostgreSQL), GCS bucket, Secret Manager
2. DNS: Cloud DNS zone, MX records → VM static IP, SPF/DMARC TXT records
3. Compute Engine VM: deploy Stalwart via Docker, configure PostgreSQL + GCS storage backend
4. Stalwart config: set pre-configured domain, configure Mailgun as outbound SMTP relay
5. Generate and publish DKIM keys via Stalwart API → add to Cloud DNS

### Phase 2: MCP Server
1. Init TypeScript project with `@modelcontextprotocol/sdk`
2. Implement `stalwart-mgmt.ts` client — wraps Stalwart's Management REST API
   - `POST /admin/principal` → create account
   - `DELETE /admin/principal/{name}` → delete account
   - `GET /admin/principal` → list accounts
3. Implement `jmap.ts` client — wraps Stalwart's JMAP endpoint
   - Session discovery: `GET /.well-known/jmap`
   - `Email/query`, `Email/get`, `Email/set` (for delete)
   - `EmailSubmission/set` (for send)
   - `Mailbox/get`, `Mailbox/query`
4. Implement MCP tools in `src/tools/`:
   - `create_account(local_part: string)` → returns `{local_part}@{DOMAIN}`
   - `list_emails(account, folder?, limit?)` → array of email summaries
   - `read_email(account, email_id)` → full email with body
   - `send_email(from_account, to, subject, body, cc?, bcc?)` → send result
   - `delete_email(account, email_id)` → success/failure
   - `search_emails(account, query)` → matching emails
5. Auth: API key passed via `X-API-Key` header, validated at MCP server → forward to Stalwart

### Phase 3: Cloud Run Deployment
1. Dockerfile for MCP server (Node.js 22 slim base)
2. Cloud Run service config: env vars from Secret Manager, internal VPC for Stalwart access
3. IAM: Cloud Run Invoker role for authenticated access
4. Wire env vars: `STALWART_URL`, `STALWART_API_KEY`, `DOMAIN`, `MAILGUN_*` from Secret Manager

---

## Domain Pre-Configuration

The domain (e.g. `mail.clawmail.ai`) is set once in `config.ts` and `config.toml`.

Required DNS records (one-time setup via Terraform):
```
mail.clawmail.ai.     MX  10  stalwart.clawmail.ai.
mail.clawmail.ai.     TXT "v=spf1 include:mailgun.org ~all"
mail._domainkey.mail.clawmail.ai.  TXT "<stalwart-generated-dkim-key>"
_dmarc.mail.clawmail.ai.  TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@mail.clawmail.ai"
stalwart.clawmail.ai. A   <static-ip>
```

---

## Key GCP Constraints & Mitigations

| Constraint | Mitigation |
|-----------|-----------|
| GCP blocks outbound port 25 | Mailgun SMTP relay via port 587 |
| Cloud Run is stateless (no persistent queue) | Stalwart handles SMTP queue on Compute Engine persistent disk |
| GCS is not native email storage | Use GCS via S3 interop only for blobs; PostgreSQL for mail index |
| Port 25 firewall for inbound | Open port 25 on Compute Engine VM firewall rule (inbound only) |

---

## Verification

1. **Local dev**: Run Stalwart + PostgreSQL via `docker-compose` in `stalwart/`, test Management API with `curl`
2. **Unit tests**: Jest tests for each MCP tool (`src/tools/*.test.ts`), mock Stalwart API responses
3. **Integration test**: Spin up Stalwart in CI, call MCP tools end-to-end:
   - Create account → verify via Management API
   - Send email to newly created account → verify via JMAP list_emails
   - Read email → verify body matches
4. **Cloud Run smoke test**: Deploy MCP server, call it with MCP Inspector or a test client
5. **Live email test**: Use `swaks` (SMTP testing tool) to send inbound email to VM, verify inbox via MCP `list_emails` tool

---

## Open Source Projects Summary

| Project | Role | URL |
|---------|------|-----|
| Stalwart Mail Server | All-in-one SMTP/IMAP/JMAP email server | https://stalw.art |
| @modelcontextprotocol/sdk | MCP server framework (TypeScript) | https://github.com/modelcontextprotocol/typescript-sdk |
| Terraform Google Provider | GCP infrastructure as code | https://registry.terraform.io/providers/hashicorp/google |
| node-mailjet or nodemailer | Optional fallback email sending library | npm |

---

## Security & Reliability

### Rate Limiting

Prevent any single agent account from flooding outbound SMTP or overwhelming the server.

**Two-layer approach:**
1. **Stalwart built-in throttling** — configure per-account send limits in `config.toml`:
   ```toml
   [queue.throttle]
   rate = "100/1h"          # max 100 outbound messages per hour per account
   concurrency = 5          # max 5 simultaneous outbound connections per account
   ```
2. **MCP server middleware** — add a rate-limiter (e.g., `@upstash/ratelimit` backed by Redis/Firestore) at the tool call level:
   - `send_email`: max 20 calls/minute per API key
   - `create_account`: max 10 calls/hour per API key (prevent account flooding)
   - `list_emails` / `read_email`: max 200 calls/minute per API key (lighter, but still bounded)
   - Return HTTP 429 with a `Retry-After` header on violation

Cloud Run itself can also be configured with `--max-instances` to cap total concurrency across all callers.

---

### Storage Limits

Prevent unbounded storage growth from large attachments or runaway inboxes.

**Stalwart per-account quotas** — set in `config.toml` or via Management API at account creation time:
```toml
[quota]
messages = 10000     # max messages per mailbox
size = 1073741824    # 1 GB per account
```
When creating an account via MCP, always pass a `quotaMessages` and `quotaSize` value — never create an unlimited account.

**Attachment size cap** — enforce at the MCP `send_email` tool level before passing to Stalwart:
- Reject requests where total attachment size exceeds a configurable `MAX_ATTACHMENT_BYTES` env var (default: 25 MB, matching Gmail's limit)
- Return a descriptive error: `"Attachment exceeds maximum size of 25 MB"`

**GCS bucket lifecycle policy** — add a Terraform-managed lifecycle rule to the attachments bucket:
- Delete objects older than 90 days (configurable)
- Prevents orphaned attachments from accumulating

**Cloud SQL storage alert** — set a Cloud Monitoring alert if Cloud SQL disk usage exceeds 80% to catch growth early.

---

### Authentication & Authorization

Ensure only legitimate callers can invoke MCP tools, and that they can only act on accounts they own.

**Layer 1 — Cloud Run IAM (infrastructure level)**
- Cloud Run service set to `--no-allow-unauthenticated`
- Callers must present a valid Google-signed OIDC token with the `Cloud Run Invoker` role
- Managed entirely by GCP; no code required

**Layer 2 — API Key (application level)**
- Every MCP call must include `X-API-Key: <key>` header
- Keys are provisioned by the operator and stored in Secret Manager
- The MCP server validates the key on every request before forwarding to Stalwart
- Keys are scoped: each key maps to an allowed set of accounts (e.g., key `k1` can only access `agent-xyz@domain`)
- Key-to-scope mapping stored in Cloud Firestore or a small Cloud SQL table

**Layer 3 — Account ownership enforcement (tool level)**
- `list_emails(account, ...)`, `read_email(account, ...)`, `send_email(from_account, ...)`, etc. all take an `account` parameter
- The MCP server checks: does the caller's API key have access to this account? If not → HTTP 403
- This prevents key `k1` from reading key `k2`'s inbox even if both keys are valid

**Stalwart API key** — the MCP server authenticates to Stalwart using a single service-level API key stored in Secret Manager. Stalwart never exposes its API directly to external clients.

**Credential rotation** — Secret Manager versioning allows key rotation without downtime. The MCP server reads the current version on startup (or per request for critical secrets).

---

## Post-Build Validation Checklist

A sequential smoke test to confirm the full system is wired up correctly after deployment.

### 1. Infrastructure health
- [ ] `curl https://<MCP_CLOUD_RUN_URL>/` returns HTTP 200 (MCP server is up)
- [ ] `curl -u admin:<pass> http://<STALWART_VM_IP>:8080/api/health` returns `{"type":"Ok"}` (Stalwart is up)
- [ ] Cloud SQL connection: `psql` from VM succeeds with Cloud SQL credentials
- [ ] GCS bucket accessible: `gsutil ls gs://<bucket>` succeeds

### 2. Account management (via MCP tool)
- [ ] Call `create_account("smoke-test")` → account `smoke-test@<DOMAIN>` created
- [ ] Call `create_account("smoke-test")` again → returns a clear error (duplicate)
- [ ] Stalwart Admin API confirms account exists: `GET /admin/principal/smoke-test`

### 3. Inbound email (receiving)
- [ ] Send a test email to `smoke-test@<DOMAIN>` using `swaks`:
  ```
  swaks --to smoke-test@<DOMAIN> --from test@external.com \
        --server <STALWART_VM_IP> --port 25 \
        --header "Subject: Smoke Test" --body "Hello from swaks"
  ```
- [ ] Call MCP `list_emails("smoke-test@<DOMAIN>")` → returns the swaks email
- [ ] Call MCP `read_email("smoke-test@<DOMAIN>", <email_id>)` → body contains "Hello from swaks"

### 4. Outbound email (sending)
- [ ] Call MCP `send_email(from="smoke-test@<DOMAIN>", to="<a real address you control>", subject="Clawmail smoke test", body="It works!")`
- [ ] Verify the email arrives at the real address
- [ ] Check Mailgun dashboard for delivery confirmation and no bounce

### 5. Inbox management
- [ ] Call MCP `delete_email("smoke-test@<DOMAIN>", <email_id>)` → success
- [ ] Call MCP `list_emails("smoke-test@<DOMAIN>")` → deleted email no longer present
- [ ] Call MCP `search_emails("smoke-test@<DOMAIN>", "smoke")` → returns correct results

### 6. Cleanup
- [ ] Delete the test account (or leave for manual inspection)
- [ ] Review Stalwart logs on VM for any errors during the test run

---

## Future Work

### Dashboard UI

Build a lightweight web dashboard for operators to monitor and inspect the service.

**Metrics panel**
- Active account count and recent account creation activity
- Email volume over time (inbound vs. outbound)
- Send success/failure rate (pulled from SendGrid event webhooks or Cloud Run logs)
- Cloud Run request latency and error rate
- Cloud SQL storage utilization

**Inbox visualization**
- List all accounts with message counts and last-activity timestamps
- Drill into any account's inbox: subject, from, received time, preview
- Read full email body inline
- Delete emails or accounts directly from the UI

**Tech considerations**
- Could be a simple static SPA (React or plain HTML + JS) served from Cloud Run or GCS + Cloud CDN
- Auth: same `X-API-Key` header passed from a login screen, or Cloud IAP for Google-identity gating
- Data source: calls the existing MCP server HTTP API, or a new thin REST API alongside it
- Alternatively, embed directly in the MCP server as an additional route (`GET /dashboard`) to avoid a separate deployment
