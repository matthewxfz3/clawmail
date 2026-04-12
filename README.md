<p align="center">
  <img src="assets/banner.png" alt="Claw Email" width="100%">
</p>

# Clawmail

> Give every AI agent its own email address — provisioned in seconds, managed via tool calls, ready for the real world.

An MCP (Model Context Protocol) service that gives AI agents a full email capability — create ad-hoc accounts, manage inboxes, send and receive mail — all via tool calls.

Built on [Stalwart Mail Server](https://stalw.art) (SMTP + IMAP + JMAP), deployed on Google Cloud Run, with Terraform-managed infrastructure.

---

## MCP Tool Reference

### Account management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_account` | `local_part` | Creates `{local_part}@{DOMAIN}`; returns the email address and a scoped `token` for all subsequent operations |
| `list_accounts` | — | Lists all accounts on the server (admin only) |
| `delete_account` | `local_part` | Permanently removes an account, revokes its tokens, and deletes all its mail (admin only) |
| `manage_token` | `action`, `account?`, `token_id?`, `label?` | Create, list, or revoke per-account tokens. Users can self-service their own tokens; admin can manage any account's tokens |

### Email

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_emails` | `account`, `folder?`, `limit?` | Lists email summaries in inbox or named folder |
| `read_email` | `account`, `email_id` | Returns full email (headers + body) |
| `send_email` | `from_account`, `to`, `subject`, `body`, `cc?`, `bcc?` | Sends an email via the configured relay |
| `delete_email` | `account`, `email_id` | Moves email to trash |
| `search_emails` | `account`, `query` | Full-text search across all folders |
| `mark_as_spam` | `account`, `email_id` | Moves email to Junk folder |
| `mark_as_not_spam` | `account`, `email_id` | Moves email from Junk back to Inbox |

### Calendar

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_event` | `account`, `title`, `start`, `end`, `description?`, `attendees?` | Creates a calendar event for an agent account |
| `list_events` | `account`, `from_date?`, `to_date?` | Lists events, optionally filtered by date range |
| `get_event` | `account`, `event_id` | Returns a single event by ID |
| `update_event` | `account`, `event_id`, `title?`, `start?`, `end?`, `description?`, `attendees?` | Updates fields on an existing event |
| `delete_event` | `account`, `event_id` | Deletes a calendar event |
| `check_availability` | `account`, `start`, `end` | Returns whether a time window is free of events |
| `send_event_invite` | `from_account`, `to`, `title`, `start`, `end`, `description?`, `location?`, `uid?`, `video_url?` | Sends an RFC 5545 calendar invite that auto-appears in Google Calendar, Outlook, and Apple Calendar. Auto-creates a Google Meet or Daily.co video room if configured. |

### Mailbox rules

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_rule` | `account`, `name`, `condition`, `action` | Creates a rule that matches emails by sender/subject/age and moves, marks, or deletes them |
| `list_rules` | `account` | Lists all rules for an account |
| `delete_rule` | `account`, `rule_id` | Deletes a rule by ID |
| `apply_rules` | `account`, `folder?` | Runs all rules against a folder and returns a summary of actions taken |

---

## Connecting to the MCP service

Add to your `mcp.json` or Claude Desktop config:

```json
{
  "mcpServers": {
    "clawmail": {
      "type": "http",
      "url": "https://<CLOUD_RUN_URL>/mcp",
      "headers": {
        "X-API-Key": "<your-api-key>"
      }
    }
  }
}
```

The `X-API-Key` value must match a key configured in `MCP_API_KEY_MAP` (or the legacy `MCP_API_KEYS`).

### Two-layer authentication

Clawmail uses two independent auth layers:

1. **Service auth** (`X-API-Key` header) — proves you are allowed to connect to this MCP endpoint. Set once in `mcp.json`.
2. **Account auth** (`token` tool parameter) — per-account credential returned by `create_account`. Proves "I own this account."

**Typical agent flow:**
```
1. Connect with X-API-Key in headers
2. Call create_account({ local_part: "my-agent" })
   → returns { email: "my-agent@domain.com", token: "tok_abc123..." }
3. Use the token for all subsequent operations:
   list_emails({ token: "tok_abc123..." })
   send_email({ token: "tok_abc123...", to: "...", ... })
```

The `token` parameter is accepted by every account-scoped tool (`list_emails`, `send_email`, `manage_contact`, etc.). The token encodes the bound account — no need to pass `account` separately.

### API key roles (legacy / admin path)

For operators who prefer static keys, configure `MCP_API_KEY_MAP`:

```json
[
  { "key": "admin-key-abc", "role": "admin" },
  { "key": "user-key-xyz", "role": "user", "account": "agent@yourdomain.com" }
]
```

| Role | Access |
|------|--------|
| **admin** | Full access to all tools and all accounts |
| **user** | Full mailbox access for their own bound account only; cannot delete or list accounts |

For backward compatibility, `MCP_API_KEYS` (comma-separated) still works — all keys are treated as admin.

**Admin tokens** (`MCP_ADMIN_TOKENS` env var): comma-separated static tokens that bypass all account scoping. Equivalent to an admin key but passed as a `token` parameter.

---

## Deploying to Google Cloud

See **[docs/deployment-gcp.md](docs/deployment-gcp.md)** for the full deployment guide, including:

- Prerequisites and one-time GCP setup
- Running the setup script
- DNS and SendGrid configuration
- Monitoring (dashboard, Cloud Run logs, Stalwart logs, alerts)
- Stopping, restarting, and full teardown

**Quick start:**

```bash
bash scripts/setup.sh
```

---

## Local development

No GCP account needed:

```bash
# Start Stalwart mail server + PostgreSQL
cd stalwart
cp .env.example .env    # set DOMAIN, DB_PASSWORD, STALWART_ADMIN_SECRET
docker-compose up -d

# Start MCP server
cd mcp-server
cp .env.example .env    # set STALWART_URL, STALWART_ADMIN_PASSWORD, SENDGRID_API_KEY, SENDGRID_VERIFIED_SENDER
npm install
npm run dev             # http://localhost:3000/mcp
```

Test a tool call (no API key required in dev mode when `MCP_API_KEYS` is empty):

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}'
```

Install the pre-commit hook to catch secrets before they're committed:

```bash
bash scripts/install-hooks.sh
```

---

## Project structure

```
clawmail/
├── scripts/
│   ├── setup.sh              ← full GCP setup (interactive)
│   ├── destroy.sh            ← full GCP teardown (double-confirmed)
│   └── hooks/pre-commit      ← secret scanner hook
├── infra/                    ← Terraform (GCP infrastructure)
├── stalwart/                 ← Stalwart config + local docker-compose
├── mcp-server/               ← TypeScript MCP service (Cloud Run)
│   └── src/
│       ├── index.ts          ← HTTP server, auth, rate limiter
│       ├── auth.ts           ← API key parsing, role-based authorization
│       ├── config.ts         ← environment variable config
│       ├── dashboard.ts      ← web dashboard
│       ├── clients/          ← Stalwart Management + JMAP clients
│       └── tools/            ← tool implementations (25 tools)
├── docs/
│   └── deployment-gcp.md    ← GCP deployment and monitoring guide
└── CLAUDE.md                 ← guide for AI agents contributing to this repo
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Email server | [Stalwart Mail Server](https://stalw.art) (SMTP + IMAP + JMAP) |
| MCP service | TypeScript + `@modelcontextprotocol/sdk` |
| Outbound relay | Twilio SendGrid (GCP blocks outbound port 25) |
| Database | Cloud SQL — PostgreSQL |
| Blob storage | GCS via S3 interop API |
| Secrets | GCP Secret Manager |
| DNS | Cloud DNS |
| IaC | Terraform |
| Container registry | Artifact Registry |
