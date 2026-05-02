/**
 * @module 04b-link-relations
 * @description Phase 4d: Link many-to-many relations (the relation triangle).
 *
 * After all content types are loaded in Strapi 5, this script links the
 * three sets of many-to-many relations:
 *
 *   Pass 1: Article -> datasets (article is dominant)
 *   Pass 2: App -> articles AND app -> datasets (app is dominant for both)
 *
 * IMPORTANT: Article -> apps must NOT be linked from the article side because
 * article is non-dominant on that relation. It is linked from the app side.
 *
 * Uses Strapi 5 REST API `connect` syntax:
 *   PUT /api/{pluralName}/{documentId}
 *   { data: { relationField: { connect: [{ documentId: "..." }] } } }
 *
 * Outputs: Console log of linked relations and any warnings.
 *
 * @example
 *   node migration/scripts/04b-link-relations.js
 *
 * Prerequisites:
 * - Phase 4a-4c complete (all content loaded, ID maps exist)
 * - Strapi 5 running
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
 * Translate an array of Strapi 3 ObjectIds to Strapi 5 documentIds using an ID map.
 * Logs warnings for IDs not found in the map.
 *
 * @param {string[]} legacyIds - Array of Strapi 3 ObjectIds
 * @param {Object} idMap - ID map: legacyId -> { strapi5DocumentId, ... }
 * @param {string} label - Label for logging (e.g., "dataset")
 * @param {string} contextLabel - Context for the warning (e.g., "article violent-crime")
 * @returns {{ documentIds: string[], warnings: number }} Translated IDs and warning count
 */
function translateIds(legacyIds, idMap, label, contextLabel) {
  const documentIds = [];
  let warnings = 0;

  for (const legacyId of legacyIds) {
    const mapping = idMap[legacyId];
    if (mapping) {
      documentIds.push(mapping.strapi5DocumentId);
    } else {
      console.log(
        `    ${YELLOW}WARNING: ${label} ${legacyId} not found in map, skipping (from ${contextLabel})${RESET}`,
      );
      warnings++;
    }
  }

  return { documentIds, warnings };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Phase 4d: Link Relations (Relation Triangle) ===\n');

  // Show config
  console.log('Configuration:');
  console.log(`  Strapi 5 API:      ${config.strapi5.apiUrl}`);
  console.log(`  Strapi 5 token:    ${config.strapi5.token ? '(set)' : `${RED}(not set)${RESET}`}`);
  console.log(`  Request delay:     ${config.settings.requestDelayMs}ms`);
  console.log(`  Maps directory:    ${config.paths.maps}`);
  console.log('');

  if (!config.strapi5.token) {
    console.error(`${RED}ERROR: Strapi 5 API token is not set in config.js${RESET}`);
    process.exit(1);
  }

  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings.requestTimeoutMs,
  });

  const delayMs = config.settings.requestDelayMs || 100;
  const mapsDir = path.resolve(ROOT, config.paths.maps);
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);

  // Read ID maps
  let datasetMap, articleMap, appMap;
  try {
    datasetMap = JSON.parse(await fs.readFile(path.join(mapsDir, 'datasets.json'), 'utf8'));
    articleMap = JSON.parse(await fs.readFile(path.join(mapsDir, 'articles.json'), 'utf8'));
    appMap = JSON.parse(await fs.readFile(path.join(mapsDir, 'apps.json'), 'utf8'));
  } catch (err) {
    console.error(`${RED}ERROR: Could not read ID maps: ${err.message}${RESET}`);
    console.error(`${RED}Run 04-load.js first to create the ID maps.${RESET}`);
    process.exit(1);
  }

  // Read transformed data
  let articles, apps;
  try {
    articles = JSON.parse(await fs.readFile(path.join(transformedDir, 'articles.json'), 'utf8'));
    apps = JSON.parse(await fs.readFile(path.join(transformedDir, 'apps.json'), 'utf8'));
  } catch (err) {
    console.error(`${RED}ERROR: Could not read transformed data: ${err.message}${RESET}`);
    process.exit(1);
  }

  let totalWarnings = 0;

  // ── Pass 1: Article → datasets (article is dominant) ───────────────
  console.log(`Linking article -> dataset relations for ${articles.length} articles...`);
  let articlesProcessed = 0;
  let articlesWithRelations = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const legacyId = article.legacyId;
    const progress = `${i + 1}/${articles.length}`;
    const slug = article.slug || legacyId;

    const relatedDatasetIds = article._relatedDatasetIds || [];

    if (relatedDatasetIds.length === 0) {
      console.log(`  Article ${progress}: ${slug} — 0 datasets (no relations)`);
      articlesProcessed++;
      continue;
    }

    // Get the article's Strapi 5 documentId
    const articleMapping = articleMap[legacyId];
    if (!articleMapping) {
      console.log(`  ${YELLOW}Article ${progress}: ${slug} — WARNING: not found in article map, skipping${RESET}`);
      totalWarnings++;
      continue;
    }

    // Translate dataset IDs
    const { documentIds, warnings } = translateIds(
      relatedDatasetIds,
      datasetMap,
      'dataset',
      `article ${slug}`,
    );
    totalWarnings += warnings;

    if (documentIds.length > 0) {
      try {
        const connectPayload = documentIds.map((docId) => ({ documentId: docId }));
        await client.put(`/api/articles/${articleMapping.strapi5DocumentId}`, {
          datasets: { connect: connectPayload },
        });
        console.log(`  ${GREEN}Article ${progress}: ${slug} — ${documentIds.length} datasets linked${RESET}`);
        articlesWithRelations++;
      } catch (err) {
        console.error(`  ${RED}Article ${progress}: ${slug} — ERROR: ${err.message}${RESET}`);
        totalWarnings++;
      }
    } else {
      console.log(`  ${YELLOW}Article ${progress}: ${slug} — all ${relatedDatasetIds.length} dataset IDs missing from map${RESET}`);
    }

    articlesProcessed++;

    if (delayMs > 0 && i < articles.length - 1) {
      await delay(delayMs);
    }
  }

  console.log(
    `Article -> dataset relations: ${articlesProcessed} articles processed, ` +
    `${articlesWithRelations} with relations linked, ${totalWarnings} warning(s)\n`,
  );

  // ── Pass 2: App → articles AND app → datasets (app is dominant) ────
  console.log(`Linking app -> article and app -> dataset relations for ${apps.length} apps...`);
  let appsProcessed = 0;
  let appsWithRelations = 0;
  let pass2Warnings = 0;

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const legacyId = app.legacyId;
    const progress = `${i + 1}/${apps.length}`;
    const slug = app.slug || legacyId;

    const relatedArticleIds = app._relatedArticleIds || [];
    const relatedDatasetIds = app._relatedDatasetIds || [];

    if (relatedArticleIds.length === 0 && relatedDatasetIds.length === 0) {
      console.log(`  App ${progress}: ${slug} — 0 articles, 0 datasets (no relations)`);
      appsProcessed++;
      continue;
    }

    // Get the app's Strapi 5 documentId
    const appMapping = appMap[legacyId];
    if (!appMapping) {
      console.log(`  ${YELLOW}App ${progress}: ${slug} — WARNING: not found in app map, skipping${RESET}`);
      pass2Warnings++;
      continue;
    }

    // Translate article IDs
    const articleResult = translateIds(
      relatedArticleIds,
      articleMap,
      'article',
      `app ${slug}`,
    );
    pass2Warnings += articleResult.warnings;

    // Translate dataset IDs
    const datasetResult = translateIds(
      relatedDatasetIds,
      datasetMap,
      'dataset',
      `app ${slug}`,
    );
    pass2Warnings += datasetResult.warnings;

    // Build the update payload
    const updateData = {};
    if (articleResult.documentIds.length > 0) {
      updateData.articles = {
        connect: articleResult.documentIds.map((docId) => ({ documentId: docId })),
      };
    }
    if (datasetResult.documentIds.length > 0) {
      updateData.datasets = {
        connect: datasetResult.documentIds.map((docId) => ({ documentId: docId })),
      };
    }

    if (Object.keys(updateData).length > 0) {
      try {
        await client.put(`/api/apps/${appMapping.strapi5DocumentId}`, updateData);
        console.log(
          `  ${GREEN}App ${progress}: ${slug} — ` +
          `${articleResult.documentIds.length} articles, ${datasetResult.documentIds.length} datasets linked${RESET}`,
        );
        appsWithRelations++;
      } catch (err) {
        console.error(`  ${RED}App ${progress}: ${slug} — ERROR: ${err.message}${RESET}`);
        pass2Warnings++;
      }
    } else {
      console.log(
        `  ${YELLOW}App ${progress}: ${slug} — all related IDs missing from maps${RESET}`,
      );
    }

    appsProcessed++;

    if (delayMs > 0 && i < apps.length - 1) {
      await delay(delayMs);
    }
  }

  totalWarnings += pass2Warnings;
  console.log(
    `App relations: ${appsProcessed} apps processed, ` +
    `${appsWithRelations} with relations linked, ${pass2Warnings} warning(s)\n`,
  );

  // ── Summary ────────────────────────────────────────────────────────
  console.log(
    `All relations linked: ${articlesProcessed} articles + ${appsProcessed} apps processed, ` +
    `${totalWarnings} total warning(s)`,
  );

  if (totalWarnings > 0) {
    console.log(`\n${YELLOW}There were ${totalWarnings} warning(s) during relation linking.${RESET}`);
    console.log(`${YELLOW}Review the warnings above. Missing IDs may indicate records that were not migrated.${RESET}`);
  }

  console.log(`\n${GREEN}Phase 4d (relation linking) complete.${RESET}`);
  console.log('Next: pnpm migrate:phase04 (or node migration/scripts/04c-fix-timestamps.js)');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
