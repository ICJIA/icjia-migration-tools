/**
 * @module migrate-full
 * @description Prints the complete migration runbook with copy-paste commands.
 *
 * Rather than trying to automate interactive prompts and SSH steps, this
 * script prints a clear, numbered checklist of every command needed to
 * run a full migration. Each phase is a separate command so you can
 * monitor progress and handle any issues as they arise.
 *
 * IMPORTANT: Every phase is idempotent (safe to re-run). If a phase fails due
 * to a timeout, network glitch, or any transient error, you do NOT need to
 * start over from scratch. Just re-run the failed command. Each phase uses
 * legacyId lookups to detect already-processed records and skips them. Only
 * unfinished work will be retried. No data will be duplicated.
 *
 * @example
 *   pnpm migrate:full
 */

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('');
console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║   Full Migration Runbook: Strapi 3 → Strapi 5           ║${RESET}`);
console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
console.log('');
console.log(`${GREEN}${BOLD}SAFE TO RE-RUN:${RESET} Every phase is idempotent. If any step fails`);
console.log(`(timeout, network glitch, etc.), just re-run that command.`);
console.log(`It will pick up where it left off. No data will be duplicated.`);
console.log('');

// Pre-flight status
const hasToken = !!config.strapi5.token;
console.log(`${BOLD}── Current Configuration ──${RESET}`);
console.log(`  Strapi 3: ${config.strapi3.apiUrl}`);
console.log(`  Strapi 5: ${config.strapi5.apiUrl}`);
console.log(`  Token:    ${hasToken ? GREEN + '(set)' + RESET : RED + 'NOT SET' + RESET}`);
console.log('');

if (!hasToken) {
  console.log(`${RED}${BOLD}⚠  STRAPI5_TOKEN is not set. You must set it before running phases 2+.${RESET}`);
  console.log(`   Create a Full Access token in Strapi 5 admin → Settings → API Tokens`);
  console.log(`   Then run: ${CYAN}export STRAPI5_TOKEN="<paste-your-token>"${RESET}`);
  console.log('');
}

console.log(`${BOLD}── Run these commands in order ──${RESET}`);
console.log('');
console.log(`${CYAN}# Phase 2: Extract all content from Strapi 3${RESET}`);
console.log(`pnpm migrate:phase02`);
console.log('');
console.log(`${CYAN}# Phase 3: Process media (scan, decode, upload, rewrite content)${RESET}`);
console.log(`pnpm migrate:phase03`);
console.log('');
console.log(`${CYAN}# Phase 4: Load data, link relations, fix timestamps (SSH), fix image refs${RESET}`);
console.log(`pnpm migrate:phase04`);
console.log('');
console.log(`${CYAN}# Phase 5: Validate migration (10 automated checks)${RESET}`);
console.log(`pnpm migrate:phase05`);
console.log('');
console.log(`${CYAN}# Phase 6: Parity audit (field-by-field comparison of every record)${RESET}`);
console.log(`pnpm migrate:phase06`);
console.log('');
console.log(`${CYAN}# Phase 7: Generate HTML + DOCX reports for stakeholder sign-off${RESET}`);
console.log(`pnpm report`);
console.log('');
console.log(`${DIM}─────────────────────────────────────────────────────────${RESET}`);
console.log('');
console.log(`${BOLD}── One-liner (copy-paste all at once) ──${RESET}`);
console.log('');
console.log(`${CYAN}pnpm migrate:phase02 && pnpm migrate:phase03 && pnpm migrate:phase04 && pnpm migrate:phase05 && pnpm migrate:phase06 && pnpm report${RESET}`);
console.log('');
console.log(`${BOLD}── After migration completes ──${RESET}`);
console.log('');
console.log(`  1. Open ${CYAN}migration/data/migration-report.html${RESET} in a browser to review`);
console.log(`  2. Send ${CYAN}migration/data/migration-report.docx${RESET} to your manager`);
console.log(`  3. Complete the manual QA checklist in the report`);
console.log(`  4. Update the frontend to point to ${CYAN}${config.strapi5.apiUrl}${RESET}`);
console.log('');
