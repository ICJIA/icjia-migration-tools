/**
 * @module 03-run-phase
 * @description Phase 3 orchestrator: collect → download → upload → rewrite.
 *
 * Runs the four Phase 3 sub-scripts in order:
 *
 *   1. **03a-collect-media** — scan upload_file table + extracted JSONs;
 *      build uploadfile-manifest.json keyed by hash with reference info.
 *
 *   2. **03b-download-media** — fetch each file from agency.icjia-api.cloud
 *      to migration/data/media/files/. Idempotent.
 *
 *   3. **03c-upload-media** — re-upload each file to Strapi 5 /api/upload
 *      preserving metadata. Output: uploadfile-map.json (sourceHash → strapi5Id).
 *
 *   4. **03f-rewrite-content** — substitute UploadFile IDs in extracted records
 *      and rewrite richtext URLs. Output: migration/data/transformed/.
 *
 * Each sub-script is independently re-runnable. If a step fails, fix the
 * underlying issue and re-run just that script — or re-run the orchestrator
 * (idempotent skips kick in for already-completed work).
 *
 * @example
 *   pnpm migrate:phase03
 */

import { spawn } from 'child_process';
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

const STEPS = [
  {
    label: 'Phase 3a: Collect media references',
    script: 'migration/scripts/03a-collect-media.js',
    fixHint: 'Verify SQLite snapshot exists at docs/strapi-3-source/data.db and extracts in migration/data/raw/',
  },
  {
    label: 'Phase 3b: Download files from Strapi 3',
    script: 'migration/scripts/03b-download-media.js',
    fixHint: 'Check network access to agency.icjia-api.cloud. Re-run with --retry-failed to retry only failures.',
  },
  {
    label: 'Phase 3c: Upload files to Strapi 5',
    script: 'migration/scripts/03c-upload-media.js',
    fixHint: 'Ensure Strapi 5 is running and STRAPI5_TOKEN is set. Re-run to retry just the failures.',
  },
  {
    label: 'Phase 3f: Rewrite content (UploadFile IDs + richtext URLs)',
    script: 'migration/scripts/03f-rewrite-content.js',
    fixHint: 'If unmatched uploads were reported, re-run 03c first.',
  },
];

async function main() {
  console.log(`${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Phase 3: Media migration                                 ║${RESET}`);
  console.log(`${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`This phase migrates ~2,110 UploadFiles from Strapi 3 to Strapi 5:`);
  console.log(`  ${DIM}1.${RESET} Collect references (scan SQLite + extract JSONs)`);
  console.log(`  ${DIM}2.${RESET} Download files (~1-2 GB depending on what's already cached)`);
  console.log(`  ${DIM}3.${RESET} Re-upload to Strapi 5 with original metadata preserved`);
  console.log(`  ${DIM}4.${RESET} Rewrite UploadFile IDs + richtext URLs in extracted records`);
  console.log('');

  for (const [i, step] of STEPS.entries()) {
    console.log('');
    console.log(`${BOLD}── Step ${i + 1}/${STEPS.length}: ${step.label} ──${RESET}`);
    console.log('');
    const code = await runScript(step.script);
    if (code !== 0) {
      console.log('');
      console.log(`${RED}${BOLD}Step ${i + 1} FAILED (exit code ${code}).${RESET}`);
      console.log(`${YELLOW}Fix hint:${RESET} ${step.fixHint}`);
      console.log('');
      console.log(`Resume from this step:`);
      console.log(`  ${CYAN}node ${step.script}${RESET}`);
      console.log('');
      console.log(`Or re-run the full orchestrator (idempotent — completed steps are skipped):`);
      console.log(`  ${CYAN}pnpm migrate:phase03${RESET}`);
      console.log('');
      process.exit(code);
    }
  }

  console.log('');
  console.log(`${GREEN}${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}${BOLD}║  Phase 3 complete                                         ║${RESET}`);
  console.log(`${GREEN}${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('Outputs:');
  console.log(`  ${CYAN}migration/data/media/uploadfile-manifest.json${RESET}  — collected references`);
  console.log(`  ${CYAN}migration/data/media/files/${RESET}                       — downloaded files`);
  console.log(`  ${CYAN}migration/data/maps/uploadfile-map.json${RESET}         — sourceHash → strapi5Id`);
  console.log(`  ${CYAN}migration/data/transformed/<plural>.json${RESET}        — records with new IDs + URLs`);
  console.log('');
  console.log('Next: Phase 4 (Load content into Strapi 5)');
  console.log(`  ${CYAN}pnpm migrate:phase04${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
