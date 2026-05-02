# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
