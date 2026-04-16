#!/usr/bin/env bash
# =============================================================================
# clawmail.sh — Clawmail deployment management
#
# Commands:
#   deploy   Full deployment: provision GCP infra, build & push image, setup VM
#   health   Check status of all system components
#   stop     Gracefully stop services (Cloud Run → 0, VM stopped)
#   help     Show this help
#
# Usage:
#   ./deploy/clawmail.sh <command>
#
# Config:
#   Copy deploy/config.example.sh → deploy/config.sh and fill in all values.
#   Or set CLAWMAIL_CONFIG=/path/to/your/config.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
MCP_DIR="$ROOT_DIR/mcp-server"
STALWART_DIR="$ROOT_DIR/stalwart"
CONFIG_FILE="${CLAWMAIL_CONFIG:-$SCRIPT_DIR/config.sh}"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
log()      { echo -e "${BLUE}[clawmail]${NC} $*"; }
success()  { echo -e "${GREEN}[✔]${NC} $*"; }
warn()     { echo -e "${YELLOW}[!]${NC} $*"; }
error()    { echo -e "${RED}[✖]${NC} $*" >&2; }
header()   { echo -e "\n${BOLD}${CYAN}══════════════════════════════════════════${NC}"; \
             echo -e "${BOLD}${CYAN}  $*${NC}"; \
             echo -e "${BOLD}${CYAN}══════════════════════════════════════════${NC}"; }
check_ok() { printf "  %-45s ${GREEN}OK${NC}\n" "$1"; }
check_fail(){ printf "  %-45s ${RED}FAIL${NC}\n" "$1"; }
check_warn(){ printf "  %-45s ${YELLOW}WARN${NC}\n" "$1"; }

# ---------------------------------------------------------------------------
# Load config
# ---------------------------------------------------------------------------
load_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    error "Config file not found: $CONFIG_FILE"
    echo ""
    echo "  To get started:"
    echo "    cp deploy/config.example.sh deploy/config.sh"
    echo "    # fill in all values"
    echo "    ./deploy/clawmail.sh deploy"
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"

  # Validate required variables
  local required=(
    CLAWMAIL_GCP_PROJECT
    CLAWMAIL_GCP_REGION
    CLAWMAIL_GCP_ZONE
    CLAWMAIL_DOMAIN
    CLAWMAIL_STALWART_ADMIN_PASSWORD
    CLAWMAIL_DB_PASSWORD
    CLAWMAIL_SENDGRID_API_KEY
    CLAWMAIL_MCP_API_KEYS
  )
  local missing=0
  for var in "${required[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      error "Missing required config variable: $var"
      missing=1
    fi
  done
  [[ $missing -eq 0 ]] || exit 1

  # Derived values
  TF_STATE_BUCKET="${CLAWMAIL_TF_STATE_BUCKET:-clawmail-tfstate-${CLAWMAIL_GCP_PROJECT}}"
  IMAGE_REPO="${CLAWMAIL_GCP_REGION}-docker.pkg.dev/${CLAWMAIL_GCP_PROJECT}/clawmail/mcp-server"

  # Git SHA for versioning (if not in a git repo, use "local")
  if git rev-parse --git-dir &>/dev/null; then
    GIT_SHA="$(git rev-parse --short HEAD)"
  else
    GIT_SHA="local"
  fi

  # Image tag: use override or auto-generate from git SHA
  IMAGE_TAG="${CLAWMAIL_IMAGE_TAG:-git-${GIT_SHA}}"
  IMAGE_URL_SHA="${IMAGE_REPO}:${IMAGE_TAG}"
  IMAGE_URL_LATEST="${IMAGE_REPO}:latest"

  VM_NAME="stalwart"
  CLOUD_RUN_SERVICE="clawmail-mcp"
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
check_prereqs() {
  header "Checking prerequisites"
  local ok=1

  for tool in gcloud terraform docker; do
    if command -v "$tool" &>/dev/null; then
      check_ok "$tool installed"
    else
      check_fail "$tool installed"
      ok=0
    fi
  done

  # gcloud auth
  if gcloud auth print-access-token &>/dev/null; then
    check_ok "gcloud authenticated"
  else
    check_fail "gcloud authenticated  (run: gcloud auth login)"
    ok=0
  fi

  # gcloud project
  if gcloud projects describe "$CLAWMAIL_GCP_PROJECT" &>/dev/null; then
    check_ok "GCP project accessible: $CLAWMAIL_GCP_PROJECT"
  else
    check_fail "GCP project accessible: $CLAWMAIL_GCP_PROJECT"
    ok=0
  fi

  # Docker daemon
  if docker info &>/dev/null; then
    check_ok "Docker daemon running"
  else
    check_fail "Docker daemon running"
    ok=0
  fi

  [[ $ok -eq 1 ]] || { error "Fix the above issues and re-run."; exit 1; }
}

# ---------------------------------------------------------------------------
# Terraform helpers
# ---------------------------------------------------------------------------
tf_vars() {
  echo \
    "-var=project_id=${CLAWMAIL_GCP_PROJECT}" \
    "-var=region=${CLAWMAIL_GCP_REGION}" \
    "-var=zone=${CLAWMAIL_GCP_ZONE}" \
    "-var=domain=${CLAWMAIL_DOMAIN}" \
    "-var=stalwart_admin_password=${CLAWMAIL_STALWART_ADMIN_PASSWORD}" \
    "-var=db_password=${CLAWMAIL_DB_PASSWORD}" \
    "-var=sendgrid_api_key=${CLAWMAIL_SENDGRID_API_KEY}" \
    "-var=mcp_api_key=${CLAWMAIL_MCP_API_KEYS}" \
    "-var=mcp_server_image=${IMAGE_URL_SHA}"
}

tf_init() {
  log "Initialising Terraform (state bucket: $TF_STATE_BUCKET)..."

  # Create the state bucket if it doesn't exist
  if ! gsutil ls "gs://${TF_STATE_BUCKET}" &>/dev/null; then
    log "Creating Terraform state bucket..."
    gsutil mb -p "$CLAWMAIL_GCP_PROJECT" \
              -l "$CLAWMAIL_GCP_REGION" \
              "gs://${TF_STATE_BUCKET}"
    gsutil versioning set on "gs://${TF_STATE_BUCKET}"
    success "State bucket created: gs://${TF_STATE_BUCKET}"
  fi

  terraform -chdir="$INFRA_DIR" init \
    -backend-config="bucket=${TF_STATE_BUCKET}" \
    -backend-config="prefix=terraform/state" \
    -reconfigure \
    -input=false
}

# ---------------------------------------------------------------------------
# Deploy command
# ---------------------------------------------------------------------------
cmd_deploy() {
  load_config
  check_prereqs

  header "Phase 1 — Provision base infrastructure"
  log "Applying Terraform (registry + compute + SQL + storage + secrets + DNS)..."
  tf_init

  # First pass: everything except Cloud Run (needs the Docker image to exist first)
  # shellcheck disable=SC2046
  terraform -chdir="$INFRA_DIR" apply \
    -auto-approve \
    -input=false \
    $(tf_vars) \
    -target=google_project_service.artifact_registry \
    -target=google_artifact_registry_repository.clawmail \
    -target=google_compute_address.stalwart \
    -target=google_compute_instance.stalwart \
    -target=google_compute_firewall.stalwart_smtp_in \
    -target=google_compute_firewall.stalwart_internal \
    -target=google_compute_firewall.stalwart_imap \
    -target=google_sql_database_instance.clawmail \
    -target=google_sql_database.stalwart \
    -target=google_sql_user.stalwart \
    -target=google_storage_bucket.clawmail_attachments \
    -target=google_project_service.secretmanager \
    -target=google_secret_manager_secret.secrets \
    -target=google_secret_manager_secret_version.secrets \
    -target=google_dns_managed_zone.clawmail \
    -target=google_dns_record_set.stalwart_a \
    -target=google_dns_record_set.mx \
    -target=google_dns_record_set.spf \
    -target=google_dns_record_set.dmarc
  success "Base infrastructure provisioned"

  # Retrieve the static IP so we can display DNS instructions
  STALWART_IP=$(terraform -chdir="$INFRA_DIR" output -raw stalwart_ip 2>/dev/null || echo "unknown")

  header "Phase 2 — Build & push MCP server image"
  log "Configuring Docker for Artifact Registry..."
  gcloud auth configure-docker "${CLAWMAIL_GCP_REGION}-docker.pkg.dev" --quiet

  log "Building and pushing MCP server image with both tags..."
  docker buildx build \
    --platform linux/amd64 \
    -t "$IMAGE_URL_SHA" \
    -t "$IMAGE_URL_LATEST" \
    --push \
    "$MCP_DIR"

  success "Image pushed:"
  success "  SHA tag (pinned): $IMAGE_URL_SHA"
  success "  Latest tag: $IMAGE_URL_LATEST"

  header "Phase 3 — Deploy Cloud Run MCP service"
  # Second pass: Cloud Run now has the image
  # shellcheck disable=SC2046
  terraform -chdir="$INFRA_DIR" apply \
    -auto-approve \
    -input=false \
    $(tf_vars)
  success "Cloud Run service deployed"

  CLOUD_RUN_URL=$(terraform -chdir="$INFRA_DIR" output -raw cloud_run_url 2>/dev/null || echo "unknown")

  header "Phase 4 — Configure Stalwart on VM"
  log "Waiting for VM to be ready..."
  local retries=0
  until gcloud compute ssh "$VM_NAME" \
        --project="$CLAWMAIL_GCP_PROJECT" \
        --zone="$CLAWMAIL_GCP_ZONE" \
        --command="echo ready" \
        --quiet 2>/dev/null; do
    retries=$((retries + 1))
    if [[ $retries -gt 12 ]]; then
      error "VM not reachable after 2 minutes. Check the instance console."
      exit 1
    fi
    sleep 10
    log "  Waiting for SSH... ($retries/12)"
  done

  log "Uploading Stalwart config to VM..."
  DB_HOST=$(terraform -chdir="$INFRA_DIR" output -raw cloud_sql_connection_name 2>/dev/null || echo "")
  GCS_BUCKET=$(terraform -chdir="$INFRA_DIR" output -raw gcs_bucket_name 2>/dev/null || echo "")

  gcloud compute scp \
    "$STALWART_DIR/config.toml" \
    "$STALWART_DIR/docker-compose.yml" \
    "${VM_NAME}:/opt/stalwart/" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --zone="$CLAWMAIL_GCP_ZONE" \
    --quiet

  log "Starting Stalwart via docker-compose..."
  gcloud compute ssh "$VM_NAME" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --zone="$CLAWMAIL_GCP_ZONE" \
    --quiet \
    --command="
      set -e
      cd /opt/stalwart

      # Write env file for docker-compose
      cat > .env <<EOF
DOMAIN=${CLAWMAIL_DOMAIN}
DB_HOST=${DB_HOST}
DB_PASSWORD=${CLAWMAIL_DB_PASSWORD}
GCS_BUCKET=${GCS_BUCKET}
GCS_ACCESS_KEY=\$(gcloud secrets versions access latest --secret=gcs-hmac-access-key 2>/dev/null || echo '')
GCS_SECRET_KEY=\$(gcloud secrets versions access latest --secret=gcs-hmac-secret-key 2>/dev/null || echo '')
SENDGRID_API_KEY=${CLAWMAIL_SENDGRID_API_KEY}
STALWART_ADMIN_SECRET=${CLAWMAIL_STALWART_ADMIN_PASSWORD}
EOF

      docker compose up -d --pull always
      echo 'Stalwart started'
    "
  success "Stalwart running on VM"

  # ---------------------------------------------------------------------------
  # Deployment summary
  # ---------------------------------------------------------------------------
  header "Deployment complete"
  echo ""
  echo -e "  ${BOLD}MCP Server URL${NC}      https://${CLOUD_RUN_URL}/mcp"
  echo -e "  ${BOLD}Stalwart IP${NC}         ${STALWART_IP}"
  echo -e "  ${BOLD}Domain${NC}              ${CLAWMAIL_DOMAIN}"
  echo ""
  echo -e "  ${YELLOW}Next steps:${NC}"
  echo "  1. Update your domain registrar to use these DNS name servers:"
  terraform -chdir="$INFRA_DIR" output dns_name_servers 2>/dev/null || true
  echo ""
  echo "  2. Generate a DKIM key in Stalwart and add it to Cloud DNS:"
  echo "     gcloud compute ssh ${VM_NAME} --zone=${CLAWMAIL_GCP_ZONE} \\"
  echo "       --command=\"curl -s -u admin:\$PASS http://localhost:8080/api/dkim/generate\""
  echo ""
  echo "  3. Run a health check:"
  echo "     ./deploy/clawmail.sh health"
  echo ""
}

# ---------------------------------------------------------------------------
# Health command
# ---------------------------------------------------------------------------
cmd_health() {
  load_config
  header "System health — Clawmail"

  local overall_ok=0

  # ── Compute Engine VM ─────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}  Compute Engine — Stalwart VM${NC}"
  local vm_status
  vm_status=$(gcloud compute instances describe "$VM_NAME" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --zone="$CLAWMAIL_GCP_ZONE" \
    --format="value(status)" 2>/dev/null || echo "NOT_FOUND")

  if [[ "$vm_status" == "RUNNING" ]]; then
    check_ok "VM status: RUNNING"
  else
    check_fail "VM status: ${vm_status}"
    overall_ok=1
  fi

  # Stalwart health endpoint (via SSH — port 8080 is VPC-internal only)
  local stalwart_health
  stalwart_health=$(gcloud compute ssh "$VM_NAME" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --zone="$CLAWMAIL_GCP_ZONE" \
    --quiet \
    --command="curl -sf http://localhost:8080/healthz 2>/dev/null && echo OK || echo FAIL" \
    2>/dev/null || echo "SSH_ERROR")

  if [[ "$stalwart_health" == *"OK"* ]]; then
    check_ok "Stalwart health endpoint"
  else
    check_fail "Stalwart health endpoint (${stalwart_health})"
    overall_ok=1
  fi

  # Docker containers on VM
  local docker_status
  docker_status=$(gcloud compute ssh "$VM_NAME" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --zone="$CLAWMAIL_GCP_ZONE" \
    --quiet \
    --command="docker compose -f /opt/stalwart/docker-compose.yml ps --format json 2>/dev/null | \
               python3 -c \"import sys,json; d=json.load(sys.stdin); \
               [print(c['Service']+': '+c['State']) for c in d]\" 2>/dev/null || echo 'unavailable'" \
    2>/dev/null || echo "SSH_ERROR")

  if [[ "$docker_status" != "SSH_ERROR" && "$docker_status" != "unavailable" ]]; then
    while IFS= read -r line; do
      if [[ "$line" == *"running"* ]]; then
        check_ok "  Container: $line"
      else
        check_warn "  Container: $line"
      fi
    done <<< "$docker_status"
  else
    check_warn "  Could not read container status"
  fi

  # ── Cloud Run MCP Server ───────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}  Cloud Run — MCP Server${NC}"
  local cr_status cr_url
  cr_status=$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --region="$CLAWMAIL_GCP_REGION" \
    --format="value(status.conditions[0].status)" 2>/dev/null || echo "NOT_FOUND")
  cr_url=$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --region="$CLAWMAIL_GCP_REGION" \
    --format="value(status.url)" 2>/dev/null || echo "")

  if [[ "$cr_status" == "True" ]]; then
    check_ok "Cloud Run service: READY"
  else
    check_fail "Cloud Run service: ${cr_status}"
    overall_ok=1
  fi

  if [[ -n "$cr_url" ]]; then
    # Probe the MCP server health (unauthenticated GET /mcp should return 401 or 200)
    local http_code
    http_code=$(curl -sf -o /dev/null -w "%{http_code}" \
      -H "X-API-Key: health-probe" \
      "${cr_url}/mcp" 2>/dev/null || echo "000")
    if [[ "$http_code" == "200" || "$http_code" == "401" || "$http_code" == "405" ]]; then
      check_ok "MCP endpoint reachable (HTTP ${http_code})"
    else
      check_fail "MCP endpoint unreachable (HTTP ${http_code})"
      overall_ok=1
    fi
    echo -e "       URL: ${CYAN}${cr_url}/mcp${NC}"
  fi

  # ── Cloud SQL ──────────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}  Cloud SQL — PostgreSQL${NC}"
  local sql_state
  sql_state=$(gcloud sql instances describe clawmail \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --format="value(state)" 2>/dev/null || echo "NOT_FOUND")

  if [[ "$sql_state" == "RUNNABLE" ]]; then
    check_ok "Cloud SQL instance: RUNNABLE"
  else
    check_fail "Cloud SQL instance: ${sql_state}"
    overall_ok=1
  fi

  # ── GCS Bucket ────────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}  Cloud Storage — Attachments bucket${NC}"
  local bucket_name
  bucket_name="clawmail-attachments-${CLAWMAIL_GCP_PROJECT}"
  if gsutil ls "gs://${bucket_name}" &>/dev/null; then
    check_ok "GCS bucket accessible: gs://${bucket_name}"
  else
    check_fail "GCS bucket not found: gs://${bucket_name}"
    overall_ok=1
  fi

  # ── DNS ───────────────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}  DNS — MX record propagation${NC}"
  local mx_record
  mx_record=$(dig +short MX "$CLAWMAIL_DOMAIN" 2>/dev/null || echo "")
  if [[ -n "$mx_record" ]]; then
    check_ok "MX record found for ${CLAWMAIL_DOMAIN}"
    echo "       $mx_record"
  else
    check_warn "MX record not found for ${CLAWMAIL_DOMAIN} (DNS may still be propagating)"
  fi

  local spf_record
  spf_record=$(dig +short TXT "$CLAWMAIL_DOMAIN" 2>/dev/null | grep "v=spf1" || echo "")
  if [[ -n "$spf_record" ]]; then
    check_ok "SPF record found"
  else
    check_warn "SPF record not found (DNS may still be propagating)"
  fi

  # ── Summary ───────────────────────────────────────────────────────────────
  echo ""
  if [[ $overall_ok -eq 0 ]]; then
    echo -e "  ${GREEN}${BOLD}All checks passed.${NC}"
  else
    echo -e "  ${YELLOW}${BOLD}Some checks failed — review the output above.${NC}"
  fi
  echo ""
  return $overall_ok
}

# ---------------------------------------------------------------------------
# Stop command
# ---------------------------------------------------------------------------
cmd_stop() {
  load_config
  header "Stopping Clawmail services"

  echo ""
  warn "This will:"
  echo "  • Scale Cloud Run MCP server to 0 instances (no traffic served)"
  echo "  • Stop the Stalwart Compute Engine VM (mail delivery paused)"
  echo "  • Cloud SQL and GCS are left running (data preserved)"
  echo ""
  read -rp "  Continue? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }

  echo ""

  # Scale Cloud Run to 0
  log "Scaling Cloud Run service to 0 instances..."
  if gcloud run services update "$CLOUD_RUN_SERVICE" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --region="$CLAWMAIL_GCP_REGION" \
    --min-instances=0 \
    --max-instances=0 \
    --quiet 2>/dev/null; then
    success "Cloud Run scaled to 0"
  else
    warn "Cloud Run service not found or already stopped"
  fi

  # Stop the Stalwart VM
  log "Stopping Stalwart VM: $VM_NAME..."
  if gcloud compute instances stop "$VM_NAME" \
    --project="$CLAWMAIL_GCP_PROJECT" \
    --zone="$CLAWMAIL_GCP_ZONE" \
    --quiet 2>/dev/null; then
    success "VM stopped: $VM_NAME"
  else
    warn "VM not found or already stopped"
  fi

  echo ""
  success "Services stopped."
  echo ""
  echo -e "  To restart, run: ${CYAN}./deploy/clawmail.sh deploy${NC}"
  echo -e "  To start the VM only:"
  echo "    gcloud compute instances start ${VM_NAME} \\"
  echo "      --project=${CLAWMAIL_GCP_PROJECT} --zone=${CLAWMAIL_GCP_ZONE}"
  echo ""
}

# ---------------------------------------------------------------------------
# Rollback command
# ---------------------------------------------------------------------------
cmd_rollback() {
  load_config
  header "Rolling back to a previous Cloud Run revision"

  echo ""
  log "Recent Cloud Run revisions:"
  echo ""

  # List revisions with timestamps and images
  gcloud run revisions list \
    --service "$CLOUD_RUN_SERVICE" \
    --region "$CLAWMAIL_GCP_REGION" \
    --project "$CLAWMAIL_GCP_PROJECT" \
    --format="table(name,status.conditions[0].lastTransitionTime,spec.containers[0].image)" \
    --limit 10

  echo ""
  read -rp "Enter revision name to roll back to (e.g. clawmail-mcp-00081-abc): " REVISION

  if [[ -z "$REVISION" ]]; then
    error "No revision specified."
    exit 1
  fi

  log "Switching all traffic to revision: $REVISION"
  if gcloud run services update-traffic "$CLOUD_RUN_SERVICE" \
    --region "$CLAWMAIL_GCP_REGION" \
    --project "$CLAWMAIL_GCP_PROJECT" \
    --to-revisions "$REVISION=100" \
    --quiet; then
    success "Traffic switched to $REVISION"
    echo ""
    echo -e "  ${CYAN}MCP endpoint will start serving the rolled-back revision.${NC}"
    echo "  Propagation should take 10-30 seconds."
  else
    error "Failed to switch traffic to $REVISION"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Versions command
# ---------------------------------------------------------------------------
cmd_versions() {
  load_config
  header "Recent MCP server images in Artifact Registry"

  echo ""
  log "Listing recent docker images:"
  echo ""

  gcloud artifacts docker images list \
    "${CLAWMAIL_GCP_REGION}-docker.pkg.dev/${CLAWMAIL_GCP_PROJECT}/clawmail/mcp-server" \
    --include-tags \
    --limit 20 \
    --format="table(version,tags,createTime)"

  echo ""
  log "To redeploy a specific version:"
  echo "  git checkout <commit-sha>"
  echo "  CLAWMAIL_IMAGE_TAG=git-<sha> ./deploy/clawmail.sh deploy"
  echo ""
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
cmd_help() {
  echo ""
  echo -e "${BOLD}clawmail.sh${NC} — Clawmail deployment management"
  echo ""
  echo -e "${BOLD}Usage:${NC}"
  echo "  ./deploy/clawmail.sh <command>"
  echo ""
  echo -e "${BOLD}Commands:${NC}"
  echo "  deploy   Full deployment — provisions GCP infrastructure, builds and"
  echo "           pushes the MCP server Docker image, configures Stalwart on VM."
  echo "           Safe to re-run (Terraform is idempotent)."
  echo "           Images are tagged with git-<SHA> + :latest for versioning."
  echo ""
  echo "  health   Checks all system components and prints a status table:"
  echo "           VM, Stalwart health endpoint, Cloud Run, Cloud SQL,"
  echo "           GCS bucket, DNS MX/SPF records."
  echo ""
  echo "  versions Lists recent MCP server images in Artifact Registry"
  echo "           with tags and creation timestamps."
  echo ""
  echo "  rollback Switches Cloud Run traffic to a previous revision."
  echo "           Fast recovery (no rebuild needed, ~30 seconds)."
  echo ""
  echo "  stop     Gracefully stops Cloud Run (scale → 0) and the Stalwart VM."
  echo "           Data in Cloud SQL and GCS is preserved."
  echo ""
  echo "  help     Show this help."
  echo ""
  echo -e "${BOLD}Config:${NC}"
  echo "  cp deploy/config.example.sh deploy/config.sh"
  echo "  # fill in GCP project, domain, passwords, API keys"
  echo "  ./deploy/clawmail.sh deploy"
  echo ""
  echo -e "${BOLD}Override image tag:${NC}"
  echo "  CLAWMAIL_IMAGE_TAG=git-abc1234 ./deploy/clawmail.sh deploy"
  echo ""
  echo -e "${BOLD}Override config path:${NC}"
  echo "  CLAWMAIL_CONFIG=/path/to/config.sh ./deploy/clawmail.sh deploy"
  echo ""
  echo -e "${BOLD}Prerequisites:${NC}"
  echo "  gcloud  — authenticated (gcloud auth login)"
  echo "  terraform >= 1.6"
  echo "  docker  — daemon running, logged into Artifact Registry"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "${1:-help}" in
  deploy)   cmd_deploy  ;;
  health)   cmd_health  ;;
  rollback) cmd_rollback ;;
  versions) cmd_versions ;;
  stop)     cmd_stop    ;;
  help|--help|-h) cmd_help ;;
  *)
    error "Unknown command: ${1}"
    cmd_help
    exit 1
    ;;
esac
