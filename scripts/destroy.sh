#!/usr/bin/env bash
# Clawmail — full environment teardown script
#
# WARNING: This permanently deletes ALL Clawmail infrastructure:
#   - Cloud Run service (MCP server)
#   - Compute Engine VM (Stalwart + all emails stored on disk)
#   - Cloud SQL instance (all account and email metadata)
#   - GCS bucket (all email blobs/attachments)
#   - Cloud DNS zone (all DNS records)
#   - Secret Manager secrets
#   - Artifact Registry repository
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

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLUE}[destroy]${NC} $*"; }
success() { echo -e "${GREEN}[destroy]${NC} $*"; }
warn()    { echo -e "${YELLOW}[destroy]${NC} $*"; }
error()   { echo -e "${RED}[destroy]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
for cmd in gcloud terraform; do
  if ! command -v "$cmd" &>/dev/null; then
    error "Required tool not found: $cmd"
    exit 1
  fi
done

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
# Banner
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
echo "  • Cloud DNS zone (all DNS records)"
echo "  • Secret Manager secrets"
echo "  • Artifact Registry repository"
echo ""
echo -e "${RED}${BOLD}This action CANNOT be undone. All email data will be lost.${NC}"
echo ""

# ---------------------------------------------------------------------------
# Gather inputs
# ---------------------------------------------------------------------------
prompt PROJECT_ID "GCP project ID"
prompt REGION "GCP region" "us-west1"
prompt ZONE "GCP zone" "us-west1-a"
prompt DOMAIN "Mail domain (must match deployed config)"

# ---------------------------------------------------------------------------
# Confirmation 1 — type the word 'destroy'
# ---------------------------------------------------------------------------
echo ""
echo -e "${RED}You are about to destroy the Clawmail environment for:${NC}"
echo "  Project: $PROJECT_ID"
echo "  Region:  $REGION"
echo "  Domain:  $DOMAIN"
echo ""
read -rp "$(echo -e "${RED}Confirmation 1/2${NC} — type ${BOLD}'destroy'${NC} to continue: ")" confirm1
if [[ "$confirm1" != "destroy" ]]; then
  echo ""
  echo "Aborted. Nothing was deleted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Confirmation 2 — type the exact project ID
# ---------------------------------------------------------------------------
echo ""
warn "Last chance. This will permanently erase ALL data in project '$PROJECT_ID'."
echo ""
read -rp "$(echo -e "${RED}Confirmation 2/2${NC} — type the project ID ${BOLD}'${PROJECT_ID}'${NC} to confirm: ")" confirm2
if [[ "$confirm2" != "$PROJECT_ID" ]]; then
  echo ""
  echo "Aborted. Project ID did not match. Nothing was deleted."
  exit 0
fi

echo ""
warn "Proceeding with destruction in 5 seconds... Press Ctrl+C to abort."
for i in 5 4 3 2 1; do
  echo -ne "\r  ${RED}${i}...${NC}  "
  sleep 1
done
echo -e "\r  Starting destruction."
echo ""

# ---------------------------------------------------------------------------
# Step 1 — Terraform destroy
# ---------------------------------------------------------------------------
info "Step 1/2 — Running terraform destroy..."
cd "$INFRA_DIR"

# Terraform destroy requires the same variables as apply.
# Sensitive vars are not needed for destroy — we pass dummy values.
info "Initializing Terraform..."
terraform init -input=false

info "Destroying all resources..."
terraform destroy \
  -input=false \
  -auto-approve \
  -var "project_id=$PROJECT_ID" \
  -var "region=$REGION" \
  -var "zone=$ZONE" \
  -var "domain=$DOMAIN" \
  -var "sendgrid_api_key=DESTROY_PLACEHOLDER" \
  -var "sendgrid_verified_sender=noreply@example.com" \
  -var "stalwart_admin_password=DESTROY_PLACEHOLDER" \
  -var "db_password=DESTROY_PLACEHOLDER" \
  -var "mcp_api_key=DESTROY_PLACEHOLDER" \
  -var "dashboard_password=DESTROY_PLACEHOLDER" \
  -var "mcp_server_image=DESTROY_PLACEHOLDER"

success "All Terraform-managed resources destroyed."

# ---------------------------------------------------------------------------
# Step 2 — Manual cleanup note
# ---------------------------------------------------------------------------
echo ""
info "Step 2/2 — Manual cleanup:"
echo ""
echo "  The Terraform state bucket was NOT deleted automatically."
echo "  To fully clean up, delete it manually:"
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
