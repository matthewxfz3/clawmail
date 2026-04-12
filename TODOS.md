# Clawmail TODO

## Active

_All items completed._

## Completed

- [x] **Stalwart DKIM signing** — Ed25519 key generated via `/api/dkim`, `auth.dkim.sign` settings written to DB, `default._domainkey.fridaymailer.com` TXT record published, `queue.route.sendgrid` v0.15 inline fields fixed, clean reload (no errors)
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
- [x] Two-layer authentication model — `X-API-Key` for service auth + per-account `token` for account auth
- [x] `tokens.ts` — token CRUD: `createToken`, `resolveToken`, `listTokens`, `revokeToken`; SHA-256 hash storage in `_tokens` JMAP mailbox of `clawmail-system` account; 60-second in-memory cache
- [x] `create_account` now returns a scoped `token` automatically (open to any authenticated caller)
- [x] `manage_token` MCP tool — create/list/revoke per-account tokens with inline self-service authorization
- [x] Dashboard Tokens tab — generate and revoke tokens with server-side flash store (plaintext token never in URL/logs)
- [x] Per-account rate limiting for all account-scoped tools (prevents one agent exhausting the shared API key quota)
- [x] Static admin tokens via `MCP_ADMIN_TOKENS` env var — bypass all account scoping; pre-computed SHA-256 hashes for performance
- [x] `clawmail-system` account guard — `delete_account` rejects deletion of reserved system account
- [x] Token revocation on `delete_account` — revokes all account tokens before deleting the mailbox; surfaces JMAP outage as a warning rather than silent failure
- [x] Case-insensitive account comparison in `manage_token` (email addresses are case-insensitive)
- [x] `accounts.test.ts` (12 tests) — account lifecycle, deletion guard, token cleanup, JMAP failure paths
- [x] `tokens.test.ts` — token CRUD unit tests with mocked JMAP/Stalwart backends
