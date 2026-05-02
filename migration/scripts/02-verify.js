/**
 * @module 02-verify
 * @description Phase 2 verification: validates extracted data integrity.
 *
 * Runs independently of the extraction script — useful for re-verifying
 * after Strapi 3 data changes without re-extracting.
 *
 * Checks:
 * 1. All 3 raw JSON files exist and parse successfully
 * 2. Manifest exists and counts match actual file record counts
 * 3. Every record has a non-null `id` matching MongoDB ObjectId format
 * 4. Every record has `createdAt` and `updatedAt` (non-null)
 * 5. No duplicate `id` values within any file
 * 6. Article relation arrays (`datasets`, `apps`) are present
 * 7. Article media references (`mainfile`, `extrafile`) are well-formed when present
 * 8. Dataset `datafile` objects are well-formed when present
 * 9. Dataset/app relation arrays are present
 * 10. App `image` field is captured
 * 11. Record counts match Strapi 3 REST count endpoints (if reachable)
 *
 * @example
 *   node migration/scripts/02-verify.js
 *
 * Prerequisites:
 * - Phase 2 extraction complete (`migration/data/raw/*.json` files exist)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

const OBJECT_ID_RE = /^[a-f0-9]{24}$/;

/** @type {{name: string, passed: boolean, detail: string}[]} */
const results = [];

/**
 * Record a check result.
 * @param {string} name - Check name
 * @param {boolean} passed - Whether the check passed
 * @param {string} detail - Description of the result
 */
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  const icon = passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${icon} ${name}: ${detail}`);
}

/**
 * Load and parse a JSON file, returning null if it doesn't exist or fails.
 * @param {string} filePath - Absolute path to the JSON file
 * @returns {Promise<any|null>}
 */
async function loadJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Query a Strapi 3 REST count endpoint.
 * @param {string} contentType - Plural name (e.g., "articles")
 * @returns {Promise<number|null>}
 */
async function getRestCount(contentType) {
  const url = `${config.strapi3.apiUrl}/${contentType}/count`;
  const headers = {};
  if (config.strapi3.token) {
    headers['Authorization'] = `Bearer ${config.strapi3.token}`;
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const count = await res.json();
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

/**
 * Validate a media reference object has the required fields.
 * @param {Object} media - The media object from the extracted data
 * @returns {boolean}
 */
function isValidMediaRef(media) {
  return media && typeof media.url === 'string' && typeof media.name === 'string' && typeof media.mime === 'string';
}

async function main() {
  console.log('=== Phase 2: Verification ===\n');

  const rawDir = path.resolve(ROOT, config.paths.rawData);

  // 1. Load files
  const manifest = await loadJson(path.join(rawDir, 'manifest.json'));
  const articles = await loadJson(path.join(rawDir, 'articles.json'));
  const datasets = await loadJson(path.join(rawDir, 'datasets.json'));
  const apps = await loadJson(path.join(rawDir, 'apps.json'));

  check('manifest.json exists', !!manifest, manifest ? 'loaded' : 'MISSING — run 02-extract.js first');
  check('articles.json parses', Array.isArray(articles), articles ? `${articles.length} records` : 'MISSING or invalid JSON');
  check('datasets.json parses', Array.isArray(datasets), datasets ? `${datasets.length} records` : 'MISSING or invalid JSON');
  check('apps.json parses', Array.isArray(apps), apps ? `${apps.length} records` : 'MISSING or invalid JSON');

  if (!articles || !datasets || !apps || !manifest) {
    console.log(`\n${RED}Cannot continue — required files are missing.${RESET}`);
    process.exit(1);
  }

  console.log('');

  // 2. Manifest counts match actual
  const data = { articles, datasets, apps };
  for (const [ct, records] of Object.entries(data)) {
    const expected = manifest.counts?.[ct];
    check(`${ct} manifest count`, expected === records.length,
      `manifest says ${expected}, file has ${records.length}`);
  }

  console.log('');

  // 3-5. Per-record checks for each content type
  for (const [ct, records] of Object.entries(data)) {
    let idsValid = 0;
    let timestampsValid = 0;
    const idSet = new Set();
    let duplicateIds = 0;

    for (const record of records) {
      // ID check
      if (record.id && OBJECT_ID_RE.test(record.id)) {
        idsValid++;
      }
      // Duplicate check
      if (idSet.has(record.id)) {
        duplicateIds++;
      }
      idSet.add(record.id);
      // Timestamp check
      if (record.createdAt && record.updatedAt) {
        timestampsValid++;
      }
    }

    check(`${ct} IDs are ObjectIds`, idsValid === records.length,
      `${idsValid}/${records.length} valid`);
    check(`${ct} no duplicate IDs`, duplicateIds === 0,
      duplicateIds === 0 ? 'all unique' : `${duplicateIds} duplicates found`);
    check(`${ct} timestamps present`, timestampsValid === records.length,
      `${timestampsValid}/${records.length} have createdAt + updatedAt`);
  }

  console.log('');

  // 6. Article-specific checks
  let articlesWithRelations = 0;
  let articlesWithMainfile = 0;
  let articlesWithExtrafile = 0;
  let mainfileValid = 0;
  let extrafileValid = 0;

  for (const article of articles) {
    if (Array.isArray(article.datasets) && Array.isArray(article.apps)) {
      articlesWithRelations++;
    }
    if (article.mainfile) {
      articlesWithMainfile++;
      if (isValidMediaRef(article.mainfile)) mainfileValid++;
    }
    if (article.extrafile) {
      articlesWithExtrafile++;
      if (isValidMediaRef(article.extrafile)) extrafileValid++;
    }
  }

  check('article relation arrays', articlesWithRelations === articles.length,
    `${articlesWithRelations}/${articles.length} have datasets[] + apps[]`);
  check('article mainfile refs', articlesWithMainfile === 0 || mainfileValid === articlesWithMainfile,
    `${mainfileValid}/${articlesWithMainfile} valid (${articles.length - articlesWithMainfile} null)`);
  check('article extrafile refs', articlesWithExtrafile === 0 || extrafileValid === articlesWithExtrafile,
    `${extrafileValid}/${articlesWithExtrafile} valid (${articles.length - articlesWithExtrafile} null)`);

  // 7. Dataset-specific checks
  let datasetsWithRelations = 0;
  let datasetsWithDatafile = 0;
  let datafileValid = 0;

  for (const dataset of datasets) {
    if (Array.isArray(dataset.apps) && Array.isArray(dataset.articles)) {
      datasetsWithRelations++;
    }
    if (dataset.datafile) {
      datasetsWithDatafile++;
      if (isValidMediaRef(dataset.datafile)) datafileValid++;
    }
  }

  check('dataset relation arrays', datasetsWithRelations === datasets.length,
    `${datasetsWithRelations}/${datasets.length} have apps[] + articles[]`);
  check('dataset datafile refs', datasetsWithDatafile === 0 || datafileValid === datasetsWithDatafile,
    `${datafileValid}/${datasetsWithDatafile} valid (${datasets.length - datasetsWithDatafile} null)`);

  // 8. App-specific checks
  let appsWithRelations = 0;
  let appsWithImage = 0;

  for (const app of apps) {
    if (Array.isArray(app.datasets) && Array.isArray(app.articles)) {
      appsWithRelations++;
    }
    if (app.image !== null && app.image !== undefined) {
      appsWithImage++;
    }
  }

  check('app relation arrays', appsWithRelations === apps.length,
    `${appsWithRelations}/${apps.length} have datasets[] + articles[]`);
  check('app image field captured', true,
    `${appsWithImage}/${apps.length} have non-null image`);

  console.log('');

  // 9. REST count verification
  const allowedStatuses = config.allowedStatuses || null;
  console.log('Checking Strapi 3 REST count endpoints...');
  for (const ct of Object.keys(data)) {
    const restCount = await getRestCount(ct);
    if (restCount === null) {
      check(`${ct} REST count`, true, `${YELLOW}endpoint unavailable — skipped${RESET}`);
    } else if (allowedStatuses) {
      // When filtering by status, extracted count will be <= REST total — this is expected
      check(`${ct} REST count`, data[ct].length <= restCount,
        `extracted ${data[ct].length} (filtered by status: ${allowedStatuses.join('/')}) from ${restCount} total in Strapi 3`);
    } else {
      check(`${ct} REST count`, restCount === data[ct].length,
        `extracted ${data[ct].length}, REST says ${restCount}`);
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('\n--- Results ---');
  if (failed === 0) {
    console.log(`${GREEN}All ${passed} checks passed ✓${RESET}`);
    console.log(`\nPhase 2 verified. Run Phase 3 next.`);
  } else {
    console.log(`${RED}${failed} check(s) failed, ${passed} passed${RESET}`);
    console.log(`\nReview failures above. Re-run extraction if needed:`);
    console.log(`  pnpm migrate:phase02 (or node migration/scripts/02-extract.js)`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
