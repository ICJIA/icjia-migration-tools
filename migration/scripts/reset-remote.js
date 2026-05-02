/**
 * @module reset-remote
 * @description Full reset of both local migration data and remote Strapi 5 instance.
 *
 * Automates the complete teardown needed before a fresh migration:
 * 1. Cleans all local migration data (introspection, raw, transformed, maps, output)
 * 2. Stops Strapi 5 on the remote server
 * 3. Deletes the remote SQLite database and all uploaded media files
 * 4. Restarts Strapi 5 (which auto-creates a fresh empty database)
 * 5. Waits for Strapi 5 to become available
 * 6. Prompts user to create admin account and API token
 *
 * After this script completes, the system is ready for a full migration run.
 *
 * NOTE: You only need this reset to start completely from scratch. If a
 * migration phase fails due to a timeout or network glitch, you do NOT need
 * to reset — just re-run `pnpm migrate:full`. Every phase is idempotent and
 * will pick up where it left off without duplicating data.
 *
 * @example
 *   pnpm reset-remote
 *   # or: node migration/scripts/reset-remote.js
 *
 * Prerequisites:
 * - SSH access to the remote server (key-based auth configured)
 * - config.js set to production (cp config.prod.js config.js)
 */

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

// ── Configuration ───────────────────────────────────────────────────

/**
 * SSH connection details. Override via environment variables if needed.
 * @type {{ host: string, user: string, strapiDir: string }}
 */
const SSH = {
  host: process.env.SSH_HOST || '137.184.64.249',
  user: process.env.SSH_USER || 'forge',
  strapiDir: config.strapi5ProjectPath || '/home/forge/v2.hub.icjia-api.cloud/v2hub',
};

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Run a shell command synchronously, returning output.
 * @param {string} cmd - Command to execute
 * @returns {string} Command stdout
 */
function run(cmd) {
  console.log(`  ${DIM}$ ${cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd}${RESET}`);
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.stderr) console.error(`  ${RED}${err.stderr.trim()}${RESET}`);
    throw err;
  }
}

/**
 * Run a command via SSH on the remote server.
 * @param {string} cmd - Remote command to execute
 * @returns {string} Command stdout
 */
function ssh(cmd) {
  return run(`ssh ${SSH.user}@${SSH.host} "${cmd.replace(/"/g, '\\"')}"`);
}

/**
 * SCP a local file/directory to the remote server.
 * @param {string} localPath - Local path
 * @param {string} remotePath - Remote destination
 */
function scp(localPath, remotePath) {
  run(`scp -r "${localPath}" ${SSH.user}@${SSH.host}:${remotePath}`);
}

/**
 * Prompt the user and wait for a line of input.
 * @param {string} question - Prompt text
 * @returns {Promise<string>} User input
 */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for Strapi 5 to become available by polling the API.
 * @param {string} url - Strapi 5 base URL
 * @param {number} maxAttempts - Maximum number of attempts
 * @param {number} delayMs - Delay between attempts
 * @returns {Promise<boolean>} True if available, false if timed out
 */
async function waitForStrapi5(url, maxAttempts = 30, delayMs = 3000) {
  for (let i = 1; i <= maxAttempts; i++) {
    process.stdout.write(`  Attempt ${i}/${maxAttempts}...`);
    try {
      const res = await fetch(`${url}/admin`, { signal: AbortSignal.timeout(5000) });
      if (res.ok || res.status === 401 || res.status === 403 || res.status === 200) {
        console.log(` ${GREEN}ready${RESET}`);
        return true;
      }
      console.log(` ${YELLOW}status ${res.status}${RESET}`);
    } catch {
      console.log(` ${DIM}not yet${RESET}`);
    }
    await sleep(delayMs);
  }
  return false;
}

/**
 * Remove a file or directory if it exists.
 * @param {string} targetPath - Absolute path to remove
 * @param {string} label - Display label
 */
async function removeLocal(targetPath, label) {
  try {
    await fs.access(targetPath);
    await fs.rm(targetPath, { recursive: true });
    console.log(`  ${GREEN}✓${RESET} Removed: ${label}`);
  } catch {
    console.log(`  ${DIM}-${RESET} Already clean: ${label}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

/**
 * Main entry point: full reset of local and remote state.
 */
async function main() {
  console.log('');
  console.log(`${BOLD}${RED}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${RED}║         FULL MIGRATION RESET (Local + Remote)           ║${RESET}`);
  console.log(`${BOLD}${RED}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${YELLOW}This will:${RESET}`);
  console.log(`  1. Delete all local migration data (introspection, raw, transformed, maps, output)`);
  console.log(`  2. Stop Strapi 5 on ${SSH.host}`);
  console.log(`  3. Delete the remote SQLite database and all uploaded media`);
  console.log(`  4. Rebuild and restart Strapi 5 with a fresh empty database`);
  console.log(`  5. Re-deploy content type schemas to the remote server`);
  console.log(`  6. Verify schemas against the fresh Strapi 5 instance`);
  console.log('');
  console.log(`${YELLOW}After this script finishes, you will need to:${RESET}`);
  console.log(`  1. Create a new admin account at ${CYAN}${config.strapi5.apiUrl}/admin${RESET}`);
  console.log(`  2. Create a new API token (Settings → API Tokens → Full access)`);
  console.log(`  3. Set the token: ${CYAN}export STRAPI5_TOKEN="<token>"${RESET}`);
  console.log(`  4. Run the migration: ${CYAN}pnpm migrate:full${RESET}`);
  console.log('');

  const confirm = await ask(`${RED}${BOLD}Type "RESET" to confirm (or anything else to cancel): ${RESET}`);
  if (confirm !== 'RESET') {
    console.log('\nCancelled. No changes made.');
    process.exit(0);
  }

  console.log('');

  // ── Step 1: Clean local migration data ──

  console.log(`${BOLD}── Step 1/6: Clean local migration data ──${RESET}\n`);

  const localTargets = [
    [path.resolve(ROOT, 'migration/data'), 'migration/data/'],
    [path.resolve(ROOT, 'migration/output'), 'migration/output/'],
    [path.resolve(ROOT, 'migration/config/field-map.json'), 'migration/config/field-map.json'],
  ];

  for (const [absPath, label] of localTargets) {
    await removeLocal(absPath, label);
  }
  console.log('');

  // ── Step 2: Stop Strapi 5 ──

  console.log(`${BOLD}── Step 2/6: Stop Strapi 5 on remote server ──${RESET}\n`);
  try {
    ssh('pm2 stop strapi5');
    console.log(`  ${GREEN}✓${RESET} Strapi 5 stopped\n`);
  } catch {
    console.log(`  ${YELLOW}⚠ Could not stop (may already be stopped)${RESET}\n`);
  }

  // ── Step 3: Delete remote database and media ──

  console.log(`${BOLD}── Step 3/6: Delete remote database and media ──${RESET}\n`);
  ssh(`rm -f ${SSH.strapiDir}/.tmp/data.db`);
  console.log(`  ${GREEN}✓${RESET} Deleted .tmp/data.db`);
  ssh(`rm -rf ${SSH.strapiDir}/public/uploads/*`);
  console.log(`  ${GREEN}✓${RESET} Cleared public/uploads/\n`);

  // ── Step 4: Re-deploy schemas and rebuild ──

  console.log(`${BOLD}── Step 4/6: Re-deploy schemas and rebuild ──${RESET}\n`);

  // Run introspect + generate locally
  console.log('  Running introspect + generate locally...');
  run(`cd "${ROOT}" && node migration/scripts/01a-introspect.js`);
  console.log(`  ${GREEN}✓${RESET} Introspection complete`);
  run(`cd "${ROOT}" && node migration/scripts/01b-generate-schemas.js`);
  console.log(`  ${GREEN}✓${RESET} Schema generation complete`);

  // SCP schemas to server
  console.log('  Uploading schemas to server...');
  const outputDir = path.resolve(ROOT, 'migration/output/strapi5-schemas');
  const contentTypes = ['article', 'dataset', 'app'];
  for (const ct of contentTypes) {
    const localSchemaDir = path.join(outputDir, ct);
    try {
      await fs.access(localSchemaDir);
      scp(localSchemaDir, `${SSH.strapiDir}/src/api/`);
      console.log(`  ${GREEN}✓${RESET} Uploaded ${ct} schema`);
    } catch {
      console.log(`  ${YELLOW}⚠ No schema for ${ct}${RESET}`);
    }
  }

  // Build and restart
  console.log('  Building and restarting Strapi 5...');
  ssh(`cd ${SSH.strapiDir} && npm run build`);
  console.log(`  ${GREEN}✓${RESET} Build complete`);
  ssh('pm2 restart strapi5');
  console.log(`  ${GREEN}✓${RESET} Strapi 5 restarting\n`);

  // ── Step 5: Wait for Strapi 5 ──

  console.log(`${BOLD}── Step 5/6: Wait for Strapi 5 to become available ──${RESET}\n`);
  const ready = await waitForStrapi5(config.strapi5.apiUrl);
  if (!ready) {
    console.log(`\n${RED}Strapi 5 did not become available in time.${RESET}`);
    console.log(`Check: ssh ${SSH.user}@${SSH.host} "pm2 logs strapi5 --lines 50"`);
    process.exit(1);
  }
  console.log('');

  // ── Step 6: Verify schemas ──

  console.log(`${BOLD}── Step 6/6: Verify schemas ──${RESET}\n`);
  try {
    run(`cd "${ROOT}" && node migration/scripts/01c-verify-schemas.js`);
    console.log(`  ${GREEN}✓${RESET} Schema verification passed\n`);
  } catch {
    console.log(`  ${YELLOW}⚠ Schema verification had issues — check output above${RESET}\n`);
  }

  // ── Done ──

  console.log(`${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}${BOLD}║         Reset Complete — Ready for Fresh Migration       ║${RESET}`);
  console.log(`${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log('');
  console.log(`  ${CYAN}1.${RESET} Create admin account at ${CYAN}${config.strapi5.apiUrl}/admin${RESET}`);
  console.log(`  ${CYAN}2.${RESET} Create API token: Settings → API Tokens → "Full access"`);
  console.log(`  ${CYAN}3.${RESET} Set the token:`);
  console.log(`     ${CYAN}export STRAPI5_TOKEN="<paste-your-token>"${RESET}`);
  console.log(`  ${CYAN}4.${RESET} Run the full migration:`);
  console.log(`     ${CYAN}pnpm migrate:full${RESET}`);
  console.log('');
  console.log(`${GREEN}${BOLD}NOTE: Every migration phase is idempotent (safe to re-run).${RESET}`);
  console.log(`${GREEN}If a phase fails due to a timeout, network glitch, or any transient${RESET}`);
  console.log(`${GREEN}error, you do NOT need to run this reset again. Just re-run:${RESET}`);
  console.log(`  ${CYAN}pnpm migrate:full${RESET}`);
  console.log(`${GREEN}Completed phases will detect prior work and skip already-processed${RESET}`);
  console.log(`${GREEN}records. Only use this reset script to start completely from scratch.${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
