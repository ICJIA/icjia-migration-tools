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

import { RestClient } from '../lib/rest-client.js';
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

function restPluralName(manifestEntry) {
  if (manifestEntry.kind === 'singleType') return manifestEntry.name;
  return (manifestEntry.queryName || manifestEntry.name)
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

async function fetchS5Count(client, manifestEntry) {
  const params = {
    'pagination[pageSize]': 1,
    'fields[0]': 'documentId',
    publicationState: 'preview', // include drafts
  };
  const result = await client.get(`/api/${restPluralName(manifestEntry)}`, params);
  if (manifestEntry.kind === 'singleType') {
    return result.data ? 1 : 0;
  }
  return result.meta?.pagination?.total ?? 0;
}

async function main() {
  console.log(`${BOLD}── Phase 4 verify ──${RESET}\n`);

  const manifest = await loadJson(path.resolve(ROOT, config.paths.contentTypesManifest));
  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  const dbPath = path.resolve(ROOT, config.strapi3.sqliteDbPath);
  const db = openSourceDb(dbPath);

  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings?.requestTimeoutMs || 30000,
  });

  const mapsDir = path.resolve(ROOT, config.paths.maps);

  const results = { types: 0, countsMatch: 0, countsMismatch: 0, mapErrors: 0, errors: [] };

  console.log(`${BOLD}Per-type record counts (S5 vs SQLite source):${RESET}`);

  for (const ct of activeTypes) {
    const expected = ct.kind === 'singleType' ? 1 : countTable(db, ct.sqlTable);

    let actual;
    try {
      actual = await fetchS5Count(client, ct);
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
