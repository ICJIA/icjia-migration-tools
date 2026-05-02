/**
 * @module 04-verify
 * @description Phase 4 verify: confirm content + relations are loaded correctly.
 *
 * Cross-checks:
 *   1. Per-type record counts: Strapi 5 (incl. drafts) vs source SQLite
 *   2. Errors flagged in any per-type ID map
 *
 * Read-only — does not write to S5.
 *
 * @example
 *   node migration/scripts/04-verify.js
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { openSourceDb, countTable } from '../lib/sqlite-reader.js';
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

async function loadJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Strapi 5 stores 2 rows per document for draftAndPublish types (one draft +
 * one published version). REST API's pagination.total counts ROWS, not
 * documents. Counting distinct document_id from the destination SQLite gives
 * the actual document count, which matches the source record count.
 */
function fetchS5DocumentCount(s5Db, manifestEntry) {
  const table = manifestEntry.sqlTable;
  const row = s5Db
    .prepare(`SELECT COUNT(DISTINCT document_id) AS n FROM ${quoteIdent(table)}`)
    .get();
  return row.n;
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Refusing unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

async function main() {
  console.log(`${BOLD}── Phase 4 verify ──${RESET}\n`);

  const manifest = await loadJson(path.resolve(ROOT, config.paths.contentTypesManifest));
  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  const dbPath = path.resolve(ROOT, config.strapi3.sqliteDbPath);
  const db = openSourceDb(dbPath);

  const s5DbPath = path.resolve(ROOT, config.strapi5.dbPath);
  if (!existsSync(s5DbPath)) {
    console.error(`${RED}ERROR${RESET} Strapi 5 SQLite DB not found at ${s5DbPath}`);
    db.close();
    process.exit(1);
  }
  const s5Db = new Database(s5DbPath, { readonly: true });

  const mapsDir = path.resolve(ROOT, config.paths.maps);

  const results = { types: 0, countsMatch: 0, countsMismatch: 0, mapErrors: 0, errors: [] };

  console.log(`${BOLD}Per-type document counts (S5 vs SQLite source):${RESET}`);

  for (const ct of activeTypes) {
    const expected = ct.kind === 'singleType' ? 1 : countTable(db, ct.sqlTable);

    let actual;
    try {
      actual = fetchS5DocumentCount(s5Db, ct);
    } catch (err) {
      results.errors.push({ type: ct.name, error: err.message });
      console.log(`  ${RED}✗${RESET} ${ct.name.padEnd(16)} ${RED}${err.message.slice(0, 80)}${RESET}`);
      continue;
    }

    // Check the per-type map for any error entries
    const mapPath = path.join(mapsDir, ct.queryName + '.json');
    let mapErrCount = 0;
    if (existsSync(mapPath)) {
      try {
        const map = await loadJson(mapPath);
        mapErrCount = Object.values(map).filter((v) => v.error).length;
      } catch {}
    }

    const match = actual === expected;
    const icon = match ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const detail = match
      ? `${actual.toString().padStart(5)} records`
      : `${RED}${actual} in S5, expected ${expected}${RESET}`;
    const errNote = mapErrCount > 0 ? ` ${YELLOW}(${mapErrCount} load errors in map)${RESET}` : '';
    console.log(`  ${icon} ${ct.name.padEnd(16)} ${detail}${errNote}`);

    results.types++;
    if (match) results.countsMatch++;
    else results.countsMismatch++;
    results.mapErrors += mapErrCount;
  }

  db.close();
  s5Db.close();

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Types checked:        ${results.types}`);
  console.log(`  Counts match:         ${results.countsMatch}`);
  console.log(`  Counts mismatch:      ${results.countsMismatch}`);
  console.log(`  Map errors recorded:  ${results.mapErrors}`);
  console.log(`  Verify errors:        ${results.errors.length}`);
  console.log('');

  if (results.countsMismatch > 0 || results.errors.length > 0) {
    console.log(`${RED}${BOLD}Phase 4 verify FAILED.${RESET}`);
    console.log('Review per-type discrepancies above. Re-run failed types:');
    console.log(`  ${CYAN}node migration/scripts/04-load.js --type=<name>${RESET}`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 4 verify PASSED.${RESET}`);
  console.log('');
  console.log('Next: Phase 5 (Validation — 10 automated checks)');
  console.log(`  ${CYAN}pnpm migrate:phase05${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
