# Clawmail Release Versioning & Deployment Tracking

**Last Updated:** 2026-04-16  
**Current Version:** v1.5.0 (5 of 8 critical fixes deployed)

---

## 📋 Release History

| Version | Date | Git SHA | Critical Fixes | Status |
|---------|------|---------|---|---|
| **v1.5.0** | 2026-04-16 | `445075f` | O1, O3, O6, O7, D2 | ✅ Deployed |
| v1.4.0 | 2026-04-16 | `ee76937` | O7 (health checks) | ⚪ In Dev |
| v1.3.0 | 2026-04-16 | `5930d9f` | O6 (session TTL) | ⚪ In Dev |
| v1.2.0 | 2026-04-16 | `ed9d74d` | O3 (key rotation) | ⚪ In Dev |
| v1.1.0 | 2026-04-16 | `b48d693` | O1 (persistent storage) | ⚪ In Dev |
| v1.0.0 | 2026-04-16 | `c481ac6` | Versioning & rollback system | ✅ Deployed |

---

## ✅ Completed Fixes (v1.5.0)

### O1: Stalwart Persistent Storage ✅
- **Commit:** `b48d693`
- **Change:** Added 100GB persistent disk (pd-standard) mounted at `/mnt/stalwart-data`
- **Impact:** Emails survive VM restart/crash — prevents catastrophic data loss
- **Verification:** MCP fully operational with persistent storage

### O3: SendGrid API Key Rotation ✅
- **Commit:** `ed9d74d`
- **Change:** Removed transporter caching — creates fresh instance on each `send_email` call
- **Impact:** SendGrid keys can be rotated in Secret Manager without restarting Cloud Run
- **Verification:** Each send call reads latest API key from config

### O6: Dashboard Session TTL Reduced ✅
- **Commit:** `5930d9f`
- **Change:** Reduced `SESSION_TTL_MS` from 7 days to 2 hours
- **Impact:** Limits impact of compromised session cookies (2h vs 7 days)
- **Verification:** Sessions expire after 2 hours of inactivity

### O7: Stalwart Startup Health Checks ✅
- **Commit:** `ee76937`
- **Change:** Added startup health verification loop (60 retries, JMAP endpoint check)
- **Impact:** Detects silent startup failures (DB connection issues, etc.)
- **Verification:** Startup fails if Stalwart health check doesn't pass within 120s

### D2: SendGrid Error Reporting ✅
- **Commit:** `445075f`
- **Change:** Added `sendMailWithErrorHandling()` wrapper that reports errors to caller
- **Impact:** No more silent failures — agents receive error messages instead
- **Verification:** Any SendGrid failure is now reported with descriptive error message

---

## 🔄 Rollback Guide

All deployments use git SHA tags (`git-<SHA>`) for precise versioning.

### Quick Rollback (via Cloud Run traffic switching)

```bash
# List recent revisions
gcloud run revisions list --service=clawmail-mcp --region=us-west1 \
  --format="table(name,status.conditions[0].lastTransitionTime)" --limit=10

# Switch traffic to previous revision (no rebuild needed)
gcloud run services update-traffic clawmail-mcp \
  --to-revisions=<REVISION_NAME>=100 --region=us-west1
```

**RTO:** ~30 seconds | **No downtime**

### Full Redeploy to Specific Commit

```bash
git checkout <commit-sha>
CLAWMAIL_IMAGE_TAG=git-<sha> ./deploy/clawmail.sh deploy
```

**RTO:** 5-10 minutes | **Full rebuild**

---

## 📊 Deployment Checklist

### Pre-Deployment
- [ ] All tests passing (`npm test`)
- [ ] Code builds successfully (`npm run build`)
- [ ] No obvious regressions in manually tested flows
- [ ] Release notes drafted (what changed, why, risks)

### During Deployment
- [ ] Docker image builds and pushes successfully
- [ ] Cloud Run revision created and READY
- [ ] Health endpoint responding (`/.well-known/jmap` or `/health`)
- [ ] Stalwart VM startup logs show successful startup

### Post-Deployment
- [ ] MCP `/mcp` endpoint returns 200
- [ ] `tools/list` returns complete tool schema
- [ ] `create_account` succeeds (validates Stalwart connectivity)
- [ ] `send_email` succeeds (validates SendGrid setup)
- [ ] No error logs from Cloud Run

---

## 🚨 Known Deployment Issues & Workarounds

### Issue: Terraform state lock contention
**Cause:** Multiple deploys running simultaneously  
**Workaround:** `terraform force-unlock <LOCK_ID>` if deploy hangs

### Issue: Disk attachment fails on running VM
**Cause:** Attached disks don't auto-trigger startup script  
**Workaround:** Manually restart VM after attaching disk, or recreate VM

---

## S3: TLS Encryption (Cloud Run ↔ Stalwart) ✅
- Added JMAP listener on port 8443 with TLS
- Self-signed certificates generated during VM startup
- MCP server updated to use https://stalwart:8443
- STALWART_SKIP_TLS_VERIFY environment variable for self-signed certs
- Prevents admin password exposure on internal network

## S2: Redis Distributed Caching ✅
- Created Google Memorystore Redis instance (1GB, BASIC tier)
- Migrated idempotency cache to Redis with 24-hour TTL
- In-memory fallback when Redis unavailable
- Added redis npm package dependency
- Enables safe scale-to-zero for Cloud Run with state preservation

## O4: Stalwart Redundancy & HA Failover ✅
- Deployed secondary Stalwart VM in different zone (us-central1-b)
- Both VMs share same Cloud SQL database and GCS storage
- Independent persistent disks (100GB each) for local data
- Health checks configured on JMAP endpoint (port 8080)
- Static external IPs for both primary and secondary
- Manual failover: update Cloud Run's STALWART_URL to secondary IP
- RTO: ~5-10 minutes when primary fails
- Future enhancement: automated load balancer for transparent failover

---

## 🏷️ Versioning Strategy

**Semantic Versioning:** `v<major>.<minor>.<patch>`

- **Patch** (`v1.0.1` → `v1.0.2`): Bug fixes, security patches
- **Minor** (`v1.0.0` → `v1.1.0`): New features, operational improvements
- **Major** (`v1.0.0` → `v2.0.0`): Breaking changes, large refactors

**Every deployed image is tagged:**
- By git SHA: `git-<short-SHA>` (e.g., `git-445075f`)
- By semver: `v1.5.0` (git tag, optional but recommended)
- Always: `:latest` (current production)

**Create git tags for stable releases:**
```bash
git tag -a v1.5.0 -m "5 critical fixes: persistent storage, key rotation, session TTL, health checks, error reporting"
git push origin v1.5.0
```

---

## 🔗 References

- **Versioning & Rollback:** See `docs/deployment-gcp.md` for complete guide
- **MCP Endpoints:** See `CLAUDE.md` for architecture overview
- **Risk Analysis:** See `docs/planning/risk-analysis.md` for full issue catalog

---

**Maintainer:** Engineering Team  
**Next Review:** 2026-04-30
