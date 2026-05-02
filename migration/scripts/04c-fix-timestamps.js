/**
 * @module 04c-fix-timestamps
 * @description Phase 4 step 3: Restore original timestamps via direct SQLite UPDATE.
 *
 * Strapi 5's REST API doesn't allow setting `createdAt` or `updatedAt` —
 * those are system-managed. After Phase 4 load, every record's timestamps
 * reflect the migration time, not the original Strapi 3 source.
 *
 * This script reads the source extracts (raw/<plural>.json) for the original
 * `created_at` / `updated_at` / `published_at`, and writes them directly into
 * Strapi 5's SQLite database.
 *
 * Strapi 5 must be **stopped** while this runs (otherwise SQLite write locks
 * cause errors). The script verifies this and aborts if Strapi 5 is reachable.
 *
 * @example
 *   pnpm migrate:phase04   # full Phase 4 (load + link + timestamps + verify)
 *   # standalone:
 *   # 1. Stop Strapi 5 (Ctrl+C in its terminal)
 *   # 2. node migration/scripts/04c-fix-timestamps.js
 *   # 3. Restart Strapi 5 (pnpm develop)
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

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
 * Probe Strapi 5 to make sure it's NOT running (we're about to grab the
 * SQLite write lock). If we can fetch from /admin or /api/.../, refuse.
 */
async function checkStrapi5IsStopped() {
  try {
    const res = await fetch(`${config.strapi5.apiUrl}/_health`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000),
    });
    if (res.status === 204 || res.status === 200) {
      return { stopped: false, status: res.status };
    }
  } catch {
    return { stopped: true };
  }
  return { stopped: false };
}

async function main() {
  console.log(`${BOLD}── Phase 4 step 3: Restore original timestamps ──${RESET}\n`);

  const dbPath = path.resolve(ROOT, config.strapi5.dbPath);
  if (!existsSync(dbPath)) {
    console.error(`${RED}ERROR${RESET} Strapi 5 SQLite DB not found at ${dbPath}`);
    console.error(`Verify ${CYAN}config.js${RESET} → strapi5.dbPath`);
    process.exit(1);
  }

  const probe = await checkStrapi5IsStopped();
  if (!probe.stopped) {
    console.error(`${RED}ERROR${RESET} Strapi 5 appears to be running at ${config.strapi5.apiUrl}.`);
    console.error(`Stop Strapi 5 (Ctrl+C in its terminal) before this script can write to its SQLite DB.`);
    console.error(`After this script completes, restart Strapi 5 with ${CYAN}pnpm develop${RESET}.`);
    process.exit(1);
  }

  const manifest = await loadJson(path.resolve(ROOT, config.paths.contentTypesManifest));
  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const mapsDir = path.resolve(ROOT, config.paths.maps);

  console.log(`Configuration:`);
  console.log(`  Strapi 5 DB:     ${CYAN}${path.relative(ROOT, dbPath)}${RESET}`);
  console.log(`  Active types:    ${activeTypes.length}`);
  console.log('');

  const db = new Database(dbPath);
  // Use WAL mode for better-sqlite3 performance
  try {
    db.pragma('journal_mode = WAL');
  } catch {}

  const overall = { types: 0, updated: 0, missing: 0, errors: [] };

  for (const ct of activeTypes) {
    const t0 = Date.now();
    const fileName = ct.queryName + '.json';
    const rawPath = path.join(rawDir, fileName);
    const mapPath = path.join(mapsDir, fileName);

    if (!existsSync(rawPath) || !existsSync(mapPath)) {
      console.log(`  ${YELLOW}skip${RESET} ${ct.name} (raw or map missing)`);
      continue;
    }

    const parsed = await loadJson(rawPath);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const map = await loadJson(mapPath);

    // Determine the destination table — Strapi 5 stores it as the schema's collectionName
    // which we set from manifest.sqlTable in Phase 1. For singletons it's the same
    // table (with id=1).
    const tableName = ct.sqlTable;

    // Verify the table exists
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(tableName);

    if (!tableExists) {
      console.log(`  ${YELLOW}skip${RESET} ${ct.name} (Strapi 5 table "${tableName}" not found)`);
      continue;
    }

    // Probe the column names so we know what to update
    const cols = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((r) => r.name);

    const updateCols = [];
    if (cols.includes('created_at')) updateCols.push('created_at');
    if (cols.includes('updated_at')) updateCols.push('updated_at');
    if (cols.includes('published_at')) updateCols.push('published_at');

    if (updateCols.length === 0) {
      console.log(`  ${YELLOW}skip${RESET} ${ct.name} (no timestamp columns in ${tableName})`);
      continue;
    }

    // Build a parameterized UPDATE
    const setClause = updateCols.map((c) => `${c} = ?`).join(', ');
    const updateStmt = db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE id = ?`);

    // Wrap in a transaction for atomicity + speed
    const tx = db.transaction(() => {
      let updated = 0;
      let missing = 0;
      for (const record of records) {
        const sourceId = String(record.id);
        const mapEntry = map[sourceId];
        const docId = mapEntry?.documentId;
        // For singletons, the strapi5 row id is typically 1 — but we also have `id` from the load
        const strapi5Id = mapEntry?.id || (ct.kind === 'singleType' ? 1 : null);
        if (!docId && !strapi5Id) {
          missing++;
          continue;
        }

        const params = updateCols.map((c) => {
          if (c === 'created_at') return record.created_at || null;
          if (c === 'updated_at') return record.updated_at || null;
          if (c === 'published_at') return record.published_at || null;
          return null;
        });

        // Strapi 5 row id — better-sqlite3 returns a Number for integer PK
        if (strapi5Id) {
          updateStmt.run(...params, strapi5Id);
          updated++;
        } else if (docId) {
          // Look up by document_id when we don't have the integer id
          const row = db.prepare(`SELECT id FROM ${tableName} WHERE document_id = ?`).get(docId);
          if (row) {
            updateStmt.run(...params, row.id);
            updated++;
          } else {
            missing++;
          }
        }
      }
      return { updated, missing };
    });

    try {
      const stats = tx();
      const ms = Date.now() - t0;
      overall.types++;
      overall.updated += stats.updated;
      overall.missing += stats.missing;
      const missNote = stats.missing > 0 ? ` ${YELLOW}(${stats.missing} unmapped)${RESET}` : '';
      console.log(`  ${GREEN}✓${RESET} ${ct.name.padEnd(16)} ${stats.updated.toString().padStart(5)} timestamps fixed${missNote} ${DIM}${ms}ms${RESET}`);
    } catch (err) {
      console.log(`  ${RED}✗${RESET} ${ct.name.padEnd(16)} ${err.message}`);
      overall.errors.push({ type: ct.name, error: err.message });
    }
  }

  db.close();

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Types updated:    ${overall.types}`);
  console.log(`  Records updated:  ${overall.updated}`);
  console.log(`  Unmapped:         ${overall.missing}`);
  console.log(`  Errors:           ${overall.errors.length}`);
  console.log('');

  if (overall.errors.length > 0) {
    console.log(`${RED}${BOLD}Phase 4 fix-timestamps had errors.${RESET}`);
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 4 fix-timestamps complete.${RESET}`);
  console.log('');
  console.log('Restart Strapi 5 to pick up the timestamp updates:');
  console.log(`  ${CYAN}cd ${config.strapi5ProjectPath} && pnpm develop${RESET}`);
  console.log('');
  console.log('Then verify:');
  console.log(`  ${CYAN}node migration/scripts/04-verify.js${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
