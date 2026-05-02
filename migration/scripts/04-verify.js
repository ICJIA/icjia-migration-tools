/**
 * @module 04-verify
 * @description Phase 4 verification: validates the full Phase 4 output.
 *
 * Checks performed:
 * 1. Record counts via Strapi 5 REST API match raw extraction counts
 * 2. No duplicate legacyIds (via SQLite query)
 * 3. All relations linked correctly (article->datasets, app->articles, app->datasets)
 * 4. Timestamps are historic (not migration day)
 * 5. Media relations set (splash, thumbnail, mainfile, extrafile, image, datafile)
 *
 * Exits 0 if all checks pass, 1 if any check fails.
 *
 * @example
 *   node migration/scripts/04-verify.js
 *
 * Prerequisites:
 * - Phase 4 complete (04-load, 04b-link-relations, 04c-fix-timestamps)
 * - Strapi 5 running (restarted after timestamp fix)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { RestClient } from '../lib/rest-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

/** Track pass/fail results */
const results = { passed: 0, failed: 0, warnings: 0, checks: [] };

/**
 * Log a check result and track it.
 *
 * @param {string} category - Category name (e.g., "Counts")
 * @param {string} description - What was checked
 * @param {boolean} passed - Whether the check passed
 * @param {string} [detail] - Optional detail message
 */
function check(category, description, passed, detail) {
  const status = passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const detailStr = detail ? ` — ${detail}` : '';
  console.log(`  [${status}] ${description}${detailStr}`);
  results.checks.push({ category, description, passed, detail });
  if (passed) {
    results.passed++;
  } else {
    results.failed++;
  }
}

/**
 * Log a warning (non-fatal).
 *
 * @param {string} message - Warning message
 */
function warn(message) {
  console.log(`  ${YELLOW}[WARN] ${message}${RESET}`);
  results.warnings++;
}

/**
 * Get the total count of a content type from Strapi 5 REST API.
 *
 * @param {RestClient} client - REST client
 * @param {string} pluralName - Plural content type name (e.g., "articles")
 * @returns {Promise<number>} Total record count
 */
async function getStrapi5Count(client, pluralName) {
  const result = await client.get(`/api/${pluralName}`, {
    'pagination[pageSize]': 1,
  });
  return result.meta?.pagination?.total ?? 0;
}

/**
 * Find the actual table name for a content type in the SQLite database.
 *
 * @param {import('better-sqlite3').Database} db - SQLite database handle
 * @param {string} singular - Singular name
 * @param {string} plural - Plural name
 * @returns {string|null} The actual table name, or null
 */
function findTableName(db, singular, plural) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);

  if (tables.includes(singular)) return singular;
  if (tables.includes(plural)) return plural;

  const lower = singular.toLowerCase();
  const lowerPlural = plural.toLowerCase();
  for (const t of tables) {
    if (t.toLowerCase() === lower || t.toLowerCase() === lowerPlural) return t;
  }
  return null;
}

/**
 * Delay execution.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Phase 4 Verification ===\n');

  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings.requestTimeoutMs,
  });

  const delayMs = config.settings.requestDelayMs || 100;
  const mapsDir = path.resolve(ROOT, config.paths.maps);
  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);
  const dbPath = path.resolve(ROOT, config.strapi5.dbPath);

  // ── Check 0: Strapi 5 Reachable ───────────────────────────────────
  console.log(`${BOLD}Checking Strapi 5 connectivity...${RESET}`);
  try {
    await client.get('/api/content-type-builder/content-types');
    console.log(`  ${GREEN}Strapi 5 is reachable at ${config.strapi5.apiUrl}${RESET}\n`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot connect to Strapi 5 at ${config.strapi5.apiUrl}${RESET}`);
    console.error(`${RED}${err.message}${RESET}`);
    console.error(`${RED}Ensure Strapi 5 is running (restart it after the timestamp fix).${RESET}`);
    process.exit(1);
  }

  // Load reference data
  let rawManifest;
  try {
    rawManifest = JSON.parse(await fs.readFile(path.join(rawDir, 'manifest.json'), 'utf8'));
  } catch {
    rawManifest = null;
    warn('Raw manifest not found — will use transformed data counts as reference');
  }

  const transformedArticles = JSON.parse(
    await fs.readFile(path.join(transformedDir, 'articles.json'), 'utf8'),
  );
  const transformedDatasets = JSON.parse(
    await fs.readFile(path.join(transformedDir, 'datasets.json'), 'utf8'),
  );
  const transformedApps = JSON.parse(
    await fs.readFile(path.join(transformedDir, 'apps.json'), 'utf8'),
  );

  const articleMap = JSON.parse(await fs.readFile(path.join(mapsDir, 'articles.json'), 'utf8'));
  const datasetMap = JSON.parse(await fs.readFile(path.join(mapsDir, 'datasets.json'), 'utf8'));
  const appMap = JSON.parse(await fs.readFile(path.join(mapsDir, 'apps.json'), 'utf8'));

  const expectedCounts = rawManifest
    ? rawManifest.counts
    : {
        articles: transformedArticles.length,
        datasets: transformedDatasets.length,
        apps: transformedApps.length,
      };

  // ── 1. Record Counts ──────────────────────────────────────────────
  console.log(`${BOLD}1. Record Counts${RESET}`);

  for (const [pluralName, expectedCount] of Object.entries(expectedCounts)) {
    try {
      const actualCount = await getStrapi5Count(client, pluralName);
      check('Counts', `${pluralName} count`, actualCount === expectedCount,
        `expected ${expectedCount}, got ${actualCount}`);
    } catch (err) {
      check('Counts', `${pluralName} count`, false, err.message);
    }
    await delay(delayMs);
  }

  // Check ID maps are complete
  check('Counts', 'articles ID map complete',
    Object.keys(articleMap).length === transformedArticles.length,
    `map has ${Object.keys(articleMap).length}, transformed has ${transformedArticles.length}`);
  check('Counts', 'datasets ID map complete',
    Object.keys(datasetMap).length === transformedDatasets.length,
    `map has ${Object.keys(datasetMap).length}, transformed has ${transformedDatasets.length}`);
  check('Counts', 'apps ID map complete',
    Object.keys(appMap).length === transformedApps.length,
    `map has ${Object.keys(appMap).length}, transformed has ${transformedApps.length}`);

  console.log('');

  // ── 2. Duplicate Check (SQLite) ───────────────────────────────────
  console.log(`${BOLD}2. Duplicate legacyId Check${RESET}`);

  let db = null;
  try {
    await fs.access(dbPath);
    db = new Database(dbPath, { readonly: true });

    for (const ct of [
      { singular: 'article', plural: 'articles' },
      { singular: 'dataset', plural: 'datasets' },
      { singular: 'app', plural: 'apps' },
    ]) {
      const tableName = findTableName(db, ct.singular, ct.plural);
      if (!tableName) {
        check('Duplicates', `${ct.singular} — no duplicate legacyIds`, false,
          `table "${ct.singular}" or "${ct.plural}" not found`);
        continue;
      }

      // Determine the actual legacy_id column name
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
      const legacyIdCol = columns.includes('legacy_id') ? 'legacy_id' : columns.includes('legacyId') ? 'legacyId' : null;

      if (!legacyIdCol) {
        check('Duplicates', `${ct.singular} — no duplicate legacyIds`, false,
          `legacy_id column not found in ${tableName}`);
        continue;
      }

      const dupes = db
        .prepare(
          `SELECT ${legacyIdCol}, COUNT(*) as cnt FROM ${tableName} GROUP BY ${legacyIdCol} HAVING COUNT(*) > 1`,
        )
        .all();

      check('Duplicates', `${ct.singular} — no duplicate legacyIds`,
        dupes.length === 0,
        dupes.length > 0 ? `${dupes.length} duplicate(s) found` : 'no duplicates');
    }
  } catch (err) {
    check('Duplicates', 'SQLite duplicate check', false, `could not open DB: ${err.message}`);
  }

  console.log('');

  // ── 3. Relations Check ────────────────────────────────────────────
  console.log(`${BOLD}3. Relations (Triangle)${RESET}`);

  // Check article -> datasets
  const articlesWithDatasets = transformedArticles.filter(
    (a) => a._relatedDatasetIds && a._relatedDatasetIds.length > 0,
  );
  const sampleArticles = articlesWithDatasets.slice(0, 10);
  let articleRelPassed = 0;
  let articleRelTotal = sampleArticles.length;

  for (const article of sampleArticles) {
    const mapping = articleMap[article.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/articles/${mapping.strapi5DocumentId}`, {
        'populate[datasets][fields][0]': 'legacyId',
      });
      const linkedLegacyIds = (result.data?.datasets || []).map((d) => d.legacyId);
      const expectedIds = article._relatedDatasetIds.filter((id) => datasetMap[id]);
      const allFound = expectedIds.every((id) => linkedLegacyIds.includes(id));
      if (allFound) articleRelPassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Relations', 'article -> dataset relations (sample)',
    articleRelPassed === articleRelTotal || articleRelTotal === 0,
    `${articleRelPassed}/${articleRelTotal} sampled articles have correct dataset relations`);

  // Check app -> articles
  const appsWithArticles = transformedApps.filter(
    (a) => a._relatedArticleIds && a._relatedArticleIds.length > 0,
  );
  const sampleAppsForArticles = appsWithArticles.slice(0, 10);
  let appArticleRelPassed = 0;
  let appArticleRelTotal = sampleAppsForArticles.length;

  for (const app of sampleAppsForArticles) {
    const mapping = appMap[app.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/apps/${mapping.strapi5DocumentId}`, {
        'populate[articles][fields][0]': 'legacyId',
      });
      const linkedLegacyIds = (result.data?.articles || []).map((a) => a.legacyId);
      const expectedIds = app._relatedArticleIds.filter((id) => articleMap[id]);
      const allFound = expectedIds.every((id) => linkedLegacyIds.includes(id));
      if (allFound) appArticleRelPassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Relations', 'app -> article relations (sample)',
    appArticleRelPassed === appArticleRelTotal || appArticleRelTotal === 0,
    `${appArticleRelPassed}/${appArticleRelTotal} sampled apps have correct article relations`);

  // Check app -> datasets
  const appsWithDatasets = transformedApps.filter(
    (a) => a._relatedDatasetIds && a._relatedDatasetIds.length > 0,
  );
  const sampleAppsForDatasets = appsWithDatasets.slice(0, 10);
  let appDatasetRelPassed = 0;
  let appDatasetRelTotal = sampleAppsForDatasets.length;

  for (const app of sampleAppsForDatasets) {
    const mapping = appMap[app.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/apps/${mapping.strapi5DocumentId}`, {
        'populate[datasets][fields][0]': 'legacyId',
      });
      const linkedLegacyIds = (result.data?.datasets || []).map((d) => d.legacyId);
      const expectedIds = app._relatedDatasetIds.filter((id) => datasetMap[id]);
      const allFound = expectedIds.every((id) => linkedLegacyIds.includes(id));
      if (allFound) appDatasetRelPassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Relations', 'app -> dataset relations (sample)',
    appDatasetRelPassed === appDatasetRelTotal || appDatasetRelTotal === 0,
    `${appDatasetRelPassed}/${appDatasetRelTotal} sampled apps have correct dataset relations`);

  console.log('');

  // ── 4. Timestamps Check ───────────────────────────────────────────
  console.log(`${BOLD}4. Timestamps${RESET}`);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (db) {
    for (const ct of [
      { singular: 'article', plural: 'articles', data: transformedArticles, map: articleMap },
      { singular: 'dataset', plural: 'datasets', data: transformedDatasets, map: datasetMap },
      { singular: 'app', plural: 'apps', data: transformedApps, map: appMap },
    ]) {
      const tableName = findTableName(db, ct.singular, ct.plural);
      if (!tableName) {
        check('Timestamps', `${ct.singular} timestamps are historic`, false, 'table not found');
        continue;
      }

      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
      const createdAtCol = columns.includes('created_at') ? 'created_at' : columns.includes('createdAt') ? 'createdAt' : null;

      if (!createdAtCol) {
        check('Timestamps', `${ct.singular} timestamps are historic`, false, 'created_at column not found');
        continue;
      }

      // Check that no records have today's date as created_at
      const todayRecords = db
        .prepare(`SELECT COUNT(*) as cnt FROM ${tableName} WHERE ${createdAtCol} LIKE ?`)
        .get(`${today}%`);

      check('Timestamps', `${ct.singular} timestamps are historic (not migration day)`,
        todayRecords.cnt === 0,
        todayRecords.cnt > 0 ? `${todayRecords.cnt} records have today's date` : 'all timestamps are pre-migration');
    }

    db.close();
  } else {
    check('Timestamps', 'timestamp verification', false, 'SQLite database not available');
  }

  console.log('');

  // ── 5. Media Relations Check ──────────────────────────────────────
  console.log(`${BOLD}5. Media Relations${RESET}`);

  // Check articles with splash
  const articlesWithSplash = transformedArticles.filter((a) => a.splash);
  const sampleSplash = articlesWithSplash.slice(0, 10);
  let splashPassed = 0;

  for (const article of sampleSplash) {
    const mapping = articleMap[article.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/articles/${mapping.strapi5DocumentId}`, {
        'populate': 'splash',
      });
      if (result.data?.splash) splashPassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Media', 'article splash images (sample)',
    splashPassed === sampleSplash.length || sampleSplash.length === 0,
    `${splashPassed}/${sampleSplash.length} sampled articles have splash`);

  // Check articles with thumbnail
  const articlesWithThumb = transformedArticles.filter((a) => a.thumbnail);
  const sampleThumb = articlesWithThumb.slice(0, 10);
  let thumbPassed = 0;

  for (const article of sampleThumb) {
    const mapping = articleMap[article.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/articles/${mapping.strapi5DocumentId}`, {
        'populate': 'thumbnail',
      });
      if (result.data?.thumbnail) thumbPassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Media', 'article thumbnails (sample)',
    thumbPassed === sampleThumb.length || sampleThumb.length === 0,
    `${thumbPassed}/${sampleThumb.length} sampled articles have thumbnail`);

  // Check articles with mainfile/extrafile
  const articlesWithMainfile = transformedArticles.filter((a) => a.mainfile);
  const sampleMainfile = articlesWithMainfile.slice(0, 10);
  let mainfilePassed = 0;

  for (const article of sampleMainfile) {
    const mapping = articleMap[article.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/articles/${mapping.strapi5DocumentId}`, {
        'populate[0]': 'mainfile',
        'populate[1]': 'extrafile',
      });
      if (result.data?.mainfile) mainfilePassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Media', 'article mainfile (sample)',
    mainfilePassed === sampleMainfile.length || sampleMainfile.length === 0,
    `${mainfilePassed}/${sampleMainfile.length} sampled articles have mainfile`);

  // Check apps with image
  const appsWithImage = transformedApps.filter((a) => a.image);
  const sampleImage = appsWithImage.slice(0, 10);
  let imagePassed = 0;

  for (const app of sampleImage) {
    const mapping = appMap[app.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/apps/${mapping.strapi5DocumentId}`, {
        'populate': 'image',
      });
      if (result.data?.image) imagePassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Media', 'app images (sample)',
    imagePassed === sampleImage.length || sampleImage.length === 0,
    `${imagePassed}/${sampleImage.length} sampled apps have image`);

  // Check datasets with datafile
  const datasetsWithDatafile = transformedDatasets.filter((d) => d.datafile);
  const sampleDatafile = datasetsWithDatafile.slice(0, 10);
  let datafilePassed = 0;

  for (const dataset of sampleDatafile) {
    const mapping = datasetMap[dataset.legacyId];
    if (!mapping) continue;

    try {
      const result = await client.get(`/api/datasets/${mapping.strapi5DocumentId}`, {
        'populate': 'datafile',
      });
      if (result.data?.datafile) datafilePassed++;
    } catch {
      // count as not passed
    }
    await delay(delayMs);
  }

  check('Media', 'dataset datafiles (sample)',
    datafilePassed === sampleDatafile.length || sampleDatafile.length === 0,
    `${datafilePassed}/${sampleDatafile.length} sampled datasets have datafile`);

  console.log('');

  // ── Load Report Check ─────────────────────────────────────────────
  console.log(`${BOLD}6. Load Report${RESET}`);

  try {
    await fs.access(path.resolve(ROOT, 'migration/data/load-report.json'));
    check('Report', 'load-report.json exists', true);
  } catch {
    check('Report', 'load-report.json exists', false, 'file not found');
  }

  console.log('');

  // ── Final Summary ─────────────────────────────────────────────────
  console.log('--- Verification Summary ---');
  console.log(`  ${GREEN}Passed: ${results.passed}${RESET}`);
  console.log(`  ${results.failed > 0 ? RED : GREEN}Failed: ${results.failed}${RESET}`);
  console.log(`  ${results.warnings > 0 ? YELLOW : GREEN}Warnings: ${results.warnings}${RESET}`);

  if (results.failed === 0) {
    console.log(`\n${GREEN}${BOLD}All verification checks passed.${RESET}`);
    console.log(`${GREEN}Phase 4 is complete. Ready for Phase 5 (final validation).${RESET}`);
    process.exit(0);
  } else {
    console.log(`\n${RED}${BOLD}${results.failed} check(s) failed.${RESET}`);
    console.log(`${RED}Review the failures above and re-run the relevant Phase 4 scripts.${RESET}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
