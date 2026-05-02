/**
 * @module 06-run-phase
 * @description Phase 6 orchestrator: runs the comprehensive parity audit.
 *
 * This phase goes beyond Phase 5 (pass/fail validation) by performing a
 * detailed field-by-field comparison of EVERY record in Strapi 3 vs Strapi 5.
 * Every difference is categorized as ERROR, EXPECTED, INFO, or OK.
 *
 * **How it differs from Phase 5:**
 * - Phase 5 runs 10 high-level checks (counts, coverage, spot checks)
 * - Phase 6 compares EVERY field of EVERY record, producing a complete audit trail
 * - Phase 5 is pass/fail; Phase 6 categorizes differences (errors vs expected changes)
 * - Phase 6 produces a detailed per-record report suitable for sign-off documentation
 *
 * Executes:
 * - Connectivity checks for both Strapi 3 and Strapi 5
 * - `06-audit.js` — the comprehensive parity audit
 *
 * On success: prints location of both reports and summary
 * On failure: prints which records had ERRORs and how to investigate
 *
 * @example
 *   pnpm migrate:phase06
 *   # or: node migration/scripts/06-run-phase.js
 *
 * Prerequisites:
 * - Phase 4 complete (all content loaded, relations linked, timestamps restored)
 * - Phase 5 passed (basic validation — recommended but not required)
 * - Strapi 3 running (for live GraphQL comparison)
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

// ── Config ───────────────────────────────────────────────────────────

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Run a script as a child process, streaming its stdout/stderr to the console.
 * @param {string} scriptPath - Path relative to project root
 * @returns {Promise<number>} Exit code (0 for success, non-zero for failure)
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
 * Check connectivity to Strapi 3 by sending a simple GraphQL introspection query.
 * @returns {Promise<boolean>} True if Strapi 3 is reachable
 */
async function checkStrapi3() {
  const url = config.strapi3.graphqlUrl;
  const headers = { 'Content-Type': 'application/json' };
  if (config.strapi3.token) {
    headers['Authorization'] = `Bearer ${config.strapi3.token}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 10000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return !!json.data;
  } catch {
    return false;
  }
}

/**
 * Check connectivity to Strapi 5 by fetching a minimal REST endpoint.
 * @returns {Promise<boolean>} True if Strapi 5 is reachable
 */
async function checkStrapi5() {
  const url = `${config.strapi5.apiUrl}/api/articles?pagination[pageSize]=1`;
  const headers = {};
  if (config.strapi5.token) {
    headers['Authorization'] = `Bearer ${config.strapi5.token}`;
  }

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Print success output with report locations and a summary of next steps.
 */
function printSuccess() {
  console.log(`${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}║     Phase 6 Complete — Parity Audit Passed              ║${RESET}`);
  console.log(`${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${BOLD}Reports generated:${RESET}`);
  console.log(`  ${CYAN}JSON:${RESET}     migration/data/audit-report.json`);
  console.log(`  ${CYAN}Markdown:${RESET} migration/data/audit-report.md`);
  console.log('');
  console.log(`${BOLD}What this means:${RESET}`);
  console.log(`  Every field of every record has been compared between Strapi 3 and Strapi 5.`);
  console.log(`  All differences are accounted for as expected migration changes (Base64 → media,`);
  console.log(`  upload → media relations, inline image extraction, etc).`);
  console.log('');
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log(`  1. Generate shareable HTML + DOCX reports: ${CYAN}pnpm report${RESET}`);
  console.log(`  2. Review the markdown report for a human-readable summary`);
  console.log(`  3. Archive reports as migration sign-off documentation`);
  console.log(`  4. Proceed with frontend cutover to Strapi 5`);
  console.log('');
}

/**
 * Print failure output with guidance on investigating ERRORs.
 * @param {number} exitCode - The exit code from 06-audit.js
 */
function printFailure(exitCode) {
  console.log('');
  console.log(`${RED}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${RED}║     Phase 6 Parity Audit FAILED (exit code ${exitCode})${' '.repeat(Math.max(0, 12 - String(exitCode).length))}║${RESET}`);
  console.log(`${RED}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${YELLOW}How to investigate:${RESET}`);
  console.log('');
  console.log(`  1. ${BOLD}Review the audit report for ERROR findings:${RESET}`);
  console.log(`     ${CYAN}cat migration/data/audit-report.json | jq '.records.articles[] | select(.findings[] | .category == "ERROR")'${RESET}`);
  console.log(`     ${CYAN}cat migration/data/audit-report.json | jq '.records.datasets[] | select(.findings[] | .category == "ERROR")'${RESET}`);
  console.log(`     ${CYAN}cat migration/data/audit-report.json | jq '.records.apps[] | select(.findings[] | .category == "ERROR")'${RESET}`);
  console.log('');
  console.log(`  2. ${BOLD}Read the markdown report for a summary:${RESET}`);
  console.log(`     ${CYAN}cat migration/data/audit-report.md${RESET}`);
  console.log('');
  console.log(`  3. ${BOLD}Common ERROR causes:${RESET}`);
  console.log(`     ${DIM}Scalar field mismatch:${RESET}     Transform logic may have altered the value (check 03e-transform.js)`);
  console.log(`     ${DIM}Markdown text differs:${RESET}     Non-image content was modified during transform`);
  console.log(`     ${DIM}JSON field mismatch:${RESET}       JSON array/object serialization difference`);
  console.log(`     ${DIM}Media missing in S5:${RESET}       Media upload failed for specific record (re-run 03c-upload-media.js)`);
  console.log(`     ${DIM}Relation mismatch:${RESET}         Relation linking missed a record (re-run 04b-link-relations.js)`);
  console.log(`     ${DIM}Timestamp mismatch:${RESET}        Timestamp restoration missed a record (re-run 04c-fix-timestamps.js)`);
  console.log(`     ${DIM}Missing S5 record:${RESET}         Load failed for a record (re-run 04-load.js)`);
  console.log('');
  console.log(`  4. ${BOLD}After fixing, re-run the audit:${RESET}`);
  console.log(`     ${CYAN}pnpm audit${RESET}`);
  console.log('');
  console.log(`  ${YELLOW}The idempotent design (legacyId checks, media duplicate detection)${RESET}`);
  console.log(`  ${YELLOW}makes partial re-runs safe. You do not need to start from scratch.${RESET}`);
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Main entry point: explains the audit, checks connectivity, runs the audit script,
 * and reports results.
 */
async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║            Phase 6: Parity Audit                        ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('This phase performs a comprehensive field-by-field comparison of every');
  console.log('record in Strapi 3 vs Strapi 5. Unlike Phase 5 (pass/fail validation),');
  console.log('Phase 6 categorizes every difference:');
  console.log('');
  console.log(`  ${RED}ERROR${RESET}    — Unexpected discrepancy that needs investigation`);
  console.log(`  ${YELLOW}EXPECTED${RESET} — Known change from migration (Base64 → media, etc.)`);
  console.log(`  ${CYAN}INFO${RESET}     — System-level or inconsequential difference`);
  console.log(`  ${GREEN}OK${RESET}       — Fields match exactly`);
  console.log('');
  console.log('The audit covers:');
  console.log(`  ${CYAN}1.${RESET} Schema comparison — field names and types between S3 and S5`);
  console.log(`  ${CYAN}2.${RESET} Record comparison — every field of every record (scalar, JSON, markdown, media, relations, timestamps)`);
  console.log(`  ${CYAN}3.${RESET} Media audit — accessibility, Base64 conversion counts`);
  console.log('');
  console.log(`${DIM}Requirements: Strapi 3 running, Strapi 5 running, Phase 4 complete.${RESET}`);
  console.log('');

  // ── Connectivity Checks ────────────────────────────────────────────

  console.log(`${BOLD}── Checking connectivity ──${RESET}\n`);

  process.stdout.write('  Strapi 3 (GraphQL)... ');
  const s3Ok = await checkStrapi3();
  if (s3Ok) {
    console.log(`${GREEN}reachable${RESET}`);
  } else {
    console.log(`${RED}UNREACHABLE${RESET}`);
    console.error(`\n${RED}Cannot connect to Strapi 3 at ${config.strapi3.graphqlUrl}${RESET}`);
    console.error(`${RED}Phase 6 requires a running Strapi 3 instance for live comparison.${RESET}`);
    process.exit(1);
  }

  process.stdout.write('  Strapi 5 (REST)...    ');
  const s5Ok = await checkStrapi5();
  if (s5Ok) {
    console.log(`${GREEN}reachable${RESET}`);
  } else {
    console.log(`${RED}UNREACHABLE${RESET}`);
    console.error(`\n${RED}Cannot connect to Strapi 5 at ${config.strapi5.apiUrl}${RESET}`);
    console.error(`${RED}Phase 6 requires a running Strapi 5 instance for live comparison.${RESET}`);
    process.exit(1);
  }

  console.log('');

  // ── Run Audit ──────────────────────────────────────────────────────

  console.log(`${BOLD}── Running Parity Audit ──${RESET}\n`);

  const exitCode = await runScript('migration/scripts/06-audit.js');

  if (exitCode === 0) {
    printSuccess();
  } else {
    printFailure(exitCode);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
