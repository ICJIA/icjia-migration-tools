/**
 * @module 02-extract
 * @description Phase 2: Extract all content from Strapi 3 via GraphQL.
 *
 * Pulls every record for all three content types (articles, datasets, apps)
 * using paginated GraphQL queries, saves them as local JSON files, and
 * verifies record counts against Strapi 3 REST count endpoints.
 *
 * After this script runs, all Strapi 3 data exists locally and
 * the Strapi 3 instance is no longer needed for subsequent phases.
 *
 * Outputs:
 * - `migration/data/raw/articles.json` — all articles with full field data
 * - `migration/data/raw/datasets.json` — all datasets with full field data
 * - `migration/data/raw/apps.json` — all apps with full field data
 * - `migration/data/raw/manifest.json` — extraction metadata and counts
 *
 * @example
 *   node migration/scripts/02-extract.js
 *
 * Prerequisites:
 * - Strapi 3 running and accessible at the configured URL
 * - Phase 1 complete (introspection data exists)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GraphQLClient } from '../lib/graphql-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

// ── GraphQL Queries ──────────────────────────────────────────────────

/**
 * GraphQL query for articles — includes all scalar fields,
 * relation expansions (datasets, apps), and media expansions (mainfile, extrafile).
 */
const ARTICLE_QUERY = `
query GetArticles($start: Int!, $limit: Int!) {
  articles(start: $start, limit: $limit, sort: "createdAt:asc") {
    id
    title
    status
    slug
    date
    external
    categories
    tags
    authors
    splash
    thumbnail
    images
    abstract
    markdown
    mainfiletype
    funding
    citation
    doi
    hideFromBanner
    createdAt
    updatedAt
    datasets {
      id
      title
      slug
    }
    apps {
      id
      title
    }
    mainfile {
      id
      url
      name
      mime
      size
      ext
    }
    extrafile {
      id
      url
      name
      mime
      size
      ext
    }
  }
}`;

/**
 * GraphQL query for datasets — includes all fields, datafile media expansion,
 * and relation expansions (apps, articles).
 */
const DATASET_QUERY = `
query GetDatasets($start: Int!, $limit: Int!) {
  datasets(start: $start, limit: $limit, sort: "createdAt:asc") {
    id
    title
    status
    slug
    date
    external
    categories
    tags
    project
    sources
    unit
    timeperiod
    description
    notes
    variables
    funding
    citation
    createdAt
    updatedAt
    datafile {
      id
      url
      name
      mime
      size
      ext
    }
    apps {
      id
      title
    }
    articles {
      id
      title
    }
  }
}`;

/**
 * GraphQL query for apps — includes all fields and relation expansions
 * (datasets, articles). The `image` field is a string (likely Base64).
 */
const APP_QUERY = `
query GetApps($start: Int!, $limit: Int!) {
  apps(start: $start, limit: $limit, sort: "createdAt:asc") {
    id
    title
    status
    slug
    date
    external
    categories
    tags
    contributors
    image
    description
    url
    funding
    citation
    createdAt
    updatedAt
    datasets {
      id
      title
    }
    articles {
      id
      title
    }
  }
}`;

/**
 * Map of content type plural names to their GraphQL queries.
 * @type {Record<string, string>}
 */
const QUERIES = {
  articles: ARTICLE_QUERY,
  datasets: DATASET_QUERY,
  apps: APP_QUERY,
};

// ── Extraction Logic ─────────────────────────────────────────────────

/**
 * Extract all records for a content type using paginated GraphQL queries.
 *
 * @param {string} contentType - Plural name of the content type (e.g., "articles")
 * @param {string} query - GraphQL query string with $start and $limit variables
 * @param {GraphQLClient} client - Configured GraphQL client
 * @param {number} limit - Records per page
 * @returns {Promise<Object[]>} All extracted records
 */
/**
 * Maximum total records to extract per content type.
 * Safety valve against infinite pagination loops or compromised servers.
 * @type {number}
 */
const MAX_RECORDS = 10000;

async function extractAll(contentType, query, client, limit) {
  let start = 0;
  let allRecords = [];
  let page;
  let pageNum = 0;
  const delayMs = config.settings?.requestDelayMs || 0;

  do {
    pageNum++;
    page = await client.query(query, { start, limit });
    const records = page.data[contentType];

    if (!Array.isArray(records)) {
      throw new Error(`Unexpected response for ${contentType}: expected array, got ${typeof records}`);
    }

    allRecords = allRecords.concat(records);
    console.log(`  ${contentType}: page ${pageNum} — ${allRecords.length} records so far`);

    if (allRecords.length >= MAX_RECORDS) {
      console.warn(`  ${YELLOW}WARNING: Hit safety limit of ${MAX_RECORDS} records for ${contentType}. Stopping.${RESET}`);
      break;
    }

    start += limit;

    // Configurable delay between pages to avoid overwhelming the server
    if (delayMs > 0 && page.data[contentType].length === limit) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  } while (page.data[contentType].length === limit);

  return allRecords;
}

/**
 * Query a Strapi 3 REST count endpoint to get the total record count.
 *
 * @param {string} contentType - Plural content type name (e.g., "articles")
 * @returns {Promise<number|null>} Record count, or null if the endpoint is unavailable
 */
async function getRestCount(contentType) {
  const url = `${config.strapi3.apiUrl}/${contentType}/count`;
  const headers = {};
  if (config.strapi3.token) {
    headers['Authorization'] = `Bearer ${config.strapi3.token}`;
  }

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 10000),
    });
    if (!res.ok) return null;
    const count = await res.json();
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Phase 2: Data Extraction ===\n');

  // Show config
  console.log('Configuration:');
  console.log(`  Strapi 3 GraphQL: ${config.strapi3.graphqlUrl}`);
  console.log(`  Strapi 3 API:     ${config.strapi3.apiUrl}`);
  console.log(`  Strapi 3 token:   ${config.strapi3.token ? '(set)' : '(not set)'}`);
  console.log(`  Output dir:       ${config.paths.rawData}`);
  console.log(`  Pagination limit: ${config.settings?.paginationLimit || 100}`);
  console.log('');

  // Verify Strapi 3 is reachable
  console.log('Checking Strapi 3 connectivity...');
  const client = new GraphQLClient(config.strapi3.graphqlUrl, {
    token: config.strapi3.token,
    timeoutMs: config.settings?.requestTimeoutMs || 30000,
  });

  try {
    await client.query('{ __typename }');
    console.log(`  ${GREEN}✓ Strapi 3 GraphQL is reachable${RESET}\n`);
  } catch (err) {
    console.error(`\n${RED}ERROR: Cannot connect to Strapi 3 at ${config.strapi3.graphqlUrl}${RESET}`);
    console.error(`${RED}${err.message}${RESET}`);
    console.error(`\n${RED}Phase 2 requires a running Strapi 3 instance. Check the URL in config.js.${RESET}`);
    process.exit(1);
  }

  const limit = config.settings?.paginationLimit || 100;
  const outputDir = path.resolve(ROOT, config.paths.rawData);
  await fs.mkdir(outputDir, { recursive: true });

  const counts = {};
  const contentTypes = Object.keys(QUERIES);
  const allowedStatuses = config.allowedStatuses || null;

  if (allowedStatuses) {
    console.log(`Status filter: only migrating records with status: ${allowedStatuses.map(s => `"${s}"`).join(', ')}`);
    console.log(`Records with other statuses (drafts, pending approval) will be skipped.\n`);
  }

  // Extract each content type
  for (const ct of contentTypes) {
    console.log(`Extracting ${ct}...`);
    try {
      let records = await extractAll(ct, QUERIES[ct], client, limit);
      const totalExtracted = records.length;

      // Filter by allowed statuses if configured
      if (allowedStatuses && allowedStatuses.length > 0) {
        const before = records.length;
        records = records.filter((r) => allowedStatuses.includes(r.status));
        const excluded = before - records.length;
        if (excluded > 0) {
          console.log(`  ${YELLOW}Filtered: ${excluded} record(s) excluded (non-${allowedStatuses.join('/')} status)${RESET}`);
        }
      }

      counts[ct] = records.length;

      const filePath = path.join(outputDir, `${ct}.json`);
      await fs.writeFile(filePath, JSON.stringify(records, null, 2));
      console.log(`  ${GREEN}✓ ${records.length} ${ct} saved to ${path.relative(ROOT, filePath)}${totalExtracted !== records.length ? ` (${totalExtracted} total, ${totalExtracted - records.length} filtered)` : ''}${RESET}\n`);
    } catch (err) {
      console.error(`\n${RED}ERROR extracting ${ct}: ${err.message}${RESET}`);
      console.error(`${RED}Fix the issue and re-run this script. Previously extracted content types are safe.${RESET}`);
      process.exit(1);
    }
  }

  // Write manifest
  const manifest = {
    extractedAt: new Date().toISOString(),
    source: config.strapi3.graphqlUrl,
    counts,
    paginationLimit: limit,
    sortOrder: 'createdAt:asc',
  };
  const manifestPath = path.join(outputDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest saved to ${path.relative(ROOT, manifestPath)}`);

  // Post-extraction count verification
  console.log('\nVerifying counts against Strapi 3 REST endpoints...');
  let allMatch = true;

  for (const ct of contentTypes) {
    const restCount = await getRestCount(ct);
    if (restCount === null) {
      console.log(`  ${YELLOW}⚠ ${ct}: REST count endpoint unavailable — skipped${RESET}`);
    } else if (allowedStatuses) {
      // When filtering by status, extracted count will be <= REST total
      console.log(`  ${GREEN}✓ ${ct}: ${counts[ct]} extracted (${restCount} total in Strapi 3, filtered by status: ${allowedStatuses.join('/')})${RESET}`);
    } else if (restCount === counts[ct]) {
      console.log(`  ${GREEN}✓ ${ct}: ${counts[ct]} extracted = ${restCount} in Strapi 3${RESET}`);
    } else {
      console.log(`  ${YELLOW}⚠ ${ct}: extracted ${counts[ct]} but REST says ${restCount}${RESET}`);
      allMatch = false;
    }
  }

  // Summary
  console.log('\n--- Summary ---');
  for (const [ct, count] of Object.entries(counts)) {
    console.log(`  ${ct}: ${count} records`);
  }
  console.log(`  Total: ${Object.values(counts).reduce((a, b) => a + b, 0)} records`);

  if (!allMatch) {
    console.log(`\n${YELLOW}WARNING: Some counts did not match REST endpoints.${RESET}`);
    console.log(`${YELLOW}This may be due to draft filtering or records created during extraction.${RESET}`);
    console.log(`${YELLOW}Review the counts above and re-run if necessary.${RESET}`);
  }

  console.log(`\n${GREEN}Phase 2 extraction complete.${RESET}`);
  console.log('Next: pnpm migrate:phase02 (or node migration/scripts/02-verify.js)');
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
