# Clawmail

An MCP (Model Context Protocol) service that gives AI agents a full email capability — create ad-hoc accounts, manage inboxes, send and receive mail — all via tool calls.

Built on [Stalwart Mail Server](https://stalw.art) (SMTP + IMAP + JMAP) and deployed on Google Cloud Run, with Terraform-managed infrastructure.

---

## MCP Tool Reference

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_account` | `local_part: string` | Creates `{local_part}@{DOMAIN}`, returns the full address |
| `list_emails` | `account`, `folder?`, `limit?` | Lists email summaries in inbox or named folder |
| `read_email` | `account`, `email_id` | Returns full email (headers + body) |
| `send_email` | `from_account`, `to`, `subject`, `body`, `cc?`, `bcc?` | Sends an email via the configured relay |
| `delete_email` | `account`, `email_id` | Moves email to trash |
| `search_emails` | `account`, `query` | Full-text search across inbox |

---

## Connecting

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

---

## Domain Configuration

The mail domain (e.g. `mail.clawmail.ai`) is pre-configured at deploy time via the `DOMAIN` environment variable. Agents pick only the local part — the domain is fixed.

All accounts share the domain: `create_account("agent-xyz")` → `agent-xyz@mail.clawmail.ai`.

---

## Authentication

Every request requires an `X-API-Key` header. Keys are provisioned by the operator and stored in GCP Secret Manager. Each key is scoped to specific accounts — a key for `agent-a` cannot read `agent-b`'s inbox.

Cloud Run also enforces GCP IAM (`Cloud Run Invoker` role) as an additional layer.

---

## Local Development

No GCP account needed for local dev:

```bash
# Start Stalwart mail server + PostgreSQL
cd stalwart && docker-compose up

# Start MCP server (points at local Stalwart)
cd mcp-server && npm install && npm run dev
```

MCP server will be available at `http://localhost:3000/mcp`.

---

## Project Structure

```
clawmail/
├── docs/
│   └── planning/            # Architecture & planning docs
├── infra/                   # Terraform IaC (GCP)
├── stalwart/                # Stalwart config & local docker-compose
└── mcp-server/              # TypeScript MCP service
```

See [`docs/planning/`](docs/planning/) for the full architecture plan.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Email server | [Stalwart Mail Server](https://stalw.art) (SMTP + IMAP + JMAP) |
| MCP service | TypeScript + `@modelcontextprotocol/sdk` |
| Outbound relay | Mailgun (GCP blocks port 25) |
| Database | Cloud SQL (PostgreSQL) |
| Blob storage | GCS via S3 interop |
| Secrets | GCP Secret Manager |
| DNS | Cloud DNS |
| IaC | Terraform |
