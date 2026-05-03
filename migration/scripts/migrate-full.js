/**
 * @module migrate-full
 * @description Run the full migration pipeline: preflight → phases 1-7 → postflight.
 *
 * Sequence:
 *   1. preflight         — verify environment (Node, deps, configs, Strapi reachability)
 *   2. migrate:phase01   — introspect source + generate Strapi 5 schemas + verify
 *   3. migrate:phase02   — extract content from Strapi 3 (GraphQL + SQLite fallback)
 *   4. migrate:phase03   — collect → download → upload media + rewrite richtext URLs
 *   5. migrate:phase04   — load records + link relations + restore timestamps + verify
 *      (interactive: prompts you to stop/restart Strapi 5 around the timestamp step)
 *   6. migrate:phase05   — 10 automated validation checks
 *   7. audit (phase06)   — field-by-field parity audit
 *   8. report (phase07)  — HTML + DOCX migration report
 *   9. postflight        — consolidated final summary
 *
 * Each phase is independently re-runnable. If a phase fails, fix the underlying
 * issue and re-run that phase or the orchestrator (idempotent skips kick in for
 * already-completed work).
 *
 * @example
 *   pnpm migrate:full
 *   pnpm migrate:full --start-from=phase04   # skip earlier phases
 *   pnpm migrate:full --skip=phase07         # skip the report step
 *   pnpm migrate:full --skip-preflight       # bypass the environment check
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Restrict default file/dir permissions to the running user only.
// Override with MIGRATION_DISABLE_UMASK=1 if a workflow needs the default.
if (process.env.MIGRATION_DISABLE_UMASK !== '1') {
  process.umask(0o077);
}

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const argv = process.argv.slice(2);
const SKIP_PREFLIGHT = argv.includes('--skip-preflight');
const SKIP_POSTFLIGHT = argv.includes('--skip-postflight');
const START_FROM = argv.find((a) => a.startsWith('--start-from='))?.slice('--start-from='.length);
const SKIP_LIST = argv
  .filter((a) => a.startsWith('--skip='))
  .map((a) => a.slice('--skip='.length));

const STAGES = [
  { id: 'preflight', label: 'Preflight environment check', script: 'migration/scripts/preflight.js' },
  { id: 'phase01', label: 'Phase 1 — Schema generation + verification', script: 'migration/scripts/01-run-phase.js' },
  { id: 'phase02', label: 'Phase 2 — Extract content from Strapi 3', script: 'migration/scripts/02-run-phase.js' },
  { id: 'phase03', label: 'Phase 3 — Media migration (download + upload + rewrite)', script: 'migration/scripts/03-run-phase.js' },
  { id: 'phase04', label: 'Phase 4 — Load records + link relations + restore timestamps', script: 'migration/scripts/04-run-phase.js', interactive: true },
  { id: 'phase05', label: 'Phase 5 — Validation (10 automated checks)', script: 'migration/scripts/05-validate.js' },
  { id: 'phase06', label: 'Phase 6 — Field-by-field parity audit', script: 'migration/scripts/06-audit.js' },
  { id: 'phase07', label: 'Phase 7 — Generate HTML + DOCX migration report', script: 'migration/scripts/07-generate-report.js' },
  { id: 'postflight', label: 'Postflight — final consolidated summary', script: 'migration/scripts/postflight.js' },
];

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

async function main() {
  console.log('');
  console.log(`${BOLD}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  ICJIA Public Website CMS Migration — Full pipeline           ║${RESET}`);
  console.log(`${BOLD}║  Strapi 3 (SQLite) → Strapi 5 (SQLite)                        ║${RESET}`);
  console.log(`${BOLD}╚═══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('This will run the complete migration pipeline.');
  console.log('Estimated time: ${BOLD}45-65 minutes${RESET} for a fresh end-to-end run.');
  console.log('');
  console.log(`${YELLOW}!${RESET} Phase 4 is interactive — it will prompt you twice (stop Strapi 5,`);
  console.log(`  then restart it) so it can write timestamps directly to the SQLite DB.`);
  console.log('');
  console.log(`${DIM}Stages:${RESET}`);
  for (const s of STAGES) {
    const skipped = SKIP_LIST.includes(s.id) || (SKIP_PREFLIGHT && s.id === 'preflight') || (SKIP_POSTFLIGHT && s.id === 'postflight');
    const startSkip = START_FROM && STAGES.findIndex((x) => x.id === s.id) < STAGES.findIndex((x) => x.id === START_FROM);
    const tag = skipped ? `${DIM}[skip]${RESET}` : startSkip ? `${DIM}[before start]${RESET}` : '      ';
    const interactive = s.interactive ? ` ${YELLOW}(interactive)${RESET}` : '';
    console.log(`  ${tag} ${s.label}${interactive}`);
  }
  console.log('');

  const startIdx = START_FROM ? STAGES.findIndex((s) => s.id === START_FROM) : 0;
  if (START_FROM && startIdx === -1) {
    console.error(`${RED}ERROR${RESET} unknown stage: --start-from=${START_FROM}`);
    process.exit(1);
  }

  const startTime = Date.now();
  const results = [];

  for (let i = startIdx; i < STAGES.length; i++) {
    const stage = STAGES[i];
    if (SKIP_LIST.includes(stage.id)) continue;
    if (SKIP_PREFLIGHT && stage.id === 'preflight') continue;
    if (SKIP_POSTFLIGHT && stage.id === 'postflight') continue;

    const stageStart = Date.now();
    console.log('');
    console.log(`${CYAN}════════════════════════════════════════════════════════════════${RESET}`);
    console.log(`${BOLD}${stage.label}${RESET}`);
    console.log(`${CYAN}════════════════════════════════════════════════════════════════${RESET}`);
    console.log('');

    const code = await runScript(stage.script);
    const elapsed = Date.now() - stageStart;
    results.push({ stage: stage.id, code, elapsedMs: elapsed });

    if (code !== 0) {
      console.log('');
      console.log(`${RED}${BOLD}${stage.label} FAILED (exit code ${code})${RESET}`);
      console.log('');
      console.log('Resume options:');
      console.log(`  Re-run from this stage: ${CYAN}pnpm migrate:full --start-from=${stage.id}${RESET}`);
      console.log(`  Re-run just this stage: ${CYAN}node ${stage.script}${RESET}`);
      console.log('');
      process.exit(code);
    }
  }

  const totalElapsed = Date.now() - startTime;
  const totalMin = (totalElapsed / 1000 / 60).toFixed(1);

  console.log('');
  console.log(`${GREEN}${BOLD}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}${BOLD}║  Migration pipeline complete                                  ║${RESET}`);
  console.log(`${GREEN}${BOLD}╚═══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${BOLD}Stages run:${RESET}`);
  for (const r of results) {
    const sec = (r.elapsedMs / 1000).toFixed(1);
    console.log(`  ${r.stage.padEnd(12)} ${GREEN}ok${RESET}  ${DIM}${sec}s${RESET}`);
  }
  console.log(`  ${BOLD}total:${RESET}       ${BOLD}${totalMin} minutes${RESET}`);
  console.log('');
  console.log(`${BOLD}Reports:${RESET}`);
  console.log(`  ${CYAN}migration/data/migration-report.html${RESET}     — open in browser`);
  console.log(`  ${CYAN}migration/data/migration-report.docx${RESET}     — share with stakeholders`);
  console.log(`  ${CYAN}migration/data/audit-report.md${RESET}           — human-readable parity details`);
  console.log(`  ${CYAN}migration/data/validation-report.json${RESET}    — machine-readable check results`);
  console.log('');
  console.log(`${GREEN}Strapi 5 admin:${RESET} http://localhost:1340/admin (or whatever port your install uses)`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
