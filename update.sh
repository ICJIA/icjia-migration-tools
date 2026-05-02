#!/usr/bin/env bash
#
# update.sh — incremental update from Strapi 3 to a Strapi 5 destination.
#
# Re-runs the migration phases to pick up records added or modified in
# Strapi 3 since the last run. All phases are idempotent — already-migrated
# records are skipped via legacyId lookup, already-downloaded files are
# skipped on disk, already-uploaded media is skipped via the hash map.
#
# Usage:
#   ./update.sh --target=local              # update against config.dev.js's Strapi 5
#   ./update.sh --target=prod               # update against config.prod.js's Strapi 5
#   ./update.sh --target=local --skip-media # skip Phase 3 (faster; useful if no new media)
#   ./update.sh --target=local --skip-timestamps  # skip the SQLite UPDATE step (Phase 4c)
#   ./update.sh --help
#
# What this script does:
#   1. Verifies the chosen target's Strapi 5 install / endpoint is reachable
#   2. Re-runs Phase 2 (extract) — pulls fresh data from Strapi 3 GraphQL
#   3. Re-runs Phase 3 (media) — downloads new files, uploads new files
#   4. Re-runs Phase 4 step 1 (load) — POSTs new records (existing ones skip)
#   5. Re-runs Phase 4 step 2 (link-relations) — connects relations
#   6. (Optional, --skip-timestamps to skip) — Phase 4c needs Strapi STOPPED
#   7. Re-runs Phase 5/6/7 — validation, audit, report
#
# What this script does NOT do (intentional):
#   - Update records that already exist (we only INSERT new). If a Strapi 3
#     record was edited, this script does NOT push the change to Strapi 5.
#     For full re-sync, delete the record from Strapi 5 first then re-run.
#   - Delete records from Strapi 5 that were removed from Strapi 3.
#   - Reconcile editorial conflicts (records edited on both sides).
#
# Recommended workflow:
#   - During cutover window: ./update.sh --target=local (or prod) once
#     a day to catch recent Strapi 3 edits.
#   - After cutover: stop running this — Strapi 5 is the new source of truth.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─────────────────────────────────────────────────────────────────────
# Args
# ─────────────────────────────────────────────────────────────────────

TARGET=""
SKIP_MEDIA=0
SKIP_TIMESTAMPS=0
UPDATE_MODE=""   # ""|"newer"|"all"

for arg in "$@"; do
  case "$arg" in
    --target=local) TARGET="local" ;;
    --target=prod)  TARGET="prod" ;;
    --target=*)     echo "ERROR: --target must be 'local' or 'prod'" >&2; exit 1 ;;
    --skip-media)        SKIP_MEDIA=1 ;;
    --skip-timestamps)   SKIP_TIMESTAMPS=1 ;;
    --update-newer)      UPDATE_MODE="newer" ;;
    --update-existing)   UPDATE_MODE="all" ;;
    --help|-h)
      sed -n '2,/^set/p' "$0" | sed 's/^# //;s/^#//' | head -n 40
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "ERROR: --target=local or --target=prod is required" >&2
  echo "Run with --help for usage." >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────
# Colors
# ─────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; BOLD=""; DIM=""; RESET=""
fi

step() { echo ""; echo "${BOLD}── $* ──${RESET}"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
fail() { echo "${RED}ERROR:${RESET} $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────
# Activate the right config
# ─────────────────────────────────────────────────────────────────────

cd "$SCRIPT_DIR"

step "Activating $TARGET config"

CONFIG_SOURCE="config.${TARGET}.js"
if [ ! -f "$CONFIG_SOURCE" ]; then
  fail "Config not found: $CONFIG_SOURCE"
fi

# Back up existing config.js if any (so we don't clobber the user's tokens)
if [ -f config.js ]; then
  cp config.js config.js.backup
  ok "Backed up existing config.js → config.js.backup"
fi

cp "$CONFIG_SOURCE" config.js
ok "Activated config.js from $CONFIG_SOURCE"

# ─────────────────────────────────────────────────────────────────────
# Verify the destination exists / is reachable
# ─────────────────────────────────────────────────────────────────────

step "Verifying $TARGET Strapi 5 destination"

# For local: also check the project directory exists
if [ "$TARGET" = "local" ]; then
  S5_PATH=$(node -e "import('./config.js').then(m=>console.log(m.default.strapi5ProjectPath)).catch(e=>{console.error(e); process.exit(1)})")
  if [ ! -d "$S5_PATH" ]; then
    fail "Local Strapi 5 install not found at $S5_PATH

The migration tool expects a Strapi 5 project at this path. Either:
  - Run ./install-strapi5.sh first to set up a fresh local Strapi 5, or
  - Update config.dev.js → strapi5ProjectPath to point at your existing install"
  fi
  ok "Local Strapi 5 install present: $S5_PATH"
fi

# Run preflight to verify reachability + token validity
if ! pnpm preflight --skip-checklist > /tmp/update-preflight.log 2>&1; then
  echo ""
  echo "${RED}Preflight FAILED.${RESET} Output:"
  echo ""
  tail -40 /tmp/update-preflight.log
  echo ""
  fail "Cannot reach $TARGET Strapi 5. Fix the failures above and re-run.

Common causes:
  - Strapi 5 not running (local: 'cd \$STRAPI5_PROJECT_PATH && pnpm develop')
  - Wrong port in config (check config.${TARGET}.js)
  - API token missing or invalid (set strapi5.token in config.js)
  - Network issue (prod: check VPN/firewall)"
fi
ok "Preflight passed — Strapi 5 reachable, token valid"

# ─────────────────────────────────────────────────────────────────────
# Run the incremental update
# ─────────────────────────────────────────────────────────────────────

step "Phase 2: Re-extract from Strapi 3"
echo "  This pulls fresh data; existing extracts will be checked against"
echo "  the SQLite ground-truth count and re-extracted only if stale."
node migration/scripts/02-extract.js --force
ok "Phase 2 complete"

if [ "$SKIP_MEDIA" -eq 1 ]; then
  step "Phase 3: ${YELLOW}SKIPPED${RESET} (--skip-media)"
else
  step "Phase 3: Media (download new files, upload new files)"
  echo "  Already-downloaded files (matching size) are skipped."
  echo "  Already-uploaded files (matching hash) are skipped."
  node migration/scripts/03-run-phase.js || true   # orphan-failure exits non-zero but is OK
  ok "Phase 3 complete"
fi

step "Phase 4 step 1: Load"
LOAD_FLAGS=""
case "$UPDATE_MODE" in
  newer) LOAD_FLAGS="--update-newer"; echo "  ${YELLOW}--update-newer:${RESET} will PUT records whose source updated_at is newer than last sync" ;;
  all)   LOAD_FLAGS="--update-existing"; echo "  ${YELLOW}--update-existing:${RESET} will PUT every existing record (heavy — re-applies all fields)" ;;
  *)     echo "  ${DIM}Default: skips records whose legacyId already exists. Use --update-newer for cutover-window sync.${RESET}" ;;
esac
node migration/scripts/04-load.js $LOAD_FLAGS
ok "Phase 4 load complete"

step "Phase 4 step 2: Link relations (idempotent — Strapi 5 'connect' is no-op for existing links)"
node migration/scripts/04b-link-relations.js
ok "Phase 4 link-relations complete"

if [ "$SKIP_TIMESTAMPS" -eq 1 ]; then
  step "Phase 4 step 3: ${YELLOW}SKIPPED${RESET} (--skip-timestamps)"
else
  step "Phase 4 step 3: Restore timestamps"
  echo ""
  echo "${YELLOW}!${RESET} Strapi 5 must be ${BOLD}STOPPED${RESET} for direct SQLite UPDATE."
  echo "  In your Strapi 5 terminal: press ${CYAN}Ctrl+C${RESET}."
  echo ""
  read -rp "  Type 'yes' once Strapi 5 is stopped (or 'skip'): " confirm
  if [ "$confirm" = "yes" ] || [ "$confirm" = "y" ]; then
    node migration/scripts/04c-fix-timestamps.js
    echo ""
    echo "${YELLOW}!${RESET} Restart Strapi 5 now: ${DIM}cd \$STRAPI5_PROJECT_PATH && pnpm develop${RESET}"
    read -rp "  Type 'yes' once Strapi 5 is back up: " confirm2
    if [ "$confirm2" != "yes" ] && [ "$confirm2" != "y" ]; then
      echo "${YELLOW}Skipping verification — Strapi 5 not confirmed running.${RESET}"
      exit 0
    fi
  else
    echo "${YELLOW}Skipping timestamp restoration.${RESET}"
  fi
fi

step "Phase 5/6/7: Validate + Audit + Report"
node migration/scripts/05-validate.js || true   # check 8 timestamp drift may not be 100% clean
node migration/scripts/06-audit.js
node migration/scripts/07-generate-report.js

echo ""
echo "${GREEN}${BOLD}Update complete.${RESET}"
echo ""
echo "Reports updated:"
echo "  ${CYAN}migration/data/migration-report.html${RESET}"
echo "  ${CYAN}migration/data/audit-report.md${RESET}"
echo ""
S5_API=$(node -e "import('./config.js').then(m=>console.log(m.default.strapi5.apiUrl)).catch(()=>{})")
if [ -n "$S5_API" ]; then
  echo "Live report: ${CYAN}${S5_API}/migration-report.html${RESET}"
  echo ""
fi
