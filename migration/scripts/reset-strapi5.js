/**
 * @module reset-strapi5
 * @description Resets the Strapi 5 database and cleans migration data for a fresh run.
 *
 * This script:
 * 1. Checks if Strapi 5 is running and asks you to stop it
 * 2. Deletes the Strapi 5 SQLite database
 * 3. Cleans all migration data (same as pnpm migrate:clean)
 * 4. Tells you to restart Strapi 5, create admin user + API token
 *
 * After running this, you can do a full migration from scratch:
 *   pnpm migrate:phase01 through pnpm migrate:phase06
 *
 * @example
 *   node migration/scripts/reset-strapi5.js
 *   # or: pnpm reset
 */

import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const config = await loadConfig();

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Prompt yes/no with default Y.
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const t = answer.trim().toLowerCase();
      resolve(t === '' || t === 'y' || t === 'yes');
    });
  });
}

/**
 * Wait for enter.
 * @param {string} message
 * @returns {Promise<void>}
 */
function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/**
 * Check if Strapi 5 is running.
 * @returns {Promise<boolean>}
 */
async function isStrapi5Running() {
  try {
    const res = await fetch(config.strapi5.apiUrl, { signal: AbortSignal.timeout(3000) });
    return res.ok || res.status === 403 || res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Remove a file or directory.
 * @param {string} targetPath
 * @param {string} label
 * @returns {Promise<boolean>}
 */
async function remove(targetPath, label) {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true });
    } else {
      await fs.unlink(targetPath);
    }
    console.log(`  ${GREEN}✓${RESET} Removed: ${label}`);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`  - Skipped (not found): ${label}`);
      return false;
    }
    throw err;
  }
}

async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║         Reset Strapi 5 + Clean Migration Data           ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  const dbPath = path.resolve(ROOT, config.strapi5?.dbPath || '');
  const strapi5Dir = path.resolve(ROOT, config.strapi5ProjectPath || '');

  console.log('Configuration:');
  console.log(`  Strapi 5 URL:     ${config.strapi5.apiUrl}`);
  console.log(`  Strapi 5 DB:      ${dbPath}`);
  console.log(`  Strapi 5 project: ${strapi5Dir}`);
  console.log('');

  console.log(`${YELLOW}This will:${RESET}`);
  console.log(`  1. Delete the Strapi 5 SQLite database`);
  console.log(`  2. Clean all migration data (migration/data/, migration/output/, field-map.json)`);
  console.log('');
  console.log(`${YELLOW}After reset you will need to:${RESET}`);
  console.log(`  1. Restart Strapi 5 (npm run develop)`);
  console.log(`  2. Create a new admin user`);
  console.log(`  3. Create a new Full Access API token`);
  console.log(`  4. Update your token: pnpm set-strapi5`);
  console.log(`  5. Run all phases: pnpm migrate:phase01 through pnpm migrate:phase06`);
  console.log('');

  const proceed = await promptYesNo(`${RED}Proceed with reset? This cannot be undone. [y/N] ${RESET}`);
  if (!proceed) {
    console.log('\nAborted.');
    process.exit(0);
  }

  // Check if Strapi 5 is running
  console.log('\nChecking Strapi 5...');
  const running = await isStrapi5Running();
  if (running) {
    console.log(`  ${YELLOW}Strapi 5 is running at ${config.strapi5.apiUrl}${RESET}`);
    console.log(`  ${YELLOW}You must stop it before deleting the database.${RESET}`);
    console.log(`  ${YELLOW}Press Ctrl+C in the Strapi 5 terminal, then come back here.${RESET}`);
    console.log('');
    await waitForEnter(`${YELLOW}Press Enter after stopping Strapi 5...${RESET} `);

    // Verify it's actually stopped
    const stillRunning = await isStrapi5Running();
    if (stillRunning) {
      console.error(`\n${RED}ERROR: Strapi 5 is still running. Stop it first.${RESET}`);
      process.exit(1);
    }
  }
  console.log(`  ${GREEN}✓${RESET} Strapi 5 is not running\n`);

  // Delete Strapi 5 database
  console.log(`${BOLD}── Deleting Strapi 5 database ──${RESET}\n`);
  if (dbPath && dbPath !== path.resolve(ROOT)) {
    await remove(dbPath, `Strapi 5 DB: ${path.relative(ROOT, dbPath)}`);
    // Also remove journal/wal files
    await remove(dbPath + '-journal', 'DB journal');
    await remove(dbPath + '-wal', 'DB WAL');
    await remove(dbPath + '-shm', 'DB SHM');
  } else {
    console.log(`  ${YELLOW}⚠ No database path configured. Check strapi5.dbPath in config.js${RESET}`);
  }

  // Clean migration data
  console.log(`\n${BOLD}── Cleaning migration data ──${RESET}\n`);
  for (const target of ['migration/data', 'migration/output', 'migration/config/field-map.json']) {
    await remove(path.resolve(ROOT, target), target);
  }

  // Summary
  console.log('');
  console.log(`${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}║         Reset complete — ready for fresh migration       ║${RESET}`);
  console.log(`${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('Before continuing:');
  console.log('');
  console.log(`  ${CYAN}1.${RESET} Start Strapi 5 (it recreates the DB from existing schema files):`);
  console.log(`     ${CYAN}cd ${strapi5Dir} && npm run develop${RESET}`);
  console.log('');
  console.log(`  ${CYAN}2.${RESET} Create admin user at ${CYAN}http://localhost:1338/admin${RESET}`);
  console.log('');
  console.log(`  ${CYAN}3.${RESET} Create API token: Settings → API Tokens → Full Access → Save & copy`);
  console.log('');

  await waitForEnter(`${YELLOW}Press Enter when Strapi 5 is running with a new admin + API token...${RESET} `);

  // Chain into set-strapi5 (which chains into phase01)
  console.log('');
  const { spawn } = await import('child_process');
  const child = spawn('node', ['migration/scripts/set-strapi5-url.js'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
