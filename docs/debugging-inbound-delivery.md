# Debugging Log: Inbound Email Delivery (fridaymailer.com)

This file records all experiments, results, and hypotheses from debugging inbound
email delivery for Clawmail on `fridaymailer.com`. Updated to avoid going in loops.

---

## Status Summary (as of 2026-04-01)

| Component | Status | Notes |
|-----------|--------|-------|
| DNS (MX, A, SPF, DMARC) | ✅ Working | Propagated, verified via `dig` |
| Stalwart v0.15 running | ✅ Working | On `<STALWART_VM_IP>`, bind-mount at `/opt/stalwart-data:/opt/stalwart` |
| Admin auth | ✅ Working | `[authentication.fallback-admin]` loaded from config |
| Domain principal | ✅ Working | `fridaymailer.com` principal exists in Stalwart |
| Queue routing | ✅ Working | Local → `'local'` route, external → sendgrid relay |
| JMAP storage | ✅ Working | Reads/writes confirmed via direct JMAP API |
| SMTP port 25 (inbound) | ✅ Working | GCE firewall open, emails arrive at Stalwart |
| `email-receive` permission | ✅ Fixed (manually) | Must be set on accounts; `createAccount` not yet updated |
| Email delivery to mailbox | ✅ Working | Confirmed via direct JMAP query |
| Spam filter / folder | ❌ Problem | Emails arrive in **Junk Mail** (id=c), not Inbox (id=a) |
| MCP `list_emails` cache | ❌ Problem | Returns stale count; module-level JMAP cache on Cloud Run |
| `createAccount` permission | ❌ Bug | New accounts miss `enabledPermissions: ["email-receive"]` |
| Old DSN queue messages | ⚠️ Noise | 4 messages for `fridaymail.duckdns.org` stuck retrying hourly |

---

## Domain Migration History

### Why we migrated
`fridaymail.duckdns.org` only supports A records via DuckDNS API. Cannot add CNAME/TXT
needed for SendGrid domain auth or DKIM. Needed a proper domain.

### What was done
1. Obtained `fridaymailer.com` (already in GCP project `<GCP_PROJECT>`)
2. Created Cloud DNS zone `fridaymailer-com`
3. Added records:
   - `A fridaymailer.com → <STALWART_VM_IP>` (Stalwart VM static IP)
   - `MX 10 fridaymailer.com.` (self-hosted MX)
   - `TXT "v=spf1 a mx ~all"` (SPF)
   - `TXT "_dmarc: v=DMARC1; p=none; rua=mailto:dmarc@fridaymailer.com"` (DMARC)
4. Rebuilt Stalwart container with `DOMAIN=fridaymailer.com`
5. Updated `stalwart/config.toml` to reference `fridaymailer.com`
6. Redeployed Cloud Run MCP server with new domain env var

---

## Experiment Log

### Exp-01: Docker Hub image missing
**Hypothesis**: `stalwartlabs/mail-server:latest` should pull from Docker Hub.
**Result**: FAIL — image no longer exists on Docker Hub. Docker Hub returned 404/403.
**Fix**: Pull `stalwartlabs/stalwart:latest` from GHCR, push to Artifact Registry at
`us-west1-docker.pkg.dev/<GCP_PROJECT>/clawmail/stalwart:latest`.
The startup script was updated to pull from Artifact Registry.

### Exp-02: GHCR image 403
**Hypothesis**: `ghcr.io/stalwartlabs/mail-server:latest` accessible without auth.
**Result**: FAIL — private GitHub Container Registry, returns 403.
**Fix**: Use Artifact Registry copy (from Exp-01).

### Exp-03: Wrong data directory path
**Symptom**: Admin auth returning 401; OIDC issuer showing container hostname instead
of configured domain; config not being read.
**Hypothesis**: Volume mount path is wrong.
**Investigation**: Old image (`stalwartlabs/mail-server`) used `/opt/stalwart-mail`.
New image (`stalwartlabs/stalwart` v0.15) uses `/opt/stalwart`.
**Fix**: Changed Docker mount from `/opt/stalwart-mail:/opt/stalwart-mail` to
`/opt/stalwart-data:/opt/stalwart`.

### Exp-04: Docker Compose named volume shadowing
**Symptom**: Even after fixing path, config.toml still not found.
**Hypothesis**: Named volume `stalwart_data` is being persisted from old runs.
**Investigation**: Docker Compose prefixes named volumes with the project name:
`stalwart_data` → `stalwart_stalwart_data`. Old volume data shadowed config writes.
**Fix**: Switched to bind mount (`/opt/stalwart-data:/opt/stalwart`) so host path is
predictable and config writes happen in `/opt/stalwart-data/etc/config.toml`.

### Exp-05: SENDGRID_API_KEY missing from container
**Symptom**: Outbound email failing; queue messages stuck.
**Investigation**: `docker-compose.yml` startup script had `DB_PASSWORD` and other vars
but forgot `SENDGRID_API_KEY`.
**Fix**: Added `SENDGRID_API_KEY` to the environment section in the startup script.

### Exp-06: Stalwart Settings API POST format change (v0.15)
**Attempt**: POST to `/api/settings` to change queue routing at runtime.
**Old format** (v0.14): `[{"_id": "queue.outbound.next-hop", "_value": "..."}]`
**Result**: FAIL — `{"error":"JSON deserialization failed","details":"missing field 'type'"}`
**Root cause**: v0.15 Settings API requires a `type` field in the request.
**Conclusion**: Cannot reliably update queue config via Settings API.
**Workaround**: Managed via `config.toml` file which is loaded on container start.

### Exp-07: `email-receive` permission missing (Stalwart v0.15)
**Symptom**: Inbound SMTP returned `550 5.7.1 This account is not authorized to receive email`.
**Hypothesis**: v0.15 requires an explicit permission that v0.14 granted by default.
**Confirmed**: Stalwart v0.15 added `enabledPermissions` list. Accounts without
`email-receive` in that list cannot receive SMTP.
**Fix applied manually**:
```bash
curl -X PATCH \
  -H "Content-Type: application/json" \
  -u "admin:$PASS" \
  -d '[{"action":"addItem","field":"enabledPermissions","value":"email-receive"}]' \
  http://<STALWART_VM_IP>:8080/api/principal/delivery-test
```
**Fix needed in code**: `createAccount` in `stalwart-mgmt.ts` must include
`enabledPermissions: ["email-receive"]` in the POST body. **NOT YET DEPLOYED.**

### Exp-08: Spam filter placing email in Junk Mail
**Symptom**: Inbound SMTP delivery confirmed (Stalwart logs show acceptance), but
`list_emails` (Inbox) shows 0 new emails. Direct JMAP query shows email in
mailbox with id=c (Junk Mail), not id=a (Inbox).
**Hypothesis**: Stalwart spam filter is scoring SendGrid-relayed mail as junk.
**Evidence**:
- Email FROM `<SENDGRID_VERIFIED_SENDER>` sent via SendGrid's SMTP relay
- SendGrid IP is not in SPF for `fridaymailer.com` (SPF: `v=spf1 a mx ~all`)
- From address doesn't match the verified sender domain
- Stalwart scored it as spam → delivered to Junk folder
**Attempted**: Direct JMAP shows email in Junk (mailbox id=c, total=1, unread=1)
**NOT YET FIXED**: Need to either:
  1. Disable/relax spam filter in Stalwart config, OR
  2. Add SendGrid IP ranges to SPF record, OR
  3. Use a `fridaymailer.com` verified sender in SendGrid

### Exp-09: MCP `list_emails` stale cache
**Symptom**: After email delivery confirmed in Junk, MCP `list_emails("Junk")` still
returned stale count even after Cloud Run redeployment.
**Hypothesis**: Module-level JMAP session cache (`userContextCache`, `cachedSession`,
`jmapIdCache` in `jmap.ts`) persists per Cloud Run instance. Even new revision may
reuse the same instance, or cache TTL is too long.
**Evidence**: Direct JMAP query returned correct data; MCP tool returned stale data.
**Status**: Not resolved. The cache needs a shorter TTL or per-request invalidation.

### Exp-10: Old DSN messages for fridaymail.duckdns.org
**Symptom**: Stalwart queue shows 4 messages trying to deliver DSNs to
`postmaster@fridaymail.duckdns.org`, failing with `Connection refused`.
**Root cause**: These are delivery status notifications (bounces) from failed deliveries
when the domain was `fridaymail.duckdns.org`. The DSNs are addressed to the old domain.
**Impact**: Low (background noise, hourly retries). They will expire per Stalwart's
`queue.outbound` retry/expiry policy.
**Workaround**: Let them expire naturally, or delete via Stalwart Admin API.

---

## Key Diagnostic Commands

### Check Stalwart queue
```bash
curl -s -u "admin:$PASS" http://<STALWART_VM_IP>:8080/api/queue/messages?limit=20 | jq .
```

### Check all mailboxes for an account (JMAP)
```bash
# Get session
SESSION=$(curl -s -u "admin:$PASS" http://<STALWART_VM_IP>:8080/.well-known/jmap)
ACCOUNT_ID=$(echo $SESSION | jq -r '.accounts | keys[0]')

# Get all mailboxes
curl -s -u "admin:$PASS" http://<STALWART_VM_IP>:8080/jmap \
  -H 'Content-Type: application/json' \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Mailbox/get\",{\"accountId\":\"$ACCOUNT_ID\",\"ids\":null},\"r1\"]]}" \
  | jq '.methodResponses[0][1].list[] | {id, name, totalEmails, unreadEmails}'
```

### Get JMAP account ID for a user (via Principals API)
```bash
# Get admin's principals accountId
PRINCIPALS_ID=$(curl -s -u "admin:$PASS" http://<STALWART_VM_IP>:8080/.well-known/jmap \
  | jq -r '."primaryAccounts"["urn:ietf:params:jmap:principals"]')

# List all principals to find user's opaque ID
curl -s -u "admin:$PASS" http://<STALWART_VM_IP>:8080/jmap \
  -H 'Content-Type: application/json' \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:principals\"],\"methodCalls\":[[\"Principal/query\",{\"accountId\":\"$PRINCIPALS_ID\"},\"r1\"]]}" \
  | jq .
```

### Check account permissions
```bash
curl -s -u "admin:$PASS" http://<STALWART_VM_IP>:8080/api/principal/ACCOUNT_NAME | jq .
```

### Add email-receive permission to existing account
```bash
curl -X PATCH \
  -H "Content-Type: application/json" \
  -u "admin:$PASS" \
  -d '[{"action":"addItem","field":"enabledPermissions","value":"email-receive"}]' \
  http://<STALWART_VM_IP>:8080/api/principal/ACCOUNT_NAME
```

### Check Stalwart logs for SMTP activity
```bash
# On the VM:
docker logs stalwart 2>&1 | grep -E "(RCPT|DATA|550|250|queued|delivered)" | tail -50
```

### Trigger queue flush
```bash
curl -X POST -u "admin:$PASS" \
  http://<STALWART_VM_IP>:8080/api/queue/retry
```

---

## Current Hypotheses for Remaining Issues

### H1: Spam filter — emails landing in Junk Mail
**Root cause**: SPF alignment failure. SendGrid sends from its own IP pool, but
`fridaymailer.com` SPF only lists `a mx ~all` (the VM's IP). SendGrid IPs fail SPF.
Additionally, the `From:` header uses `<SENDGRID_VERIFIED_SENDER>`, a different domain.

**Options to fix** (in order of preference):
1. **Add SendGrid to SPF**: `v=spf1 a mx include:sendgrid.net ~all`
2. **Configure SendGrid domain auth**: DKIM + DMARC alignment requires CNAME records at
   `fridaymailer.com`. Add those CNAME records to Cloud DNS and verify in SendGrid dashboard.
3. **Disable spam filter in Stalwart**: Add `[spam.score] classify.spam = -100` or similar
   in `config.toml` (nuclear option, not recommended for production).
4. **Use a `fridaymailer.com` FROM address**: Change `SENDGRID_VERIFIED_SENDER` to
   `noreply@fridaymailer.com` and verify it in SendGrid. Requires SendGrid to send a
   verification email to that address (need inbound SMTP working first — chicken/egg).

### H2: MCP `list_emails` stale results
**Root cause**: `jmap.ts` uses module-level caches (`userContextCache`, `cachedSession`,
`jmapIdCache`). On Cloud Run, a single instance can serve many requests, and the caches
never expire. Even after redeployment, the same Go process may keep running on warm instances.

**Options to fix**:
1. Add TTL to caches (e.g., expire after 5 minutes)
2. Cache-bust on cold start by checking a cache version header
3. Remove module-level caching entirely (slight latency hit, ~50-100ms extra per call)

### H3: `createAccount` missing `email-receive` permission
**Root cause**: `stalwart-mgmt.ts:createAccount()` doesn't include `enabledPermissions`
in the POST body. All accounts created via the MCP tool cannot receive email.

**Fix**: Add `enabledPermissions: ["email-receive"]` to the JSON body in `createAccount`.
Also need to PATCH all existing accounts (e.g., via a one-time script or admin UI).

### H4: Old DSN queue messages
**Root cause**: Stalwart still has 4 delivery status notification messages for
`postmaster@fridaymail.duckdns.org` that can never be delivered (DNS no longer exists).
GCP blocks outbound port 25, so these can't be relayed via sendgrid either (they're
FROM null/postmaster, not a regular account).

**Options**:
1. Let them expire naturally (lowest effort)
2. Delete via Stalwart Admin API: `DELETE /api/queue/message/{id}`
3. Get the message IDs: `GET /api/queue/messages?limit=20`, then delete each

---

## Configuration Gotchas

### Stalwart v0.15 breaking changes from v0.14
- **Data dir**: `/opt/stalwart` (was `/opt/stalwart-mail`)
- **Docker image**: `stalwartlabs/stalwart` (was `stalwartlabs/mail-server`)
- **Settings API**: Requires `type` field in POST body
- **Account permissions**: `email-receive` must be explicitly set
- **Quota format**: Flat integer bytes, not an object

### JMAP account IDs
JMAP `accountId` is an opaque hash (`"e"`, `"d333333"` etc.), NOT the email address.
Passing an email as accountId causes `{"type":"notRequest","detail":"trailing characters"}`.
The `jmap.ts` client resolves email → opaque ID via Principals API.

### Stalwart API returns 200 for errors
HTTP 200 does NOT mean success. Always check the JSON body:
- `{"error":"notFound"}` — resource doesn't exist
- `{"error":"fieldAlreadyExists"}` — duplicate creation (treat as idempotent)
- `{"error":"JSON deserialization failed", "details":"..."}` — bad request format

### Admin JMAP session only sees admin's mailbox
`/.well-known/jmap` session only returns the admin's own account in `accounts`.
Access other users' mailboxes via Principals API to get their opaque ID first.

### MCP transport must be per-request
`StreamableHTTPServerTransport` cannot be reused across requests. Create a new
`McpServer` + transport on every HTTP request. See `index.ts` `createMcpServer()`.
