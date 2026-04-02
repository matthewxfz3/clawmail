# Clawmail TODO

## Active

- [ ] **Fix spam filter — emails land in Junk Mail instead of Inbox**
  SPF includes SendGrid (`include:sendgrid.net` confirmed in DNS). Root issue is likely
  missing DKIM signing + DMARC alignment. Add SendGrid DKIM CNAME records in Cloud DNS
  and configure DKIM in SendGrid dashboard for `fridaymailer.com`.

- [ ] **Set up DKIM for `fridaymailer.com`**
  Generate DKIM key via Stalwart Admin API, publish as TXT record in Cloud DNS.
  Also add SendGrid DKIM CNAMEs (`s1._domainkey`, `s2._domainkey`) from SendGrid dashboard.
  Required for email deliverability and to stop spam-scoring.

- [ ] **Verify SendGrid domain auth for `fridaymailer.com`**
  Add CNAME records from SendGrid dashboard → Cloud DNS.
  Then update `SENDGRID_VERIFIED_SENDER` env var from `matthew@sanchi.ai` to `noreply@fridaymailer.com`.

- [ ] **Patch existing accounts with `email-receive` permission**
  All accounts created before today's `createAccount` fix lack the permission.
  Run: `STALWART_ADMIN_PASSWORD=<pass> bash scripts/patch-email-receive.sh`

- [ ] **Clean up stuck DSN queue messages for `fridaymail.duckdns.org`**
  4 messages stuck retrying hourly. Delete via:
  `GET /api/queue/messages?limit=20` → grab IDs → `DELETE /api/queue/message/{id}`.

- [ ] **Write unit tests for `stalwart-mgmt.ts` and `jmap.ts`**
  No test suite yet. Mock the Stalwart HTTP API and JMAP endpoint.
  Minimum coverage: `createAccount`, `accountExists`, `listAccounts`, `deleteAccount`, `listEmails`, `readEmail`.

## Completed

- [x] Migrate domain from `fridaymail.duckdns.org` → `fridaymailer.com`
- [x] Create Cloud DNS zone with A, MX, SPF, DMARC records
- [x] Fix Stalwart v0.15 Docker image (renamed to `stalwartlabs/stalwart`, pushed to Artifact Registry)
- [x] Fix Stalwart data directory mount (`/opt/stalwart-data:/opt/stalwart`)
- [x] Fix `SENDGRID_API_KEY` missing from docker-compose env
- [x] Fix `createAccount` to include `enabledPermissions: ["email-receive"]` (Stalwart v0.15)
- [x] Fix JMAP client cache TTL — 5-minute expiry on `userContextCache` and `cachedSession`
- [x] Add patch script `scripts/patch-email-receive.sh` for existing accounts
- [x] Add JMAP master-user impersonation to `jmap.ts` (avoids cross-account ACL issues)
- [x] Add debug JMAP route `/dashboard/debug/jmap?a=email`
- [x] Add queue routing to `stalwart/config.toml` (local delivery + SendGrid relay)
- [x] Document all debugging experiments and hypotheses in `docs/debugging-inbound-delivery.md`
- [x] Dashboard: tabbed UI with Overview, Inboxes, Metrics tabs
- [x] Dashboard: inbox drill-down with folder tabs and email list
- [x] Dashboard: metrics tab with time-series charts
- [x] Dashboard: test email send form
- [x] In-memory metrics tracking (`metrics.ts`) with per-tool call/error/rate-limit counters
