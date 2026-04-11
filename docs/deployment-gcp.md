# Deploying Clawmail on Google Cloud

This guide covers everything needed to provision, deploy, monitor, and tear down Clawmail on GCP.

---

## Prerequisites

| Tool | Install | Purpose |
|------|---------|---------|
| `gcloud` CLI | [cloud.google.com/sdk](https://cloud.google.com/sdk/docs/install) | Manage GCP resources |
| `terraform` ≥ 1.6 | [developer.hashicorp.com/terraform](https://developer.hashicorp.com/terraform/install) | Provision infrastructure |
| `docker` | [docs.docker.com](https://docs.docker.com/get-docker/) | Build the MCP server image |
| `jq` | `brew install jq` / `apt install jq` | Used by setup script |

You'll also need:

- A **GCP project** with billing enabled
- A **SendGrid account** with a verified sender address — [sendgrid.com](https://sendgrid.com). GCP blocks outbound port 25, so a relay is required for sending.
- A **domain name** you control (e.g. `mail.yourdomain.com`) where agents get addresses like `agent@mail.yourdomain.com`

---

## First-time setup

### 1. Authenticate with GCP

```bash
gcloud auth login
gcloud auth application-default login
```

### 2. Run the setup script

```bash
bash scripts/setup.sh
```

The script prompts for all required values interactively (no config file needed), then runs five phases:

| Phase | What happens |
|-------|-------------|
| **1 — Infrastructure** | Terraform provisions Cloud SQL, GCS bucket, Stalwart VM, Cloud DNS zone, Secret Manager secrets, Artifact Registry |
| **2 — Read outputs** | Reads the Stalwart VM IP and Cloud Run URL from Terraform state |
| **3 — Build & push image** | Compiles the TypeScript MCP server and pushes a Docker image to Artifact Registry |
| **4 — Cloud Run deploy** | Deploys the MCP server on Cloud Run |
| **5 — Smoke test** | Waits for Stalwart to boot, creates and deletes a test account, verifies the MCP endpoint |

Full deployment takes roughly 10–15 minutes on a fresh project (Cloud SQL provisioning is the slow part).

### 3. Point your domain at Cloud DNS

After Terraform runs, get the name servers assigned to your Cloud DNS zone:

```bash
gcloud dns managed-zones describe clawmail \
  --project=YOUR_PROJECT_ID \
  --format="value(nameServers)"
```

Go to your domain registrar and update the name servers to the four values printed. DNS propagation typically takes under an hour (up to 48 hours in the worst case). Once it propagates, the MX record takes effect and inbound email will reach your Stalwart server.

### 4. Verify SendGrid sender identity

SendGrid requires a verified sender before it will relay email. Two options:

**Option A — Domain authentication (recommended)**

In the SendGrid dashboard: *Settings → Sender Authentication → Authenticate Your Domain*. Add the provided CNAME records to Cloud DNS:

```bash
gcloud dns record-sets create em1234.mail.yourdomain.com \
  --type=CNAME --ttl=300 \
  --rrdatas=u1234567.wl.sendgrid.net. \
  --zone=clawmail \
  --project=YOUR_PROJECT_ID
# Repeat for each CNAME SendGrid provides (usually 3)
```

Then set the verified sender address in Cloud Run:

```bash
gcloud run services update clawmail-mcp \
  --region=us-west1 \
  --project=YOUR_PROJECT_ID \
  --set-env-vars SENDGRID_VERIFIED_SENDER=noreply@mail.yourdomain.com
```

**Option B — Single Sender Verification (quick start)**

In the SendGrid dashboard: *Settings → Sender Authentication → Verify a Single Sender*. Verify any address you control, then set it in Cloud Run using the same command above.

---

## Configuring API key permissions

Clawmail supports two API key roles: **admin** (full access) and **user** (scoped to one account). Keys are configured via the `MCP_API_KEY_MAP` secret in Secret Manager.

### Creating the key map

Generate keys and build a JSON array:

```bash
ADMIN_KEY=$(openssl rand -hex 32)
USER_KEY=$(openssl rand -hex 32)

cat <<EOF
[
  { "key": "$ADMIN_KEY", "role": "admin" },
  { "key": "$USER_KEY", "role": "user", "account": "agent@yourdomain.com" }
]
EOF
```

### Storing in Secret Manager

```bash
# Create the secret (first time)
echo -n '<JSON_ARRAY>' | gcloud secrets create mcp-api-key-map \
  --data-file=- --project=YOUR_PROJECT_ID

# Update an existing secret
echo -n '<JSON_ARRAY>' | gcloud secrets versions add mcp-api-key-map \
  --data-file=- --project=YOUR_PROJECT_ID
```

Grant the Cloud Run service account access:

```bash
gcloud secrets add-iam-policy-binding mcp-api-key-map \
  --project=YOUR_PROJECT_ID \
  --member="serviceAccount:clawmail-mcp-run@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Wiring to Cloud Run

```bash
gcloud run services update clawmail-mcp \
  --region=us-west1 \
  --project=YOUR_PROJECT_ID \
  --update-secrets=MCP_API_KEY_MAP=mcp-api-key-map:latest
```

If you're using Terraform, `infra/cloudrun.tf` and `infra/secrets.tf` already have `mcp-api-key-map` wired up — just set the `mcp_api_key_map` Terraform variable.

> **Backward compatibility:** If only `MCP_API_KEYS` is set (comma-separated keys, no JSON), all keys are treated as admin. Dev mode (no keys set) allows open access.

---

## Redeploying after code changes

```bash
cd mcp-server
npm run build

# Build and push the updated image (option A: local Docker)
docker buildx build --platform linux/amd64 \
  -t us-west1-docker.pkg.dev/YOUR_PROJECT_ID/clawmail/mcp-server:latest \
  --push .

# Build and push the updated image (option B: Cloud Build — no local Docker needed)
gcloud builds submit --tag=us-west1-docker.pkg.dev/YOUR_PROJECT_ID/clawmail/mcp-server:latest \
  --project=YOUR_PROJECT_ID --region=us-west1

# Deploy
gcloud run services update clawmail-mcp \
  --region=us-west1 \
  --project=YOUR_PROJECT_ID \
  --image=us-west1-docker.pkg.dev/YOUR_PROJECT_ID/clawmail/mcp-server:latest
```

---

## Monitoring

### Dashboard

The built-in dashboard is the easiest way to see system health at a glance:

```
https://YOUR_CLOUD_RUN_URL/dashboard
```

It requires the dashboard password set during setup (`DASHBOARD_PASSWORD`). The dashboard has three tabs:

| Tab | What it shows |
|-----|--------------|
| **Overview** | MCP connect snippet, system status (Stalwart, DNS, SendGrid), active account count |
| **Inboxes** | All agent accounts with inbox/sent counts; click any account to browse emails |
| **Metrics** | Tool call counts, error rates, process uptime, memory usage |

### Cloud Run logs (MCP server)

```bash
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=clawmail-mcp" \
  --project=YOUR_PROJECT_ID \
  --limit=50 \
  --format="value(textPayload)"
```

Or in the console: **Cloud Run → clawmail-mcp → Logs**

Useful filters:
```bash
# Only errors
--log-filter='severity>=ERROR'

# Watch a specific tool
--log-filter='textPayload:"send_email"'

# Live tail
gcloud beta run services logs tail clawmail-mcp \
  --region=us-west1 \
  --project=YOUR_PROJECT_ID
```

### Stalwart logs (mail server on the VM)

```bash
# Get the VM name
VM=$(gcloud compute instances list \
  --project=YOUR_PROJECT_ID \
  --filter="tags.items=clawmail-stalwart" \
  --format="value(name)" | head -1)

# Follow logs
gcloud compute ssh "$VM" \
  --project=YOUR_PROJECT_ID \
  --zone=us-west1-a \
  --command="docker logs stalwart --tail=100 --follow"
```

Key things to watch in Stalwart logs:
- `SMTP session` lines — inbound delivery attempts
- `queue` lines — outbound relay status
- `auth` errors — misconfigured credentials

### Cloud SQL metrics

In the console: **SQL → clawmail → Overview** — shows CPU, connections, and storage.

Set up a storage alert to catch disk pressure early:

```bash
gcloud alpha monitoring policies create \
  --display-name="Clawmail SQL storage > 80%" \
  --condition-filter='resource.type="cloudsql_database" AND metric.type="cloudsql.googleapis.com/database/disk/utilization"' \
  --condition-threshold-value=0.8 \
  --condition-threshold-comparison=COMPARISON_GT \
  --project=YOUR_PROJECT_ID
```

### Key metrics to watch

| Signal | Where to check | Alert threshold |
|--------|---------------|----------------|
| MCP error rate | Cloud Run → Metrics → Request count (5xx) | > 1% of requests |
| Cloud Run latency | Cloud Run → Metrics → Request latency (p99) | > 5s |
| Stalwart VM disk | Compute Engine → VM → Monitoring | > 80% |
| Cloud SQL storage | SQL → Overview | > 80% |
| Cloud SQL connections | SQL → Connections | > 80 active |
| GCS bucket size | GCS → Bucket → Monitoring | Set lifecycle policy |

---

## Stopping the service (preserving data)

Scale Cloud Run to zero and stop the VM — no data is lost. Cloud SQL and GCS continue running.

```bash
# Stop the VM
gcloud compute instances stop INSTANCE_NAME \
  --project=YOUR_PROJECT_ID \
  --zone=us-west1-a

# Scale Cloud Run to zero
gcloud run services update clawmail-mcp \
  --region=us-west1 \
  --project=YOUR_PROJECT_ID \
  --min-instances=0 \
  --max-instances=0
```

Monthly cost while stopped: ~$10–15 (Cloud SQL idle charge).

To restart, start the VM and set `--min-instances=0 --max-instances=10` on Cloud Run (it scales up automatically on the first request), or re-run `bash scripts/setup.sh` — Terraform is idempotent.

---

## Destroying the service (full teardown)

> **Warning:** This permanently deletes all email data — accounts, messages, attachments. It cannot be undone.

```bash
bash scripts/destroy.sh
```

The script requires two confirmations: typing `destroy` then your exact project ID. After a 5-second countdown you can still press Ctrl+C to abort.

After destruction, delete the Terraform state bucket manually if you no longer need it:

```bash
gcloud storage rm -r gs://clawmail-tfstate --project=YOUR_PROJECT_ID
```

---

## Troubleshooting

### Inbound email not arriving

1. Verify MX record has propagated: `dig MX mail.yourdomain.com`
2. Check Stalwart is running: `gcloud compute ssh $VM -- docker ps`
3. Check Stalwart logs for SMTP session errors (see above)
4. Confirm port 25 firewall rule exists:
   ```bash
   gcloud compute firewall-rules list --filter="name~clawmail" --project=YOUR_PROJECT_ID
   ```

### Outbound email bouncing or going to spam

1. Check SendGrid dashboard for bounce details (*Activity → Email Activity*)
2. Verify domain auth CNAMEs are all green in SendGrid (*Sender Authentication*)
3. Confirm `SENDGRID_VERIFIED_SENDER` in Cloud Run matches a verified address
4. Test SPF/DKIM/DMARC: send an email to [mail-tester.com](https://www.mail-tester.com)

### Cloud Run returning 500

```bash
gcloud logging read \
  "resource.type=cloud_run_revision AND severity>=ERROR" \
  --project=YOUR_PROJECT_ID \
  --limit=20 \
  --format="value(textPayload)"
```

Common causes: missing env var, Stalwart unreachable, JMAP auth failure.

### Permission denied errors

If a tool call returns `Permission denied: "create_account" requires admin privileges`:
- The API key is configured with `"role": "user"` — only admin keys can manage accounts
- Check the `MCP_API_KEY_MAP` secret value to verify the key's role

If a tool call returns `Permission denied: you can only access your own account`:
- The API key is a user key trying to access a different account
- Verify the `"account"` field in the key map matches the account being accessed

### Stalwart API returns 200 with error JSON

Stalwart's REST API always returns HTTP 200, even for errors — check the JSON body. See `CLAUDE.md` for details on how the client handles this.
