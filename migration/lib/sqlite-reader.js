/**
 * @module sqlite-reader
 * @description Read-only thin wrapper over better-sqlite3 for the Strapi 3 source DB.
 *
 * Used as a fallback when GraphQL can't reach the data:
 *   - **Drafts** — Strapi 3 GraphQL filters out records with NULL published_at
 *     for unauthenticated callers. SQLite shows them all.
 *   - **Form (205 records)** — 403'd by GraphQL unauthenticated. SQLite reads
 *     freely from the `forms` table.
 *   - **Validation cross-checks** — ground-truth record counts, ground-truth
 *     relation join-table contents.
 *
 * **Read-only by design.** Phase 4c uses a separate path for direct UPDATE
 * (timestamp restoration) and uses better-sqlite3 differently.
 *
 * The reader returns rows with JSON fields automatically deserialized — Strapi 3
 * stores JSON-typed columns as TEXT, so we parse on read. Relation join-table
 * reads return the raw ID pairs (no auto-joining).
 *
 * @example
 *   import { openSourceDb, readTable, countTable, readJoinTable } from '../lib/sqlite-reader.js';
 *   const db = openSourceDb('./docs/strapi-3-source/data.db');
 *   const allPosts = readTable(db, 'posts');
 *   const draftPosts = readTable(db, 'posts', { where: 'published_at IS NULL' });
 *   const tagPostJoins = readJoinTable(db, 'posts_tags__tags_posts');
 *   db.close();
 */

import Database from 'better-sqlite3';

/**
 * Fields that Strapi 3 stores as TEXT but represent JSON.
 * The reader auto-parses these on read. Add more here if new JSON fields
 * surface in other content types.
 *
 * Pattern: "<table>.<column>"
 */
const JSON_TEXT_FIELDS = new Set([
  'publications.tags',
  'configs.config',
  'forms.form',
]);

/**
 * Open the source SQLite database read-only. Caller is responsible for
 * calling .close() when done.
 *
 * @param {string} dbPath - Absolute path to data.db
 * @returns {Database.Database} better-sqlite3 instance, opened read-only
 */
export function openSourceDb(dbPath) {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Get the list of all tables in the database.
 *
 * @param {Database.Database} db
 * @returns {string[]}
 */
export function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

/**
 * Get the column metadata for a table.
 *
 * @param {Database.Database} db
 * @param {string} table
 * @returns {Array<{cid, name, type, notnull, dflt_value, pk}>}
 */
export function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

/**
 * Count rows in a table, optionally filtered.
 *
 * @param {Database.Database} db
 * @param {string} table
 * @param {{where?: string, params?: Object}} [opts]
 * @returns {number}
 */
export function countTable(db, table, opts = {}) {
  let sql = `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`;
  if (opts.where) sql += ` WHERE ${opts.where}`;
  const stmt = db.prepare(sql);
  const row = opts.params ? stmt.get(opts.params) : stmt.get();
  return row.n;
}

/**
 * Read all rows from a table (or a filtered subset).
 * JSON fields configured in JSON_TEXT_FIELDS are auto-deserialized.
 *
 * @param {Database.Database} db
 * @param {string} table
 * @param {{where?: string, params?: Object, columns?: string[], orderBy?: string, limit?: number, offset?: number}} [opts]
 * @returns {Object[]} Array of row objects
 */
export function readTable(db, table, opts = {}) {
  const cols = opts.columns?.length ? opts.columns.map(quoteIdent).join(', ') : '*';
  let sql = `SELECT ${cols} FROM ${quoteIdent(table)}`;
  if (opts.where) sql += ` WHERE ${opts.where}`;
  if (opts.orderBy) sql += ` ORDER BY ${opts.orderBy}`;
  if (opts.limit !== undefined) sql += ` LIMIT ${Number(opts.limit)}`;
  if (opts.offset !== undefined) sql += ` OFFSET ${Number(opts.offset)}`;

  const stmt = db.prepare(sql);
  const rows = opts.params ? stmt.all(opts.params) : stmt.all();
  return rows.map((row) => deserializeJsonFields(table, row));
}

/**
 * Read a single row (or null if not found) by primary key.
 *
 * @param {Database.Database} db
 * @param {string} table
 * @param {number|string} id
 * @returns {Object|null}
 */
export function readRow(db, table, id) {
  const row = db
    .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE id = ?`)
    .get(id);
  return row ? deserializeJsonFields(table, row) : null;
}

/**
 * Read a relation join table.
 * Returns the raw row pairs as stored in SQLite (e.g., {id, post_id, tag_id}).
 *
 * @param {Database.Database} db
 * @param {string} joinTable
 * @returns {Object[]}
 */
export function readJoinTable(db, joinTable) {
  return db.prepare(`SELECT * FROM ${quoteIdent(joinTable)} ORDER BY id`).all();
}

/**
 * Read components linked to a content type's records.
 * Strapi 3 stores them in `<table>_components` with columns:
 *   id, field, order, component_type, component_id, <table>_id
 *
 * @param {Database.Database} db
 * @param {string} contentTypePluralLowercase - e.g., "pages", "homes", "meetings"
 * @returns {Object[]}
 */
export function readComponentLinks(db, contentTypePluralLowercase) {
  const table = `${contentTypePluralLowercase}_components`;
  // The host-FK column name is the singular of the content type with `_id`.
  // Strapi 3 conventions: pages_components has `page_id`. Sometimes plural-prefix.
  // The caller can use tableInfo(db, table) if column names differ.
  return db.prepare(`SELECT * FROM ${quoteIdent(table)} ORDER BY \`order\``).all();
}

/**
 * Distinct enum values observed in a column. Useful pre-Phase-4 to
 * sanity-check enum coverage before the Strapi 5 schema rejects unknown values.
 *
 * @param {Database.Database} db
 * @param {string} table
 * @param {string} column
 * @returns {string[]}
 */
export function distinctValues(db, table, column) {
  return db
    .prepare(`SELECT DISTINCT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL ORDER BY v`)
    .all()
    .map((r) => r.v);
}

/**
 * Quote a SQL identifier (table or column name) for SQLite.
 * Uses double-quotes, which is the SQL standard. Backticks are also accepted
 * by SQLite but less portable.
 */
function quoteIdent(name) {
  if (typeof name !== 'string') throw new Error(`Identifier must be a string: ${name}`);
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(`Refusing to quote unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Auto-deserialize known JSON-text columns on a row read from a table.
 */
function deserializeJsonFields(table, row) {
  if (!row) return row;
  const cols = Object.keys(row);
  for (const col of cols) {
    const key = `${table}.${col}`;
    if (!JSON_TEXT_FIELDS.has(key)) continue;
    if (typeof row[col] !== 'string') continue;
    try {
      row[col] = JSON.parse(row[col]);
    } catch {
      // Leave as raw string if not parseable — caller can decide what to do
    }
  }
  return row;
}
