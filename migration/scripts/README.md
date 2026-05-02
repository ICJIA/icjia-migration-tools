# Migration Scripts

All scripts are ES modules (Node 18+). Run from the **project root**:

```bash
node migration/scripts/<script-name>.js
```

Or use the pnpm shortcuts defined in `package.json`:

```bash
pnpm introspect    # runs 01a-introspect.js
pnpm generate      # runs 01b-generate-schemas.js
pnpm verify        # runs 01c-verify-schemas.js
```

## Configuration

All scripts read from `config.js` in the project root. If `config.js` doesn't exist, they fall back to `config.example.js` defaults.

To customize, copy the example and edit:

```bash
cp config.example.js config.js
```

**Defaults:**
- **Strapi 3:** `https://researchhub.icjia-api.cloud` (production ResearchHub API)
- **Strapi 5:** `http://localhost:1338` (local development instance)
- **API tokens:** Empty by default — set via environment variables or in `config.js`

Every script prints its configuration at startup so you can verify the target URLs before it runs.

## Directory Structure

```
migration/
├── scripts/         # Runnable migration scripts (this directory)
├── lib/             # Shared libraries used by scripts
├── config/          # Field type maps and generated field mappings
├── data/            # Generated intermediate data (introspection, extracts, transforms)
│   ├── introspection/   # GraphQL introspection results and schema diffs
│   ├── raw/             # Raw Strapi 3 data extracts (Phase 2, gitignored)
│   ├── transformed/     # Transformed data for Strapi 5 (Phase 3, gitignored)
│   ├── media/           # Decoded media files (Phase 3, gitignored)
│   └── maps/            # ID translation tables (Phase 4+)
└── output/          # Generated Strapi 5 schema files and boilerplate
```

---

## Reset / Clean

### `00-clean.js`

**What it does:** Removes all generated data and output from the `migration/` directory so you can start fresh. Preserves scripts, libraries, and static config (`field-type-map.json`).

**What gets removed:**
- `migration/data/` — introspection results, raw extracts, transformed data, media, maps
- `migration/output/` — generated Strapi 5 schemas and boilerplate
- `migration/config/field-map.json` — generated field mapping

**What is preserved:**
- `migration/scripts/`, `migration/lib/` — code
- `migration/config/field-type-map.json` — static config
- `schemas/` — source Strapi 3 schemas
- `config.js` / `config.example.js` — configuration

```bash
node migration/scripts/00-clean.js    # or: pnpm clean
```

---

## Phase 1: Introspection & Schema Generation

### `01-run-phase.js` (recommended)

**What it does:** Orchestrates all Phase 1 steps in sequence with interactive prompts. This is the easiest way to run Phase 1 — it handles the flow, explains what's happening at each step, and gives clear recovery instructions if anything fails.

```bash
node migration/scripts/01-run-phase.js    # or: pnpm migrate:phase01
```

The orchestrator runs: `01a` → `01b` → (manual copy + start Strapi 5) → `01c`, with confirmation prompts between each step. If a step fails, it tells you exactly which script to re-run — you don't need to start Phase 1 over.

You can also run each script individually (see below) if you prefer.

### `01a-introspect.js`

**What it does:** Reads Strapi 3 model schemas and optionally runs a GraphQL introspection query against the Strapi 3 instance.

**Requires:** Schema files in `schemas/` directory (already in the repo). Strapi 3 does NOT need to be running — if unreachable, introspection is skipped and local schema files are used instead.

**Produces:**
- `migration/data/introspection/strapi3-models.json` — parsed model definitions (authoritative source)
- `migration/data/introspection/strapi3.json` — GraphQL introspection result (supplementary)

```bash
node migration/scripts/01a-introspect.js
```

### `01b-generate-schemas.js`

**What it does:** Takes the Strapi 3 model data from 01a and generates complete Strapi 5 `schema.json` files with correct field types, relation mappings (inversedBy/mappedBy), Base64-to-media overrides, and boilerplate files (routes, controllers, services).

**Requires:** Phase 1a output (`migration/data/introspection/strapi3-models.json`).

**Produces:**
- `migration/output/strapi5-schemas/article/content-types/article/schema.json` + boilerplate
- `migration/output/strapi5-schemas/dataset/content-types/dataset/schema.json` + boilerplate
- `migration/output/strapi5-schemas/app/content-types/app/schema.json` + boilerplate
- `migration/config/field-map.json` — per-field mapping details

```bash
node migration/scripts/01b-generate-schemas.js
```

After running, copy the output to your Strapi 5 project:

```bash
cp -r migration/output/strapi5-schemas/* /path/to/strapi5-project/src/api/
```

### `01c-verify-schemas.js`

**What it does:** Verifies that a running Strapi 5 instance has the correct schemas by:
1. Polling until Strapi 5 is ready (up to 60 seconds)
2. Running GraphQL introspection against Strapi 5
3. Diffing against Strapi 3 introspection data
4. Checking REST API responses
5. Verifying `legacyId` field exists on all content types

**Requires:**
- Strapi 5 running with the generated schemas applied
- `@strapi/plugin-graphql` installed in the Strapi 5 project
- Phase 1a output (`migration/data/introspection/strapi3.json`)

**Produces:**
- `migration/data/introspection/strapi5.json` — Strapi 5 introspection data
- `migration/data/introspection/schema-diff.json` — categorized differences + REST/legacyId checks

**Exit codes:** 0 = all checks pass, 1 = unexpected differences found.

```bash
node migration/scripts/01c-verify-schemas.js
```

---

## Phase 2: Data Extraction

### `02-run-phase.js` (recommended)

**What it does:** Orchestrates extraction and verification with interactive prompts and graceful failure recovery.

```bash
node migration/scripts/02-run-phase.js    # or: pnpm migrate:phase02
```

### `02-extract.js`

**What it does:** Pulls all content from Strapi 3 via paginated GraphQL queries. Extracts articles (~250), datasets (~42), and apps (~15) with all scalar fields, relation expansions, and media references. Verifies record counts against Strapi 3 REST endpoints after extraction.

**Requires:** Strapi 3 running and accessible at the configured URL.

**Produces:**
- `migration/data/raw/articles.json` — all articles with full field data (including Base64 splash/thumbnail/markdown)
- `migration/data/raw/datasets.json` — all datasets with datafile media references
- `migration/data/raw/apps.json` — all apps with image field and relation data
- `migration/data/raw/manifest.json` — extraction metadata, record counts, timestamp

```bash
node migration/scripts/02-extract.js
```

### `02-verify.js`

**What it does:** Validates extracted data integrity without re-extracting. Checks: JSON parsability, ObjectId format, timestamps, duplicate IDs, relation arrays, media reference completeness, and Strapi 3 REST count parity.

**Requires:** Phase 2 extraction complete (`migration/data/raw/*.json` files exist).

**Exit codes:** 0 = all checks pass, 1 = failures found.

```bash
node migration/scripts/02-verify.js
```

---

## Phase 3: Base64 Extraction & Media Migration

### `03-run-phase.js` (recommended)

**What it does:** Orchestrates all Phase 3 steps: scan → decode → upload → rewrite → transform → verify.

```bash
node migration/scripts/03-run-phase.js    # or: pnpm migrate:phase03
```

### Individual scripts

| Script | What it does |
|---|---|
| `03a-scan-base64.js` | Scans article `splash`/`thumbnail`/`images`/`markdown` and app `image` for Base64 data. Produces `migration/data/media/manifest.json` |
| `03b-decode-base64.js` | Decodes each Base64 entry to binary files in `migration/data/media/files/`. Validates magic bytes |
| `03c-upload-media.js` | Uploads decoded files to Strapi 5 `/api/upload`. Idempotent (skips existing). Saves `migration/data/maps/media.json` |
| `03d-rewrite-content.js` | Rewrites articles: splash/thumbnail → media IDs, markdown inline images → URLs. Saves `migration/data/transformed/articles.json` |
| `03e-transform.js` | Downloads/re-uploads dataset `datafile` + article `mainfile`/`extrafile`. Transforms datasets + apps. Saves `datasets.json` + `apps.json` |
| `03-verify.js` | Verifies zero Base64 remnants, all media accessible, field parity. Exit 0/1 |

---

## Phase 4: Data Loading & Timestamp Restoration

### `04-run-phase.js` (recommended)

**What it does:** Orchestrates: load → link relations → (stop Strapi 5) → fix timestamps → (restart) → verify.

```bash
node migration/scripts/04-run-phase.js    # or: pnpm migrate:phase04
```

### Individual scripts

| Script | What it does |
|---|---|
| `04-load.js` | Loads content in order: datasets → apps → articles. Checks legacyId for duplicates. Saves ID maps to `migration/data/maps/` |
| `04b-link-relations.js` | Links relation triangle: article→datasets (article dominant), app→articles + app→datasets (app dominant) |
| `04c-fix-timestamps.js` | Restores `createdAt`/`updatedAt` via direct SQLite UPDATE. Strapi 5 must be stopped first |
| `04-verify.js` | Verifies counts, relations (all 3 m2m sets), timestamps, no duplicates. Exit 0/1 |

---

## Phase 5: Validation & Reconciliation

### `05-run-phase.js` (recommended)

**What it does:** Runs end-to-end validation and prints manual QA sign-off checklist on success.

```bash
node migration/scripts/05-run-phase.js    # or: pnpm migrate:phase05
```

### `05-validate.js`

**What it does:** Runs 10 automated checks comparing Strapi 3 and Strapi 5:

1. Record counts match
2. Legacy ID coverage (every Strapi 3 ID → exactly one Strapi 5 record)
3. Zero Base64 remnants in all text fields
4. Image/media migration (splash, thumbnail, mainfile, extrafile, app image)
5. Dataset file migration (datafile)
6. Media accessibility (HEAD request every URL)
7. Relation integrity (all 3 m2m sets)
8. Timestamp preservation (±1 second tolerance)
9. Content integrity (random 10% spot check against Strapi 3)
10. No duplicate records

**Produces:** `migration/data/validation-report.json`. Exit 0 if all pass, 1 if any fail.

```bash
node migration/scripts/05-validate.js    # or: pnpm validate
```

---

## Phase 6: Parity Audit

### `06-run-phase.js` (recommended)

**What it does:** Checks that both Strapi instances are accessible, runs the full audit, and prints summary with report locations.

```bash
node migration/scripts/06-run-phase.js    # or: pnpm migrate:phase06
```

### `06-audit.js`

**What it does:** Comprehensive field-by-field comparison of every record in Strapi 3 vs Strapi 5. Unlike Phase 5 (pass/fail), this categorizes every difference:

- **ERROR** — unexpected difference needing investigation
- **EXPECTED** — intentional change (Base64 → media, image refs → URLs)
- **INFO** — worth noting but not an issue (system fields, etc.)
- **OK** — exact match

Compares: all scalar fields, JSON fields (deep-equal), markdown text (stripped of image refs), media fields, timestamps (±1s), and all relation sets.

**Requires:** Both Strapi 3 and Strapi 5 running. Phase 5 should pass first.

**Produces:**
- `migration/data/audit-report.json` — structured per-record findings
- `migration/data/audit-report.md` — human-readable report for stakeholders

**Exit codes:** 0 = zero ERRORs, 1 = ERRORs found.

```bash
node migration/scripts/06-audit.js    # or: pnpm audit
```

---

## Conventions

All scripts follow the same patterns:
- Read configuration from `config.js` at the project root
- Print configuration at startup so you can verify targets
- Show red ANSI error messages for failures
- Use colored console output for pass/fail status
- Are independently re-runnable (idempotent where possible)
- Include JSDoc on all exports
