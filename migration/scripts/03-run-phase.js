/**
 * @module 03-run-phase
 * @description Phase 3 orchestrator: runs all sub-steps in sequence.
 *
 * Executes: 03a-scan-base64 -> 03b-decode-base64 -> (prompt) -> 03c-upload-media
 * -> 03d-rewrite-content -> 03e-transform -> 03-verify
 *
 * Each step has graceful failure with recovery instructions.
 * Interactive prompts between steps allow the user to pause and inspect output.
 *
 * @example
 *   pnpm migrate:phase03
 *   # or: node migration/scripts/03-run-phase.js
 *
 * Prerequisites:
 * - Phase 2 complete (raw data exists)
 * - Strapi 3 running (for file downloads)
 * - Strapi 5 running with API token (for uploads)
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
  console.log(`${RED}${'='.repeat(60)}${RESET}`);
  console.log(`${RED}  ${stepName} failed (exit code ${exitCode})${RESET}`);
  console.log(`${RED}${'='.repeat(60)}${RESET}`);
  console.log('');
  console.log(`${YELLOW}You do NOT need to start Phase 3 over from the beginning.${RESET}`);
  console.log(`${YELLOW}Fix the issue above, then resume by running:${RESET}`);
  console.log(`  ${CYAN}node ${scriptPath}${RESET}`);
  console.log('');
  console.log(`${YELLOW}Then continue with the next step, or re-run this orchestrator.${RESET}`);
  if (hint) console.log(`\n${YELLOW}Hint: ${hint}${RESET}`);
  console.log('');
}

/**
 * Phase 3 step definitions.
 * @type {Array<{name: string, script: string, hint: string, prePrompt?: string}>}
 */
const STEPS = [
  {
    name: 'Step 1/6: Scan for Base64 Images (03a)',
    script: 'migration/scripts/03a-scan-base64.js',
    hint: 'Check that data/raw/articles.json and data/raw/apps.json exist (Phase 2 output).',
  },
  {
    name: 'Step 2/6: Decode Base64 to Binary Files (03b)',
    script: 'migration/scripts/03b-decode-base64.js',
    hint: 'Check that data/media/manifest.json exists (output from 03a).',
  },
  {
    name: 'Step 3/6: Upload Media to Strapi 5 (03c)',
    script: 'migration/scripts/03c-upload-media.js',
    hint: 'Ensure Strapi 5 is running at the configured URL with a valid API token.',
    prePrompt:
      `${YELLOW}IMPORTANT: Strapi 5 must be running at the configured URL with a valid API token.${RESET}\n` +
      `${YELLOW}This step will upload all decoded media files to Strapi 5.${RESET}\n`,
  },
  {
    name: 'Step 4/6: Rewrite Article Content (03d)',
    script: 'migration/scripts/03d-rewrite-content.js',
    hint: 'Check that data/maps/media.json exists (output from 03c).',
  },
  {
    name: 'Step 5/6: Transform Datasets, Article Media & Apps (03e)',
    script: 'migration/scripts/03e-transform.js',
    hint: 'Ensure Strapi 3 is running (for file downloads) and Strapi 5 is running (for uploads).\n' +
      '  Check that data/transformed/articles.json exists (output from 03d).',
    prePrompt:
      `${YELLOW}IMPORTANT: Both Strapi 3 (for downloads) and Strapi 5 (for uploads) must be running.${RESET}\n`,
  },
  {
    name: 'Step 6/6: Verify Phase 3 Output (03-verify)',
    script: 'migration/scripts/03-verify.js',
    hint: 'Review the failed checks and fix the issue in the appropriate sub-step.\n' +
      '  Then re-run from that step forward.',
  },
];

async function main() {
  console.log('');
  console.log(`${BOLD}${'='.repeat(60)}${RESET}`);
  console.log(`${BOLD}    Phase 3: Base64 Extraction & Media Migration${RESET}`);
  console.log(`${BOLD}${'='.repeat(60)}${RESET}`);
  console.log('');
  console.log('This will run all Phase 3 steps in sequence:');
  for (const step of STEPS) {
    console.log(`  ${CYAN}${step.name}${RESET}`);
  }
  console.log('');

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];

    // Pre-prompt (for steps that need external services)
    if (step.prePrompt) {
      console.log(step.prePrompt);
    }

    const proceed = await promptYesNo(
      `${CYAN}${step.name}${RESET}\nContinue? [Y/n] `
    );

    if (!proceed) {
      console.log(`\nPaused. Resume later with: ${CYAN}node ${step.script}${RESET}`);
      if (i + 1 < STEPS.length) {
        console.log(`Then continue with: ${CYAN}node ${STEPS[i + 1].script}${RESET}`);
      }
      process.exit(0);
    }

    console.log(`\n${BOLD}── ${step.name} ──${RESET}\n`);

    const code = await runScript(step.script);
    if (code !== 0) {
      printFailure(step.name, step.script, code, step.hint);
      process.exit(1);
    }

    console.log(`\n${GREEN}\u2713 ${step.name} complete.${RESET}\n`);
  }

  // ── Success ─────────────────────────────────────────────────────────
  console.log('');
  console.log(`${GREEN}${'='.repeat(60)}${RESET}`);
  console.log(`${GREEN}    Phase 3 Complete — All steps passed \u2713${RESET}`);
  console.log(`${GREEN}${'='.repeat(60)}${RESET}`);
  console.log('');
  console.log('Deliverables:');
  console.log(`  ${GREEN}\u2713${RESET} Media manifest    -> migration/data/media/manifest.json`);
  console.log(`  ${GREEN}\u2713${RESET} Decoded files      -> migration/data/media/files/`);
  console.log(`  ${GREEN}\u2713${RESET} Media map          -> migration/data/maps/media.json`);
  console.log(`  ${GREEN}\u2713${RESET} Transformed articles -> migration/data/transformed/articles.json`);
  console.log(`  ${GREEN}\u2713${RESET} Transformed datasets -> migration/data/transformed/datasets.json`);
  console.log(`  ${GREEN}\u2713${RESET} Transformed apps     -> migration/data/transformed/apps.json`);
  console.log('');
  console.log('Next: Phase 4 (Content Loading)');
  console.log(`  ${CYAN}pnpm migrate:phase04${RESET}  (when implemented)`);
  console.log('');
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
