<p align="center">
  <img src="assets/banner.png" alt="Claw Email" width="100%">
</p>

# Clawmail

> Give every AI agent its own email address — provisioned in seconds, managed via tool calls, ready for the real world.

An MCP (Model Context Protocol) service that gives AI agents a full email capability — create ad-hoc accounts, manage inboxes, send and receive mail — all via tool calls.

Built on [Stalwart Mail Server](https://stalw.art) (SMTP + IMAP + JMAP), deployed on Google Cloud Run, with Terraform-managed infrastructure.

---

## MCP Tool Reference

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_account` | `local_part: string` | Creates `{local_part}@{DOMAIN}`, returns the full address |
| `list_accounts` | — | Lists all accounts on the server |
| `delete_account` | `local_part: string` | Permanently removes an account |
| `list_emails` | `account`, `folder?`, `limit?` | Lists email summaries in inbox or named folder |
| `read_email` | `account`, `email_id` | Returns full email (headers + body) |
| `send_email` | `from_account`, `to`, `subject`, `body`, `cc?`, `bcc?` | Sends an email via the configured relay |
| `delete_email` | `account`, `email_id` | Moves email to trash |
| `search_emails` | `account`, `query` | Full-text search across inbox |

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

The `X-API-Key` value must match one of the keys in `CLAWMAIL_MCP_API_KEYS`.

---

## Prerequisites

You'll need these installed before running the deploy script:

| Tool | Install | Purpose |
|------|---------|---------|
| `gcloud` CLI | [cloud.google.com/sdk](https://cloud.google.com/sdk/docs/install) | Manage GCP resources |
| `terraform` ≥ 1.6 | [developer.hashicorp.com/terraform](https://developer.hashicorp.com/terraform/install) | Provision infrastructure |
| `docker` | [docs.docker.com](https://docs.docker.com/get-docker/) | Build the MCP server image |

You'll also need:

- A **GCP project** with billing enabled
- A **SendGrid account** (free tier works) — [sendgrid.com](https://sendgrid.com). GCP blocks outbound port 25, so a relay is required for sending email.
- A **domain name** you control, where agents will get addresses like `agent@yourdomain.com`

---

## Setup

### 1. Authenticate with GCP

```bash
gcloud auth login
gcloud auth application-default login
```

### 2. Configure the deployment

```bash
cp deploy/config.example.sh deploy/config.sh
```

Open `deploy/config.sh` and fill in every value:

```bash
# Your GCP project ID (find it at console.cloud.google.com)
export CLAWMAIL_GCP_PROJECT="your-gcp-project-id"
export CLAWMAIL_GCP_REGION="us-central1"
export CLAWMAIL_GCP_ZONE="us-central1-a"

# The domain agents get email addresses on
export CLAWMAIL_DOMAIN="mail.yourdomain.com"

# Stalwart admin password — used to manage accounts via REST API
export CLAWMAIL_STALWART_ADMIN_PASSWORD="$(openssl rand -hex 24)"

# PostgreSQL password for the Stalwart database user
export CLAWMAIL_DB_PASSWORD="$(openssl rand -hex 24)"

# SendGrid API key (username is always the literal "apikey")
# Get it at: sendgrid.com → Settings → API Keys → Create Key
export CLAWMAIL_SENDGRID_API_KEY="SG.your-key-here"

# One or more API keys for MCP callers (comma-separated)
export CLAWMAIL_MCP_API_KEYS="$(openssl rand -hex 32)"
```

> `deploy/config.sh` is in `.gitignore` — it will never be committed.

### 3. Deploy

```bash
./deploy/clawmail.sh deploy
```

The script runs four phases automatically:

| Phase | What happens |
|-------|-------------|
| **1 — Infrastructure** | Terraform provisions Cloud SQL, GCS bucket, Stalwart VM, Cloud DNS zone, Secret Manager secrets, Artifact Registry |
| **2 — Build image** | Compiles the TypeScript MCP server and pushes a Docker image to Artifact Registry |
| **3 — Cloud Run** | Deploys the MCP server on Cloud Run, wired to Secret Manager for credentials |
| **4 — Stalwart** | Uploads config to the VM, starts Stalwart via docker-compose |

The full deployment takes roughly 10–15 minutes on a fresh project (Cloud SQL provisioning is the slow part).

At the end, the script prints your MCP server URL and the DNS name servers to delegate your domain to.

### 4. Point your domain at Cloud DNS

The script outputs a set of name servers like:

```
ns-cloud-e1.googledomains.com.
ns-cloud-e2.googledomains.com.
ns-cloud-e3.googledomains.com.
ns-cloud-e4.googledomains.com.
```

Go to your domain registrar and update the name servers to these four. Once DNS propagates (up to 48 hours, usually under an hour), MX records take effect and inbound email will reach your Stalwart server.

### 5. Verify SendGrid sender identity

SendGrid requires a verified sender before it will relay email from your domain. Two options:

**Option A — Domain authentication (recommended for production)**
In the SendGrid dashboard: Settings → Sender Authentication → Authenticate Your Domain. Add the provided CNAME records to Cloud DNS:

```bash
gcloud dns record-sets create em1234.mail.yourdomain.com \
  --type=CNAME --ttl=300 --rrdatas=u1234567.wl.sendgrid.net. \
  --zone=clawmail --project=your-gcp-project-id
# (repeat for each CNAME SendGrid provides)
```

**Option B — Single Sender Verification (quick start)**
In the SendGrid dashboard: Settings → Sender Authentication → Verify a Single Sender. Verify any address you control, then set it in Cloud Run:

```bash
gcloud run services update clawmail-mcp \
  --region us-central1 \
  --project your-gcp-project-id \
  --set-env-vars SENDGRID_VERIFIED_SENDER=noreply@mail.yourdomain.com
```

---

## Checking system health

```bash
./deploy/clawmail.sh health
```

This checks every component and prints a status table:

```
══════════════════════════════════════════
  System health — Clawmail
══════════════════════════════════════════

  Compute Engine — Stalwart VM
  VM status: RUNNING                          OK
  Stalwart health endpoint                    OK
  Container: stalwart: running                OK

  Cloud Run — MCP Server
  Cloud Run service: READY                    OK
  MCP endpoint reachable (HTTP 405)           OK
       URL: https://clawmail-mcp-xxx.run.app/mcp

  Cloud SQL — PostgreSQL
  Cloud SQL instance: RUNNABLE                OK

  Cloud Storage — Attachments bucket
  GCS bucket accessible: gs://...             OK

  DNS — MX record propagation
  MX record found for mail.yourdomain.com     OK
  SPF record found                            OK
```

---

## Monitoring

### Cloud Run logs (MCP server)

```bash
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=clawmail-mcp" \
  --project=your-gcp-project-id \
  --limit=50 \
  --format="value(textPayload)"
```

Or in the Cloud Console: **Cloud Run → clawmail-mcp → Logs**

Useful filters:
```bash
# Only errors
--log-filter='severity>=ERROR'

# A specific MCP tool
--log-filter='textPayload:"send_email"'
```

### Stalwart logs (mail server)

```bash
gcloud compute ssh stalwart \
  --project=your-gcp-project-id \
  --zone=us-central1-a \
  --command="docker logs stalwart --tail=100 --follow"
```

### Cloud SQL metrics

In the Cloud Console: **SQL → clawmail → Overview** — shows CPU, connections, storage usage.

Set up a storage alert so you're notified before the disk fills:

```bash
# Alert when Cloud SQL storage exceeds 80%
gcloud alpha monitoring policies create \
  --notification-channels="" \
  --display-name="Clawmail SQL storage > 80%" \
  --condition-display-name="storage" \
  --condition-filter='resource.type="cloudsql_database" AND metric.type="cloudsql.googleapis.com/database/disk/utilization"' \
  --condition-threshold-value=0.8 \
  --condition-threshold-comparison=COMPARISON_GT \
  --project=your-gcp-project-id
```

---

## Stopping the service

```bash
./deploy/clawmail.sh stop
```

This scales Cloud Run to 0 instances and stops the Stalwart VM. **Cloud SQL and GCS are left running — no data is lost.** Monthly cost while stopped: ~$10–15 (Cloud SQL idle charge).

To restart after stopping:

```bash
# Start the VM
gcloud compute instances start stalwart \
  --project=your-gcp-project-id \
  --zone=us-central1-a

# Scale Cloud Run back up
gcloud run services update clawmail-mcp \
  --region=us-central1 \
  --project=your-gcp-project-id \
  --min-instances=0 \
  --max-instances=10
```

Or simply re-run `./deploy/clawmail.sh deploy` — Terraform is idempotent and will restore everything to the desired state.

---

## Destroying the service (full teardown)

> **Warning:** This deletes all data — email accounts, messages, attachments. It cannot be undone.

```bash
cd infra

terraform init \
  -backend-config="bucket=clawmail-tfstate-your-gcp-project-id" \
  -backend-config="prefix=terraform/state"

terraform destroy \
  -var-file=<(cat <<EOF
project_id       = "your-gcp-project-id"
region           = "us-central1"
zone             = "us-central1-a"
domain           = "mail.yourdomain.com"
stalwart_admin_password = "placeholder"
db_password      = "placeholder"
sendgrid_api_key = "placeholder"
mcp_api_key      = "placeholder"
mcp_server_image = "placeholder"
EOF
)
```

Terraform will list every resource it plans to delete and ask for confirmation. After destroy completes, delete the Terraform state bucket manually if you no longer need it:

```bash
gsutil rm -r gs://clawmail-tfstate-your-gcp-project-id
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
cp .env.example .env    # set STALWART_URL, STALWART_ADMIN_PASSWORD, SENDGRID_API_KEY
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

---

## Project structure

```
clawmail/
├── deploy/
│   ├── clawmail.sh          ← deployment script (deploy / health / stop)
│   └── config.example.sh    ← configuration template
├── infra/                   ← Terraform (GCP infrastructure)
├── stalwart/                ← Stalwart config + local docker-compose
├── mcp-server/              ← TypeScript MCP service (Cloud Run)
├── CLAUDE.md                ← guide for AI agents contributing to this repo
└── docs/planning/           ← architecture docs
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
