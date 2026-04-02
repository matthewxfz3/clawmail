#!/usr/bin/env bash
# Patch all existing individual accounts with email-receive permission.
# Stalwart v0.15 requires this permission for inbound SMTP delivery.
# Accounts created before the createAccount fix don't have it.
#
# Usage:
#   STALWART_URL=http://<stalwart-vm-ip>:8080 \
#   STALWART_ADMIN_PASSWORD=<password> \
#   bash scripts/patch-email-receive.sh

set -euo pipefail

STALWART_URL="${STALWART_URL:-http://localhost:8080}"
ADMIN_USER="${STALWART_ADMIN_USER:-admin}"
ADMIN_PASS="${STALWART_ADMIN_PASSWORD:?STALWART_ADMIN_PASSWORD must be set}"

echo "Fetching all individual accounts from $STALWART_URL ..."
ACCOUNTS=$(curl -sf -u "$ADMIN_USER:$ADMIN_PASS" \
  "$STALWART_URL/api/principal?type=individual&page=0&limit=100" | \
  jq -r '.data // .data.items // [] | .[] | .name // .id // empty')

if [ -z "$ACCOUNTS" ]; then
  echo "No individual accounts found."
  exit 0
fi

echo "Found accounts:"
echo "$ACCOUNTS"
echo ""

for name in $ACCOUNTS; do
  echo -n "Patching $name ... "
  RESULT=$(curl -sf -X PATCH \
    -H "Content-Type: application/json" \
    -u "$ADMIN_USER:$ADMIN_PASS" \
    -d '[{"action":"addItem","field":"enabledPermissions","value":"email-receive"}]' \
    "$STALWART_URL/api/principal/$name")
  echo "$RESULT"
done

echo ""
echo "Done. All accounts patched with email-receive permission."
