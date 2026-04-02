#!/usr/bin/env bash
# Clawmail — full environment setup script
#
# This script provisions all GCP infrastructure and deploys Clawmail from scratch.
# It is idempotent: safe to re-run if a previous run was interrupted.
#
# Prerequisites:
#   - gcloud CLI authenticated: gcloud auth login && gcloud auth application-default login
#   - Terraform >= 1.5 installed
#   - Docker installed and running (for building the MCP server image)
#   - jq installed
#
# Usage:
#   bash scripts/setup.sh
#
# Environment variables (all prompted interactively if not set):
#   PROJECT_ID              GCP project ID
#   REGION                  GCP region (default: us-west1)
#   ZONE                    GCP zone (default: us-west1-a)
#   DOMAIN                  Mail domain (e.g. fridaymailer.com)
#   SENDGRID_API_KEY        SendGrid API key
#   STALWART_ADMIN_PASSWORD Stalwart admin password
#   DB_PASSWORD             Cloud SQL password for the stalwart user
#   MCP_API_KEY             API key for MCP server auth
#   DASHBOARD_PASSWORD      Dashboard login password

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
MCP_DIR="$REPO_ROOT/mcp-server"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[setup]${NC} $*"; }
success() { echo -e "${GREEN}[setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[setup]${NC} $*"; }
error()   { echo -e "${RED}[setup]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# Prompt helpers
# ---------------------------------------------------------------------------
prompt() {
  local var="$1" prompt_text="$2" default="${3:-}"
  if [[ -n "${!var:-}" ]]; then
    info "$var already set."
    return
  fi
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${YELLOW}?${NC} $prompt_text [$default]: ")" val
    val="${val:-$default}"
  else
    read -rp "$(echo -e "${YELLOW}?${NC} $prompt_text: ")" val
    while [[ -z "$val" ]]; do
      error "$var is required."
      read -rp "$(echo -e "${YELLOW}?${NC} $prompt_text: ")" val
    done
  fi
  export "$var=$val"
}

prompt_secret() {
  local var="$1" prompt_text="$2"
  if [[ -n "${!var:-}" ]]; then
    info "$var already set."
    return
  fi
  read -rsp "$(echo -e "${YELLOW}?${NC} $prompt_text (hidden): ")" val
  echo ""
  while [[ -z "$val" ]]; do
    error "$var is required."
    read -rsp "$(echo -e "${YELLOW}?${NC} $prompt_text (hidden): ")" val
    echo ""
  done
  export "$var=$val"
}

# ---------------------------------------------------------------------------
# Gather inputs
# ---------------------------------------------------------------------------
echo ""
echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Clawmail Setup Script          ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

prompt PROJECT_ID "GCP project ID"
prompt REGION "GCP region" "us-west1"
prompt ZONE "GCP zone" "us-west1-a"
prompt DOMAIN "Mail domain (e.g. fridaymailer.com)"
prompt_secret SENDGRID_API_KEY "SendGrid API key"
prompt_secret STALWART_ADMIN_PASSWORD "Stalwart admin password (min 12 chars)"
prompt_secret DB_PASSWORD "Cloud SQL password for stalwart user"
prompt_secret MCP_API_KEY "MCP server API key (given to agents)"
prompt_secret DASHBOARD_PASSWORD "Dashboard login password (optional, press Enter to skip)"

echo ""
info "Configuration:"
echo "  Project:  $PROJECT_ID"
echo "  Region:   $REGION / $ZONE"
echo "  Domain:   $DOMAIN"
echo "  Secrets:  SENDGRID_API_KEY=*** STALWART_ADMIN_PASSWORD=*** DB_PASSWORD=*** MCP_API_KEY=***"
echo ""
read -rp "$(echo -e "${YELLOW}?${NC} Proceed with setup? [y/N]: ")" confirm
if [[ "${confirm,,}" != "y" ]]; then
  echo "Aborted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1 — Terraform init + apply
# ---------------------------------------------------------------------------
info "Step 1/5 — Provisioning infrastructure with Terraform..."
cd "$INFRA_DIR"

terraform init -input=false

terraform apply \
  -input=false \
  -auto-approve \
  -var "project_id=$PROJECT_ID" \
  -var "region=$REGION" \
  -var "zone=$ZONE" \
  -var "domain=$DOMAIN" \
  -var "sendgrid_api_key=$SENDGRID_API_KEY" \
  -var "stalwart_admin_password=$STALWART_ADMIN_PASSWORD" \
  -var "db_password=$DB_PASSWORD" \
  -var "mcp_api_key=$MCP_API_KEY" \
  -var "dashboard_password=${DASHBOARD_PASSWORD:-}" \
  -var "mcp_server_image=us-west1-docker.pkg.dev/${PROJECT_ID}/clawmail/mcp-server:latest"

success "Infrastructure provisioned."

# ---------------------------------------------------------------------------
# Step 2 — Get outputs
# ---------------------------------------------------------------------------
info "Step 2/5 — Reading Terraform outputs..."
STALWART_IP=$(terraform output -raw stalwart_ip 2>/dev/null || echo "")
MCP_URL=$(terraform output -raw cloud_run_url 2>/dev/null || echo "")

if [[ -z "$STALWART_IP" ]]; then
  error "Could not read stalwart_ip from Terraform outputs. Check infra/outputs.tf."
  exit 1
fi
info "Stalwart VM IP: $STALWART_IP"
info "MCP URL: $MCP_URL"

# ---------------------------------------------------------------------------
# Step 3 — Build + push MCP server image
# ---------------------------------------------------------------------------
info "Step 3/5 — Building and pushing MCP server image..."
cd "$MCP_DIR"
npm ci --silent
npm run build

gcloud auth configure-docker "us-west1-docker.pkg.dev" --quiet

docker buildx build --platform linux/amd64 \
  -t "us-west1-docker.pkg.dev/${PROJECT_ID}/clawmail/mcp-server:latest" \
  --push .

success "MCP server image pushed."

# ---------------------------------------------------------------------------
# Step 4 — Deploy MCP server to Cloud Run
# ---------------------------------------------------------------------------
info "Step 4/5 — Deploying MCP server to Cloud Run..."
gcloud run services update clawmail-mcp \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --image "us-west1-docker.pkg.dev/${PROJECT_ID}/clawmail/mcp-server:latest"

success "MCP server deployed."

# ---------------------------------------------------------------------------
# Step 5 — Wait for Stalwart to boot + run smoke tests
# ---------------------------------------------------------------------------
info "Step 5/5 — Waiting for Stalwart to become ready..."
BASE="http://${STALWART_IP}:8080"
for i in $(seq 1 24); do
  STATUS=$(/usr/bin/curl -sf -o /dev/null -w "%{http_code}" \
    -u "admin:$STALWART_ADMIN_PASSWORD" "$BASE/api/reload" 2>/dev/null || echo "000")
  if [[ "$STATUS" == "200" ]]; then
    break
  fi
  if [[ "$i" -eq 24 ]]; then
    error "Stalwart did not become ready after 2 minutes. Check VM startup logs."
    error "  gcloud compute instances get-serial-port-output INSTANCE --zone=$ZONE --project=$PROJECT_ID"
    exit 1
  fi
  warn "Stalwart not ready yet (HTTP $STATUS), retrying in 5s... ($i/24)"
  sleep 5
done
success "Stalwart is ready."

# Smoke test: create a test account
info "Running smoke test..."
SMOKE_ACCOUNT="setup-smoke-$$"
CREATE_RESULT=$(/usr/bin/curl -sf -X POST \
  -H "Content-Type: application/json" \
  -u "admin:$STALWART_ADMIN_PASSWORD" \
  -d "{\"type\":\"individual\",\"name\":\"${SMOKE_ACCOUNT}\",\"emails\":[\"${SMOKE_ACCOUNT}@${DOMAIN}\"],\"quota\":10485760,\"enabledPermissions\":[\"email-receive\"]}" \
  "$BASE/api/principal" 2>&1) || true
info "Smoke account creation: $CREATE_RESULT"

# Verify via MCP server
if [[ -n "$MCP_URL" ]]; then
  MCP_RESP=$(/usr/bin/curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-API-Key: $MCP_API_KEY" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_accounts\",\"arguments\":{}}}" \
    "$MCP_URL/mcp" 2>&1) || true
  if echo "$MCP_RESP" | grep -q '"accounts"' 2>/dev/null; then
    success "MCP server smoke test passed."
  else
    warn "MCP server returned unexpected response — check manually: $MCP_URL/mcp"
  fi
fi

# Delete smoke account
/usr/bin/curl -sf -X DELETE \
  -u "admin:$STALWART_ADMIN_PASSWORD" \
  "$BASE/api/principal/$SMOKE_ACCOUNT" > /dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Setup Complete!              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  Stalwart VM:    http://$STALWART_IP:8080"
echo "  MCP endpoint:   $MCP_URL/mcp"
if [[ -n "$MCP_URL" ]]; then
  echo "  Dashboard:      $MCP_URL/dashboard"
fi
echo ""
echo "  MCP config for Claude Desktop / agents:"
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"clawmail\": {"
echo "        \"type\": \"http\","
echo "        \"url\": \"$MCP_URL/mcp\","
echo "        \"headers\": { \"X-API-Key\": \"$MCP_API_KEY\" }"
echo "      }"
echo "    }"
echo "  }"
echo ""
