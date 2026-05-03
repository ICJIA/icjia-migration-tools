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
# Migration state reset:
#   By default this script ALSO wipes the migration tool's working state
#   (migration/data/, migration/output/, migration/config/field-map.json)
#   so a re-run starts truly from scratch. Pass --keep-migration-data to
#   preserve cached extracts and downloaded media.
#
# Usage:
#   ./install-strapi5.sh                    # local dev (port 1337, dir ../icjia-public-strapi5)
#   ./install-strapi5.sh --port=5150        # custom port
#   ./install-strapi5.sh --target=/tmp/foo  # custom target dir
#   ./install-strapi5.sh --force            # skip the "wipe existing dir" confirmation
#   ./install-strapi5.sh --keep-migration-data  # don't wipe migration/data + output
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
KEEP_MIGRATION_DATA=0
MIGRATION_REPO="$SCRIPT_DIR"

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
    --port=*)   PORT="${arg#--port=}" ;;
    --force)    FORCE=1 ;;
    --keep-migration-data) KEEP_MIGRATION_DATA=1 ;;
    --help|-h)
      sed -n '2,/^set/p' "$0" | sed 's/^# //;s/^#//' | head -n 35
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
# Wipe migration tool's working state (true fresh start)
# ─────────────────────────────────────────────────────────────────────

if [ "$KEEP_MIGRATION_DATA" -eq 0 ]; then
  step "Wiping migration tool's working state"
  for path in \
    "$MIGRATION_REPO/migration/data" \
    "$MIGRATION_REPO/migration/output" \
    "$MIGRATION_REPO/migration/config/field-map.json"; do
    if [ -e "$path" ]; then
      rm -rf "$path"
      ok "removed $(basename "$(dirname "$path")")/$(basename "$path")"
    fi
  done
  ok "migration state cleared (Phase 0 baseline)"
else
  step "Keeping migration data (--keep-migration-data)"
  warn "Cached extracts, downloaded media, and ID maps preserved"
fi

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
# Build native bindings (CRITICAL — pnpm 10+ blocks build scripts)
# ─────────────────────────────────────────────────────────────────────

step "Approving native build scripts in package.json"

# pnpm 10+ blocks all install/postinstall scripts unless the package is
# listed in `pnpm.onlyBuiltDependencies`. Even `pnpm rebuild` is a no-op
# without this allowlist — that's why the previous "rebuild only" approach
# silently produced no .node binaries and Strapi crashed at startup with
# "Could not locate the bindings file".
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.pnpm = pkg.pnpm || {};
pkg.pnpm.onlyBuiltDependencies = [
  'better-sqlite3',
  'sharp',
  'esbuild',
  '@swc/core',
  'core-js-pure',
  '@apollo/protobufjs',
  'prebuild-install',
];
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Added pnpm.onlyBuiltDependencies allowlist');
"
ok "package.json updated with build-script allowlist"

step "Reinstalling with build scripts enabled"

# Force a fresh install so the now-approved scripts actually run.
pnpm install --reporter default
ok "pnpm install completed with build scripts"

# ─────────────────────────────────────────────────────────────────────
# Verify the binding actually exists; fall back to node-gyp if not
# ─────────────────────────────────────────────────────────────────────

step "Verifying better-sqlite3 native binding"

# Find the actual path (pnpm's content-addressable hashing makes this hairy)
BINDING=$(find node_modules/.pnpm/better-sqlite3* -name "better_sqlite3.node" 2>/dev/null | head -1)

if [ -n "$BINDING" ] && [ -f "$BINDING" ]; then
  ok "binding present at $BINDING"
else
  warn "binding not found — falling back to direct node-gyp build"
  BSQ_DIR=$(find node_modules/.pnpm -type d -name "better-sqlite3" -path "*/better-sqlite3@*/node_modules/better-sqlite3" 2>/dev/null | head -1)
  if [ -z "$BSQ_DIR" ]; then
    fail "could not locate better-sqlite3 install directory under node_modules/.pnpm — install is broken"
  fi
  echo "  Building in: $BSQ_DIR"
  (cd "$BSQ_DIR" && npx --yes node-gyp rebuild) || fail "node-gyp rebuild failed"
  BINDING=$(find node_modules/.pnpm/better-sqlite3* -name "better_sqlite3.node" 2>/dev/null | head -1)
  if [ -z "$BINDING" ] || [ ! -f "$BINDING" ]; then
    fail "binding STILL not found after node-gyp. Manual debug:
      cd $BSQ_DIR
      npx node-gyp rebuild --verbose"
  fi
  ok "binding built at $BINDING"
fi

# ─────────────────────────────────────────────────────────────────────
# Write PM2 ecosystem file (used in production)
# ─────────────────────────────────────────────────────────────────────

step "Writing PM2 ecosystem file"

# App name derives from the install dir basename, with a fallback.
APP_NAME="$(basename "$TARGET")"
[ -z "$APP_NAME" ] && APP_NAME="icjia-public-strapi5"

cat > "$TARGET/ecosystem.config.cjs" <<EOF
// PM2 ecosystem config for Strapi 5 (auto-generated by install-strapi5.sh).
// Production usage:
//   cd $TARGET
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # follow the printed sudo command to enable on boot
//
// Strapi reads APP_KEYS, JWT secrets, and the database path from .env
// (auto-generated by create-strapi-app); no need to duplicate them here.

module.exports = {
  apps: [
    {
      name: '$APP_NAME',
      cwd: '$TARGET',
      script: 'pnpm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: '$PORT',
      },
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
      // Logs land under PM2's default log dir (~/.pm2/logs/<name>-out.log).
      // Override here if you want them somewhere specific:
      //   out_file: '/var/log/$APP_NAME/out.log',
      //   error_file: '/var/log/$APP_NAME/error.log',
      //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
EOF
ok "wrote $TARGET/ecosystem.config.cjs (app name: $APP_NAME, port: $PORT)"

# ─────────────────────────────────────────────────────────────────────
# Symlink update.sh into the Strapi 5 dir
# ─────────────────────────────────────────────────────────────────────
# So the editor can cd into the Strapi 5 install and run ./update.sh
# directly without having to remember the migration-tools repo path.
# update.sh's SCRIPT_DIR resolution follows the symlink back to the repo.

step "Linking update.sh into the Strapi 5 dir"

UPDATE_SRC="$SCRIPT_DIR/update.sh"
UPDATE_LINK="$TARGET/update.sh"

if [ ! -f "$UPDATE_SRC" ]; then
  warn "update.sh not found at $UPDATE_SRC — skipping symlink"
elif [ -e "$UPDATE_LINK" ] || [ -L "$UPDATE_LINK" ]; then
  rm -f "$UPDATE_LINK"
  ln -s "$UPDATE_SRC" "$UPDATE_LINK"
  ok "replaced $UPDATE_LINK → $UPDATE_SRC"
else
  ln -s "$UPDATE_SRC" "$UPDATE_LINK"
  ok "linked $UPDATE_LINK → $UPDATE_SRC"
fi

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
echo "${BOLD}Production (PM2):${RESET}"
echo "  PM2 ecosystem file generated at:"
echo "       ${CYAN}$TARGET/ecosystem.config.cjs${RESET}"
echo "  Start under PM2:"
echo "       ${DIM}cd $TARGET${RESET}"
echo "       ${DIM}pm2 start ecosystem.config.cjs${RESET}"
echo "       ${DIM}pm2 save${RESET}                  ${DIM}# persist across reboots${RESET}"
echo "       ${DIM}pm2 startup${RESET}               ${DIM}# follow the printed sudo command${RESET}"
echo ""
echo "${BOLD}Incremental sync (after the first migration):${RESET}"
echo "  ${CYAN}update.sh${RESET} is symlinked into the Strapi 5 dir, so:"
echo "       ${DIM}cd $TARGET${RESET}"
echo "       ${DIM}./update.sh --target=local --update-newer${RESET}    ${DIM}# pull latest Strapi 3 changes${RESET}"
echo "  (Symlink target: ${DIM}$UPDATE_SRC${RESET} — don't move the migration-tools repo or the link breaks.)"
echo ""
if [ "$KEEP_MIGRATION_DATA" -eq 0 ]; then
  echo "  ${DIM}(Migration state was wiped — Phase 1+ will rebuild from scratch.)${RESET}"
else
  echo "  ${DIM}(Migration data was kept — Phase 2 extracts and Phase 3 downloads will skip cached items.)${RESET}"
fi
echo ""
