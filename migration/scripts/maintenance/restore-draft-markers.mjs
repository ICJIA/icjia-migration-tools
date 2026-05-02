/**
 * @module restore-draft-markers
 * @description Recovery script for v0.9.5's Phase 4c bug.
 *
 * v0.9.5's `04c-fix-timestamps.js` set `published_at` on every row of each
 * document — including the draft row, which MUST have published_at NULL for
 * Strapi 5 to distinguish it from the published row. The result: the admin
 * showed "0 entries found" for every content type even though all records
 * were physically in SQLite.
 *
 * This script reverts the damage: for each document with TWO rows both
 * having published_at set, NULL out the lower-id row (the draft row).
 *
 * Strapi 5 must be STOPPED while this runs (it writes directly to SQLite).
 *
 * @example
 *   node migration/scripts/maintenance/restore-draft-markers.mjs
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const config = await loadConfig();
const dbPath = path.resolve(ROOT, config.strapi5?.dbPath || '../icjia-public-strapi5/.tmp/data.db');

const manifest = JSON.parse(
  await import('fs/promises').then((fs) => fs.readFile(path.join(ROOT, 'migration/config/content-types.json'), 'utf8')),
);

const db = new Database(dbPath);

let totalFixed = 0;
for (const ct of manifest.contentTypes) {
  if (ct.skipDefault) continue;
  const t = ct.sqlTable;
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((r) => r.name);
  if (!cols.includes('published_at') || !cols.includes('document_id')) continue;
  const result = db.prepare(`
    UPDATE "${t}"
    SET published_at = NULL
    WHERE id IN (
      SELECT MIN(id) FROM "${t}"
      WHERE published_at IS NOT NULL
      GROUP BY document_id
      HAVING COUNT(*) > 1
    )
  `).run();
  console.log(`  ${ct.name.padEnd(18)} reverted ${result.changes} draft rows`);
  totalFixed += result.changes;
}
console.log(`\nTotal: nulled published_at on ${totalFixed} draft rows.`);
console.log('Restart Strapi 5 — admin should now show all migrated records.');
db.close();
