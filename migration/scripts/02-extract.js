/**
 * @module 02-extract
 * @description Phase 2: Extract content from Strapi 3.
 *
 * Iterates the manifest's active content types and pulls every record:
 *
 *   - **GraphQL primary path** for most types: paginated query via the generic
 *     query-builder (lib/query-builder.js).
 *
 *   - **SQLite supplemental path** for types with drafts (publication, meeting,
 *     post, job): GraphQL filters out NULL `published_at` for unauthenticated
 *     callers, so we read draft rows directly from the in-repo SQLite snapshot
 *     and merge them with the GraphQL results.
 *
 *   - **SQLite-only path** for `form` (205 records): the Form GraphQL endpoint
 *     returns 403 unauthenticated, so we read it from SQLite. The opaque `form`
 *     JSON column is preserved verbatim.
 *
 *   - **Singleton path** for `home`: single GraphQL fetch, no pagination.
 *
 * Per-type checkpointing: if `migration/data/raw/<plural>.json` already exists
 * with the expected record count, skip that type. Pass `--force` to override.
 *
 * Outputs:
 *   - `migration/data/raw/<plural>.json` — one file per content type
 *   - `migration/data/raw/manifest.json` — counts, timing, source flags
 *
 * @example
 *   pnpm extract                       # all types
 *   pnpm extract -- --type=publication # one type only
 *   pnpm extract -- --force            # force re-extract
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { GraphQLClient } from '../lib/graphql-client.js';
import { buildQuery } from '../lib/query-builder.js';
import { openSourceDb, readTable, countTable } from '../lib/sqlite-reader.js';
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
const FORCE = argv.includes('--force');
const TYPE_FILTER = argv.find((a) => a.startsWith('--type='))?.slice('--type='.length);

async function loadManifest() {
  const p = path.resolve(ROOT, config.paths.contentTypesManifest);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function loadSourceSchema() {
  const p = path.resolve(ROOT, config.paths.introspection, 'source-schema.json');
  if (!existsSync(p)) {
    throw new Error(`source-schema.json not found at ${p}. Run Phase 1 first: pnpm migrate:phase01`);
  }
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Pluralize via manifest queryName, kebab-cased — used for output filenames.
 */
function jsonFileName(manifestEntry) {
  return manifestEntry.queryName + '.json';
}

/**
 * Sleep for `ms` milliseconds.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Extract via paginated GraphQL.
 *
 * @returns {Promise<Object[]>} All records for this type
 */
async function extractViaGraphQL(client, manifestEntry, queries) {
  const limit = config.settings?.paginationLimit || 100;
  const delay = config.settings?.requestDelayMs || 100;
  const records = [];

  if (queries.isSingleType) {
    const json = await client.query(queries.collectionQuery);
    const record = json.data?.[manifestEntry.queryName];
    if (record) records.push(record);
    return records;
  }

  let start = 0;
  while (true) {
    const json = await client.query(queries.collectionQuery, { start, limit });
    const page = json.data?.[manifestEntry.queryName] || [];
    records.push(...page);
    if (page.length < limit) break;
    start += limit;
    if (delay > 0) await sleep(delay);
  }
  return records;
}

/**
 * Get the GraphQL count from the connection aggregate.
 *
 * @returns {Promise<number|null>} count, or null if no count query (singletons)
 */
async function fetchGraphQLCount(client, manifestEntry, queries) {
  if (!queries.countQuery) return null;
  const json = await client.query(queries.countQuery);
  return json.data?.[`${manifestEntry.queryName}Connection`]?.aggregate?.count ?? null;
}

/**
 * Read drafts (records with published_at IS NULL) from SQLite for a type
 * that has draftAndPublish enabled.
 *
 * Returns rows in a shape compatible with GraphQL output (id as string, etc.)
 * to allow merging with GraphQL results.
 */
function extractDraftsFromSqlite(db, manifestEntry) {
  const rows = readTable(db, manifestEntry.sqlTable, {
    where: 'published_at IS NULL',
    orderBy: 'id',
  });
  // Convert id to string to match GraphQL behavior
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/**
 * Read entire content type from SQLite (used for Form, which is 403'd in GraphQL).
 */
function extractAllFromSqlite(db, manifestEntry) {
  const rows = readTable(db, manifestEntry.sqlTable, { orderBy: 'id' });
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/**
 * Atomic write: write to .tmp then rename to final path.
 */
async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

/**
 * Check whether an existing type JSON should be reused.
 * Returns the parsed records if the file exists with the expected count, else null.
 */
async function checkExistingExtract(filePath, expectedCount) {
  if (FORCE) return null;
  if (!existsSync(filePath)) return null;
  try {
    const records = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(records) && records.length === expectedCount) {
      return records;
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`${BOLD}── Phase 2: Extract content from Strapi 3 ──${RESET}\n`);

  // Load manifest + normalized source schema (built by Phase 1)
  const manifest = await loadManifest();
  const sourceSchema = await loadSourceSchema();

  // Filter to active types, optionally narrowed by --type
  let activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);
  if (TYPE_FILTER) {
    activeTypes = activeTypes.filter((c) => c.name === TYPE_FILTER);
    if (activeTypes.length === 0) {
      console.error(`${RED}ERROR${RESET} no active content type matches --type=${TYPE_FILTER}`);
      process.exit(1);
    }
  }

  // Where extracted JSONs go
  const rawDir = path.resolve(ROOT, config.paths.rawData);
  await fs.mkdir(rawDir, { recursive: true });

  // GraphQL client
  const gql = new GraphQLClient(config.strapi3.graphqlUrl, {
    token: config.strapi3.token,
    timeoutMs: config.settings?.requestTimeoutMs || 30000,
  });

  // SQLite handle (opened lazily, only used for fallback reads)
  let db = null;
  const getDb = () => {
    if (!db) {
      const dbPath = path.resolve(ROOT, config.strapi3.sqliteDbPath);
      if (!existsSync(dbPath)) {
        throw new Error(`Strapi 3 SQLite snapshot not found at ${dbPath}`);
      }
      db = openSourceDb(dbPath);
    }
    return db;
  };

  console.log(`Configuration:`);
  console.log(`  Strapi 3 GraphQL: ${CYAN}${config.strapi3.graphqlUrl}${RESET}`);
  console.log(`  SQLite snapshot:  ${CYAN}${config.strapi3.sqliteDbPath}${RESET}`);
  console.log(`  Include drafts:   ${config.includeDrafts ? GREEN + 'yes' : DIM + 'no'}${RESET}`);
  console.log(`  Pagination limit: ${config.settings?.paginationLimit || 100}`);
  console.log(`  Active types:     ${activeTypes.length}${TYPE_FILTER ? ` (filtered to ${TYPE_FILTER})` : ''}`);
  console.log('');

  const startedAt = new Date().toISOString();
  const summary = [];

  for (const ct of activeTypes) {
    const t0 = Date.now();
    const filePath = path.join(rawDir, jsonFileName(ct));
    const isSingle = ct.kind === 'singleType';
    const useSqliteOnly = ct.name === 'form'; // Form is 403'd in GraphQL
    const usesGraphQL = !useSqliteOnly;

    // Any draftAndPublish type may have drafts — check via SQLite, not the
    // hardcoded `hasDrafts` flag (which only reflected counts at audit time).
    const supportsDrafts = ct.draftAndPublish && config.includeDrafts;

    console.log(`${BOLD}${ct.name.padEnd(16)}${RESET} ${DIM}${isSingle ? 'singleton' : (useSqliteOnly ? 'SQLite-only' : 'GraphQL' + (supportsDrafts ? ' + SQLite drafts' : ''))}${RESET}`);

    let records;
    let source = useSqliteOnly ? 'sqlite-only' : (supportsDrafts ? 'graphql+sqlite-drafts' : 'graphql');

    // Find query for this type
    const typeEntry = sourceSchema.contentTypes.find((e) => e.manifest.name === ct.name);
    if (!typeEntry || !typeEntry.model) {
      console.log(`  ${RED}skip${RESET}: no source model loaded`);
      continue;
    }

    // SQLite is ground truth for record counts. GraphQL may or may not filter
    // drafts depending on the Strapi 3 endpoint config (agency.icjia-api.cloud
    // returns drafts, contradicting common Strapi 3 behavior) — the dedup
    // in the merge step handles either case. Using the SQLite count as
    // `expected` lets us detect a real mismatch (missing or extra rows).
    const expectedCount = isSingle ? 1 : countTable(getDb(), ct.sqlTable);

    // Skip if already extracted
    const existing = await checkExistingExtract(filePath, expectedCount);
    if (existing) {
      console.log(`  ${DIM}skip${RESET}: ${existing.length} records already extracted (use --force to re-run)`);
      summary.push({
        name: ct.name,
        count: existing.length,
        durationMs: 0,
        source: 'cache',
        skipped: true,
      });
      continue;
    }

    // Extract
    try {
      if (useSqliteOnly) {
        records = extractAllFromSqlite(getDb(), ct);
      } else {
        const queries = buildQuery(typeEntry, sourceSchema);
        records = await extractViaGraphQL(gql, ct, queries);
        if (config.includeDrafts && supportsDrafts) {
          const drafts = extractDraftsFromSqlite(getDb(), ct);
          // Merge drafts that aren't already in the GraphQL set (by id)
          const existingIds = new Set(records.map((r) => String(r.id)));
          const newDrafts = drafts.filter((d) => !existingIds.has(String(d.id)));
          records.push(...newDrafts);
          console.log(`  ${DIM}+ ${newDrafts.length} drafts merged from SQLite${RESET}`);
        }
      }
    } catch (err) {
      console.log(`  ${RED}FAIL${RESET}: ${err.message}`);
      summary.push({
        name: ct.name,
        error: err.message,
        durationMs: Date.now() - t0,
        source,
      });
      continue;
    }

    await writeJsonAtomic(filePath, records);

    const ms = Date.now() - t0;
    const countDelta = expectedCount !== null && records.length !== expectedCount
      ? ` ${YELLOW}(expected ${expectedCount})${RESET}`
      : '';
    console.log(`  ${GREEN}OK${RESET}: ${records.length} records${countDelta}, ${ms}ms → ${path.relative(ROOT, filePath)}`);

    summary.push({
      name: ct.name,
      count: records.length,
      expectedCount,
      durationMs: ms,
      source,
    });
  }

  // Write manifest
  const manifestOut = {
    generatedAt: startedAt,
    completedAt: new Date().toISOString(),
    config: {
      strapi3GraphqlUrl: config.strapi3.graphqlUrl,
      includeDrafts: !!config.includeDrafts,
      paginationLimit: config.settings?.paginationLimit || 100,
    },
    types: summary,
    totals: {
      types: summary.length,
      records: summary.reduce((acc, s) => acc + (s.count || 0), 0),
      failures: summary.filter((s) => s.error).length,
    },
  };
  const manifestPath = path.join(rawDir, 'manifest.json');
  await writeJsonAtomic(manifestPath, manifestOut);

  // Close SQLite if opened
  if (db) db.close();

  // Summary output
  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Types extracted:   ${manifestOut.totals.types}`);
  console.log(`  Total records:     ${manifestOut.totals.records}`);
  console.log(`  Failures:          ${manifestOut.totals.failures}`);
  console.log(`  Manifest:          ${path.relative(ROOT, manifestPath)}`);
  console.log('');

  if (manifestOut.totals.failures > 0) {
    console.log(`${RED}${BOLD}Phase 2 had failures.${RESET} Fix errors above and re-run:`);
    console.log(`  ${CYAN}pnpm migrate:phase02${RESET}`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 2 complete.${RESET}`);
  console.log('');
  console.log('Next: 02-verify (cross-check counts) → Phase 3 (Media)');
  console.log(`  ${CYAN}pnpm migrate:phase03${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
