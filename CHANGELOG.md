# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.16] - 2026-05-03

### Improved — preflight surfaces port mismatches with a specific message

When `Server reachable` fails because the configured URL doesn't respond,
preflight now:
1. Reads `<strapi5ProjectPath>/.env` to find Strapi 5's expected PORT.
2. HEAD-probes `/_health` on that port.
3. If Strapi 5 IS running there: FAILs with the exact mismatch message
   (`Strapi 5 is running on :1340 but config.js points to :1337`) plus
   both fix options (edit config.js, or edit .env + restart Strapi 5).
4. If Strapi 5 isn't running on either port: falls through to the
   generic "Strapi 5 not running" error.

This is the same scenario that confused us repeatedly during this
session. The dedicated `Port matches Strapi 5 .env` check (added in
v0.9.13) catches it BEFORE attempting connection; this enhancement adds
a second layer that catches it even if the .env is missing or the user
is running Strapi 5 manually on a non-default port.

### Removed — confusing post-copy "Strapi 5 not running" prompt in Phase 1

The Phase 1 orchestrator's `isStrapi5Running()` check (run after schema
copy, before step 4 verify) was reporting "Strapi 5 is not running" even
when preflight had just confirmed it WAS reachable. The exact divergence
was hard to reproduce in isolation — different node-fetch internal state
between the orchestrator process and the preflight subprocess seemed to
matter.

Since:
1. Preflight already verifies Strapi 5 is reachable + token writes.
2. Strapi 5 in dev mode auto-reloads on `src/api/` changes — no manual
   restart is needed after Phase 1's schema copy.
3. Step 4 (`01c-verify-schemas.js`) introspects the running Strapi 5 via
   GraphQL/REST — if it can't connect, that step fails with a clear,
   non-confusing error.

…the redundant prompt provided no real safety and confused developers
with false negatives. Removed entirely. The orchestrator now prints a
single dim line noting the auto-reload behavior and proceeds straight
to verify.

## [0.9.15] - 2026-05-03

### Fixed — Phase 1 orchestrator's reachability check now agrees with preflight

`isStrapi5Running()` in `01-run-phase.js` was using GET / with various
status-code rules; preflight uses HEAD `/_health`. They could disagree
under different fetch versions, causing the confusing "preflight passed,
orchestrator says Strapi 5 isn't running" symptom.

Switched the orchestrator to use the **identical** check as preflight:
HEAD `/_health` → 204 or 200 means reachable. Now there's exactly one
implementation of "is Strapi 5 reachable", so the two checks can never
diverge.

### Changed — pnpm everywhere (replaces npm)

Replaced every `npm run develop` / `npm install` / `npm run build` in
the codebase with the `pnpm` equivalent. Affects:
- `01-run-phase.js` (5 references in printed guidance + recovery hints)
- `reset-strapi5.js` + `reset-remote.js`
- `deploy/restart.sh`

The only remaining `npm` references are `npm install -g pnpm` (the
legitimate way to install pnpm itself — leave alone).

## [0.9.14] - 2026-05-03

### Fixed — exact parity counts everywhere

Stakeholder review issue: the migration report and README showed
"2,491 of 2,492 records" / "2,109 of 2,110 files" suggesting the
migration was missing 1 record and 1 file. In reality the source data
was cleaned up before the run (grant 357 with null title + the corrupt
Headshot_Smith image were both removed from the SQLite snapshot), so
"X of X" is correct — but the templates had hardcoded the pre-cleanup
"Y" values from earlier runs.

#### Report (`07-generate-report.js`)

- Now opens the Strapi 3 SQLite snapshot at report-generation time and
  computes ground-truth source totals dynamically: total records (sum
  across all non-skipped content type tables) and total upload_file rows.
- Sums uploaded media bytes from the local `migration/data/media/files/`
  dir (Strapi 5's response sizes are in KB, so this is more accurate).
- Pipeline-summary cells render as "X" when source matches loaded, and
  "X of Y" only when there's a real discrepancy.
- Phase 1 row reports the actual deployed component count (5 for ICJIA
  after Phase 1.1 cleanup) and content-type count (read from manifest).
- Removed all hardcoded counts (2,492 / 2,110 / 1.20 GB / 1,349) — every
  number is computed from data files at render time.

#### README

- "Validated end-to-end" line: dropped misleading "of N" suffixes.
- Per-type table: corrected drafts column for biography (28), grant (9),
  page (5), unit (1) — these were stale 0s from before the source
  data audit. Grant total corrected to 114 (was 115). Tag, config, and
  home now show "—" in the drafts column since they have
  `draftAndPublish: false` (no draft state to count).
- Added a Total row: 2,491 records, 95 source drafts.
- "Plus" section corrected: 5 components actually deployed (was "10
  component types" which conflated source list with deployed list).
- Other count references updated: 2,110 → 2,109, 5,308 → 2,491.

After this release, every count in the report and README is verifiable
by running the SQL query that produced it. No off-by-ones, no stale
constants from prior data states.

## [0.9.13] - 2026-05-03

### Added — preflight checks port match between config.js and Strapi 5 .env

New preflight check: "Port matches Strapi 5 .env". Reads PORT from
`<strapi5ProjectPath>/.env`, parses the port out of `config.strapi5.apiUrl`,
and FAILs if they disagree (with explicit fix instructions covering both
directions: edit config.js OR edit .env). PASSes when they match (or
SKIPs if Strapi 5 is remote / .env not local).

Catches the failure mode we hit twice this session: install-strapi5.sh
sets a new PORT in .env, but the gitignored config.js still points at
the old port, so preflight's "Server reachable" check fails with an
unhelpful "fetch failed" message. Now the port-match check runs after
"Server reachable" and tells the operator exactly what to fix.

## [0.9.12] - 2026-05-03

### Fixed — Phase 1 orchestrator's "Strapi 5 is running" detection

`isStrapi5Running()` in `01-run-phase.js` only treated HTTP 200-299 / 401 /
403 as "running". Strapi 5's GET / returns **HTTP 302** (redirect to
/admin), so the orchestrator falsely reported "Strapi 5 is not running"
even when it was up and serving requests, then asked the user to start
it. Confusing — preflight had just confirmed the server was reachable.

Fix: accept any HTTP status in 200-499 (with `redirect: 'manual'` so
fetch doesn't auto-follow the 302). Anything in that range means the
server is responding, regardless of which page it returns.

## [0.9.11] - 2026-05-03

### Added — preflight now write-probes the API token

The `API token valid` preflight check used to do a single GET request,
so a Read-only token would PASS but then fail every POST during Phase 4
with HTTP 405. We hit that exact failure mode earlier this session — it
took ~10 minutes of failed inserts before the symptom was diagnosable.

Preflight now:
1. GETs `/api/upload/files` (or `/api/users/me`) to confirm authenticate
   + read access (existing behavior).
2. POSTs `/api/upload` with no body. A Full-Access token reaches the
   upload handler and gets HTTP 400 "Files are empty" — that's a PASS.
   A Read-only token gets HTTP 405 — that's a FAIL with explicit fix
   instructions ("recreate as Full Access, then `pnpm set-token`").

The new pass message reads "API token has read + write access (Full
Access)" so the operator knows BOTH gates were verified.

## [0.9.10] - 2026-05-03

### Changed — install-strapi5.sh now syncs config.js port too

The "Clear stale Strapi 5 token" step in install-strapi5.sh became "Sync
config.js with the freshly-installed Strapi 5". In addition to clearing
the token, the script now rewrites every `http://localhost:<digits>`
URL in config.js to use the actual `$PORT` Strapi 5 was configured for
(default 1340, or whatever was passed via `--port`).

Without this step, switching ports (e.g., 1337 → 1340) required the
user to manually update config.js's strapi5 block, otherwise preflight
would fail with "unreachable (fetch failed)" against the old port.
config.js is gitignored so the v0.9.9 default-port change didn't
propagate to existing local copies.

The rewrite only touches `http://localhost:` URLs — strapi3's
`https://agency.icjia-api.cloud` is unaffected. Idempotent (safe to
re-run).

## [0.9.9] - 2026-05-03

### Changed — default port 1337 → 1340

The local Strapi 5 default port is now **1340** (was 1337). This avoids
collisions when other Strapi instances are already using 1337/1338 on the
same machine. Updated:

- `install-strapi5.sh` PORT default
- `config.dev.js` and `config.example.js` graphqlUrl + apiUrl
- `migration/lib/graphql-client.js` example
- `migration/scripts/preflight.js` printed manual-install hint
- `migration/scripts/migrate-full.js` final admin URL
- `migration/scripts/check-source-drafts.js` adminBase fallback
- `deploy/restart.sh` health check URL
- `README.md` (8 references)

Production port (`5150` behind nginx at `v2.agency.icjia-api.cloud`) is
unchanged in `config.prod.js`.

### Added — automatic token clearing + interactive token paste in install

`install-strapi5.sh` now wipes any stale `strapi5.token` from `config.js`
during install (the previous token is invalid against the fresh admin DB
anyway). Right before exiting, the script prompts:

> Paste your new Strapi 5 API token (or press Enter to skip)

The user keeps the install terminal open, does the browser steps in
another window (start Strapi 5, create admin, generate token), then
comes back and pastes. The script validates length + character set and
writes it to config.js, so the user can immediately run `pnpm preflight`
without editing any file.

If the prompt is skipped (Enter / Ctrl+C), the same flow is available
via `pnpm set-token` (a new alias for `migration/scripts/set-strapi5-token.js`).
Both paths refuse short or whitespace-containing input.

### Added — Phase 4 load progress indicator

`04-load.js` now prints in-place progress every 25 records during long
loads (e.g., publication's 1,139 records used to look stuck for ~2.5
minutes). Format: `<type> <i>/<n> (<created>, <skipped>, <failed>)`.
Per-type ✓ summary line is unchanged.

## [0.9.8] - 2026-05-03

### Added — `update.sh` symlinked into the Strapi 5 install dir

`install-strapi5.sh` now creates a symlink at `<target>/update.sh`
pointing back at the migration-tools repo's `update.sh`. After the
initial migration, an editor / ops person can `cd` into the Strapi 5
install directory and run `./update.sh --target=local --update-newer`
directly — no need to remember the migration-tools repo path.

The symlink stores an absolute path captured at install time (the
migration-tools repo's location). Works on prod servers identically to
local. If you move the migration-tools repo, re-run install-strapi5.sh
or recreate the link manually with `ln -sf`.

The install script's "next steps" output gained an "Incremental sync"
section documenting the symlink and the typical `./update.sh` invocation.

## [0.9.7] - 2026-05-03

### Added — source-drafts checklist for the editor

When the migration runs with the v0.9.5 default (`preserveSourceDrafts:
false`), every record loads into Strapi 5 as Published. An editor often
wants to know which records were drafts in Strapi 3 so they can flip
those back to Draft manually after the migration. This release adds:

- `migration/scripts/check-source-drafts.js` — read-only sweep over the
  Strapi 3 SQLite snapshot. Lists every record where `published_at IS
  NULL`, grouped by content type, with `legacyId`, identifier (title /
  fullName / firstName+lastName / slug fallback), source slug, and
  source `updated_at`. Skips content types where `draftAndPublish:
  false` in source (e.g., tag, config) — those don't have the concept.
- Outputs JSON (`migration/data/source-drafts.json`) +
  Markdown (`migration/data/source-drafts.md`).
- The Markdown copy is mirrored into Strapi 5's `public/` so it serves
  at `<strapi-base>/source-drafts.md` (alongside the migration report).
- Wired into `postflight.js` as **Stage 5/5** — runs automatically after
  validate + audit + report. Postflight's "Reports produced" list and
  "Next steps" sequence both reference the source-drafts checklist.
- Wired into the Phase 7 HTML migration report — a "Source drafts
  checklist" callout appears (with link to `source-drafts.md`) when
  `source-drafts.json` exists.
- New `pnpm check-drafts` script alias.

For the current ICJIA dataset: 95 source drafts across 8 content types
(publication 32, biography 28, job 13, grant 9, page 5, post 5,
meeting 2, unit 1).

## [0.9.6] - 2026-05-02

### Fixed — Phase 4c was clobbering the draft-row marker

`04c-fix-timestamps.js` was running a single UPDATE per record that set
`published_at` on EVERY row matching `legacy_id` — including the draft
row, whose `published_at` MUST stay NULL for Strapi 5 to distinguish it
from the published row.

Symptom: after Phase 4c, every document had two rows with
`published_at` set, neither row marked as the draft. Strapi 5's content
manager then refused to return any records (the API returned empty
results), and the admin UI showed "0 entries found" for every content
type — even though all 2,491 records were physically present in SQLite.

Fix: split the UPDATE into two statements:
1. `created_at` and `updated_at` update both rows (matched by legacy_id).
2. `published_at` updates ONLY the row that already has it set
   (`WHERE legacy_id = ? AND published_at IS NOT NULL`), preserving the
   draft row's NULL marker.

If you ran v0.9.5's broken Phase 4c against your data, the fix script
in `migration/scripts/maintenance/restore-draft-markers.mjs` (added
this version) restores the canonical state by NULLing `published_at` on
the lower-id row of every duplicate-published-row pair. Run it once
with Strapi 5 stopped, then restart.

## [0.9.5] - 2026-05-02

### Changed — default flipped to publish-everything

Source drafts now load into Strapi 5 as **published** by default. The
editor flips individual records to draft post-migration as needed.

To restore the old behavior (preserve source drafts as drafts), set
`preserveSourceDrafts: true` in `config.js`.

- `04-load.js`: when `preserveSourceDrafts !== true`, source drafts
  (`published_at IS NULL`) get an inferred `publishedAt` from `created_at`.
  POSTs always default-publish — no `?status=draft` query param.
- `04b2-publish.js`: when `preserveSourceDrafts !== true`, no records are
  skipped — every doc gets a publish PUT, ensuring every document ends
  up with a synced published row regardless of source state.
- `04c-fix-timestamps.js`: when `preserveSourceDrafts !== true`, source
  drafts' `published_at` is filled from `created_at` instead of being
  reverted to NULL by the timestamp restoration step.
- `05-validate.js` check 3 (Draft preservation): when
  `preserveSourceDrafts !== true`, the check passes with a SKIP note —
  "0 drafts in S5" is the desired outcome, not a regression.
- `config.js`: new `preserveSourceDrafts: false` knob documented.

### Fixed — load script `record is not defined` typo

The new draft-promotion branch in `04-load.js` referenced `record`
instead of the surrounding scope's `rec`, causing 126 ReferenceErrors
on the first run after the v0.9.5 default flip.

## [0.9.4] - 2026-05-02

### Removed — stale "Known acceptable issues" boilerplate

- `07-generate-report.js`: removed hardcoded callouts for the
  `Headshot_Smith_50472f6c9b.jpg` orphan and `Grant id 357` null-title
  draft from both the HTML and DOCX templates. These were artifacts of
  earlier source data; they no longer apply (data was cleaned in v0.7.x)
  and were misleading reviewers into thinking the migration had open
  issues.
- `06-audit.js`: cleared `KNOWN_ACCEPTABLE_FAILURES` of those entries.
  The structure is preserved as an empty hook for future whitelisting.
- Final reports now show no "Known acceptable issues" section unless one
  is added back deliberately.

## [0.9.3] - 2026-05-02

### Fixed — Phase 4c (timestamp restoration) silently no-op'd

Two bugs in `04c-fix-timestamps.js` made the script report success while
actually leaving every record's timestamps at the migration time:

1. **Wrong WHERE clause.** The script used `WHERE id = <id from map>`, but
   the map's `id` field is the autoincrement value Strapi 5 returned at
   POST time. Strapi 5's PUTs (link-relations + publish) rewrite document
   rows with new auto-increment ids, leaving the map's id pointing at a
   row that no longer exists. UPDATE matched nothing → silent no-op even
   though the script printed "✓ N timestamps fixed".

   Fix: UPDATE WHERE legacy_id = ?. legacy_id is set on every version row
   of a document (both draft and published), is stable across PUTs, and
   matches both rows in one statement. Falls back to document_id for
   singletons or types without legacy_id.

2. **ISO string written into integer column.** Source records carry
   `created_at` as ISO 8601 strings (`"2021-05-04T14:40:30.029Z"`), but
   Strapi 5 stores timestamps as milliseconds-since-epoch integers.
   SQLite has loose typing, so the UPDATE succeeded but the column ended
   up holding the string; later reads via `datetime(col/1000, 'unixepoch')`
   parsed it as `parseInt("2021-...") = 2021`, displaying as
   `1970-01-01 00:00:02`.

   Fix: convert ISO → ms via `new Date(iso).getTime()` before each UPDATE
   parameter.

After the fix: source `2021-05-04 14:40:30` → Strapi 5 `2021-05-04 14:40:30`
on both the draft and published rows. Validation check 8 (timestamp
preservation ±1s) now passes for all sampled records.

## [0.9.2] - 2026-05-02

### Fixed — source drafts no longer auto-published in Strapi 5

- `04-load.js` now POSTs source drafts with `?status=draft` query param.
  Without it, Strapi 5 v5+ creates **both** a draft and a published row on
  every POST regardless of `publishedAt: null` in the body, silently
  publishing source drafts with the migration timestamp.
- `04b2-publish.js`: switched from `POST /api/<plural>/<docId>/actions/publish`
  to `PUT /api/<plural>/<docId>?status=published` with empty body. The
  `/actions/publish` route is admin-only and returns 405 on the public
  REST API; the `?status=published` PUT is the documented public path.
- `04b2-publish.js`: now skips content types where `draftAndPublish: false`
  in source (e.g., `tag`, `config`). Those don't have a draft/published
  distinction, so the publish action doesn't apply.
- `04b2-publish.js`: fixed `RestClient` constructor call — was passing an
  options object as the first arg; constructor expects positional
  `(baseUrl, options)`.

### Added — PM2 ecosystem file for production

- `install-strapi5.sh` now writes `ecosystem.config.cjs` into the Strapi 5
  install directory at install time.
  - App name derived from the install dir basename (e.g.,
    `icjia-public-strapi5`).
  - `cwd` set to the absolute install path (so `pm2 start` works from
    anywhere).
  - `PORT` matches the `--port` flag (default 1337).
  - `NODE_ENV=production`, `max_memory_restart: 512M`, `autorestart: true`.
  - Log paths commented as overrides; default uses `~/.pm2/logs/<name>-*.log`.
- Install script's "next steps" output now includes a Production (PM2)
  section with start/save/startup commands.

## [0.9.1] - 2026-05-02

### Fixed — orchestrators no longer skip steps when run non-interactively

- `01-run-phase.js`, `02-run-phase.js`, `04-run-phase.js`: prompts now
  detect `process.stdin.isTTY === false`, the `CI=true` env var, or a
  `--yes`/`-y` flag and auto-answer instead of receiving EOF and falling
  through to the next step. Symptom this fixes: piping the orchestrators
  into `node ... > log.log 2>&1` (e.g., from a CI pipeline or a
  background shell job) silently skipped the schema-generation step
  inside Phase 1, leaving Strapi 5 with an empty `src/api/` and every
  Phase 4 POST returning HTTP 405.
- Phase 1 + 2 prompts auto-answer **yes** (default).
- Phase 4's timestamp prompt auto-answers **skip** when non-interactive
  (running a SQLite UPDATE while Strapi 5 may still hold the file lock
  is unsafe). Re-run timestamp restoration manually with Strapi 5 stopped.
- Phase 4's verify prompt auto-answers **yes** (Strapi 5 was never asked
  to stop, so it should still be reachable).
- Each auto-answer prints a `[auto: ...]` notice next to the prompt for
  audit trail.
- Destructive utility scripts (`reset-remote.js`, `reset-strapi5.js`,
  `set-strapi5-url.js`) intentionally still require interactive input.

## [0.9.0] - 2026-05-02

### Added — fix "Modified" status on migrated records

- **`04b2-publish.js`** — new Phase 4 step that calls
  `POST /api/<plural>/<documentId>/actions/publish` for every loaded record
  whose source had `published_at` set. Records whose source was a draft
  (`published_at IS NULL`) are skipped — they remain as drafts in Strapi 5.
- **Why it exists:** Strapi 5 stores `draftAndPublish` content types as two
  database rows per document (one draft, one published). PUT to the
  documentId updates the draft row only. Phase 4b (link-relations) PUTs
  every record to attach m2m/m2o relations, leaving the draft "ahead" of
  the published row — the admin UI then shows status "Modified" until an
  editor manually re-publishes each one. This step closes that loop
  automatically by syncing draft → published after relations are linked.
- Wired into `04-run-phase.js` between link-relations (step 2) and
  fix-timestamps (step 3) as **step 2.5**.
- Wired into `update.sh` between link-relations and timestamps. Incremental
  syncs that touch existing records via `--update-newer` /
  `--update-existing` will re-publish them automatically.
- New script alias: `pnpm publish-all`. Idempotent — safe to re-run any
  time. Use this to fix existing migrations that show "Modified" without
  re-running the full pipeline.
- Type filter: `node migration/scripts/04b2-publish.js --type=biography`
  for surgical re-publishes.
- Documented in README troubleshooting table.

## [0.8.1] - 2026-05-02

### Documentation

- README: promoted the **Incremental updates after the first migration**
  section to its own H2 (was previously buried inside "Strapi 5 setup").
  Now sits between "Running the migration" and "Verification & validation"
  and is linked from the table of contents.
- README: expanded incremental-updates docs as the primary dev reference:
  - Three update modes table (insert-only / update-newer / update-existing)
    with explicit "when to use" guidance for each.
  - "Choosing between `--update-newer` and `--update-existing`" decision
    table covering common operational scenarios.
  - Explanation of the `lastSyncedAt` mechanism and how the loader uses
    it to decide PUT vs skip.
  - Detailed step-by-step walkthrough of what `update.sh` does internally.
  - Cron snippet for daily cutover-week sync (with `--skip-timestamps`
    rationale for non-interactive automation).
  - Documented combinations of flags (e.g. `--type=post --update-newer`
    for surgical re-syncs).
- README: added **Strapi 5 setup**, **Incremental updates**, and
  **Deploying to production** to the table of contents (previously
  missing).

## [0.8.0] - 2026-05-02

### Added — incremental updates

- **`update.sh`** — incremental sync from Strapi 3 to a Strapi 5 destination
  (local or prod). Re-runs the migration phases idempotently to pick up new
  or modified records without redoing the full migration.
  - `--target=local` activates `config.dev.js`; `--target=prod` activates
    `config.prod.js`. Fails fast if the destination Strapi 5 install isn't
    found or isn't reachable, with specific guidance per failure mode.
  - `--skip-media` skips Phase 3 (faster when no new uploads).
  - `--skip-timestamps` skips the Strapi-5-stop-required SQLite UPDATE.
  - Forwards `--update-newer` and `--update-existing` to the load phase.
  - Backs up the user's current `config.js` to `config.js.backup` before
    swapping in the target profile.
- **`04-load.js --update-existing`** — PUT every record by legacyId
  (one-off bulk update; heavy).
- **`04-load.js --update-newer`** — PUT records whose source `updated_at`
  is newer than the last sync. Tracks `lastSyncedAt` per-record in the
  per-type ID map. Recommended for cutover-window incremental updates.

### Path handling clarification

- README: explicit section on running `install-strapi5.sh` and `update.sh`
  from any working directory (both use absolute path resolution from
  `${BASH_SOURCE[0]}`). For prod, prefer absolute `--target=/var/www/...`
  over the default sibling-directory layout.

## [0.7.9] - 2026-05-02

### Added

- `07-generate-report.js` now copies the HTML and DOCX reports into the
  Strapi 5 project's `public/` directory. Once Strapi 5 is running,
  the reports are accessible directly via:
  - `http://localhost:1337/migration-report.html`
  - `http://localhost:1337/migration-report.docx`
  No standalone HTTP server needed — Strapi serves them. The script
  prints both the localhost URL and a `file://` fallback after generation.

### Fixed

- Missing `DIM` ANSI color constant in 07-generate-report.js caused the
  script to crash at the very end (after reports were written) with
  "DIM is not defined". Added the missing constant.

## [0.7.8] - 2026-05-02

### Added

- `install-strapi5.sh` now wipes the migration tool's working state by
  default — true Phase 0 fresh start. Removes:
  - `migration/data/` (extracts, downloads, maps, transformed records,
    reports)
  - `migration/output/` (generated schemas)
  - `migration/config/field-map.json` (Phase 1 generated artifact)
- New flag `--keep-migration-data` to preserve those caches when the
  Strapi 5 reinstall is just a fix (e.g., wrong port, regenerated token).

## [0.7.7] - 2026-05-02

### Fixed

- `install-strapi5.sh` now actually builds the native bindings.
  In pnpm 10+, even `pnpm rebuild <pkg>` is a no-op unless the package
  is listed in `pnpm.onlyBuiltDependencies` in package.json. The
  v0.7.6 script ran `pnpm rebuild better-sqlite3 sharp` but the
  allowlist was empty, so nothing happened — Strapi 5 still failed at
  startup with "Could not locate the bindings file".
- New flow: write the allowlist to the project's `package.json`, then
  run `pnpm install` to actually trigger the build scripts. The script
  also verifies the resulting `better_sqlite3.node` exists on disk and
  falls back to a direct `node-gyp rebuild` if not.

## [0.7.6] - 2026-05-02

### Added

- **`install-strapi5.sh`** — bash script that automates the deterministic
  parts of the Strapi 5 install:
  1. Validates Node 22+ and pnpm
  2. Wipes any existing target directory (with confirmation; `--force` to skip)
  3. Runs `create-strapi-app` non-interactively with the canonical flags
     (`--javascript --quickstart --no-run --skip-cloud --skip-db`)
  4. Sets `PORT` in `.env` (`--port=NNNN` to override)
  5. Installs `@strapi/plugin-graphql`
  6. Rebuilds native bindings (`better-sqlite3`, `sharp`) — the step
     pnpm 10+ blocks by default and the most common first-time error
  7. Prints clear next-steps for the browser-based admin user + token
- README "One-time install (automated)" section pointing at the script.

### Changed

- README install procedure now stronger about the
  `pnpm rebuild better-sqlite3 sharp` step being **mandatory** (not
  optional). Added explicit error-recovery line: if you see "Could not
  locate the bindings file" at startup, run `pnpm rebuild` then
  `pnpm develop` again.
- Troubleshooting table adds a row for the bindings-file error with the
  exact fix.
- Preflight checklist marks the rebuild step as REQUIRED in yellow.

## [0.7.5] - 2026-05-02

### Added

- `migrate-full.js` rewritten as a real end-to-end orchestrator.
  Sequence: preflight → phases 1-7 → postflight. Each stage runs as a
  child process with stdio inherited so interactive prompts (Phase 4's
  stop/restart Strapi 5 prompts) work as expected.
- `--start-from=<stage>` flag to resume from a specific stage
  (e.g., `pnpm migrate:full --start-from=phase04`).
- `--skip=<stage>` flag for skipping individual stages
  (e.g., `pnpm migrate:full --skip=phase07` to skip the report).
- `--skip-preflight` and `--skip-postflight` shortcuts for the bookend
  environment checks.
- Per-stage timing in the final summary plus paths to the generated
  HTML/DOCX/MD reports.

## [0.7.4] - 2026-05-02

### Changed

- `deploy/nginx-strapi5.conf`: ICJIA-customized
  - hostname: `v2.hub.icjia-api.cloud` → `v2.agency.icjia-api.cloud`
  - upstream: `127.0.0.1:1337` → `127.0.0.1:5150` (Strapi 5 internal port,
    chosen to avoid conflict with the existing :1337 Strapi instance on
    the prod server)
  - SSL cert paths updated to match the new hostname
  - Both the Laravel Forge and standalone variants of the config are
    updated. All other rules (no dotfile deny, single proxy_pass, no
    extra closing braces) preserved per the lessons documented in the
    config comments.

## [0.7.3] - 2026-05-02

### Added

- **README "Custom port" section** — explains how to change the Strapi 5
  port across all three places that must agree (Strapi `.env`, migration
  tool `config.{js,prod.js}`, and the optional reverse proxy). Example
  uses ICJIA's chosen prod port 5150.
- **README "Production hostname" section** — confirms the production URL
  `https://v2.agency.icjia-api.cloud` and points at the already-wired
  `config.prod.js` entries.

### Changed

- `config.prod.js`: removed the "TODO placeholder" comment from the prod
  hostname (`https://v2.agency.icjia-api.cloud` is now confirmed as the
  prod URL) and added a note that nginx proxies 443 → internal port 5150.

## [0.7.2] - 2026-05-02

### Removed (Phase 1.1 cleanup)

- 5 unused components dropped from the migration manifest and any
  `<strapi5>/src/components/` directory: `button.button`,
  `menu-item.menu-item`, `slider-button.slider-button`,
  `countdown.countdown`, `event.add-event`. None had any field references
  in the source data — they were defined in Strapi 3 but never used by
  any content type. The manifest's
  `_v1_1_removed_components` block records what was removed for future
  reference; restore from git history if needed.

## [0.7.1] - 2026-05-02

### Added

- `docs/og-image.svg` and `docs/og-image.png` — social-card-style header image
  matching the sibling tool's design (1200×630). PNG rendered with rsvg-convert.
  Embedded at the top of README.

## [0.7.0] - 2026-05-02

End-to-end migration verified against the live ICJIA Strapi 3 source
(agency.icjia-api.cloud) into a fresh local Strapi 5 (5.44.0) install.

### Added

- **Phase 5 — Validation**: 10 automated checks (counts, legacyId coverage,
  draft preservation, Base64 remnants, media coverage, media accessibility,
  relation integrity, timestamp preservation, content integrity, component
  instance counts). Outputs `migration/data/validation-report.json`.
- **Phase 6 — Parity audit**: field-by-field comparison of every loaded record
  against source. Categorizes findings as ERROR / EXPECTED / INFO / OK with
  semantic URL normalization (drops `agency.icjia-api.cloud` prefix and
  rewrites UploadFile hashes). Outputs `migration/data/audit-report.{json,md}`.
- **Phase 7 — Reports**: `07-generate-report.js` produces stakeholder-ready
  HTML and DOCX reports from validation + audit data, with executive summary,
  per-type breakdown, and a "known acceptable issues" section. Outputs
  `migration/data/migration-report.{html,docx}`.
- **README**: complete Strapi 5 install procedure (JavaScript, not TypeScript)
  with the GraphQL plugin install step and the Full-access token gotcha.
- **Preflight checklist**: now shows the exact `npx create-strapi-app` command
  with `--javascript`, the `pnpm add @strapi/plugin-graphql` step, and a clear
  warning that Read-only API tokens get HTTP 405 on write endpoints.

### Migration result

- 2,491 of 2,492 documents loaded into Strapi 5 (1 source data quality skip:
  grant 357 was an empty draft with null title).
- 2,109 of 2,110 source files re-uploaded (1 orphan headshot rejected by
  Strapi 5 sharp for unusual EXIF orientation; not referenced by any record).
- 478 dominant-edge relation links across 240 records (0 errors).
- 2,491 timestamps restored from source via direct SQLite UPDATE.
- 1,349 UploadFile reference IDs swapped + 264 richtext URLs rewritten in
  body fields.
- Phase 6 parity audit: **13,259 OK + 96 EXPECTED + 0 ERROR** across 13,355
  field comparisons on 2,490 records.

## [0.4.0] - 2026-05-02

### Added

- **Phase 4 — Load**: manifest-driven content loader (`04-load.js`),
  generic n-pass relation linker (`migration/lib/relation-engine.js`,
  `04b-link-relations.js`), local SQLite timestamp restoration
  (`04c-fix-timestamps.js`), and verifier (`04-verify.js`) that counts
  distinct `document_id` (not pagination.total) since Strapi 5 stores 2 rows
  per document for draftAndPublish types.
- **Single-type loader** (`migration/lib/single-type-loader.js`) for the
  `Home` singleton (PUT `/api/home` with no documentId).
- Schema-generator now emits both `.ts` and `.js` boilerplate; `01b-generate-
  schemas.js` detects the destination Strapi 5 project's language via
  `tsconfig.json` and writes the matching variant.

### Fixed

- Strip Strapi 3 internal fields (`created_by`, `updated_by`, `_id`, `__v`)
  from the POST body — Strapi 5 rejects unknown body keys.
- Allowlist body fields against the source schema (drop fields like
  `isFeatured` on biography or `site` on form that aren't declared in the
  `.settings.json` model but appear in source data).
- Skip `legacyId` for singletons (they have no array semantics).
- Drop `null`/`undefined` values from POST bodies — Strapi 5's type validators
  reject `null` on typed fields even on draft records.

## [0.3.0] - 2026-05-02

### Added

- **Phase 3 — Media**: full pipeline of collect → download → upload → rewrite.
  - `03a-collect-media.js`: walks SQLite + extracted JSONs, dedupes by hash,
    flags orphans (in `upload_file` but not referenced by any content).
  - `03b-download-media.js`: streams every file from the source via `fetch` +
    `pipeline()`, atomic writes (.partial → rename), idempotent skip on
    matching size.
  - `03c-upload-media.js` (rewrite): re-uploads to Strapi 5 `/api/upload`
    preserving `name`, `alternativeText`, `caption`. Persists hash → S5 ID
    map every 25 uploads for crash safety.
  - `03f-rewrite-content.js`: substitutes UploadFile reference IDs in the
    extracted records and rewrites `agency.icjia-api.cloud/uploads/<hash>`
    URLs in richtext body fields.
- **Markdown rewriter extension**: `rewriteUploadUrls()` and `findUploadUrls()`
  with a permissive regex that matches both absolute and relative
  `/uploads/<hash><ext>` patterns.

### Removed

- Sibling-tool's Phase 3 scripts replaced by ICJIA flow:
  - `03a-scan-base64.js`, `03b-decode-base64.js`, `03d-rewrite-content.js`,
    `03e-transform.js` deleted.

## [0.2.0] - 2026-05-02

### Added

- **Phase 2 — Extract**: manifest-driven extraction with SQLite ground-truth
  fallback (`02-extract.js` rewrite, `02-verify.js` rewrite).
- `migration/lib/query-builder.js`: generic GraphQL query generator that
  recursively expands components and includes UploadFile metadata.
- `migration/lib/sqlite-reader.js`: read-only thin wrapper over
  better-sqlite3 with auto-deserialization of JSON-text columns.
- Per-type idempotent extraction with atomic JSON writes.

## [0.1.0] - 2026-05-02

Initial bootstrap.

### Added

- **Phase 0 — Bootstrap**: forked from `icjia-hub-migration-tools` (sibling
  repo that migrated ResearchHub from Strapi 3 MongoDB → Strapi 5 SQLite,
  March 2026). Adapted the architecture for the ICJIA public website
  migration (Strapi 3 SQLite → Strapi 5 SQLite, 18 content types incl. 1
  singleton, 10 components).
- **Phase 1 — Schema**: schema generator with singleType + component
  emission, integer `legacyId`, manifest-driven descriptions. 28/28
  GraphQL types verified registered in destination Strapi 5.
- **Preflight + postflight**: environment-check script with PASS/FAIL/WARN
  table and a "Before you start" checklist. Postflight aggregates final
  stats from validation + audit + report into a single sign-off summary.
- **Plan + README**: full migration plan at
  `docs/icjia-public-website-migration-plan.md` and a developer-focused
  README with setup, configuration, and troubleshooting.
- **Production deployment guidance**: README section covering Option A
  (API-to-API to remote prod, recommended) and Option B (SFTP cutover) with
  prerequisites, commands, and tradeoffs.
- **Repo bootstrap**: `.gitignore` (excludes `data.db` + `node_modules`),
  `.nvmrc` (Node 22), MIT LICENSE, `pnpm-workspace.yaml`,
  `migration/config/content-types.json` central manifest,
  `migration/config/field-type-map.json`, three config profiles
  (example/dev/prod).
