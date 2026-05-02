/**
 * @module 00-clean
 * @description Cleans all generated data from the migration directory.
 *
 * Removes all intermediate and output data so the migration process can start
 * fresh. This is useful for:
 * - Testing individual phases from scratch
 * - Ensuring no stale data from previous runs interferes with new runs
 * - Starting over after fixing a bug in a script
 *
 * What gets deleted:
 * - `migration/data/` — all introspection results, raw extracts, transformed data, media, maps
 * - `migration/output/` — all generated Strapi 5 schemas and boilerplate
 * - `migration/config/field-map.json` — generated field mapping (NOT field-type-map.json)
 *
 * What is preserved:
 * - `migration/scripts/` — the scripts themselves
 * - `migration/lib/` — shared libraries
 * - `migration/config/field-type-map.json` — static configuration (not generated)
 * - `schemas/` — source Strapi 3 schemas (not in migration/)
 * - `config.js` / `config.example.js` — configuration files
 *
 * @example
 *   pnpm migrate:clean
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const MIGRATION = path.resolve(ROOT, 'migration');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * Directories and files to remove during clean.
 * All paths relative to the project root.
 * @type {string[]}
 */
const CLEAN_TARGETS = [
  'migration/data',
  'migration/output',
  'migration/config/field-map.json',
];

/**
 * Remove a file or directory, logging the result.
 *
 * @param {string} targetPath - Absolute path to remove
 * @param {string} displayPath - Relative path for display
 * @returns {Promise<boolean>} True if something was removed
 */
async function remove(targetPath, displayPath) {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true });
      console.log(`  ${GREEN}✓${RESET} Removed directory: ${displayPath}/`);
    } else {
      await fs.unlink(targetPath);
      console.log(`  ${GREEN}✓${RESET} Removed file: ${displayPath}`);
    }
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`  - Skipped (not found): ${displayPath}`);
      return false;
    }
    throw err;
  }
}

async function main() {
  console.log('=== Migration Clean ===\n');
  console.log(`${YELLOW}This will remove all generated migration data and output.${RESET}`);
  console.log(`${YELLOW}Scripts, libraries, and static config will be preserved.${RESET}\n`);

  let removedCount = 0;

  for (const target of CLEAN_TARGETS) {
    const absPath = path.resolve(ROOT, target);
    const removed = await remove(absPath, target);
    if (removed) removedCount++;
  }

  console.log('');
  if (removedCount > 0) {
    console.log(`${GREEN}Clean complete — ${removedCount} item(s) removed.${RESET}`);
  } else {
    console.log('Nothing to clean — migration directory is already empty.');
  }
  console.log(`\n${GREEN}Ready for a fresh migration run.${RESET}`);
  console.log('Start with: pnpm migrate:phase01');
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
