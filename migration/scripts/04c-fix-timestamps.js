/**
 * @module 04c-fix-timestamps
 * @description Phase 4e: Restore original createdAt/updatedAt timestamps via SQLite.
 *
 * After all content is loaded via the Strapi 5 REST API, the timestamps reflect
 * the migration date. This script directly updates the SQLite database to restore
 * the original Strapi 3 timestamps stored as `_originalCreatedAt` and
 * `_originalUpdatedAt` in the transformed data.
 *
 * IMPORTANT: Strapi 5 must be STOPPED before running this script.
 * The SQLite database should not be written to by two processes simultaneously.
 *
 * Uses `better-sqlite3` for synchronous, reliable SQLite access.
 *
 * @example
 *   node migration/scripts/04c-fix-timestamps.js
 *
 * Prerequisites:
 * - Phase 4a-4d complete (all content loaded and relations linked)
 * - Strapi 5 STOPPED (not running)
 * - `better-sqlite3` installed (`pnpm add better-sqlite3`)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

/**
 * Content types to process with their file and expected table names.
 * @type {Array<{ singular: string, plural: string, mapFile: string, dataFile: string }>}
 */
const CONTENT_TYPES = [
  { singular: 'article', plural: 'articles', mapFile: 'articles.json', dataFile: 'articles.json' },
  { singular: 'dataset', plural: 'datasets', mapFile: 'datasets.json', dataFile: 'datasets.json' },
  { singular: 'app', plural: 'apps', mapFile: 'apps.json', dataFile: 'apps.json' },
];

/**
 * Find the actual table name for a content type by querying sqlite_master.
 * Checks for both singular and plural forms.
 *
 * @param {import('better-sqlite3').Database} db - SQLite database handle
 * @param {string} singular - Singular name (e.g., "article")
 * @param {string} plural - Plural name (e.g., "articles")
 * @returns {string|null} The actual table name found, or null
 */
function findTableName(db, singular, plural) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);

  // Check singular first (Strapi 3 collectionName convention), then plural
  if (tables.includes(singular)) return singular;
  if (tables.includes(plural)) return plural;

  // Case-insensitive fallback
  const lower = singular.toLowerCase();
  const lowerPlural = plural.toLowerCase();
  for (const t of tables) {
    if (t.toLowerCase() === lower || t.toLowerCase() === lowerPlural) return t;
  }

  return null;
}

/**
 * Get column info for a table to verify expected columns exist.
 *
 * @param {import('better-sqlite3').Database} db - SQLite database handle
 * @param {string} tableName - Table name to inspect
 * @returns {string[]} Array of column names
 */
function getColumnNames(db, tableName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.map((col) => col.name);
}

/**
 * Update timestamps for all records of a content type.
 *
 * @param {import('better-sqlite3').Database} db - SQLite database handle
 * @param {string} tableName - Actual table name in the database
 * @param {Object[]} transformedRecords - Array of transformed records with _originalCreatedAt/_originalUpdatedAt
 * @param {Object} idMap - ID map: legacyId -> { strapi5DocumentId, ... }
 * @param {string} documentIdColumn - Actual column name for document_id
 * @param {string} createdAtColumn - Actual column name for created_at
 * @param {string} updatedAtColumn - Actual column name for updated_at
 * @returns {{ updated: number, skipped: number }} Counts
 */
function updateTimestamps(db, tableName, transformedRecords, idMap, documentIdColumn, createdAtColumn, updatedAtColumn) {
  const updateStmt = db.prepare(
    `UPDATE ${tableName} SET ${createdAtColumn} = ?, ${updatedAtColumn} = ? WHERE ${documentIdColumn} = ?`,
  );

  let updated = 0;
  let skipped = 0;

  for (const record of transformedRecords) {
    const legacyId = record.legacyId;
    if (!legacyId) {
      skipped++;
      continue;
    }

    const mapping = idMap[legacyId];
    if (!mapping) {
      skipped++;
      continue;
    }

    const createdAt = record._originalCreatedAt;
    const updatedAt = record._originalUpdatedAt;

    if (!createdAt || !updatedAt) {
      skipped++;
      continue;
    }

    const result = updateStmt.run(createdAt, updatedAt, mapping.strapi5DocumentId);
    if (result.changes > 0) {
      updated++;
    } else {
      skipped++;
    }
  }

  return { updated, skipped };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Phase 4e: Restore Timestamps ===\n');

  // Critical warning
  console.log(`${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${RED}${BOLD}║  WARNING: Strapi 5 should be STOPPED before running     ║${RESET}`);
  console.log(`${RED}${BOLD}║  this script. SQLite does not handle concurrent writes   ║${RESET}`);
  console.log(`${RED}${BOLD}║  from multiple processes safely.                         ║${RESET}`);
  console.log(`${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  const dbPath = path.resolve(ROOT, config.strapi5.dbPath);
  console.log('Configuration:');
  console.log(`  SQLite DB path:    ${dbPath}`);
  console.log(`  Transformed data:  ${config.paths.transformedData}`);
  console.log(`  Maps directory:    ${config.paths.maps}`);
  console.log('');

  // Verify DB file exists
  try {
    await fs.access(dbPath);
  } catch {
    console.error(`${RED}ERROR: SQLite database not found at ${dbPath}${RESET}`);
    console.error(`${RED}Check strapi5.dbPath in config.js${RESET}`);
    process.exit(1);
  }

  // Open database
  console.log('Opening SQLite database...');
  const db = new Database(dbPath);

  try {
    // List all tables for diagnostics
    const allTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    console.log(`  Tables found: ${allTables.join(', ')}\n`);

    const mapsDir = path.resolve(ROOT, config.paths.maps);
    const transformedDir = path.resolve(ROOT, config.paths.transformedData);
    let totalUpdated = 0;
    let totalSkipped = 0;

    for (const ct of CONTENT_TYPES) {
      // Find actual table name
      const tableName = findTableName(db, ct.singular, ct.plural);
      if (!tableName) {
        console.log(
          `  ${YELLOW}WARNING: No table found for "${ct.singular}" or "${ct.plural}" — skipping${RESET}`,
        );
        continue;
      }

      // Verify column names
      const columns = getColumnNames(db, tableName);
      console.log(`  Table "${tableName}" columns: ${columns.join(', ')}`);

      // Determine actual column names (check for common variations)
      const documentIdColumn = columns.includes('document_id')
        ? 'document_id'
        : columns.includes('documentId')
          ? 'documentId'
          : null;

      const createdAtColumn = columns.includes('created_at')
        ? 'created_at'
        : columns.includes('createdAt')
          ? 'createdAt'
          : null;

      const updatedAtColumn = columns.includes('updated_at')
        ? 'updated_at'
        : columns.includes('updatedAt')
          ? 'updatedAt'
          : null;

      if (!documentIdColumn || !createdAtColumn || !updatedAtColumn) {
        console.log(
          `  ${RED}ERROR: Missing required columns in "${tableName}". ` +
          `Need document_id (${documentIdColumn || 'NOT FOUND'}), ` +
          `created_at (${createdAtColumn || 'NOT FOUND'}), ` +
          `updated_at (${updatedAtColumn || 'NOT FOUND'})${RESET}`,
        );
        continue;
      }

      // Read data
      const idMap = JSON.parse(
        await fs.readFile(path.join(mapsDir, ct.mapFile), 'utf8'),
      );
      const transformedRecords = JSON.parse(
        await fs.readFile(path.join(transformedDir, ct.dataFile), 'utf8'),
      );

      // Update timestamps
      console.log(`  Updating ${tableName}: ${transformedRecords.length} records`);
      const { updated, skipped } = updateTimestamps(
        db,
        tableName,
        transformedRecords,
        idMap,
        documentIdColumn,
        createdAtColumn,
        updatedAtColumn,
      );

      console.log(
        `  ${GREEN}${tableName}: ${updated} updated, ${skipped} skipped${RESET}`,
      );
      totalUpdated += updated;
      totalSkipped += skipped;

      // Sample verification
      const sample = db
        .prepare(
          `SELECT ${documentIdColumn}, ${createdAtColumn}, ${updatedAtColumn} FROM ${tableName} LIMIT 5`,
        )
        .all();

      if (sample.length > 0) {
        console.log(`  Sample verification (${tableName}):`);
        for (const row of sample) {
          console.log(
            `    ${GREEN}${documentIdColumn}=${row[documentIdColumn]} -> ` +
            `${createdAtColumn}=${row[createdAtColumn]}${RESET}`,
          );
        }
      }
      console.log('');
    }

    // ── Summary ──────────────────────────────────────────────────────
    console.log(`Timestamp restoration complete: ${totalUpdated} records updated, ${totalSkipped} skipped`);

    if (totalUpdated === 0) {
      console.log(
        `\n${YELLOW}WARNING: No timestamps were updated. This could mean:${RESET}`,
      );
      console.log(`${YELLOW}  - ID maps are empty (run 04-load.js first)${RESET}`);
      console.log(`${YELLOW}  - Transformed data is missing _originalCreatedAt/_originalUpdatedAt${RESET}`);
      console.log(`${YELLOW}  - document_id values don't match between maps and DB${RESET}`);
    }
    // ── Set mainField to "title" for admin display ────────────────────
    console.log('\nSetting content manager "Entry title" to "title" for all content types...');
    const contentTypeKeys = [
      'plugin_content_manager_configuration_content_types::api::article.article',
      'plugin_content_manager_configuration_content_types::api::dataset.dataset',
      'plugin_content_manager_configuration_content_types::api::app.app',
    ];

    for (const key of contentTypeKeys) {
      try {
        const row = db.prepare('SELECT value FROM strapi_core_store_settings WHERE key = ?').get(key);
        if (row?.value) {
          const config = JSON.parse(row.value);
          const oldMainField = config.settings?.mainField;
          config.settings.mainField = 'title';
          config.settings.defaultSortBy = 'title';
          db.prepare('UPDATE strapi_core_store_settings SET value = ? WHERE key = ?')
            .run(JSON.stringify(config), key);
          const typeName = key.split('::').pop();
          console.log(`  ${GREEN}✓${RESET} ${typeName}: mainField ${oldMainField} → title`);
        }
      } catch (err) {
        console.log(`  ${YELLOW}⚠ Could not update ${key}: ${err.message}${RESET}`);
      }
    }
  } finally {
    // Always close the database
    db.close();
    console.log('\nSQLite database closed.');
  }

  console.log(`\n${GREEN}Phase 4e (timestamp restoration + admin config) complete.${RESET}`);
  console.log(`${YELLOW}Remember to restart Strapi 5 before running verification.${RESET}`);
  console.log('Next: pnpm migrate:phase04 (or node migration/scripts/04-verify.js)');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
