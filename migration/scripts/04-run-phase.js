/**
 * @module 04-run-phase
 * @description Phase 4 orchestrator: runs all Phase 4 steps in sequence with prompts.
 *
 * Executes:
 *   Step 1: Load content (04-load.js)
 *   Step 2: Link relations (04b-link-relations.js) — prompt first
 *   Step 3: Stop Strapi 5 prompt, then fix timestamps (04c-fix-timestamps.js)
 *   Step 4: Prompt to restart Strapi 5, then verify (04-verify.js)
 *
 * Each step has graceful failure handling with recovery instructions.
 *
 * @example
 *   pnpm migrate:phase04
 *   # or: node migration/scripts/04-run-phase.js
 *
 * Prerequisites:
 * - Phase 3 complete (transformed data exists)
 * - Strapi 5 running at configured URL with full-access API token
 * - `better-sqlite3` installed
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Run a script as a child process, streaming output to the console.
 *
 * @param {string} scriptPath - Path relative to project root
 * @returns {Promise<number>} Exit code
 */
function runScript(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath], { cwd: ROOT, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`${RED}Failed to start ${scriptPath}: ${err.message}${RESET}`);
      resolve(1);
    });
  });
}

/**
 * Prompt yes/no with default Y.
 *
 * @param {string} question - The prompt text
 * @returns {Promise<boolean>} True if user said yes (or pressed Enter)
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
 * Wait for user to press Enter (acknowledgement prompt).
 *
 * @param {string} message - The prompt text
 * @returns {Promise<void>}
 */
function promptContinue(message) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Print failure with recovery instructions.
 *
 * @param {string} stepName - Human-readable step name
 * @param {string} scriptPath - Path to the script that failed
 * @param {number} exitCode - Process exit code
 * @param {string} [hint] - Optional recovery hint
 */
function printFailure(stepName, scriptPath, exitCode, hint) {
  console.log('');
  console.log(`${RED}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${RED}║  ${stepName} failed (exit code ${exitCode})${' '.repeat(Math.max(0, 38 - stepName.length - String(exitCode).length))}║${RESET}`);
  console.log(`${RED}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${YELLOW}You do NOT need to start Phase 4 over from the beginning.${RESET}`);
  console.log(`${YELLOW}Each step is idempotent — fix the issue, then resume by running:${RESET}`);
  console.log(`  ${CYAN}node ${scriptPath}${RESET}`);
  if (hint) console.log(`\n${YELLOW}Hint: ${hint}${RESET}`);
  console.log('');
}

async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║       Phase 4: Data Loading & Post-Processing           ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('This will run all Phase 4 steps in sequence:');
  console.log(`  ${CYAN}Step 1:${RESET} Load content into Strapi 5 (datasets, apps, articles)`);
  console.log(`  ${CYAN}Step 2:${RESET} Link many-to-many relations (relation triangle)`);
  console.log(`  ${CYAN}Step 3:${RESET} Fix timestamps via SSH (stops/restarts Strapi 5 automatically)`);
  console.log(`  ${CYAN}Step 4:${RESET} Fix inline image references in article markdown`);
  console.log(`  ${CYAN}Step 5:${RESET} Verify all Phase 4 output (requires Strapi 5 running)`);
  console.log('');

  // ── Step 1: Load Content ──────────────────────────────────────────
  console.log(`${BOLD}── Step 1/5: Load Content ──${RESET}\n`);

  const code1 = await runScript('migration/scripts/04-load.js');
  if (code1 !== 0) {
    printFailure(
      'Step 1 (Load)',
      'migration/scripts/04-load.js',
      code1,
      'Check that Strapi 5 is running, the API token is set in config.js,\n' +
      '  and the transformed data exists in migration/data/transformed/.\n' +
      '  This script is idempotent — already-loaded records will be skipped on re-run.',
    );
    process.exit(1);
  }

  console.log(`\n${GREEN}Step 1 complete.${RESET}\n`);

  // ── Step 2: Link Relations ────────────────────────────────────────
  const continue2 = await promptYesNo(
    `${CYAN}Step 2/5: Link many-to-many relations (relation triangle).${RESET}\n` +
    'This links article->datasets, app->articles, and app->datasets.\n' +
    'Strapi 5 must still be running.\n' +
    'Continue? [Y/n] ',
  );
  if (!continue2) {
    console.log(`\nPaused. Resume later with: ${CYAN}node migration/scripts/04b-link-relations.js${RESET}`);
    process.exit(0);
  }

  console.log(`\n${BOLD}── Step 2/5: Link Relations ──${RESET}\n`);

  const code2 = await runScript('migration/scripts/04b-link-relations.js');
  if (code2 !== 0) {
    printFailure(
      'Step 2 (Link Relations)',
      'migration/scripts/04b-link-relations.js',
      code2,
      'Check that all ID maps exist in migration/data/maps/.\n' +
      '  This script uses the connect syntax — re-running is safe (additive).',
    );
    process.exit(1);
  }

  console.log(`\n${GREEN}Step 2 complete.${RESET}\n`);

  // ── Step 3: Fix Timestamps ────────────────────────────────────────
  console.log(`${BOLD}── Step 3/5: Fix Timestamps (Remote via SSH) ──${RESET}\n`);
  console.log(`${CYAN}This will SSH into the server, stop Strapi 5, update timestamps${RESET}`);
  console.log(`${CYAN}directly in the SQLite database, and restart Strapi 5.${RESET}\n`);

  const code3 = await runScript('migration/scripts/04c-fix-timestamps-remote.js');
  if (code3 !== 0) {
    printFailure(
      'Step 3 (Fix Timestamps)',
      'migration/scripts/04c-fix-timestamps-remote.js',
      code3,
      'Check SSH connectivity to the remote server.\n' +
      '  Verify that Strapi 5 can be stopped/started via pm2.\n' +
      '  This script is idempotent — re-running overwrites timestamps with the same values.',
    );
    process.exit(1);
  }

  console.log(`\n${GREEN}Step 3 complete.${RESET}\n`);

  // ── Wait for Strapi 5 to be ready after restart ─────────────────
  console.log(`${CYAN}Waiting for Strapi 5 to be ready after restart...${RESET}\n`);
  const s5Url = config.strapi5.apiUrl;
  const s5Token = config.strapi5.token;
  for (let attempt = 1; attempt <= 30; attempt++) {
    process.stdout.write(`  Attempt ${attempt}/30...`);
    try {
      const headers = {};
      if (s5Token) headers['Authorization'] = `Bearer ${s5Token}`;
      const res = await fetch(`${s5Url}/api/articles?pagination[pageSize]=1`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        console.log(` ${GREEN}ready${RESET}`);
        break;
      }
      console.log(` ${YELLOW}status ${res.status}${RESET}`);
    } catch {
      console.log(` not yet`);
    }
    if (attempt === 30) {
      console.log(`\n${RED}Strapi 5 did not become ready in time. Check the server.${RESET}`);
      console.log(`Once it's ready, resume with: ${CYAN}pnpm fix-image-refs${RESET}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('');

  // ── Step 4: Fix Image References ────────────────────────────────
  console.log(`${BOLD}── Step 4/5: Fix Image References ──${RESET}\n`);
  console.log(`${CYAN}Converting reference-style markdown images to inline URLs.${RESET}\n`);

  const code4 = await runScript('migration/scripts/04d-fix-image-refs.js');
  if (code4 !== 0) {
    printFailure(
      'Step 4 (Fix Image References)',
      'migration/scripts/04d-fix-image-refs.js',
      code4,
      'Check Strapi 5 connectivity and API token.\n' +
      '  This script is idempotent — re-running is safe.',
    );
    process.exit(1);
  }

  console.log(`\n${GREEN}Step 4 complete.${RESET}\n`);

  // ── Step 5: Verify ──────────────────────────────────────────────
  console.log(`${BOLD}── Step 5/5: Verify ──${RESET}\n`);

  const code5 = await runScript('migration/scripts/04-verify.js');
  if (code5 !== 0) {
    printFailure(
      'Step 5 (Verify)',
      'migration/scripts/04-verify.js',
      code5,
      'Review the failed checks above.\n' +
      '  Count mismatch: re-run 04-load.js (idempotent).\n' +
      '  Missing relations: re-run 04b-link-relations.js.\n' +
      '  Wrong timestamps: re-run pnpm fix-timestamps (handles SSH automatically).\n' +
      '  Then re-run this verification: node migration/scripts/04-verify.js',
    );
    process.exit(1);
  }

  // ── Success ───────────────────────────────────────────────────────
  console.log('');
  console.log(`${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}║       Phase 4 Complete — All steps passed               ║${RESET}`);
  console.log(`${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('Deliverables:');
  console.log(`  ${GREEN}✓${RESET} All datasets loaded into Strapi 5`);
  console.log(`  ${GREEN}✓${RESET} All apps loaded into Strapi 5`);
  console.log(`  ${GREEN}✓${RESET} All articles loaded into Strapi 5`);
  console.log(`  ${GREEN}✓${RESET} Relation triangle linked (article->datasets, app->articles, app->datasets)`);
  console.log(`  ${GREEN}✓${RESET} Original timestamps restored`);
  console.log(`  ${GREEN}✓${RESET} ID maps saved → migration/data/maps/{articles,datasets,apps}.json`);
  console.log(`  ${GREEN}✓${RESET} Load report → migration/data/load-report.json`);
  console.log(`  ${GREEN}✓${RESET} All verification checks passed`);
  console.log('');
  console.log('Next: Phase 5 (Final Validation)');
  console.log(`  ${CYAN}pnpm migrate:phase05${RESET}  (when implemented)`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
