# ICJIA Public Website Migration Tool — Strapi 3 (SQLite) → Strapi 5 (SQLite)

## Context

The ICJIA public website (`agency.icjia-api.cloud`) runs on Strapi 3, end-of-life since 2022. We need to migrate its content to Strapi 5 (SQLite source → SQLite destination), reusing the proven 7-phase API-to-API architecture from the sibling tool `icjia-hub-migration-tools` (which migrated ResearchHub from Strapi 3 MongoDB → Strapi 5 SQLite, completed March 2026).

The new local repo at `/Volumes/satechi/webdev/icjia-migration-tools/` will track the empty GitHub remote at **https://github.com/ICJIA/icjia-migration-tools** (`git init` + `git remote add origin` happens in Phase 0). The local working tree is empty except for:
- `docs/icjia-hub-migration-tools-8a5edab282632443.txt` — 22k-line dump of the sibling tool
- `docs/strapi-3-source/api/` — all 18 content type `.settings.json` files
- `docs/strapi-3-source/components/` — all 10 component definition files
- `docs/strapi-3-source/config/security.json` — Strapi 3 server config
- `docs/strapi-3-source/data.db` — 6.2 MB Strapi 3 SQLite database (must be gitignored — contains Strapi internals like `strapi_administrator` and password hashes)

This plan is a forking-and-adapting roadmap, not a from-scratch rewrite — most heavy lifting (HTTP clients, Base64 pipeline, validation framework, DOCX/HTML reports) is reused verbatim or with thin adaptations.

### Why this differs from the sibling tool

| Dimension | Sibling (ResearchHub) | This tool (Public Website) |
|---|---|---|
| Source DB | Strapi 3 MongoDB | Strapi 3 SQLite (integer IDs, max observed: 4,784) |
| Content types | 3 (Article, Dataset, App) | **18** modeled (incl. 1 true singleton `Home`) |
| Components | None used | **10 component types**, 3 nest sub-components |
| Relation graph | Triangle (3 m2m edges) | Hub-and-spoke around `Tag` (9 m2m edges) + ~25 other m2m edges |
| Primary media path | Base64 inline images | `UploadFile` references (download → re-upload). 2,110 files. |
| Schema input | `.settings.json` from local checkout | **`.settings.json` available** + GraphQL introspection + direct SQLite reads |
| Singletons | None | **`Home` only** (`Config` is collectionType despite the name) |
| Body fields | markdown | **richtext** with absolute URLs (`https://agency.icjia-api.cloud/uploads/...`) — needs URL rewrite |

### Decisions captured from clarifying questions

- **Schema source:** `.settings.json` files (primary) + SQLite for ground-truth verification + GraphQL for cross-checks. All three available.
- **Destination:** Fresh local Strapi 5 first, then deploy — mirror the sibling's `config.dev.js` / `config.prod.js` split.
- **Drafts:** **Migrate all drafts** (~52 records: 32 publications, 13 jobs, 5 posts, 2 meetings). Strapi 5 marks them as drafts via the draft/publish workflow.
- **Build / Form:** **Form yes, Build no.** Form has 205 JSON form definitions to preserve verbatim; Build has 0 records — skip until ICJIA actually creates one.
- **Orphan tables:** **Skip all** five orphans (`pubs` 1029, `funding-opportunities` 34, `documents` 0, `site-configs` 1, `context-menus` 1). v1 ships only types with `.settings.json` models. The 1029 `pubs` records are a known omission — likely a pre-rename Publication archive; verify before deciding to recover.
- **`Publication.tags`:** **Preserve as JSON (literal).** The 102 records' `tags` JSON arrays migrate as-is into a Strapi 5 JSON field. The empty `publications_tags__tags_publications` join table is dropped.
- **`legacyId` type:** **`integer`** (corrected from earlier `biginteger`). Max source ID is 4,784 — well within INT32 range.

---

## Source content inventory (verified from `.settings.json` + SQLite)

### Content types — 18 modeled (Build deferred)

| Type | Kind | Total | Pub | Draft | Notes |
|---|---|---|---|---|---|
| Publication | collectionType | 1139 | 1107 | 32 | `tags` is JSON array (preserved) |
| Meeting | collectionType | 283 | 281 | 2 | `external` array of ComponentExternalUrl |
| Job | collectionType | 231 | 218 | 13 | `external` array of ComponentExternalUrl |
| Form | collectionType | 205 | 205 | 0 | `form` JSON field — preserve verbatim |
| Post | collectionType | 190 | 185 | 5 | Dominant on 6 relations; self-ref `post.posts` (0 records — drop) |
| Biography | collectionType | 138 | 138 | 0 | `headshot` UploadFile; m2o to Unit |
| Grant | collectionType | 115 | 115 | 0 | Dominant on 4 relations |
| Program | collectionType | 65 | 65 | 0 | Dominant on 3 relations |
| Page | collectionType | 38 | 38 | 0 | `clickthrough` array of ComponentClickthrough |
| Tag | collectionType | 27 | 27 | 0 | **Hub** — dominant on all 9 m2m relations |
| RequiredForm | collectionType | 21 | 21 | 0 | `tags` relation incomplete (fix in v5) |
| Unit | collectionType | 11 | 11 | 0 | m2m to Tags |
| Policy | collectionType | 9 | 9 | 0 | `tags` relation incomplete (fix in v5) |
| Rule | collectionType | 7 | 7 | 0 | citation + citationURL |
| Event | collectionType | 6 | 6 | 0 | `splash` UploadFile; dominant on 2 relations |
| Config | collectionType | 4 | 4 | 0 | NOT a singleton; arbitrary JSON in `config` |
| Regulation | collectionType | 2 | 2 | 0 | Just url + summary |
| **Home** | **singleType** | 1 | 1 | 0 | Components only |
| ~~Build~~ | ~~collectionType~~ | 0 | — | — | **Skip v1** (empty source) |

**Migration scope: 17 content types, ~5,308 records (incl. drafts), 2,110 upload files.**

### Orphan tables — explicitly excluded from v1

`pubs` (1029), `funding-opportunities` (34), `documents` (0), `site-configs` (1), `context-menus` (1). No models in `api/`, no GraphQL exposure beyond the DB. Documented for traceability; not migrated.

### Components — 10 types, 10 categories

| Category | Name | Repeatable use sites | Nests |
|---|---|---|---|
| carousel | carousel | home.homeCarousel | slide.slide |
| slide | slide | (via carousel) | — |
| clickthrough | clickthrough | home.clickThroughBoxes (rep), page.clickthrough (rep) | — |
| banner | banner | home.homeBanner | — |
| external | external-url | meeting.external (rep), job.external (rep) | — |
| button | button | (unused in content?) | menu-item.menu-item |
| menu-item | menu-item | (via button + slider-button) | — |
| slider-button | slider-button | (unused in content?) | menu-item.menu-item |
| countdown | countdown | (unused in content?) | — |
| event | add-event | (unused in content?) | (refs Tag collection) |

**Note:** Strapi 5 categories should mirror the source folder names verbatim — keeps S5 admin UI grouping intact and avoids ID drift.

### Relation dominance matrix (9 Tag + 13 other dominant edges)

**Tag is dominant on all 9 of its m2m relations** (events, posts, pages, programs, grants, meetings, biographies, jobs, units).

| Dominant side | Field | → Target | Pop. (rows in join table) |
|---|---|---|---|
| Tag | events | Event | 4 |
| Tag | posts | Post | 60 |
| Tag | pages | Page | 9 |
| Tag | programs | Program | 40 |
| Tag | grants | Grant | 82 |
| Tag | meetings | Meeting | 115 |
| Tag | biographies | Biography | 1 |
| Tag | jobs | Job | 2 |
| Tag | units | Unit | 0 |
| Post | events | Event | 2 |
| Post | meetings | Meeting | 3 |
| Post | programs | Program | varies |
| Post | jobs | Job | varies |
| Post | biographies | Biography | 1 |
| Grant | events | Event | 0 |
| Grant | posts | Post | 14 |
| Grant | biographies | Biography | 47 |
| Program | grants | Grant | 55 |
| Event | posts | Post | 2 |
| Event | meetings | Meeting | 0 |
| Job | posts | Post | varies |
| Biography | (m2o → Unit) | Unit | direct FK, no dominance |

**Non-dominant relations (mappedBy in S5):** Post.grants (Grant dominant), Meeting.posts (Post dominant), Meeting.events (Event dominant), Program.posts (Post dominant), Biography.posts (Post dominant), Biography.grants (Grant dominant), and the 9 inverses of Tag.

**Incomplete relations (need fix in S5 schema):** `Policy.tags` and `RequiredForm.tags` are missing `via` + `dominant` in source — both join tables empty. Will be set as `dominant` from policy/required-form side in S5.

### Upload files

2,110 `upload_file` rows. Schema: `id, name, hash, ext, mime, size, url, alternativeText, caption, width, height, formats (JSON), provider="local"`. URLs stored as relative `/uploads/<hash><ext>`.

### Body fields contain absolute URLs

richtext fields across Post, Page, Grant, Program, Meeting, Biography (and likely others) embed absolute URLs like `![Webinar](https://agency.icjia-api.cloud/uploads/07_28_2021_pandemic_ff795b8dc0.jpg)`. **Phase 3 must rewrite these to relative `/uploads/...` URLs** (or to S5 upload IDs after re-upload).

---

## Repo strategy

Fork wholesale: copy `icjia-hub-migration-tools/` into `icjia-migration-tools/`, then refactor in place. Do **not** extract a shared workspace package yet — the sibling tool's libs are tenant-coupled enough that lifting them out now would force two simultaneous refactors. A future workspace extraction can happen once both tools have stabilized.

`docs/strapi-3-source/` stays in-repo as the source-of-truth reference for the migration. **`docs/strapi-3-source/data.db` must be in `.gitignore`** — it's 6.2 MB binary, contains Strapi internals (`strapi_administrator`, `strapi_users_roles`, password hashes), and isn't meant for source control.

---

## Phase-by-phase plan

All paths are relative to `/Volumes/satechi/webdev/icjia-migration-tools/`.

### Phase 0 — Bootstrap

Copy the sibling tree, then surgically remove and replace.

**Copy from sibling:** `migration/lib/*` (all 7 libs), `migration/scripts/00-clean.js`, `package.json` (rename to `icjia-public-cms-migration-2026`), `pnpm-workspace.yaml`, `.nvmrc`, `deploy/` skeleton, `migration/scripts/05-*.js`, `06-*.js`, `07-*.js` (validation/audit/report frameworks), `migrate-full.js`, `set-strapi5-url.js`, `reset-*.js`.

**Drop:** `schemas/*.settings.json` (sibling-specific), `migration/data/`, `migration/output/`, `migration/config/field-type-map.json` (will recreate with ICJIA-specific overrides).

**Create new:**

- `git init` + `git remote add origin https://github.com/ICJIA/icjia-migration-tools.git` — connect to the empty ICJIA org repo. First push happens after Phase 0 lands.
- `.gitignore` — include `docs/strapi-3-source/data.db`, `node_modules`, `migration/data/`, `migration/output/`, `config.js` (per-dev override), `*.log`, `.DS_Store`. Ensure `data.db` is excluded **before** the first `git add`.
- `config.example.js`, `config.dev.js`, `config.prod.js` — mirror sibling structure. `strapi3.graphqlUrl = 'https://agency.icjia-api.cloud/graphql'`. New: `strapi3.sqliteDbPath = './docs/strapi-3-source/data.db'` for direct SQLite reads. Local Strapi 5 on `localhost:1338`.
- `migration/config/content-types.json` — central manifest driving all phases. One entry per type with `{ name, kind, queryName, sqlTable, skipDefault, hasComponents, includeDrafts: true, dominantRelations[] }`. Hand-curated using the dominance matrix above. Singleton kind for `home` only.
- `migration/config/field-type-map.json` — keep sibling's `directMappings` verbatim; `overrides{}` mostly empty (no Base64 splash/thumbnail in this site); `uploadPluginAllowedTypes` populated from each `.settings.json`'s actual `allowedTypes` (e.g., `post.attachments` → `["files","videos"]`, `meeting.attachments` → `["files"]`).

### Phase 1 — Schema (use `.settings.json` directly, like the sibling)

Now that `.settings.json` files are available, Phase 1 reads them directly — same pattern as sibling. SQLite supplements for verification.

**Adapt: `migration/scripts/01a-introspect.js`** — read `docs/strapi-3-source/api/<type>/models/*.settings.json` and `docs/strapi-3-source/components/<cat>/<name>.json`. Persist normalized to `migration/data/introspection/source-schema.json`. Cross-check field types against `PRAGMA table_info` from SQLite for any defaults/constraints not in `.settings.json`.

**Adapt: `migration/lib/schema-generator.js`** — input contract unchanged from sibling (reads `.settings.json`). Add:
- `kind: 'singleType'` emission for `Home` only; everything else stays `collectionType`.
- **Component generation:** emit `<strapi5ProjectPath>/src/components/<category>/<name>.json` for all 10 components. Categories from source folder names (carousel, slide, clickthrough, banner, external, button, menu-item, slider-button, countdown, event).
- Component-typed attributes: emit as `{"type": "component", "repeatable": <isList>, "component": "<category>.<name>"}`.
- `legacyId` field as `{"type": "integer", "unique": true}` on every collection type. Single types skip legacyId (no array semantics).
- Relation dominance: copy `dominant` flag from source; emit `inversedBy` on dominant side, `mappedBy` on the other.
- **Fix incomplete relations:** Policy and RequiredForm tag relations get `via: "policies"`/`"requiredForms"` and `dominant: true` injected during generation.
- **Drop self-ref:** `post.posts` ↔ `post.post` (0 records using it) — remove from generated schema unless user explicitly wants it.
- Persist relation graph to `migration/data/relation-graph.json` for Phase 4 reuse.

**Reuse unchanged:** `01-run-phase.js`, `01c-verify-schemas.js` (introspects deployed S5), schema auto-copy logic.

### Phase 2 — Extract (manifest-driven, drafts included)

**New: `migration/lib/query-builder.js`** — generic GraphQL query generator from `.settings.json` definitions. Output: query string covering all scalars, all relations as `{ id }`, all UploadFile fields as `{ id url name mime size ext hash }`, components recursively expanded. Forms uses `form` (JSON field) preserved as raw string.

**Adapt: `migration/scripts/02-extract.js`** — loop manifest; per type, paginate via `start`/`limit` (default 100). Singleton (`Home`) fetched without pagination via `home { ... }`. Output one JSON per type at `migration/data/raw/<plural>.json` plus `migration/data/raw/manifest.json` with counts.

**Drafts:** GraphQL filters drafts for unauthenticated callers. **Use direct SQLite read** for any type with drafts (publications, meetings, posts, jobs) — bypass GraphQL entirely for those. `migration/lib/sqlite-reader.js` (new, thin wrapper over `better-sqlite3`) handles SELECTs with manual JSON deserialization for relation fields. Form (205 records) also extracted via SQLite since it was 403'd in GraphQL.

**Status filter:** removed. We're migrating drafts too. Strapi 5 `publishedAt` field reflects original `published_at` for drafts (NULL).

**Reuse unchanged:** `02-verify.js` framework — drive expected counts from manifest + SQLite `SELECT COUNT(*)` (now ground truth, including drafts).

### Phase 3 — Media (UploadFile-primary, defensive Base64 secondary, richtext URL rewrite)

Primary path: download UploadFile from source, re-upload to destination.

**New: `migration/scripts/03a-collect-media.js`** — read directly from SQLite `upload_file` table (2,110 rows), cross-reference with content extracts to identify orphaned files (no relations) for separate handling. Output: `migration/data/media/uploadfile-manifest.json` keyed by `hash`.

**New: `migration/scripts/03b-download-media.js`** — fetch each `https://agency.icjia-api.cloud/uploads/<hash><ext>` to `migration/data/media/files/<hash><ext>`. Idempotent — skip files already on disk. Use `fetch` with `requestDelayMs` throttling.

**Adapt: `migration/scripts/03c-upload-media.js`** — same call shape as sibling (POST `/api/upload` via `rest-client.js.uploadFile()`). Preserve original `name`, `alternativeText`, `caption`, `width`, `height`, `mime`, `hash`, `ext` from source. Output: `migration/data/maps/uploadfile.json` mapping `sourceFileId → strapi5UploadId`.

**Defensive Base64 path:**
- `03d-scan-base64.js`, `03e-decode-base64.js` — reused from sibling unchanged. Scan all richtext body fields. Most likely zero hits, but defensive cost is low.

**Adapt: `migration/lib/markdown-rewriter.js`** — extend to detect `https://agency.icjia-api.cloud/uploads/...` (absolute) AND `/uploads/...` (relative) in richtext fields and rewrite using the uploadfile map. Test fixture should include the actual sample: `![Webinar](https://agency.icjia-api.cloud/uploads/07_28_2021_pandemic_ff795b8dc0.jpg)`.

**New: `migration/scripts/03f-rewrite-content.js`** — substitute UploadFile reference IDs in extract JSONs with S5 upload IDs (so Phase 4 sees S5 IDs directly). Combine with body URL rewriting in a single pass. Affected fields: post.body, page.body, grant.body, program.body, meeting.body, biography.bio, plus any other richtext.

**Reuse from sibling:** `base64-decoder.js`, `base64-scanner.js`, `markdown-rewriter.js` core helpers.

### Phase 4 — Load (n-pass relation engine, Home singleton, components inline)

**Adapt: `migration/scripts/04-load.js`** — derive load order from `migration/data/relation-graph.json` (topological sort). Tag loads early (it's dominant on 9 outbound but has 0 m2o dependencies). Form has no relations → loads independently. Per type: POST records to `/api/<plural>` with relations stripped, components inlined, UploadFile IDs already substituted, drafts emitted with `publishedAt: null`. Idempotent via `legacyId` lookup. Output: `migration/data/maps/<plural>.json` mapping source ID → S5 documentId.

**New: `migration/lib/relation-engine.js`** — generic n-pass linker. Reads relation graph, iterates each `{contentType, fieldName}` marked dominant, batch-PUTs `{ <field>: { connect: [{ documentId }] } }`. Concretely: 1 pass for Tag (9 relations linked at once per Tag record), then passes for Post (6), Grant (4), Program (3), Job (2), Event (2), and 1 each for Page/Biography/Meeting (Tag side) — about ~15 passes total, all driven by config not hardcoded.

**New: `migration/lib/single-type-loader.js`** — Strapi 5 single types use `PUT /api/home` with `{ data: {...} }` and no documentId. Wired into `04-load.js` for `Home` only.

**Components in content** — handled inline in the POST body. `Page.clickthrough` (array of `ComponentClickthrough`), `Meeting.external`, `Job.external`, `Home.homeCarousel`/`clickThroughBoxes`/`homeBanner` — all go in the request as-is after Phase 3f's UploadFile substitution. No separate component load pass. Strapi 5 stores them with `__component` discriminator; the manifest tells the loader which fields to wrap.

**Adapt: `04c-fix-timestamps.js`** — reused logic; parameterize SQLite UPDATE by manifest. Both source and destination are SQLite — direct DB access works on both ends. For drafts, also preserve original `published_at: NULL`.

**Reuse unchanged:** `04-run-phase.js`, `04-verify.js` framework.

### Phase 5 — Validate (manifest-driven, ground-truth SQLite cross-checks)

Adapt `05-validate.js`: keep the 10-check structure, with checks now driven by `content-types.json` + SQLite ground truth + GraphQL count cross-checks. Specific changes:

1. **Counts (incl. drafts):** loop manifest, compare source SQLite `SELECT COUNT(*) FROM <table>` to S5 REST `pagination.total` (includes drafts via `publicationState=preview`). 17 checks (all modeled types except deferred Build).
2. **Legacy ID coverage:** every source `id` maps to one S5 record.
3. **Draft preservation:** sample 10 draft records per type, verify `publishedAt: null` in S5.
4. **Base64 remnants:** scan body fields across all types — expect zero.
5. **Media migration:** uploadfile-manifest.json hashes (2,110) vs S5 `/api/upload/files` listing.
6. **Media accessibility:** HTTP 200 for every S5 upload URL.
7. **Relation integrity:** spot-check each dominant edge from the relation graph (Tag's 9 + ~13 others).
8. **Timestamps ±1s.**
9. **Content integrity:** sample 10% of records per type, including richtext body URL-rewrite verification (no `agency.icjia-api.cloud` substrings remaining).
10. **Component instance counts:** total ComponentClickthrough rows in S5 = total clickthrough entries in source `pages_components` + `homes_components`.

### Phase 6 — Audit & Phase 7 — Report (light adapt)

`06-audit.js` — drive field list from manifest; ERROR/EXPECTED/INFO/OK categorization unchanged. Add EXPECTED categories for: `seearchMeta` typo preservation in RequiredForm, `Publication.tags` JSON preservation, `Policy.tags`/`RequiredForm.tags` relation fix (empty in source by definition), self-ref Post relation dropped, body URL rewrites.

`07-generate-report.js` — extend HTML/DOCX template loops to render N types, not 3. New sections: Components, Singleton (Home), Tag-as-hub relation summary, draft record breakdown, Form record summary, orphan-tables exclusion notice.

---

## Critical files to create or modify

**New:**
- `/Volumes/satechi/webdev/icjia-migration-tools/.gitignore` — incl. `docs/strapi-3-source/data.db`
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/config/content-types.json` — central manifest
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/config/field-type-map.json` — ICJIA-specific overrides
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/lib/sqlite-reader.js` — direct SQLite reader for drafts + Form
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/lib/query-builder.js` — generic GraphQL query gen
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/lib/relation-engine.js` — n-pass dominant-side linker
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/lib/single-type-loader.js` — Home loader
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/lib/component-emitter.js` — component schema generator
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/scripts/03a-collect-media.js`
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/scripts/03b-download-media.js`
- `/Volumes/satechi/webdev/icjia-migration-tools/migration/scripts/03f-rewrite-content.js`

**Adapted from sibling:**
- `migration/lib/schema-generator.js` — singleType + components + integer legacyId + Policy/RequiredForm tag relation fix
- `migration/lib/markdown-rewriter.js` — `agency.icjia-api.cloud/uploads/` URL rewriting
- `migration/scripts/01a-introspect.js` — read `.settings.json` from `docs/strapi-3-source/`
- `migration/scripts/01b-generate-schemas.js` — emit components + Home singleton + relation fixes
- `migration/scripts/02-extract.js` — manifest-loop + SQLite extraction for drafts/Form
- `migration/scripts/04-load.js` — manifest-loop + topological sort + singleton handler + draft preservation
- `migration/scripts/05-validate.js` — manifest-driven, SQLite ground-truth counts
- `migration/scripts/06-audit.js` — manifest-driven field iteration
- `migration/scripts/07-generate-report.js` — N-type templating

**Reused unchanged from sibling:**
- `migration/lib/graphql-client.js`, `rest-client.js`, `load-config.js`
- `migration/lib/base64-scanner.js`, `base64-decoder.js`
- `migration/scripts/00-clean.js`, `01-run-phase.js`, `01c-verify-schemas.js`
- `migration/scripts/04c-fix-timestamps.js` and `04c-fix-timestamps-remote.js`
- `migration/scripts/reset-strapi5.js`, `reset-remote.js`, `set-strapi5-url.js`, `migrate-full.js`

---

## Order of work (suggested 8–12 day timeline, single dev — accelerated by `.settings.json` availability)

1. **Day 1:** Phase 0 bootstrap — `.gitignore`, copy sibling, write `content-types.json` manifest from `.settings.json` audit (most of it already inferred — half-day work), smoke-test `pnpm install`.
2. **Day 2:** Phase 1 — schema generator extensions (singletons, components, integer legacyId, Policy/RequiredForm fix), generate all 17 + 10 schemas, verify against fresh local Strapi 5.
3. **Day 3:** Phase 2 — query builder + extract via GraphQL for non-draft types, SQLite reader for drafts and Form. Run end-to-end on a 3-type subset (Tag + Page + 1 component-using type) before scaling to all.
4. **Day 4–5:** Phase 3 — UploadFile collect/download/upload pipeline (2,110 files), richtext URL rewrite, defensive Base64 scan.
5. **Day 6–7:** Phase 4 — load with n-pass relation engine + Home singleton loader + component pass-through + draft preservation + timestamp fix.
6. **Day 8:** Phase 5 — manifest-driven validation, all 10 checks passing.
7. **Day 9:** Phase 6 — parity audit, fix any ERROR-category diffs.
8. **Day 10:** Phase 7 — HTML + DOCX reports.
9. **Day 11–12:** Buffer for edge cases (large richtext bodies, ENUM mismatches, RequiredForm typo handling, production deploy via `config.prod.js`).

**Defer to v2:** `Build` content type (currently empty), incremental sync (`07-sync.js` from sibling can be ported later), orphan tables (`pubs`, `funding-opportunities`, etc.) if business value emerges.

---

## Verification approach

End-to-end verification once the pipeline runs:

1. **`pnpm migrate:full`** — runs phases 1–7 sequentially against a clean local Strapi 5 instance. Exits non-zero on any failure.
2. **`pnpm validate`** — re-runnable any time post-load. Produces `migration/data/validation-report.json` with PASS/FAIL per check. All 10 checks must pass, **including draft preservation**.
3. **`pnpm audit`** — produces `migration/data/audit-report.json` and `.md` with field-by-field parity. Success criterion: **0 ERROR-category diffs**.
4. **`pnpm report`** — generates HTML + DOCX reports for stakeholder review.
5. **Idempotency proof:** re-run `pnpm migrate:phase04` on a populated Strapi 5 — expect 0 records created, all skipped via `legacyId` lookup.
6. **Manual smoke test:** spot-check 3 records per content type via Strapi 5 admin UI, comparing against the live source. Pay particular attention to:
   - **Publication (1139)** — paginated extraction succeeded; 32 drafts present and unpublished.
   - **Form (205)** — JSON `form` field preserved verbatim.
   - **Meeting (283)** — `start`/`end` DateTime preservation; `external` ComponentExternalUrl array intact.
   - **Biography (138)** — `headshot` UploadFile rehosting.
   - **Page (38)** — `clickthrough` component array preserved with order; richtext body URL rewrite confirmed (no `agency.icjia-api.cloud` substrings).
   - **Tag (27)** — all 9 dominant m2m relations linked correctly.
   - **Home (singleton)** — nested ComponentCarousel → ComponentSlide structure with image references rehosted.

---

## Open risks (updated)

- **Component nesting depth** — Carousel→Slide and Button→MenuItem are 2-level (confirmed). If a deeper component ever gets added, query builder needs recursion guarding. Low risk for v1.
- **Form JSON field schema drift** — 205 records with arbitrary JSON in `form`. If Strapi 5 enforces a JSON schema or rejects certain shapes, load fails. Mitigation: load Form first as a smoke test before scaling other types.
- **Draft field coverage** — Strapi 5's draft/publish workflow is field-level configurable. The schema generator must emit `draftAndPublish: true` on all collection types that have any draft records. Verify with a draft Publication smoke test in Phase 2.
- **`agency.icjia-api.cloud` rate limiting on 2,110 file downloads** — not detected during exploration but unconfirmed for sustained download. Mitigate via `requestDelayMs` (default 100ms) and resumable extraction.
- **richtext URL rewrite edge cases** — CDN-style URLs, query strings on URLs, escaped HTML inside richtext, URLs in alt text vs href. Add unit tests for `markdown-rewriter.js` covering each shape before running Phase 3 at scale.
- **ENUM value drift** — Strapi 5 enums are stricter. Phase 5 check #9 catches this; pre-validate by SELECTing distinct enum values from SQLite per type before generating S5 schemas, then matching to declared values.
- **Orphan table revisit** — the 1029 `pubs` records are excluded by user decision but worth a one-line forensics confirmation that they're a true legacy archive (not active content). 5-minute query before final cutover.

---

## Pre-cutover hygiene checklist

Discovered during the audit, separate from the migration tool itself:

- [ ] Confirm `.gitignore` excludes `data.db` before any commit.
- [ ] Run `SELECT MAX(updated_at) FROM pubs` — confirm `pubs` is genuinely abandoned (no recent writes).
- [ ] `Policy.tags` and `RequiredForm.tags` are incomplete in source (no `via`/`dominant`); the migration silently fixes this in S5. Document in audit report so reviewers don't flag it as data loss.
- [ ] `Publication.tags` JSON arrays may contain values that look like Tag titles. Generate a one-time report listing unique JSON tag strings vs existing Tag records — informational, not blocking.
- [ ] Verify `core_store` truly contains nothing critical before discarding (audit found it holds only Strapi internals + disabled OAuth provider configs).

---

## Post-migration evolution (deferred to v1.1 / v2)

The v1 migration prioritizes fidelity and reversibility — preserve everything, change nothing structural. Once v1 has landed and stabilized, opportunities open up for cleaner Strapi 5-idiomatic shapes. Sequencing these post-migration avoids stacking schema risk on top of cutover risk.

### v1.1 — Schema cleanup (small, post-cutover, no frontend impact)

- **Delete unused components** from Strapi 5: `button`, `slider-button`, `countdown`, `add-event`. They're definitions only — zero records reference them. Drop also removes the unused `components_slider_sliders` orphan referenced in `homes_components` but missing a definition.
- Verify no orphaned `*_components` rows remain after deletion.
- **Drop `post.posts ↔ post.post` self-ref** if v1 schema emitter retained it as a placeholder.
- ~30 minutes work, zero data risk, zero frontend coupling.

### v2 — Strapi 5-idiomatic redesign (sequence with the next frontend refresh)

- **Home page Dynamic Zone:** convert `Home.homeCarousel` + `clickThroughBoxes` + `homeBanner` (three fixed component slots) into a single polymorphic Dynamic Zone field. Editors gain section reordering without schema changes; the homepage becomes data-driven layout.
- **Strapi 5 Blocks for body fields:** evaluate Blocks (structured rich-text editor) as a replacement for richtext + inline-image components in `post.body`, `page.body`, `grant.body`, `program.body`, `meeting.body`, `biography.bio`. Yields structured JSON output instead of HTML strings, cleaner editor UX, removes the need for body URL rewriting in future migrations.
- **Rename awkward components:** `ComponentClickthroughClickthrough` → `clickthrough`, etc. Strapi 5 supports renames via content-type migrations; frontend GraphQL queries update accordingly.
- **Promote `Publication.tags` JSON → real Tag m2m:** v1 preserved the JSON arrays literally. A one-shot script parses JSON arrays, matches strings to existing Tag records by slug/title, populates the m2m relation, and drops the JSON field once the frontend stops reading it.
- **Replace `add-event` component's tag collection** with a direct relation field. Component-level relations are a Strapi 3 idiom; Strapi 5 handles this cleanly at the content-type level.
- **Re-evaluate `Config` (collectionType, 4 records):** if usage analysis confirms it behaves as a single configuration, convert to a true `singleType` in Strapi 5. If the 4 records are environment-scoped (dev/stg/prod/qa), keep as collectionType but add a clearer slug/key.
- **Structured `Form` schema** (optional): the 205 records currently store form definitions as opaque JSON. If a common shape emerges, define typed fields; otherwise keep as JSON for flexibility.

### Sequencing rationale

| Phase | Risk | Frontend coupling | Recommended timing |
|---|---|---|---|
| v1 (this plan) | Low — preserves source verbatim | None | Now |
| v1.1 cleanup | Very low — pure dead-code removal | None | 1–2 weeks after v1 stabilizes |
| v2 redesign | Medium — schema reshape + data backfill | High (frontend rewrite) | Sequence with next planned frontend refresh |

Each v2 step requires a small one-time data backfill script — same skills the migration tool exercises, so the team will be well-positioned to do it after v1 lands.
