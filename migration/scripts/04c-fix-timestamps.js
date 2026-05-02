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

    // Build parameterized UPDATEs. Use legacy_id (stable, set on every row of
    // a document) instead of the autoincrement id (rewritten by PUTs).
    //
    // CRITICAL: split into two statements so we don't clobber the draft
    // marker. created_at / updated_at need to match on BOTH rows (draft +
    // published). published_at must ONLY be written to the row that already
    // has a non-NULL value — otherwise we set published_at on the draft row
    // and Strapi 5 can no longer distinguish draft from published, returning
    // empty results from /api/<plural>.
    const nonPublishCols = updateCols.filter((c) => c !== 'published_at');
    const hasPublishedCol = updateCols.includes('published_at');
    const hasLegacyId = cols.includes('legacy_id');

    const setClauseNonPub = nonPublishCols.map((c) => `${c} = ?`).join(', ');
    const updateByLegacy = (hasLegacyId && nonPublishCols.length > 0)
      ? db.prepare(`UPDATE ${tableName} SET ${setClauseNonPub} WHERE legacy_id = ?`)
      : null;
    const updateByDocId = (nonPublishCols.length > 0)
      ? db.prepare(`UPDATE ${tableName} SET ${setClauseNonPub} WHERE document_id = ?`)
      : null;
    // Targeted published_at update: only the row that already has it set.
    const updatePublishedByLegacy = (hasLegacyId && hasPublishedCol)
      ? db.prepare(`UPDATE ${tableName} SET published_at = ? WHERE legacy_id = ? AND published_at IS NOT NULL`)
      : null;
    const updatePublishedByDocId = hasPublishedCol
      ? db.prepare(`UPDATE ${tableName} SET published_at = ? WHERE document_id = ? AND published_at IS NOT NULL`)
      : null;

    // Wrap in a transaction for atomicity + speed
    const tx = db.transaction(() => {
      let updated = 0;
      let missing = 0;
      for (const record of records) {
        const sourceId = String(record.id);
        const mapEntry = map[sourceId];
        const docId = mapEntry?.documentId;
        const legacyId = mapEntry?.legacyId;

        // Source values are ISO 8601 strings (e.g., "2021-05-04T14:40:30.029Z").
        // Strapi 5 stores timestamps as milliseconds-since-epoch integers, so
        // convert before UPDATE — otherwise SQLite stores the ISO string and
        // later reads it as parseInt("2021-...") = 2021 (just the year).
        const toMs = (v) => {
          if (!v) return null;
          if (typeof v === 'number') return v;
          const ms = new Date(v).getTime();
          return Number.isFinite(ms) ? ms : null;
        };
        // For published_at: when config.preserveSourceDrafts is false (the
        // default), source drafts (published_at IS NULL) get an inferred
        // publishedAt of created_at — same logic as 04-load.js. Otherwise
        // they'd be reverted to draft here, undoing the load.
        const publishedAtMs =
          toMs(record.published_at) ??
          (!config.preserveSourceDrafts ? toMs(record.created_at) : null);
        const nonPubParams = nonPublishCols.map((c) => {
          if (c === 'created_at') return toMs(record.created_at);
          if (c === 'updated_at') return toMs(record.updated_at);
          return null;
        });

        // Prefer legacy_id (matches all version rows). Fall back to
        // document_id for singletons or types without legacy_id.
        let touched = false;
        if (nonPublishCols.length > 0) {
          let result;
          if (updateByLegacy && legacyId !== undefined) {
            result = updateByLegacy.run(...nonPubParams, legacyId);
          } else if (updateByDocId && docId) {
            result = updateByDocId.run(...nonPubParams, docId);
          }
          if (result?.changes > 0) touched = true;
        }
        // Only update published_at on the row that already had it set —
        // never set it on the draft row (would erase the draft marker).
        if (hasPublishedCol && publishedAtMs !== null) {
          let result;
          if (updatePublishedByLegacy && legacyId !== undefined) {
            result = updatePublishedByLegacy.run(publishedAtMs, legacyId);
          } else if (updatePublishedByDocId && docId) {
            result = updatePublishedByDocId.run(publishedAtMs, docId);
          }
          if (result?.changes > 0) touched = true;
        }
        if (touched) updated++;
        else missing++;
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
