/**
 * @module 03f-rewrite-content
 * @description Phase 3f: Substitute UploadFile IDs and rewrite richtext URLs.
 *
 * Reads:
 *   - `migration/data/raw/<plural>.json` (extracted records from Phase 2)
 *   - `migration/data/maps/uploadfile-map.json` (Phase 3c upload map)
 *   - `migration/data/introspection/source-schema.json` (field type info)
 *
 * For each record across all active content types:
 *
 *   1. **UploadFile substitution.** Replace every `{id, url, hash, ...}`
 *      UploadFile reference with `{id: <strapi5Id>}` so Phase 4 can pass it
 *      directly to Strapi 5's relation `connect` syntax. The original URL,
 *      hash, mime, etc. are dropped — Strapi 5 fetches them from the upload
 *      record itself.
 *
 *   2. **Richtext URL rewrite.** For every richtext field (auto-detected from
 *      the source schema as `type: "richtext"`), rewrite embedded
 *      `agency.icjia-api.cloud/uploads/<hash>` URLs to the new Strapi 5 URLs
 *      via `markdown-rewriter.rewriteUploadUrls`.
 *
 *   3. **Defensive Base64 sweep.** Optionally scan richtext for stray Base64
 *      data URIs (defensive — likely zero hits for ICJIA, which uses
 *      UploadFile-primary).
 *
 * Writes the transformed records to `migration/data/transformed/<plural>.json`.
 *
 * Idempotent — re-running rewrites from `raw/` to `transformed/` cleanly.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { rewriteUploadUrls, checkForRemnants } from '../lib/markdown-rewriter.js';
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

async function loadManifest() {
  const p = path.resolve(ROOT, config.paths.contentTypesManifest);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function loadSourceSchema() {
  const p = path.resolve(ROOT, config.paths.introspection, 'source-schema.json');
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Build a Set of "type.field" pairs that are richtext fields, plus a map of
 * components → set of richtext fields. Used to know which strings to URL-rewrite.
 */
function buildRichtextFieldIndex(sourceSchema) {
  const contentTypeRichtext = new Map(); // ctName → Set<fieldName>
  const componentRichtext = new Map();   // "category.name" → Set<fieldName>

  for (const entry of sourceSchema.contentTypes) {
    if (!entry.model) continue;
    const set = new Set();
    for (const [fieldName, def] of Object.entries(entry.model.attributes || {})) {
      if (def.type === 'richtext' || def.type === 'text' || (def.type === 'string' && fieldName === 'body')) {
        set.add(fieldName);
      }
    }
    if (set.size > 0) contentTypeRichtext.set(entry.manifest.name, set);
  }

  for (const entry of sourceSchema.components) {
    if (!entry.model) continue;
    const set = new Set();
    for (const [fieldName, def] of Object.entries(entry.model.attributes || {})) {
      if (def.type === 'richtext' || def.type === 'text') set.add(fieldName);
    }
    if (set.size > 0) {
      componentRichtext.set(`${entry.manifest.category}.${entry.manifest.name}`, set);
    }
  }

  return { contentTypeRichtext, componentRichtext };
}

/**
 * Walk a record tree and substitute UploadFile references with `{id: <strapi5Id>}`.
 * Tracks any unmatched references (source UploadFile not in our upload map).
 */
function substituteUploadFiles(record, uploadMap, stats) {
  if (record === null || record === undefined) return record;

  if (Array.isArray(record)) {
    return record.map((item) => substituteUploadFiles(item, uploadMap, stats));
  }

  if (typeof record === 'object') {
    // UploadFile detection
    const isUploadFile =
      record.id !== undefined &&
      typeof record.url === 'string' &&
      typeof record.hash === 'string' &&
      typeof record.ext === 'string';

    if (isUploadFile) {
      const entry = uploadMap[record.hash];
      if (entry && entry.strapi5Id) {
        stats.substituted++;
        return { id: entry.strapi5Id };
      }
      stats.unmatched.push({ hash: record.hash, name: record.name });
      // Preserve original — Phase 4 will skip a record with bad upload refs
      return record;
    }

    // Recurse into properties
    const out = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = substituteUploadFiles(v, uploadMap, stats);
    }
    return out;
  }

  return record;
}

/**
 * Rewrite richtext URLs in a record's known richtext fields.
 * Recurses into components to handle nested richtext.
 */
function rewriteRichtext(record, ctName, richtextIndex, uploadMap, stats, sourceSchema) {
  if (record === null || record === undefined) return record;

  if (Array.isArray(record)) {
    return record.map((item) => rewriteRichtext(item, ctName, richtextIndex, uploadMap, stats, sourceSchema));
  }

  if (typeof record !== 'object') return record;

  const richtextFields = richtextIndex.contentTypeRichtext.get(ctName);

  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (richtextFields?.has(k) && typeof v === 'string') {
      const result = rewriteUploadUrls(v, uploadMap);
      out[k] = result.rewritten;
      stats.urlReplacements += result.replacedCount;
      for (const u of result.unmatched) {
        stats.unmatchedUrls.push({ field: k, ...u });
      }
      // Defensive Base64 sweep on the rewritten text
      const remnants = checkForRemnants(out[k]);
      if (remnants.length > 0) {
        stats.base64Remnants += remnants.length;
        if (stats.base64Samples.length < 5) {
          stats.base64Samples.push({ ctName, field: k, sample: remnants[0].context });
        }
      }
      continue;
    }

    // Component arrays/objects need their own richtext rewrite
    if (v !== null && typeof v === 'object' && v.__component_ref) {
      // (Strapi 3 didn't tag with __component_ref, so this branch is unused —
      // component-typed children are reached by general recursion below.)
    }

    if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
      // For component nested objects we need to rewrite their richtext too.
      // The trick: we lose the per-component richtext awareness here.
      // Workaround: apply rewriteUploadUrls to *every* string in nested objects
      // — that's safe since the regex is specific to /uploads/ URLs.
      out[k] = rewriteRichtextDeep(v, uploadMap, stats);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Generic deep walk: rewrite upload URLs in any string value found.
 * Used for component-nested fields where we don't know which fields are richtext.
 * The URL regex is specific enough that it only matches genuine /uploads/ paths.
 */
function rewriteRichtextDeep(value, uploadMap, stats) {
  if (typeof value === 'string') {
    const result = rewriteUploadUrls(value, uploadMap);
    if (result.replacedCount > 0) {
      stats.urlReplacements += result.replacedCount;
      stats.unmatchedUrls.push(...result.unmatched);
      return result.rewritten;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteRichtextDeep(v, uploadMap, stats));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = rewriteRichtextDeep(v, uploadMap, stats);
    }
    return out;
  }
  return value;
}

async function main() {
  console.log(`${BOLD}── Phase 3f: Rewrite content (substitute UploadFile IDs + richtext URLs) ──${RESET}\n`);

  const manifest = await loadManifest();
  const sourceSchema = await loadSourceSchema();

  // Load upload map
  const mapPath = path.resolve(ROOT, config.paths.maps, 'uploadfile-map.json');
  if (!existsSync(mapPath)) {
    console.error(`${RED}ERROR${RESET} ${path.relative(ROOT, mapPath)} not found.`);
    console.error(`Run ${CYAN}node migration/scripts/03c-upload-media.js${RESET} first.`);
    process.exit(1);
  }
  const uploadMap = JSON.parse(await fs.readFile(mapPath, 'utf8'));

  const successfulUploads = Object.entries(uploadMap).filter(([, v]) => v.strapi5Id).length;
  const failedUploads = Object.entries(uploadMap).filter(([, v]) => v.error).length;
  console.log(`Loaded upload map: ${successfulUploads} successful uploads${failedUploads > 0 ? `, ${YELLOW}${failedUploads} failed${RESET}` : ''}`);

  const richtextIndex = buildRichtextFieldIndex(sourceSchema);
  console.log(`Richtext fields detected: ${richtextIndex.contentTypeRichtext.size} content types, ${richtextIndex.componentRichtext.size} components`);
  console.log('');

  // Per-type processing
  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);
  await fs.mkdir(transformedDir, { recursive: true });

  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  const totals = {
    types: 0,
    records: 0,
    uploadSubstitutions: 0,
    unmatchedUploads: [],
    urlReplacements: 0,
    unmatchedUrls: [],
    base64Remnants: 0,
    base64Samples: [],
  };

  for (const ct of activeTypes) {
    const fileName = ct.queryName + '.json';
    const inPath = path.join(rawDir, fileName);
    const outPath = path.join(transformedDir, fileName);

    if (!existsSync(inPath)) {
      console.log(`  ${YELLOW}skip${RESET} ${ct.name} (no extract)`);
      continue;
    }

    const parsed = JSON.parse(await fs.readFile(inPath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : [parsed];

    const stats = {
      substituted: 0,
      unmatched: [],
      urlReplacements: 0,
      unmatchedUrls: [],
      base64Remnants: 0,
      base64Samples: [],
    };

    const transformed = records.map((record) => {
      // First substitute UploadFile refs (so the upload subobject becomes {id})
      const withUploadIds = substituteUploadFiles(record, uploadMap, stats);
      // Then rewrite URLs in richtext fields
      const withRewrites = rewriteRichtext(withUploadIds, ct.name, richtextIndex, uploadMap, stats, sourceSchema);
      return withRewrites;
    });

    // Singletons: unwrap from array if the source was a single object
    const writeable = ct.kind === 'singleType' && transformed.length === 1 ? transformed[0] : transformed;
    await fs.writeFile(outPath, JSON.stringify(writeable, null, 2));

    totals.types++;
    totals.records += records.length;
    totals.uploadSubstitutions += stats.substituted;
    totals.unmatchedUploads.push(...stats.unmatched);
    totals.urlReplacements += stats.urlReplacements;
    totals.unmatchedUrls.push(...stats.unmatchedUrls);
    totals.base64Remnants += stats.base64Remnants;
    totals.base64Samples.push(...stats.base64Samples);

    const subInfo = stats.substituted > 0 ? `${DIM}${stats.substituted} upload IDs${RESET}` : `${DIM}0 uploads${RESET}`;
    const urlInfo = stats.urlReplacements > 0 ? `, ${DIM}${stats.urlReplacements} URLs rewritten${RESET}` : '';
    const warnInfo = stats.unmatched.length > 0 ? ` ${YELLOW}${stats.unmatched.length} unmatched uploads${RESET}` : '';
    const b64Info = stats.base64Remnants > 0 ? ` ${YELLOW}${stats.base64Remnants} Base64 remnants${RESET}` : '';
    console.log(`  ${GREEN}✓${RESET} ${ct.name.padEnd(16)} ${records.length.toString().padStart(5)} records, ${subInfo}${urlInfo}${warnInfo}${b64Info}`);
  }

  // Save report
  const reportPath = path.resolve(ROOT, 'migration/data/rewrite-report.json');
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: {
          types: totals.types,
          records: totals.records,
          uploadSubstitutions: totals.uploadSubstitutions,
          urlReplacements: totals.urlReplacements,
          base64Remnants: totals.base64Remnants,
          unmatchedUploadsCount: totals.unmatchedUploads.length,
          unmatchedUrlsCount: totals.unmatchedUrls.length,
        },
        unmatchedUploadsSample: totals.unmatchedUploads.slice(0, 20),
        unmatchedUrlsSample: totals.unmatchedUrls.slice(0, 20),
        base64Samples: totals.base64Samples,
      },
      null,
      2,
    ),
  );

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Types processed:        ${totals.types}`);
  console.log(`  Records transformed:    ${totals.records}`);
  console.log(`  UploadFile IDs swapped: ${totals.uploadSubstitutions}`);
  console.log(`  URLs rewritten in body: ${totals.urlReplacements}`);
  if (totals.unmatchedUploads.length > 0) {
    console.log(`  ${YELLOW}Unmatched uploads:      ${totals.unmatchedUploads.length}${RESET}` +
      ` ${DIM}(refs not in upload map — may need to re-run 03c)${RESET}`);
  }
  if (totals.unmatchedUrls.length > 0) {
    console.log(`  ${YELLOW}Unmatched body URLs:    ${totals.unmatchedUrls.length}${RESET}` +
      ` ${DIM}(URLs in richtext that don't resolve in upload map)${RESET}`);
  }
  if (totals.base64Remnants > 0) {
    console.log(`  ${YELLOW}Base64 remnants:        ${totals.base64Remnants}${RESET}`);
  }
  console.log(`  Report:                 ${path.relative(ROOT, reportPath)}`);
  console.log('');

  // Failure if any unmatched uploads — those are blocking for Phase 4
  if (totals.unmatchedUploads.length > 0) {
    console.log(`${RED}${BOLD}Phase 3f had unmatched UploadFile refs.${RESET}`);
    console.log(`Re-run 03c-upload-media to upload missing files, then re-run this script.`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 3f complete.${RESET}`);
  console.log('');
  console.log('Next: Phase 4 (Load content into Strapi 5)');
  console.log(`  ${CYAN}pnpm migrate:phase04${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
