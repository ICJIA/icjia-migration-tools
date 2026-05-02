/**
 * @module 04-load
 * @description Phase 4a–4c: Load all content into Strapi 5 in dependency order.
 *
 * Loads datasets first (no outbound dominant relations), then apps, then articles.
 * For each record:
 *   1. Check if legacyId already exists (idempotent re-run support)
 *   2. POST to Strapi 5 REST API
 *   3. Capture documentId in ID map
 *
 * Fields prefixed with `_` are metadata and are stripped from the API payload.
 *
 * Outputs:
 * - `migration/data/maps/datasets.json` — Strapi 3 ObjectId → Strapi 5 documentId
 * - `migration/data/maps/apps.json`     — same
 * - `migration/data/maps/articles.json`  — same
 * - `migration/data/load-report.json`    — summary of created/skipped/failed counts
 *
 * @example
 *   node migration/scripts/04-load.js
 *
 * Prerequisites:
 * - Phase 3 complete (transformed JSON files exist)
 * - Strapi 5 running at configured URL with a full-access API token
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { RestClient } from '../lib/rest-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

/**
 * Delay execution for the configured number of milliseconds.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strip all fields whose keys start with `_` from a record.
 * These are migration metadata and must not be sent to the Strapi 5 API.
 *
 * @param {Object} record - The transformed record
 * @returns {Object} A shallow copy with `_` prefixed fields removed
 */
function stripInternalFields(record) {
  const cleaned = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('_')) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Strip relation fields that should not be included in the initial create.
 * Relations are linked in a separate pass (04b-link-relations.js).
 *
 * @param {Object} payload - The cleaned record payload
 * @param {string[]} relationFields - Field names to remove (e.g., ['datasets', 'apps', 'articles'])
 * @returns {Object} Payload without relation fields
 */
function stripRelationFields(payload, relationFields) {
  const cleaned = { ...payload };
  for (const field of relationFields) {
    delete cleaned[field];
  }
  return cleaned;
}

/**
 * Check if a record with the given legacyId already exists in Strapi 5.
 *
 * @param {RestClient} client - Configured REST client
 * @param {string} pluralName - Plural API name (e.g., "datasets")
 * @param {string} legacyId - The Strapi 3 ObjectId to check
 * @returns {Promise<Object|null>} Existing record data if found, null otherwise
 */
async function checkDuplicate(client, pluralName, legacyId) {
  const result = await client.get(`/api/${pluralName}`, {
    'filters[legacyId][$eq]': legacyId,
    'pagination[pageSize]': 1,
  });

  if (result.data && result.data.length > 0) {
    return result.data[0];
  }
  return null;
}

/**
 * Load all records for a single content type into Strapi 5.
 *
 * @param {Object} options - Load options
 * @param {RestClient} options.client - Configured REST client
 * @param {string} options.pluralName - Plural API name (e.g., "datasets")
 * @param {string} options.label - Display label for logging (e.g., "datasets")
 * @param {Object[]} options.records - Transformed records to load
 * @param {string[]} options.relationFields - Relation fields to strip from payload
 * @param {number} options.delayMs - Delay between requests in milliseconds
 * @returns {Promise<Object>} ID map: legacyId → { strapi5Id, strapi5DocumentId, legacyId }
 */
async function loadContentType({ client, pluralName, label, records, relationFields, delayMs }) {
  console.log(`\nLoading ${label}: ${records.length} records`);
  const idMap = {};
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const legacyId = record.legacyId;
    const progress = `${i + 1}/${records.length}`;

    if (!legacyId) {
      console.log(`  ${RED}${progress}: Record has no legacyId — skipping${RESET}`);
      failed++;
      continue;
    }

    try {
      // Check for duplicates
      const existing = await checkDuplicate(client, pluralName, legacyId);

      if (existing) {
        // Record already exists — capture its IDs and skip
        idMap[legacyId] = {
          strapi5Id: existing.id,
          strapi5DocumentId: existing.documentId,
          legacyId,
        };
        console.log(`  ${YELLOW}${progress}: ${record.slug || legacyId} — already exists (skipped)${RESET}`);
        skipped++;
      } else {
        // Strip internal and relation fields, then POST
        let payload = stripInternalFields(record);
        payload = stripRelationFields(payload, relationFields);

        let result;
        try {
          result = await client.post(`/api/${pluralName}`, payload);
        } catch (postErr) {
          // Handle slug collision: if uid field rejects a duplicate slug, append legacyId suffix
          if (postErr.message?.includes('unique') || postErr.message?.includes('already being used') || postErr.message?.includes('must be unique')) {
            const origSlug = payload.slug;
            payload.slug = `${payload.slug}-${legacyId.slice(-6)}`;
            console.log(`  ${YELLOW}${progress}: slug "${origSlug}" already exists — retrying as "${payload.slug}"${RESET}`);
            result = await client.post(`/api/${pluralName}`, payload);
          } else {
            throw postErr;
          }
        }

        if (result.data) {
          idMap[legacyId] = {
            strapi5Id: result.data.id,
            strapi5DocumentId: result.data.documentId,
            legacyId,
          };
          console.log(`  ${GREEN}${progress}: ${record.slug || legacyId} — created${RESET}`);
          created++;
        } else {
          console.log(`  ${RED}${progress}: ${record.slug || legacyId} — unexpected response (no data)${RESET}`);
          failed++;
        }
      }
    } catch (err) {
      console.error(`  ${RED}${progress}: ${record.slug || legacyId} — ERROR: ${err.message}${RESET}`);
      failed++;
    }

    // Delay between requests to avoid overwhelming Strapi 5
    if (delayMs > 0 && i < records.length - 1) {
      await delay(delayMs);
    }
  }

  console.log(
    `  ${label} complete: ${GREEN}${created} created${RESET}, ` +
    `${YELLOW}${skipped} skipped${RESET}, ` +
    `${failed > 0 ? RED : GREEN}${failed} failed${RESET}`,
  );

  return { idMap, created, skipped, failed };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Phase 4: Data Loading ===\n');

  // Show config
  console.log('Configuration:');
  console.log(`  Strapi 5 API:      ${config.strapi5.apiUrl}`);
  console.log(`  Strapi 5 token:    ${config.strapi5.token ? '(set)' : `${RED}(not set)${RESET}`}`);
  console.log(`  Request delay:     ${config.settings.requestDelayMs}ms`);
  console.log(`  Request timeout:   ${config.settings.requestTimeoutMs}ms`);
  console.log(`  Transformed data:  ${config.paths.transformedData}`);
  console.log(`  Maps output:       ${config.paths.maps}`);
  console.log('');

  if (!config.strapi5.token) {
    console.error(`${RED}ERROR: Strapi 5 API token is not set in config.js${RESET}`);
    console.error(`${RED}Set strapi5.token in config.js or STRAPI5_TOKEN env variable.${RESET}`);
    process.exit(1);
  }

  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings.requestTimeoutMs,
  });

  // Verify Strapi 5 is reachable
  console.log('Checking Strapi 5 connectivity...');
  try {
    await client.get('/api/content-type-builder/content-types');
    console.log(`  ${GREEN}Strapi 5 is reachable${RESET}\n`);
  } catch (err) {
    console.error(`\n${RED}ERROR: Cannot connect to Strapi 5 at ${config.strapi5.apiUrl}${RESET}`);
    console.error(`${RED}${err.message}${RESET}`);
    console.error(`\n${RED}Ensure Strapi 5 is running and the API URL in config.js is correct.${RESET}`);
    process.exit(1);
  }

  // Read transformed data
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);
  const mapsDir = path.resolve(ROOT, config.paths.maps);
  await fs.mkdir(mapsDir, { recursive: true });

  let datasets, apps, articles;
  try {
    datasets = JSON.parse(await fs.readFile(path.join(transformedDir, 'datasets.json'), 'utf8'));
    apps = JSON.parse(await fs.readFile(path.join(transformedDir, 'apps.json'), 'utf8'));
    articles = JSON.parse(await fs.readFile(path.join(transformedDir, 'articles.json'), 'utf8'));
  } catch (err) {
    console.error(`\n${RED}ERROR: Could not read transformed data: ${err.message}${RESET}`);
    console.error(`${RED}Ensure Phase 3 is complete and transformed files exist in ${config.paths.transformedData}${RESET}`);
    process.exit(1);
  }

  console.log(`Records to load: ${datasets.length} datasets, ${apps.length} apps, ${articles.length} articles`);

  const delayMs = config.settings.requestDelayMs || 100;
  const report = { startedAt: new Date().toISOString(), steps: {} };

  // ── Step 1: Load Datasets ──────────────────────────────────────────
  console.log(`\n── Step 1/3: Load Datasets ──`);
  const datasetResult = await loadContentType({
    client,
    pluralName: 'datasets',
    label: 'datasets',
    records: datasets,
    relationFields: ['articles', 'apps'],
    delayMs,
  });

  await fs.writeFile(
    path.join(mapsDir, 'datasets.json'),
    JSON.stringify(datasetResult.idMap, null, 2),
  );
  console.log(`  ${GREEN}ID map saved to ${config.paths.maps}/datasets.json${RESET}`);
  report.steps.datasets = {
    created: datasetResult.created,
    skipped: datasetResult.skipped,
    failed: datasetResult.failed,
  };

  // ── Step 2: Load Apps ──────────────────────────────────────────────
  console.log(`\n── Step 2/3: Load Apps ──`);
  const appResult = await loadContentType({
    client,
    pluralName: 'apps',
    label: 'apps',
    records: apps,
    relationFields: ['datasets', 'articles'],
    delayMs,
  });

  await fs.writeFile(
    path.join(mapsDir, 'apps.json'),
    JSON.stringify(appResult.idMap, null, 2),
  );
  console.log(`  ${GREEN}ID map saved to ${config.paths.maps}/apps.json${RESET}`);
  report.steps.apps = {
    created: appResult.created,
    skipped: appResult.skipped,
    failed: appResult.failed,
  };

  // ── Step 3: Load Articles ──────────────────────────────────────────
  console.log(`\n── Step 3/3: Load Articles ──`);
  const articleResult = await loadContentType({
    client,
    pluralName: 'articles',
    label: 'articles',
    records: articles,
    relationFields: ['datasets', 'apps'],
    delayMs,
  });

  await fs.writeFile(
    path.join(mapsDir, 'articles.json'),
    JSON.stringify(articleResult.idMap, null, 2),
  );
  console.log(`  ${GREEN}ID map saved to ${config.paths.maps}/articles.json${RESET}`);
  report.steps.articles = {
    created: articleResult.created,
    skipped: articleResult.skipped,
    failed: articleResult.failed,
  };

  // ── Save Load Report ──────────────────────────────────────────────
  report.completedAt = new Date().toISOString();
  report.totals = {
    created: datasetResult.created + appResult.created + articleResult.created,
    skipped: datasetResult.skipped + appResult.skipped + articleResult.skipped,
    failed: datasetResult.failed + appResult.failed + articleResult.failed,
  };

  const reportPath = path.resolve(ROOT, 'migration/data/load-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nLoad report saved to migration/data/load-report.json`);

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n--- Summary ---');
  console.log(`  Datasets:  ${datasetResult.created} created, ${datasetResult.skipped} skipped, ${datasetResult.failed} failed`);
  console.log(`  Apps:      ${appResult.created} created, ${appResult.skipped} skipped, ${appResult.failed} failed`);
  console.log(`  Articles:  ${articleResult.created} created, ${articleResult.skipped} skipped, ${articleResult.failed} failed`);
  console.log(`  Total:     ${report.totals.created} created, ${report.totals.skipped} skipped, ${report.totals.failed} failed`);

  if (report.totals.failed > 0) {
    console.log(`\n${YELLOW}WARNING: ${report.totals.failed} record(s) failed to load.${RESET}`);
    console.log(`${YELLOW}Review the errors above, fix the transformed data, and re-run.${RESET}`);
    console.log(`${YELLOW}Successfully loaded records will be skipped on re-run (idempotent).${RESET}`);
  }

  console.log(`\n${GREEN}Phase 4a-4c (data loading) complete.${RESET}`);
  console.log('Next: pnpm migrate:phase04 (or node migration/scripts/04b-link-relations.js)');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
