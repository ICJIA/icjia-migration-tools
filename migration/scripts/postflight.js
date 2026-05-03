/**
 * @module postflight
 * @description Post-migration parity check + final stats.
 *
 * Symmetric counterpart to `pnpm preflight`. Runs after Phase 4 (load) is
 * complete and verifies the migration is fully correct, with a single
 * consolidated report.
 *
 * Sequence:
 *   1. preflight  — verify environment is still valid (Strapi 5 still running, etc.)
 *   2. validate   — 10 automated pass/fail checks (Phase 5)
 *   3. audit      — field-by-field parity (Phase 6)
 *   4. report     — generate HTML + DOCX migration reports (Phase 7)
 *   5. summary    — aggregate stats from all of the above into one final readout
 *
 * Exits 0 only if every check passes and the audit has zero ERROR-category diffs.
 * Designed to be the single command run for migration sign-off.
 *
 * @example
 *   pnpm postflight              # Run everything end-to-end
 *   pnpm postflight --skip-report # Skip Phase 7 report generation (faster)
 *   pnpm postflight --json        # Emit JSON-only output (for CI / scripting)
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const argv = new Set(process.argv.slice(2));
const SKIP_REPORT = argv.has('--skip-report');
const JSON_OUTPUT = argv.has('--json');

function log(...args) {
  if (!JSON_OUTPUT) console.log(...args);
}

/**
 * Run a script as a child process and return the exit code + duration.
 */
function runScript(scriptRelPath, scriptArgs = []) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('node', [path.resolve(ROOT, scriptRelPath), ...scriptArgs], {
      stdio: JSON_OUTPUT ? 'ignore' : 'inherit',
      cwd: ROOT,
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, durationMs: Date.now() - start });
    });
  });
}

async function loadJsonIfExists(relPath) {
  const fullPath = path.resolve(ROOT, relPath);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(await fs.readFile(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remainder = (sec - min * 60).toFixed(0);
  return `${min}m ${remainder}s`;
}

async function getRecordCounts(config) {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = path.resolve(ROOT, config.strapi3.sqliteDbPath);
  if (!existsSync(dbPath)) return null;

  const manifest = await loadJsonIfExists(config.paths.contentTypesManifest);
  if (!manifest) return null;

  const db = new Database(dbPath, { readonly: true });
  const counts = {};

  for (const ct of manifest.contentTypes) {
    if (ct.skipDefault) continue;
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${ct.sqlTable}`).get();
      const draftRow = ct.hasDrafts
        ? db.prepare(`SELECT COUNT(*) AS n FROM ${ct.sqlTable} WHERE published_at IS NULL`).get()
        : { n: 0 };
      counts[ct.name] = { total: row.n, drafts: draftRow.n };
    } catch (err) {
      counts[ct.name] = { error: err.message };
    }
  }

  // Upload files
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM upload_file`).get();
    counts._upload_file = { total: row.n };
  } catch {}

  db.close();
  return counts;
}

async function main() {
  const overallStart = Date.now();
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    log(`${RED}Cannot load config: ${err.message}${RESET}`);
    process.exit(1);
  }

  if (!JSON_OUTPUT) {
    log('');
    log(`${BOLD}ICJIA Public Website Migration — Post-flight Parity Check${RESET}`);
    log(DIM + 'Validates the migration end-to-end and produces final sign-off stats.' + RESET);
    log('');
  }

  const stages = [];

  // ── Stage 1: preflight ────────────────────────────────────────────
  log(`${BOLD}── Stage 1/4: Preflight (environment sanity check) ──${RESET}`);
  log('');
  const preflight = await runScript('migration/scripts/preflight.js');
  stages.push({ name: 'preflight', ...preflight });
  if (preflight.code !== 0) {
    log('');
    log(`${RED}${BOLD}Preflight FAILED.${RESET} The environment is not ready — fix preflight failures first.`);
    log(`Then re-run: ${CYAN}pnpm postflight${RESET}`);
    process.exit(1);
  }
  log('');

  // ── Stage 2: validate ─────────────────────────────────────────────
  log(`${BOLD}── Stage 2/4: Validate (10 automated checks — Phase 5) ──${RESET}`);
  log('');
  const validate = await runScript('migration/scripts/05-validate.js');
  stages.push({ name: 'validate', ...validate });
  if (validate.code !== 0) {
    log('');
    log(`${RED}${BOLD}Validation FAILED.${RESET} Review the output above and ${CYAN}migration/data/validation-report.json${RESET}.`);
    log(`Fix the underlying issues and re-run: ${CYAN}pnpm postflight${RESET}`);
    process.exit(1);
  }
  log('');

  // ── Stage 3: audit ────────────────────────────────────────────────
  log(`${BOLD}── Stage 3/4: Audit (field-by-field parity — Phase 6) ──${RESET}`);
  log('');
  const audit = await runScript('migration/scripts/06-audit.js');
  stages.push({ name: 'audit', ...audit });
  if (audit.code !== 0) {
    log('');
    log(`${RED}${BOLD}Audit found ERROR-category diffs.${RESET} Review ${CYAN}migration/data/audit-report.md${RESET}.`);
    log(`Fix the underlying issues and re-run: ${CYAN}pnpm postflight${RESET}`);
    process.exit(1);
  }
  log('');

  // ── Stage 4: report ──────────────────────────────────────────────
  if (!SKIP_REPORT) {
    log(`${BOLD}── Stage 4/4: Report (HTML + DOCX — Phase 7) ──${RESET}`);
    log('');
    const reportScriptPath = 'migration/scripts/07-generate-report.js';
    if (existsSync(path.resolve(ROOT, reportScriptPath))) {
      const report = await runScript(reportScriptPath);
      stages.push({ name: 'report', ...report });
      if (report.code !== 0) {
        log('');
        log(`${YELLOW}Report generation failed (non-blocking).${RESET} Validation + audit succeeded.`);
      }
    } else {
      log(`${YELLOW}Report generator not yet implemented (07-generate-report.js).${RESET}`);
      log(`${DIM}Skipping. Phase 7 will be added in a later iteration.${RESET}`);
      stages.push({ name: 'report', code: -1, durationMs: 0, skipped: true });
    }
    log('');
  } else {
    stages.push({ name: 'report', code: 0, durationMs: 0, skipped: true });
  }

  // ── Stage 5: source-drafts checklist ─────────────────────────────
  // Read-only sweep over the Strapi 3 SQLite snapshot to list every record
  // that was a draft in source. With preserveSourceDrafts: false (default),
  // these were all loaded as Published in Strapi 5; this report tells the
  // editor exactly which ones to flip back to draft if desired.
  log(`${BOLD}── Stage 5/5: Source-drafts checklist ──${RESET}`);
  log('');
  const draftsScriptPath = 'migration/scripts/check-source-drafts.js';
  if (existsSync(path.resolve(ROOT, draftsScriptPath))) {
    const drafts = await runScript(draftsScriptPath);
    stages.push({ name: 'source-drafts', ...drafts });
    if (drafts.code !== 0) {
      log('');
      log(`${YELLOW}Source-drafts report failed (non-blocking).${RESET}`);
    }
  } else {
    stages.push({ name: 'source-drafts', code: -1, durationMs: 0, skipped: true });
  }
  log('');

  // ── Aggregate stats ──────────────────────────────────────────────
  const validationReport = await loadJsonIfExists('migration/data/validation-report.json');
  const auditReport = await loadJsonIfExists('migration/data/audit-report.json');
  const sourceCounts = await getRecordCounts(config);

  // ── Final summary ────────────────────────────────────────────────
  const overallDurationMs = Date.now() - overallStart;

  const summary = {
    verdict: 'COMPLETE',
    durationMs: overallDurationMs,
    stages: stages.map((s) => ({
      name: s.name,
      passed: s.code === 0 || s.skipped,
      durationMs: s.durationMs,
      skipped: s.skipped || false,
    })),
    sourceCounts,
    validation: validationReport ? {
      checksPassed: validationReport.checksPassed,
      checksFailed: validationReport.checksFailed,
      checksTotal: validationReport.checksRun,
    } : null,
    audit: auditReport ? {
      records: auditReport.summary?.totalRecordsCompared ?? null,
      fields: auditReport.summary?.totalFieldsCompared ?? null,
      categories: auditReport.summary?.findings ?? null,
      cleanRecords: auditReport.summary?.cleanRecords ?? null,
      recordsWithFindings: auditReport.summary?.recordsWithFindings ?? null,
    } : null,
    reports: {
      validation: existsSync(path.resolve(ROOT, 'migration/data/validation-report.json'))
        ? 'migration/data/validation-report.json' : null,
      auditJson: existsSync(path.resolve(ROOT, 'migration/data/audit-report.json'))
        ? 'migration/data/audit-report.json' : null,
      auditMd: existsSync(path.resolve(ROOT, 'migration/data/audit-report.md'))
        ? 'migration/data/audit-report.md' : null,
      html: existsSync(path.resolve(ROOT, 'migration/data/migration-report.html'))
        ? 'migration/data/migration-report.html' : null,
      docx: existsSync(path.resolve(ROOT, 'migration/data/migration-report.docx'))
        ? 'migration/data/migration-report.docx' : null,
      sourceDraftsMd: existsSync(path.resolve(ROOT, 'migration/data/source-drafts.md'))
        ? 'migration/data/source-drafts.md' : null,
      sourceDraftsJson: existsSync(path.resolve(ROOT, 'migration/data/source-drafts.json'))
        ? 'migration/data/source-drafts.json' : null,
    },
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  // Pretty summary
  log('');
  log(`${GREEN}${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}`);
  log(`${GREEN}${BOLD}║                MIGRATION COMPLETE                         ║${RESET}`);
  log(`${GREEN}${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}`);
  log('');

  // Stage timings
  log(`${BOLD}Stage timings:${RESET}`);
  for (const s of stages) {
    const status = s.skipped ? `${DIM}skipped${RESET}` : s.code === 0 ? `${GREEN}ok${RESET}` : `${RED}fail${RESET}`;
    log(`  ${s.name.padEnd(12)} ${status.padEnd(20)} ${DIM}${formatDuration(s.durationMs)}${RESET}`);
  }
  log(`  ${BOLD}total       ${RESET}${BOLD}${formatDuration(overallDurationMs).padEnd(8)}${RESET}`);
  log('');

  // Validation summary
  if (validationReport) {
    log(`${BOLD}Validation (Phase 5):${RESET}`);
    log(`  ${GREEN}${validationReport.checksPassed}/${validationReport.checksRun}${RESET} checks passed`);
    if (validationReport.checksFailed > 0) {
      log(`  ${RED}${validationReport.checksFailed}${RESET} failed`);
    }
    log('');
  }

  // Audit summary
  if (auditReport && auditReport.summary) {
    const f = auditReport.summary.findings || {};
    log(`${BOLD}Parity audit (Phase 6):${RESET}`);
    if (auditReport.summary.totalRecordsCompared) {
      log(`  Records compared:  ${formatNumber(auditReport.summary.totalRecordsCompared)}`);
    }
    if (auditReport.summary.totalFieldsCompared) {
      log(`  Fields compared:   ${formatNumber(auditReport.summary.totalFieldsCompared)}`);
    }
    if (auditReport.summary.cleanRecords !== undefined) {
      log(`  Clean records:     ${formatNumber(auditReport.summary.cleanRecords)}`);
    }
    log(`  ${GREEN}OK:${RESET}       ${formatNumber(f.OK || 0)}`);
    log(`  ${CYAN}EXPECTED:${RESET} ${formatNumber(f.EXPECTED || 0)}`);
    log(`  ${YELLOW}INFO:${RESET}     ${formatNumber(f.INFO || 0)}`);
    log(`  ${f.ERROR > 0 ? RED : DIM}ERROR:${RESET}    ${formatNumber(f.ERROR || 0)}${f.ERROR === 0 ? `  ${GREEN}(perfect parity)${RESET}` : ''}`);
    log('');
  }

  // Source data counts (so dev can eyeball type-by-type)
  if (sourceCounts) {
    log(`${BOLD}Source record counts (per type):${RESET}`);
    const entries = Object.entries(sourceCounts).filter(([k]) => !k.startsWith('_'));
    entries.sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
    for (const [name, c] of entries) {
      if (c.error) {
        log(`  ${name.padEnd(16)} ${RED}error: ${c.error}${RESET}`);
      } else {
        const draftSuffix = c.drafts > 0 ? ` ${DIM}(${c.drafts} drafts)${RESET}` : '';
        log(`  ${name.padEnd(16)} ${formatNumber(c.total).padStart(6)}${draftSuffix}`);
      }
    }
    if (sourceCounts._upload_file) {
      log(`  ${'upload_file'.padEnd(16)} ${formatNumber(sourceCounts._upload_file.total).padStart(6)}`);
    }
    log('');
  }

  // Reports produced
  log(`${BOLD}Reports produced:${RESET}`);
  for (const [label, p] of Object.entries(summary.reports)) {
    if (p) log(`  ${CYAN}${p}${RESET}`);
  }
  log('');

  // Sign-off
  log(`${GREEN}${BOLD}Sign-off ready.${RESET} Every record, every field, every relation, every media file:`);
  log(`${GREEN}all accounted for. The migration is complete.${RESET}`);
  log('');
  log(`${BOLD}Next steps:${RESET}`);
  log(`  1. Review ${CYAN}migration/data/audit-report.md${RESET} with stakeholders.`);
  if (summary.reports.sourceDraftsMd) {
    log(`  2. (If you want to keep source drafts as drafts) Use ${CYAN}migration/data/source-drafts.md${RESET}`);
    log(`     as a checklist — flip those records to "Draft" status in the Strapi 5 admin.`);
    log(`  3. Archive the HTML/DOCX reports as cutover documentation.`);
    log(`  4. Cut the frontend over to the new Strapi 5 endpoint.`);
    log(`  5. (Optional) Schedule v1.1 cleanup — see docs/icjia-public-website-migration-plan.md`);
  } else {
    log(`  2. Archive the HTML/DOCX reports as cutover documentation.`);
    log(`  3. Cut the frontend over to the new Strapi 5 endpoint.`);
    log(`  4. (Optional) Schedule v1.1 cleanup — see docs/icjia-public-website-migration-plan.md`);
  }
  log('');

  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
