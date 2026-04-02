#!/usr/bin/env bash
# Install Clawmail git hooks.
# Run once after cloning: bash scripts/install-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[hooks]${NC} $*"; }
success() { echo -e "${GREEN}[hooks]${NC} $*"; }

install_hook() {
  local name="$1"
  local src="$REPO_ROOT/scripts/hooks/$name"
  local dst="$HOOKS_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "Hook source not found: $src" >&2
    return 1
  fi

  cp "$src" "$dst"
  chmod +x "$dst"
  info "Installed $name"
}

mkdir -p "$HOOKS_DIR"
install_hook pre-commit

success "Hooks installed. Run 'git commit' to test."
