#!/usr/bin/env bash
#
# install-strapi5.sh — bootstrap a fresh Strapi 5 (JavaScript) destination
#                     for the ICJIA public website migration.
#
# Automates everything the migration tool needs:
#   1. Wipes any existing target directory (with confirmation)
#   2. Runs create-strapi-app with the canonical flags (--javascript, etc.)
#   3. Sets PORT in .env
#   4. Installs @strapi/plugin-graphql
#   5. Rebuilds native bindings (better-sqlite3, sharp) — the step pnpm 10+
#      blocks by default and the most common first-time error
#   6. Prints clear next-steps for the manual bits (admin user, API token)
#
# What this script does NOT do (cannot — they require a browser):
#   - Create the Strapi 5 admin user
#   - Generate the API token
#   - Paste the token into config.js
#
# Usage:
#   ./install-strapi5.sh                    # local dev (port 1337, dir ../icjia-public-strapi5)
#   ./install-strapi5.sh --port=5150        # custom port
#   ./install-strapi5.sh --target=/tmp/foo  # custom target dir
#   ./install-strapi5.sh --force            # skip the "wipe existing dir" confirmation
#   ./install-strapi5.sh --help             # show this help

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Defaults & arg parsing
# ─────────────────────────────────────────────────────────────────────

# Default target: sibling of this repo named icjia-public-strapi5
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_TARGET="$(cd "$SCRIPT_DIR/.." && pwd)/icjia-public-strapi5"

TARGET="$DEFAULT_TARGET"
PORT="1337"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
    --port=*)   PORT="${arg#--port=}" ;;
    --force)    FORCE=1 ;;
    --help|-h)
      sed -n '2,/^set/p' "$0" | sed 's/^# //;s/^#//' | head -n 25
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────
# Colors (only if stdout is a TTY)
# ─────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; BOLD=""; DIM=""; RESET=""
fi

step() { echo ""; echo "${BOLD}── $* ──${RESET}"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
fail() { echo "${RED}ERROR:${RESET} $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────
# Sanity checks
# ─────────────────────────────────────────────────────────────────────

step "Sanity checks"

command -v node >/dev/null || fail "node not found on PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node $NODE_MAJOR detected; need Node 22+ (see .nvmrc). Run: nvm install 22 && nvm use 22"
fi
ok "Node $(node --version)"

command -v pnpm >/dev/null || fail "pnpm not found. Install with: npm install -g pnpm@latest"
ok "pnpm $(pnpm --version)"

command -v npx >/dev/null || fail "npx not found"

# ─────────────────────────────────────────────────────────────────────
# Confirm target wipe
# ─────────────────────────────────────────────────────────────────────

step "Target directory"
echo "  ${CYAN}$TARGET${RESET}"

if [ -d "$TARGET" ]; then
  if [ "$FORCE" -eq 1 ]; then
    warn "Existing directory will be REMOVED (--force)"
  else
    echo ""
    echo "  ${YELLOW}!${RESET} Directory exists. This script will ${BOLD}remove it${RESET}"
    echo "    and replace with a fresh Strapi 5 install."
    echo ""
    read -rp "  Proceed? [y/N] " confirm
    case "$confirm" in
      [yY]|[yY][eE][sS]) ;;
      *) echo "Aborted."; exit 1 ;;
    esac
  fi
  rm -rf "$TARGET"
  ok "Removed existing $TARGET"
fi

# ─────────────────────────────────────────────────────────────────────
# Run create-strapi-app
# ─────────────────────────────────────────────────────────────────────

step "Creating Strapi 5 (JavaScript) project"

PARENT_DIR="$(dirname "$TARGET")"
PROJECT_NAME="$(basename "$TARGET")"

cd "$PARENT_DIR"

# Run the installer non-interactively. Flags:
#   --quickstart    use SQLite, skip DB prompts
#   --no-run        don't auto-launch
#   --skip-cloud    skip the Strapi Cloud signup prompt
#   --skip-db       skip the DB-type prompt (SQLite is the default with --quickstart)
#   --javascript    JS not TS (matches the migration tool's generated boilerplate)
echo "  Running: ${DIM}npx create-strapi-app@latest $PROJECT_NAME --quickstart --no-run --skip-cloud --skip-db --javascript${RESET}"
echo ""

npx --yes create-strapi-app@latest "$PROJECT_NAME" \
  --quickstart \
  --no-run \
  --skip-cloud \
  --skip-db \
  --javascript

cd "$TARGET"
ok "Project created"

# ─────────────────────────────────────────────────────────────────────
# Configure port
# ─────────────────────────────────────────────────────────────────────

step "Setting PORT=$PORT in .env"

# Remove any existing PORT lines first to avoid duplicates on re-runs
if [ -f .env ]; then
  grep -v "^PORT=" .env > .env.tmp || true
  mv .env.tmp .env
fi
echo "PORT=$PORT" >> .env
ok ".env now sets PORT=$PORT"

# ─────────────────────────────────────────────────────────────────────
# Install GraphQL plugin
# ─────────────────────────────────────────────────────────────────────

step "Installing @strapi/plugin-graphql"

# Required by the migration tool's Phase 1c verification.
pnpm add @strapi/plugin-graphql
ok "@strapi/plugin-graphql installed"

# ─────────────────────────────────────────────────────────────────────
# Rebuild native bindings (CRITICAL — pnpm 10+ blocks build scripts)
# ─────────────────────────────────────────────────────────────────────

step "Building native bindings (better-sqlite3, sharp)"

# pnpm 10+ blocks build scripts by default for security. Strapi needs the
# native .node binaries built or it fails with "Could not locate the
# bindings file" at startup. This is the most common first-time error.
pnpm rebuild better-sqlite3 sharp
ok "Native bindings built"

# ─────────────────────────────────────────────────────────────────────
# Done — print next steps
# ─────────────────────────────────────────────────────────────────────

step "Strapi 5 is ready to launch"
echo ""
echo "${GREEN}${BOLD}Install complete.${RESET}"
echo ""
echo "${BOLD}Next (these require a human in the browser):${RESET}"
echo ""
echo "  ${CYAN}1.${RESET} Launch Strapi 5"
echo "       ${DIM}cd $TARGET${RESET}"
echo "       ${DIM}pnpm develop${RESET}"
echo "       Wait for: ${GREEN}Strapi started successfully${RESET}"
echo ""
echo "  ${CYAN}2.${RESET} Open the admin in your browser"
echo "       ${DIM}http://localhost:$PORT/admin${RESET}"
echo "       Create the first admin user (any email/password)"
echo ""
echo "  ${CYAN}3.${RESET} Generate an API token"
echo "       Settings → Global Settings → API Tokens → ${BOLD}+ Create new API Token${RESET}"
echo "       ${YELLOW}Token type: Full access${RESET}  (NOT Read-only — write phases will fail)"
echo "       Token duration: Unlimited"
echo "       Copy the token (shown ${BOLD}once${RESET} at creation)"
echo ""
echo "  ${CYAN}4.${RESET} Set the token for the migration tool"
echo "       Edit ${CYAN}config.js${RESET} (gitignored) and paste into strapi5.token"
echo "       ${DIM}Or:${RESET} ${DIM}export STRAPI5_TOKEN=\"<paste here>\"${RESET}  (per-shell)"
echo ""
echo "  ${CYAN}5.${RESET} From the migration tool repo, kick off the full pipeline"
echo "       ${DIM}cd $SCRIPT_DIR${RESET}"
echo "       ${DIM}pnpm preflight${RESET}      ${DIM}# verify everything is wired${RESET}"
echo "       ${DIM}pnpm migrate:full${RESET}   ${DIM}# preflight → phases 1-7 → postflight${RESET}"
echo ""
