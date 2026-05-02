/**
 * @module 04-run-phase
 * @description Phase 4 orchestrator: load → link relations → fix timestamps → verify.
 *
 * Steps:
 *   1. **04-load** — POST every record into Strapi 5 (relations stripped).
 *   2. **04b-link-relations** — link 19 dominant m2m + 1 m2o via PUT connect.
 *   3. **04c-fix-timestamps** — restore original created_at/updated_at via direct
 *      SQLite UPDATE. **Strapi 5 must be stopped** during this step.
 *   4. **04-verify** — cross-check S5 record counts against SQLite source.
 *
 * Each sub-step is independently re-runnable. The fix-timestamps step is
 * paused with a prompt so the user can stop Strapi 5 first.
 *
 * @example
 *   pnpm migrate:phase04
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function runScript(scriptPath, args = []) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath, ...args], { cwd: ROOT, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`${RED}Failed to start ${scriptPath}: ${err.message}${RESET}`);
      resolve(1);
    });
  });
}

// Non-interactive when --yes/-y is passed, CI=true is set, or stdin isn't a
// TTY (script piped, run in the background, etc.). Phase 4's prompts gate
// physical actions (stopping/restarting Strapi 5), so non-interactive answers
// are chosen carefully: timestamp prompt → "skip" (don't run a SQLite UPDATE
// while Strapi 5 might still hold the file lock), verify prompt → "yes"
// (Strapi 5 should still be running since we never asked the user to stop it).
const NON_INTERACTIVE =
  process.argv.includes('--yes') ||
  process.argv.includes('-y') ||
  process.env.CI === 'true' ||
  !process.stdin.isTTY;

function promptUser(question, autoAnswer) {
  if (NON_INTERACTIVE) {
    process.stdout.write(`${question}${YELLOW}[auto: ${autoAnswer}]${RESET}\n`);
    return Promise.resolve(autoAnswer);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

const STEPS = [
  {
    label: 'Phase 4 step 1: Load records',
    script: 'migration/scripts/04-load.js',
    fixHint: 'Ensure Strapi 5 is running and STRAPI5_TOKEN is set.',
  },
  {
    label: 'Phase 4 step 2: Link relations',
    script: 'migration/scripts/04b-link-relations.js',
    fixHint: 'Check that all referenced source IDs were loaded. Re-run 04-load for any failed types first.',
  },
  {
    label: 'Phase 4 step 2.5: Publish (sync draft → published for non-drafts)',
    script: 'migration/scripts/04b2-publish.js',
    fixHint: 'Re-run; idempotent. Most likely cause is a Strapi 5 outage mid-run.',
  },
  {
    label: 'Phase 4 step 3: Restore timestamps',
    script: 'migration/scripts/04c-fix-timestamps.js',
    requiresStrapi5Stopped: true,
    fixHint: 'Strapi 5 must be STOPPED for direct SQLite UPDATE. Stop it (Ctrl+C) and re-run.',
  },
  {
    label: 'Phase 4 verify',
    script: 'migration/scripts/04-verify.js',
    requiresStrapi5Running: true,
    fixHint: 'Restart Strapi 5 (pnpm develop) and re-run.',
  },
];

async function main() {
  console.log(`${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Phase 4: Load content into Strapi 5                      ║${RESET}`);
  console.log(`${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('This phase loads all records, links m2m/m2o relations, and restores');
  console.log('original timestamps to match the Strapi 3 source.');
  console.log('');

  for (const [i, step] of STEPS.entries()) {
    console.log('');
    console.log(`${BOLD}── Step ${i + 1}/${STEPS.length}: ${step.label} ──${RESET}`);
    console.log('');

    if (step.requiresStrapi5Stopped) {
      console.log(`${YELLOW}!${RESET} This step requires Strapi 5 to be ${BOLD}STOPPED${RESET} so it can write directly to its SQLite DB.`);
      console.log(`  In your Strapi 5 terminal: press ${CYAN}Ctrl+C${RESET} to stop it.`);
      console.log('');
      const answer = await promptUser('  Type "yes" once Strapi 5 is stopped (or "skip" to skip timestamp restoration): ', 'skip');
      if (answer === 'skip' || answer === 's') {
        console.log(`  ${YELLOW}Skipping timestamp restoration.${RESET} Timestamps will reflect the migration date.`);
        continue;
      }
      if (answer !== 'yes' && answer !== 'y') {
        console.log(`${RED}Aborting Phase 4.${RESET} Re-run when ready.`);
        process.exit(1);
      }
    }

    if (step.requiresStrapi5Running) {
      console.log(`${YELLOW}!${RESET} This step requires Strapi 5 to be ${BOLD}RUNNING${RESET} again.`);
      console.log(`  In your Strapi 5 terminal: ${CYAN}pnpm develop${RESET}`);
      console.log('');
      const answer = await promptUser('  Type "yes" once Strapi 5 is back up: ', 'yes');
      if (answer !== 'yes' && answer !== 'y') {
        console.log(`${RED}Aborting Phase 4.${RESET} Re-run when ready.`);
        process.exit(1);
      }
    }

    const code = await runScript(step.script);
    if (code !== 0) {
      console.log('');
      console.log(`${RED}${BOLD}Step ${i + 1} FAILED (exit code ${code}).${RESET}`);
      console.log(`${YELLOW}Fix hint:${RESET} ${step.fixHint}`);
      console.log('');
      console.log(`Resume from this step:`);
      console.log(`  ${CYAN}node ${step.script}${RESET}`);
      console.log('');
      process.exit(code);
    }
  }

  console.log('');
  console.log(`${GREEN}${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}${BOLD}║  Phase 4 complete                                         ║${RESET}`);
  console.log(`${GREEN}${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('Next: Phase 5 (Validation — 10 automated checks)');
  console.log(`  ${CYAN}pnpm migrate:phase05${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
