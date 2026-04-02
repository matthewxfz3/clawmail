#!/usr/bin/env bash
# Clawmail — full environment teardown script
#
# ⚠️  WARNING: This permanently deletes ALL Clawmail infrastructure:
#       - Cloud Run service (MCP server)
#       - Compute Engine VM (Stalwart + all emails stored on disk)
#       - Cloud SQL instance (all account and email metadata)
#       - GCS bucket (all email blobs/attachments)
#       - Cloud DNS zone (all DNS records)
#       - Secret Manager secrets
#       - Artifact Registry repository
#
#   This action is IRREVERSIBLE. All email data will be lost.
#
# Usage:
#   bash scripts/destroy.sh
#
# Environment variables (all prompted interactively if not set):
#   PROJECT_ID   GCP project ID
#   REGION       GCP region (default: us-west1)
#   ZONE         GCP zone (default: us-west1-a)
#   DOMAIN       Mail domain (must match the deployed config)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/../infra" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[destroy]${NC} $*"; }
success() { echo -e "${GREEN}[destroy]${NC} $*"; }
warn()    { echo -e "${YELLOW}[destroy]${NC} $*"; }
error()   { echo -e "${RED}[destroy]${NC} $*" >&2; }

prompt() {
  local var="$1" prompt_text="$2" default="${3:-}"
  if [[ -n "${!var:-}" ]]; then return; fi
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

# ---------------------------------------------------------------------------
# Gather inputs
# ---------------------------------------------------------------------------
echo ""
echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║   ⚠️  CLAWMAIL DESTROY — PERMANENT DATA LOSS ⚠️       ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${RED}This will PERMANENTLY DELETE:${NC}"
echo "  • Cloud Run MCP server"
echo "  • Stalwart VM and ALL stored emails"
echo "  • Cloud SQL database (all accounts + metadata)"
echo "  • GCS bucket (all email blobs)"
echo "  • Cloud DNS zone"
echo "  • Secret Manager secrets"
echo "  • Artifact Registry repository"
echo ""
echo -e "${RED}This action cannot be undone.${NC}"
echo ""

prompt PROJECT_ID "GCP project ID"
prompt REGION "GCP region" "us-west1"
prompt ZONE "GCP zone" "us-west1-a"
prompt DOMAIN "Mail domain (must match deployed config)"

# ---------------------------------------------------------------------------
# Confirmation 1 — are you sure?
# ---------------------------------------------------------------------------
echo ""
echo -e "${RED}You are about to destroy the Clawmail environment for:${NC}"
echo "  Project: $PROJECT_ID"
echo "  Domain:  $DOMAIN"
echo ""
read -rp "$(echo -e "${RED}First confirmation${NC} — Type 'destroy' to continue: ")" confirm1
if [[ "$confirm1" != "destroy" ]]; then
  echo "Aborted. Nothing was deleted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Confirmation 2 — really sure?
# ---------------------------------------------------------------------------
echo ""
warn "Last chance. This will erase all email data in $PROJECT_ID."
echo ""
read -rp "$(echo -e "${RED}Second confirmation${NC} — Type the project ID '$PROJECT_ID' to confirm: ")" confirm2
if [[ "$confirm2" != "$PROJECT_ID" ]]; then
  echo "Aborted. Project ID did not match. Nothing was deleted."
  exit 0
fi

echo ""
warn "Proceeding with destruction in 5 seconds... Press Ctrl+C to abort."
sleep 5

# ---------------------------------------------------------------------------
# Step 1 — Terraform destroy
# ---------------------------------------------------------------------------
info "Step 1/2 — Running terraform destroy..."
cd "$INFRA_DIR"

# terraform destroy requires the same variables as apply.
# Sensitive vars are not needed for destroy — Terraform only needs them
# for resource addresses that use them (like secrets). We pass dummy
# values for sensitive vars since destroy doesn't create anything.
terraform init -input=false

terraform destroy \
  -input=false \
  -auto-approve \
  -var "project_id=$PROJECT_ID" \
  -var "region=$REGION" \
  -var "zone=$ZONE" \
  -var "domain=$DOMAIN" \
  -var "sendgrid_api_key=DESTROY_PLACEHOLDER" \
  -var "stalwart_admin_password=DESTROY_PLACEHOLDER" \
  -var "db_password=DESTROY_PLACEHOLDER" \
  -var "mcp_api_key=DESTROY_PLACEHOLDER" \
  -var "dashboard_password=DESTROY_PLACEHOLDER" \
  -var "mcp_server_image=DESTROY_PLACEHOLDER"

success "Terraform resources destroyed."

# ---------------------------------------------------------------------------
# Step 2 — Delete Terraform state bucket (optional, manual)
# ---------------------------------------------------------------------------
info "Step 2/2 — Cleanup note:"
echo ""
echo "  The Terraform state bucket (clawmail-tfstate) was NOT deleted automatically."
echo "  If you want to fully clean up, delete it manually:"
echo ""
echo "    gcloud storage rm -r gs://clawmail-tfstate --project=$PROJECT_ID"
echo ""

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       Destroy Complete               ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
success "All Clawmail infrastructure in project '$PROJECT_ID' has been removed."
echo ""
