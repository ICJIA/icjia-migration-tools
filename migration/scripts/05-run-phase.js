/**
 * @module 05-run-phase
 * @description Phase 5 orchestrator: runs all validation checks and reports results.
 *
 * Executes 05-validate.js with clear context about what validation does.
 * On success, prints a manual QA sign-off checklist.
 * On failure, prints which checks failed and how to investigate.
 *
 * @example
 *   pnpm migrate:phase05
 *   # or: node migration/scripts/05-run-phase.js
 *
 * Prerequisites:
 * - Phase 4 complete (all content loaded, relations linked, timestamps restored)
 * - Strapi 3 running (for comparison counts and content spot checks)
 * - Strapi 5 running (for REST API queries)
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
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
 * Print the manual QA sign-off checklist displayed after all automated checks pass.
 */
function printSignOffChecklist() {
  console.log(`${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}║     Phase 5 Complete — All automated checks passed ✓    ║${RESET}`);
  console.log(`${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${BOLD}Manual QA Sign-Off Checklist${RESET}`);
  console.log(`${DIM}Complete these items before switching the frontend to Strapi 5:${RESET}`);
  console.log('');
  console.log(`  ${CYAN}Frontend Smoke Test${RESET}`);
  console.log(`  [ ] Browse ResearchHub frontend pointed at Strapi 5 — homepage loads`);
  console.log(`  [ ] Open 5 articles with known splash images — hero images render`);
  console.log(`  [ ] Open 5 articles with known thumbnails — thumbnail images render`);
  console.log(`  [ ] Open 5 articles with known inline images — all inline images render`);
  console.log('');
  console.log(`  ${CYAN}Relations${RESET}`);
  console.log(`  [ ] Open 3 articles with known dataset relations — "Related Datasets" links work`);
  console.log(`  [ ] Open 3 articles with known app/dashboard relations — dashboard links work`);
  console.log(`  [ ] Check 3 app pages — app→dataset relations display correctly`);
  console.log('');
  console.log(`  ${CYAN}File Downloads${RESET}`);
  console.log(`  [ ] Open 3 articles with mainfile attachments — mainfile downloads work`);
  console.log(`  [ ] Open 3 articles with extrafile attachments — extrafile downloads work`);
  console.log(`  [ ] Download 3 dataset Excel files — files download and open correctly`);
  console.log('');
  console.log(`  ${CYAN}Apps & External Links${RESET}`);
  console.log(`  [ ] Check 3 app pages — app images render correctly`);
  console.log(`  [ ] Check 3 app/dashboard links — external Tableau/ShinyProxy URLs resolve`);
  console.log('');
  console.log(`  ${CYAN}Timestamps & Dates${RESET}`);
  console.log(`  [ ] Verify article publication dates display correctly (not migration date)`);
  console.log(`  [ ] Search for the oldest article — confirm date is historic`);
  console.log('');
  console.log(`  ${CYAN}Admin Panel${RESET}`);
  console.log(`  [ ] Browse Strapi 5 admin panel — can search, edit content without errors`);
  console.log('');
  console.log(`  ${CYAN}Deployment Readiness${RESET}`);
  console.log(`  [ ] Strapi 5 SQLite database backed up (cp data.db data.db.bak)`);
  console.log(`  [ ] Frontend configuration updated to point to Strapi 5 API`);
  console.log(`  [ ] Strapi 5 production environment configured (API tokens, CORS, uploads)`);
  console.log(`  [ ] Rollback plan documented`);
  console.log('');
  console.log(`${GREEN}${BOLD}Next: Run Phase 6 (Parity Audit)${RESET}`);
  console.log(`  ${CYAN}pnpm migrate:phase06${RESET}`);
  console.log('');
  console.log(`  Phase 6 does a field-by-field comparison of every record in Strapi 3`);
  console.log(`  vs Strapi 5 and produces a detailed audit report for stakeholder sign-off.`);
  console.log('');
  console.log(`${BOLD}After Phase 6:${RESET}`);
  console.log(`  1. Complete the manual QA checklist above`);
  console.log(`  2. Share the audit report (migration/data/audit-report.md) with stakeholders`);
  console.log(`  3. Back up the Strapi 5 database`);
  console.log(`  4. Update the frontend to point to Strapi 5`);
  console.log(`  5. Monitor for 2 weeks, then consider removing legacyId fields`);
  console.log('');
}

/**
 * Print failure investigation guidance.
 * @param {number} exitCode - The exit code from 05-validate.js
 */
function printFailureGuidance(exitCode) {
  console.log('');
  console.log(`${RED}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${RED}║     Phase 5 Validation FAILED (exit code ${exitCode})${' '.repeat(Math.max(0, 14 - String(exitCode).length))}║${RESET}`);
  console.log(`${RED}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${YELLOW}How to investigate:${RESET}`);
  console.log('');
  console.log(`  1. ${BOLD}Review the validation report:${RESET}`);
  console.log(`     ${CYAN}cat migration/data/validation-report.json | jq '.checks[] | select(.status != "PASS")'${RESET}`);
  console.log('');
  console.log(`  2. ${BOLD}Common fixes by check:${RESET}`);
  console.log(`     ${DIM}Record counts / Legacy ID:${RESET}   Re-run Phase 4 load (04-load.js)`);
  console.log(`     ${DIM}Base64 remnants:${RESET}             Re-run Phase 3 transform (03-transform.js), then Phase 4`);
  console.log(`     ${DIM}Media migration:${RESET}             Re-run Phase 4 media upload (04-upload-media.js)`);
  console.log(`     ${DIM}Media accessibility:${RESET}         Check Strapi 5 upload directory and permissions`);
  console.log(`     ${DIM}Relation integrity:${RESET}          Re-run Phase 4 relation linking (04-link-relations.js)`);
  console.log(`     ${DIM}Timestamp preservation:${RESET}      Re-run Phase 4 timestamp restore (04-restore-timestamps.js)`);
  console.log(`     ${DIM}Content integrity:${RESET}           Check transform logic in 03-transform.js`);
  console.log(`     ${DIM}Duplicates:${RESET}                  Check for duplicate legacyId in load script`);
  console.log('');
  console.log(`  3. ${BOLD}After fixing, re-run validation:${RESET}`);
  console.log(`     ${CYAN}pnpm validate${RESET}`);
  console.log('');
  console.log(`  ${YELLOW}The idempotent design (legacyId checks, media duplicate detection)${RESET}`);
  console.log(`  ${YELLOW}makes partial re-runs safe. You do not need to start from scratch.${RESET}`);
  console.log('');
}

async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║          Phase 5: Validation & Reconciliation           ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('This phase runs 10 automated checks to verify migration integrity:');
  console.log('');
  console.log(`  ${CYAN} 1.${RESET} Record counts — Strapi 3 vs Strapi 5 for all content types`);
  console.log(`  ${CYAN} 2.${RESET} Legacy ID coverage — every Strapi 3 ID maps to a Strapi 5 record`);
  console.log(`  ${CYAN} 3.${RESET} Zero Base64 remnants — no data:image/ strings in text fields`);
  console.log(`  ${CYAN} 4.${RESET} Image/media migration — splash, thumbnail, mainfile, extrafile, app image`);
  console.log(`  ${CYAN} 5.${RESET} Dataset file migration — datafile references intact`);
  console.log(`  ${CYAN} 6.${RESET} Media accessibility — every media URL returns HTTP 200`);
  console.log(`  ${CYAN} 7.${RESET} Relation integrity — article→dataset, app→article, app→dataset`);
  console.log(`  ${CYAN} 8.${RESET} Timestamp preservation — createdAt/updatedAt match originals`);
  console.log(`  ${CYAN} 9.${RESET} Content integrity — random 10% spot check of article content`);
  console.log(`  ${CYAN}10.${RESET} No duplicates — zero duplicate legacyId values`);
  console.log('');
  console.log(`${DIM}Requirements: Strapi 3 running, Strapi 5 running, all Phase 4 data in place.${RESET}`);
  console.log('');

  // ── Run Validation ────────────────────────────────────────────────
  console.log(`${BOLD}── Running Validation Checks ──${RESET}\n`);

  const exitCode = await runScript('migration/scripts/05-validate.js');

  if (exitCode === 0) {
    printSignOffChecklist();
  } else {
    printFailureGuidance(exitCode);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
