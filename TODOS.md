# Clawmail TODO

## Active

- [ ] **Set up Stalwart DKIM signing for `fridaymailer.com`**
  SendGrid domain auth (DKIM/DMARC) is done for outbound via SendGrid relay.
  Still need Stalwart to sign any directly-delivered mail with its own DKIM key.
  Generate key via Stalwart API → publish TXT record in Cloud DNS.

## Completed

- [x] Fix spam filter: SendGrid domain auth for `fridaymailer.com` verified ✅ (DKIM CNAMEs propagated + validated via API)
- [x] Update `SENDGRID_VERIFIED_SENDER` to `noreply@fridaymailer.com` in Cloud Run (revision 00028)
- [x] Patch all 17 existing accounts with `email-receive` permission (live against Stalwart VM)
- [x] Delete 5 stuck DSN queue messages for `fridaymail.duckdns.org`
- [x] Remove sensitive info from `CLAUDE.md` (VM IP, project hash, GCP project ID, personal email)
- [x] Remove sensitive info from `docs/debugging-inbound-delivery.md` (same)
- [x] Write unit tests — 51 tests across `stalwart-mgmt.ts` and `jmap.ts`, all passing
- [x] Migrate domain from `fridaymail.duckdns.org` → `fridaymailer.com`
- [x] Create Cloud DNS zone with A, MX, SPF, DMARC records
- [x] Fix Stalwart v0.15 Docker image (renamed to `stalwartlabs/stalwart`, pushed to Artifact Registry)
- [x] Fix Stalwart data directory mount (`/opt/stalwart-data:/opt/stalwart`)
- [x] Fix `SENDGRID_API_KEY` missing from docker-compose env
- [x] Fix `createAccount` to include `enabledPermissions: ["email-receive"]` (Stalwart v0.15)
- [x] Fix JMAP client cache TTL — 5-minute expiry on `userContextCache` and `cachedSession`
- [x] Add `clearJmapCache()` export for test isolation
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
