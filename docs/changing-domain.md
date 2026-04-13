# Changing Mail Domain

This guide covers migrating Clawmail from one mail domain to another (e.g., `mail.old.com` → `mail.new.com`).

## Overview

The domain is used for:
- Account email addresses: `user@{domain}`
- SendGrid verified sender address
- MX/SPF/DMARC DNS records
- Stalwart principal accounts

## Prerequisites

Before changing the domain, ensure:
- [ ] New domain is registered and DNS is accessible
- [ ] SendGrid has verified the new domain
- [ ] Google Meet integration (if used) is ready for new domain
- [ ] Backup current database if needed

## Process

### 1. Update Terraform Variables

```bash
cd infra
# Update terraform.tfvars or pass via CLI
terraform plan -var="domain=new.domain.com" -var="project_id=YOUR_PROJECT"
terraform apply
```

This updates:
- Cloud Run `DOMAIN` environment variable
- DNS records (if using Cloud DNS)
- SendGrid verified sender configuration

### 2. Database Cleanup (Optional)

**If keeping existing accounts:** Skip to step 3.

**If wiping database (fresh start):**

```bash
# Connect to Cloud SQL PostgreSQL
gcloud sql connect clawmail-db --user=admin --project=YOUR_PROJECT

# Clear all mail data (keeps schema)
TRUNCATE email CASCADE;
TRUNCATE mailbox CASCADE;
TRUNCATE principal CASCADE;
TRUNCATE domain CASCADE;
```

Or recreate the entire database via:
```bash
gcloud sql backups create --instance=clawmail-db
gcloud sql databases delete mailserver --instance=clawmail-db
gcloud sql databases create mailserver --instance=clawmail-db --charset=utf8mb4
```

### 3. Restart Stalwart

```bash
# Redeploy Stalwart VM (picks up new domain from env)
gcloud compute instances stop clawmail-stalwart --zone=us-west1-b
gcloud compute instances start clawmail-stalwart --zone=us-west1-b
```

Or if using local Docker:
```bash
cd stalwart
docker-compose down
docker-compose up -d
```

### 4. Verify DNS Records

Ensure these records point to Stalwart's IP:

```bash
# MX record (inbound mail)
nslookup -type=MX new.domain.com

# SPF (SendGrid signing)
nslookup -type=TXT new.domain.com

# DMARC
nslookup -type=TXT _dmarc.new.domain.com
```

### 5. Test

```bash
# Create test account (uses new domain)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "create_account",
      "arguments": { "local_part": "test" }
    }
  }'

# Should return: test@new.domain.com
```

## Rollback

If something breaks:

1. **Revert Terraform**: `terraform apply` with old `domain` variable
2. **Restore database**: Use Cloud SQL backup from step 2
3. **Restart Stalwart**: Cold reboot to pick up old domain
4. **Verify DNS**: Make sure old MX records are active again

## Key Files

| File | Change |
|------|--------|
| `infra/variables.tf` | `domain` variable |
| `infra/cloudrun.tf` | `DOMAIN` env var |
| `infra/dns.tf` | MX/SPF/DMARC records |
| `stalwart/config.toml` | Domain in Stalwart config (env-substituted) |
| `.env` (local dev) | `DOMAIN` variable |
| `mcp-server/.env` (local dev) | `DOMAIN` variable |

## Notes

- **No downtime needed** if keeping existing accounts — just update DNS + env vars and restart
- **System account** (`clawmail-system@{domain}`) is auto-created on first account creation; token store uses it
- **Token hashes** are domain-agnostic and survive domain migration
- **SendGrid domain auth** is per-domain; old domain emails may fail delivery until DNS is updated
