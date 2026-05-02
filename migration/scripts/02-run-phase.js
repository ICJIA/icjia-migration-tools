/**
 * @module 02-run-phase
 * @description Phase 2 orchestrator: runs extraction and verification in sequence.
 *
 * Executes 02-extract → 02-verify with interactive prompts between steps.
 * If a step fails, explains exactly what went wrong and how to resume.
 *
 * @example
 *   pnpm migrate:phase02
 *   # or: node migration/scripts/02-run-phase.js
 *
 * Prerequisites:
 * - Strapi 3 running and accessible
 * - Phase 1 complete
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
 * Print failure with recovery instructions.
 * @param {string} stepName
 * @param {string} scriptPath
 * @param {number} exitCode
 * @param {string} [hint]
 */
function printFailure(stepName, scriptPath, exitCode, hint) {
  console.log('');
  console.log(`${RED}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${RED}║  ${stepName} failed (exit code ${exitCode})${' '.repeat(Math.max(0, 38 - stepName.length - String(exitCode).length))}║${RESET}`);
  console.log(`${RED}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${YELLOW}You do NOT need to start Phase 2 over from the beginning.${RESET}`);
  console.log(`${YELLOW}Fix the issue above, then resume by running:${RESET}`);
  console.log(`  ${CYAN}node ${scriptPath}${RESET}`);
  if (hint) console.log(`\n${YELLOW}Hint: ${hint}${RESET}`);
  console.log('');
}

async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║              Phase 2: Data Extraction                   ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('This will run all Phase 2 steps in sequence:');
  console.log(`  ${CYAN}Step 1:${RESET} Extract all content from Strapi 3 via GraphQL (02-extract)`);
  console.log(`  ${CYAN}Step 2:${RESET} Verify extracted data integrity (02-verify)`);
  console.log('');

  // ── Step 1: Extract ─────────────────────────────────────────────────
  console.log(`${BOLD}── Step 1/2: Extract Data ──${RESET}\n`);

  const code1 = await runScript('migration/scripts/02-extract.js');
  if (code1 !== 0) {
    printFailure('Step 1 (Extract)', 'migration/scripts/02-extract.js', code1,
      'Check that Strapi 3 is running and the GraphQL URL in config.js is correct.\n' +
      '  Common causes: connection refused, auth required, field name mismatch.');
    process.exit(1);
  }

  console.log(`\n${GREEN}✓ Step 1 complete.${RESET}\n`);

  // ── Step 2: Verify ──────────────────────────────────────────────────
  const continue2 = await promptYesNo(
    `${CYAN}Step 2/2: Verify extracted data.${RESET}\n` +
    'This checks record counts, IDs, timestamps, relations, and media references.\n' +
    'Continue? [Y/n] '
  );
  if (!continue2) {
    console.log(`\nPaused. Resume later with: ${CYAN}node migration/scripts/02-verify.js${RESET}`);
    process.exit(0);
  }

  console.log(`\n${BOLD}── Step 2/2: Verify Extracted Data ──${RESET}\n`);

  const code2 = await runScript('migration/scripts/02-verify.js');
  if (code2 !== 0) {
    printFailure('Step 2 (Verify)', 'migration/scripts/02-verify.js', code2,
      'Review the failed checks above. If counts don\'t match, re-run extraction.\n' +
      '  If specific fields are missing, check the GraphQL query in 02-extract.js.');
    process.exit(1);
  }

  // ── Success ─────────────────────────────────────────────────────────
  console.log('');
  console.log(`${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}║         Phase 2 Complete — All steps passed ✓           ║${RESET}`);
  console.log(`${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('Deliverables:');
  console.log(`  ${GREEN}✓${RESET} Raw articles     → migration/data/raw/articles.json`);
  console.log(`  ${GREEN}✓${RESET} Raw datasets     → migration/data/raw/datasets.json`);
  console.log(`  ${GREEN}✓${RESET} Raw apps         → migration/data/raw/apps.json`);
  console.log(`  ${GREEN}✓${RESET} Manifest         → migration/data/raw/manifest.json`);
  console.log('');
  console.log('Next: Phase 3 (Base64 Extraction & Media Migration)');
  console.log(`  ${CYAN}pnpm migrate:phase03${RESET}  (when implemented)`);
  console.log('');
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
