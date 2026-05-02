/**
 * @module 04-load
 * @description Phase 4 step 1: Load all content records into Strapi 5.
 *
 * For each active content type:
 *
 *   1. Read `migration/data/transformed/<plural>.json` (Phase 3f output, with
 *      UploadFile IDs already swapped and richtext URLs rewritten).
 *
 *   2. For each record, build a Strapi 5 POST body by:
 *      - Dropping the source `id` (saved as `legacyId` separately)
 *      - Dropping snake_case timestamps (`created_at`, `updated_at`,
 *        `published_at`) — restored separately in 04c-fix-timestamps via
 *        direct SQLite UPDATE
 *      - Dropping all relation fields (linked separately in 04b-link-relations)
 *      - Dropping self-ref fields per SELF_REF_DROPS
 *      - Keeping scalars, components (inline), and UploadFile m2o refs (`{id}`)
 *      - Adding `legacyId: <int>` for idempotent re-runs
 *      - Adding `publishedAt: <iso>` for published, `null` for drafts
 *
 *   3. Idempotency: skip if a record with this `legacyId` already exists in S5.
 *
 *   4. POST to `/api/<pluralName>` (or PUT for single types via single-type-loader).
 *
 *   5. Record source-id → S5 documentId in `migration/data/maps/<plural>.json`.
 *
 * @example
 *   pnpm migrate:phase04          # full Phase 4 (load + link + timestamps + verify)
 *   node migration/scripts/04-load.js               # just load
 *   node migration/scripts/04-load.js --type=tag    # one type
 *   node migration/scripts/04-load.js --force       # bypass idempotency
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { RestClient } from '../lib/rest-client.js';
import { upsertSingleType } from '../lib/single-type-loader.js';
import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const config = await loadConfig();

const argv = process.argv.slice(2);
const TYPE_FILTER = argv.find((a) => a.startsWith('--type='))?.slice('--type='.length);
const FORCE = argv.includes('--force');
const UPDATE_EXISTING = argv.includes('--update-existing');
const UPDATE_NEWER = argv.includes('--update-newer');

// Strapi 3 internal fields to strip — Strapi 5 manages these itself
const STRAPI3_INTERNAL_FIELDS = new Set([
  'id',                            // saved as legacyId separately
  'created_at', 'updated_at',      // restored in 04c via direct SQLite UPDATE
  'createdAt', 'updatedAt',
  'created_by', 'updated_by',      // Strapi 3 admin user FK — meaningless in S5
  'createdBy', 'updatedBy',
  '__v', '_id',                    // MongoDB internals (defensive — ICJIA is SQLite)
]);

const SELF_REF_DROPS = new Set(['post.posts', 'post.post']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadManifest() {
  return JSON.parse(await fs.readFile(path.resolve(ROOT, config.paths.contentTypesManifest), 'utf8'));
}

async function loadSourceSchema() {
  return JSON.parse(await fs.readFile(path.resolve(ROOT, config.paths.introspection, 'source-schema.json'), 'utf8'));
}

/**
 * Classify each attribute on a content type so the loader knows what to do
 * with it: scalar (keep), component (keep inline), upload (keep as {id}),
 * or relation (drop — linked separately in 04b).
 */
function classifyAttributes(model) {
  const scalars = new Set();
  const components = new Set();
  const uploads = new Set();
  const relations = new Set();

  for (const [name, def] of Object.entries(model?.attributes || {})) {
    if (def.plugin === 'upload') {
      uploads.add(name);
    } else if (def.type === 'component') {
      components.add(name);
    } else if (def.collection || def.model) {
      relations.add(name);
    } else {
      scalars.add(name);
    }
  }
  return { scalars, components, uploads, relations };
}

/**
 * Build the POST body for one record.
 *
 * Allowlist approach: only forward fields that are explicitly known to the
 * destination schema (scalars, components, or uploads). The Strapi 3 source
 * sometimes returns extra fields (e.g., `isFeatured` on biography, `site`
 * on form) that aren't declared in the model — Strapi 5 rejects unknown keys.
 *
 * @param {Object} options - { isSingleType: boolean }
 */
function buildRecordBody(record, ctName, classified, options = {}) {
  const { isSingleType = false } = options;
  const body = {};

  for (const [key, value] of Object.entries(record)) {
    if (STRAPI3_INTERNAL_FIELDS.has(key)) continue;
    if (key === 'published_at') continue;
    if (SELF_REF_DROPS.has(`${ctName}.${key}`)) continue;
    if (classified.relations.has(key)) continue;

    // Allowlist: only keep fields the destination schema knows about
    const isKnown =
      classified.scalars.has(key) ||
      classified.components.has(key) ||
      classified.uploads.has(key);
    if (!isKnown) continue;

    // Drop nulls — Strapi 5's type validators reject null on typed fields,
    // even on drafts. Omitting the key lets the field default to whatever
    // the column allows (null for nullable, default for non-nullable).
    if (value === null || value === undefined) continue;

    body[key] = value;
  }

  // legacyId only on collection types (singletons have no array semantics)
  if (!isSingleType) {
    const sourceIdNum = parseInt(record.id, 10);
    if (!Number.isNaN(sourceIdNum)) {
      body.legacyId = sourceIdNum;
    }
  }

  // Preserve draft/publish state — null for drafts, ISO string for published
  if (record.published_at) {
    body.publishedAt = record.published_at;
  } else {
    body.publishedAt = null;
  }

  return body;
}

/**
 * Look up an existing record in Strapi 5 by legacyId. Returns the documentId,
 * or null if not found.
 */
async function findExistingByLegacyId(client, ctManifest, legacyId) {
  const pluralName = restPluralName(ctManifest);
  const params = {
    'filters[legacyId][$eq]': legacyId,
    'fields[0]': 'documentId',
    'pagination[pageSize]': 1,
    publicationState: 'preview', // include drafts
  };
  try {
    const result = await client.get(`/api/${pluralName}`, params);
    const found = result.data?.[0];
    return found?.documentId || null;
  } catch {
    return null;
  }
}

function restPluralName(manifest) {
  if (manifest.kind === 'singleType') return manifest.name;
  return (manifest.queryName || manifest.name)
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

async function main() {
  console.log(`${BOLD}── Phase 4 step 1: Load records into Strapi 5 ──${RESET}\n`);

  if (!config.strapi5.token) {
    console.error(`${RED}ERROR${RESET} STRAPI5_TOKEN is not set. Edit config.js or export the env var.`);
    process.exit(1);
  }

  const manifest = await loadManifest();
  const sourceSchema = await loadSourceSchema();

  let activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);
  if (TYPE_FILTER) {
    activeTypes = activeTypes.filter((c) => c.name === TYPE_FILTER);
    if (activeTypes.length === 0) {
      console.error(`${RED}ERROR${RESET} no active type matches --type=${TYPE_FILTER}`);
      process.exit(1);
    }
  }

  const schemaByName = new Map(sourceSchema.contentTypes.map((e) => [e.manifest.name, e]));

  const transformedDir = path.resolve(ROOT, config.paths.transformedData);
  const mapsDir = path.resolve(ROOT, config.paths.maps);
  await fs.mkdir(mapsDir, { recursive: true });

  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings?.requestTimeoutMs || 30000,
  });

  const delay = config.settings?.requestDelayMs || 100;

  console.log(`Configuration:`);
  console.log(`  Strapi 5 API:    ${CYAN}${config.strapi5.apiUrl}${RESET}`);
  console.log(`  Transformed dir: ${CYAN}${path.relative(ROOT, transformedDir)}${RESET}`);
  console.log(`  Maps dir:        ${CYAN}${path.relative(ROOT, mapsDir)}${RESET}`);
  console.log(`  Active types:    ${activeTypes.length}${TYPE_FILTER ? ` (filtered to ${TYPE_FILTER})` : ''}`);
  console.log(`  Idempotency:     ${FORCE ? `${YELLOW}--force (skip legacyId check)${RESET}` : `${GREEN}skip if legacyId exists${RESET}`}`);
  console.log('');

  const overall = { types: 0, created: 0, skipped: 0, failed: 0, drafts: 0 };

  for (const ct of activeTypes) {
    const t0 = Date.now();
    const filePath = path.join(transformedDir, ct.queryName + '.json');
    const mapPath = path.join(mapsDir, ct.queryName + '.json');

    if (!existsSync(filePath)) {
      console.log(`  ${YELLOW}skip${RESET} ${ct.name} (no transformed file)`);
      continue;
    }

    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : [parsed];

    const sourceEntry = schemaByName.get(ct.name);
    if (!sourceEntry) {
      console.log(`  ${YELLOW}skip${RESET} ${ct.name} (no source schema entry)`);
      continue;
    }
    const classified = classifyAttributes(sourceEntry.model);

    let map = {};
    if (existsSync(mapPath) && !FORCE) {
      try {
        map = JSON.parse(await fs.readFile(mapPath, 'utf8'));
      } catch {
        map = {};
      }
    }

    const stats = { created: 0, skipped: 0, failed: 0, drafts: 0, errors: [] };

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const sourceId = String(rec.id);

      // Skip-already-loaded by default. --update-existing PUTs every
      // matching record. --update-newer PUTs only if source updated_at
      // is newer than the last sync.
      const existingDocId = map[sourceId]?.documentId;
      if (existingDocId && !FORCE && !UPDATE_EXISTING && !UPDATE_NEWER) {
        stats.skipped++;
        continue;
      }
      if (existingDocId && UPDATE_NEWER) {
        const lastSyncMs = map[sourceId]?.lastSyncedAt
          ? new Date(map[sourceId].lastSyncedAt).getTime()
          : 0;
        const sourceUpdMs = rec.updated_at ? new Date(rec.updated_at).getTime() : 0;
        if (sourceUpdMs <= lastSyncMs) {
          stats.skipped++;
          continue;
        }
      }

      const body = buildRecordBody(rec, ct.name, classified, {
        isSingleType: ct.kind === 'singleType',
      });
      const isDraft = body.publishedAt === null || body.publishedAt === undefined;
      if (isDraft) stats.drafts++;

      try {
        let result;
        if (ct.kind === 'singleType') {
          result = await upsertSingleType(client, ct.name, body);
          map[sourceId] = {
            sourceId,
            legacyId: body.legacyId,
            documentId: result.data?.documentId || 'singleton',
            isSingleton: true,
          };
        } else {
          if (!FORCE && body.legacyId !== undefined) {
            const existingDocId = await findExistingByLegacyId(client, ct, body.legacyId);
            if (existingDocId) {
              map[sourceId] = {
                sourceId,
                legacyId: body.legacyId,
                documentId: existingDocId,
                preexisting: true,
              };
              stats.skipped++;
              continue;
            }
          }

          if (existingDocId && (UPDATE_EXISTING || UPDATE_NEWER)) {
            // PUT to update an existing record
            result = await client.put(`/api/${restPluralName(ct)}/${existingDocId}`, body);
            map[sourceId] = {
              ...map[sourceId],
              legacyId: body.legacyId,
              documentId: result.data?.documentId || existingDocId,
              id: result.data?.id || map[sourceId].id,
              lastSyncedAt: new Date().toISOString(),
              updated: true,
            };
          } else {
            result = await client.post(`/api/${restPluralName(ct)}`, body);
            map[sourceId] = {
              sourceId,
              legacyId: body.legacyId,
              documentId: result.data?.documentId,
              id: result.data?.id,
              lastSyncedAt: new Date().toISOString(),
            };
          }
        }
        stats.created++;
        if (delay > 0) await sleep(delay);
      } catch (err) {
        stats.failed++;
        stats.errors.push({ sourceId, message: err.message.slice(0, 500) });
        map[sourceId] = { sourceId, legacyId: body.legacyId, error: err.message };
      }

      if ((i + 1) % 50 === 0 || i === records.length - 1) {
        await fs.writeFile(mapPath, JSON.stringify(map, null, 2));
      }
    }

    await fs.writeFile(mapPath, JSON.stringify(map, null, 2));

    overall.types++;
    overall.created += stats.created;
    overall.skipped += stats.skipped;
    overall.failed += stats.failed;
    overall.drafts += stats.drafts;

    const ms = Date.now() - t0;
    const draftNote = stats.drafts > 0 ? ` ${DIM}(${stats.drafts} drafts)${RESET}` : '';
    const skipNote = stats.skipped > 0 ? `, ${DIM}${stats.skipped} skipped${RESET}` : '';
    const failNote = stats.failed > 0 ? `, ${RED}${stats.failed} failed${RESET}` : '';
    const icon = stats.failed === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${ct.name.padEnd(16)} ${stats.created.toString().padStart(5)} created${draftNote}${skipNote}${failNote} ${DIM}${ms}ms${RESET}`);

    for (const e of stats.errors.slice(0, 3)) {
      console.log(`    ${RED}[${e.sourceId}]${RESET} ${e.message.slice(0, 200)}`);
    }
  }

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Types loaded:    ${overall.types}`);
  console.log(`  Created:         ${overall.created}`);
  console.log(`  Skipped:         ${overall.skipped} ${DIM}(idempotency)${RESET}`);
  console.log(`  Failed:          ${overall.failed}`);
  console.log(`  Drafts created:  ${overall.drafts}`);
  console.log('');

  if (overall.failed > 0) {
    console.log(`${RED}${BOLD}Phase 4 load had failures.${RESET}`);
    console.log(`Review per-type maps at ${CYAN}migration/data/maps/${RESET} for error details.`);
    console.log(`Re-run to retry: ${CYAN}node migration/scripts/04-load.js${RESET}`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 4 load complete.${RESET}`);
  console.log('');
  console.log('Next: 04b-link-relations (link m2m + m2o relations)');
  console.log(`  ${CYAN}node migration/scripts/04b-link-relations.js${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
