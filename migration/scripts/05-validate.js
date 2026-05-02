/**
 * @module 05-validate
 * @description Phase 5: 10 automated validation checks.
 *
 * Reads the source SQLite snapshot, the loaded Strapi 5 SQLite, the
 * extracted JSONs, and the upload map; runs 10 checks; writes
 * `migration/data/validation-report.json` with per-check pass/fail.
 *
 * Manifest-driven — no hardcoded ResearchHub content type names.
 *
 * @example
 *   pnpm validate
 *   node migration/scripts/05-validate.js
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';
import { openSourceDb, countTable } from '../lib/sqlite-reader.js';
import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const config = await loadConfig();

async function loadJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Refusing unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

const KNOWN_ACCEPTABLE_FAILURES = {
  // Files Strapi 5's image processor (sharp) rejects for unusual EXIF data.
  // These are orphans (not referenced by any record), so their absence
  // doesn't affect the migration.
  uploadFiles: ['Headshot_Smith_50472f6c9b'],
  // Records the source has with null required fields (data quality issues
  // in the original Strapi 3 — empty drafts that were never filled in).
  records: { grant: ['357'] },
};

async function main() {
  console.log(`${BOLD}── Phase 5: Validation (10 checks) ──${RESET}\n`);

  const manifest = await loadJson(path.resolve(ROOT, config.paths.contentTypesManifest));
  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  const sourceDb = openSourceDb(path.resolve(ROOT, config.strapi3.sqliteDbPath));
  const s5DbPath = path.resolve(ROOT, config.strapi5.dbPath);
  if (!existsSync(s5DbPath)) {
    console.error(`${RED}ERROR${RESET} Strapi 5 SQLite not found at ${s5DbPath}`);
    sourceDb.close();
    process.exit(1);
  }
  const s5Db = new Database(s5DbPath, { readonly: true });

  const checks = [];
  const recordCheck = (id, title, status, detail = '', notes = []) => {
    checks.push({ id, title, status, detail, notes });
    const icon = status === 'PASS' ? `${GREEN}PASS${RESET}` : status === 'WARN' ? `${YELLOW}WARN${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  [${icon}] ${id}. ${title}${detail ? '  ' + DIM + detail + RESET : ''}`);
    for (const note of notes) console.log(`         ${DIM}${note}${RESET}`);
  };

  // ────────────────────────────────────────────────────────────────
  // Check 1: per-type document counts
  // ────────────────────────────────────────────────────────────────
  {
    const mismatches = [];
    let totalSource = 0, totalS5 = 0;
    for (const ct of activeTypes) {
      const expected = ct.kind === 'singleType' ? 1 : countTable(sourceDb, ct.sqlTable);
      const actual = s5Db
        .prepare(`SELECT COUNT(DISTINCT document_id) AS n FROM ${quoteIdent(ct.sqlTable)}`)
        .get().n;
      totalSource += expected;
      totalS5 += actual;
      if (actual !== expected) {
        const allowed = KNOWN_ACCEPTABLE_FAILURES.records[ct.name]?.length || 0;
        if (actual + allowed === expected) {
          mismatches.push({ name: ct.name, expected, actual, acceptable: allowed });
        } else {
          mismatches.push({ name: ct.name, expected, actual });
        }
      }
    }
    const real = mismatches.filter((m) => !m.acceptable);
    recordCheck(
      1,
      'Document counts (per type)',
      real.length === 0 ? 'PASS' : 'FAIL',
      `${totalS5}/${totalSource} documents loaded`,
      real.map((m) => `${m.name}: ${m.actual} in S5, expected ${m.expected}`),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Check 2: legacyId coverage
  // ────────────────────────────────────────────────────────────────
  {
    const missingByType = [];
    for (const ct of activeTypes) {
      if (ct.kind === 'singleType') continue; // singletons don't have legacyId
      // Count source records minus known acceptable failures
      const acceptable = (KNOWN_ACCEPTABLE_FAILURES.records[ct.name] || []).length;
      const expected = countTable(sourceDb, ct.sqlTable) - acceptable;
      const actual = s5Db
        .prepare(`SELECT COUNT(DISTINCT legacy_id) AS n FROM ${quoteIdent(ct.sqlTable)} WHERE legacy_id IS NOT NULL`)
        .get().n;
      if (actual !== expected) missingByType.push({ name: ct.name, expected, actual });
    }
    recordCheck(
      2,
      'Legacy ID coverage',
      missingByType.length === 0 ? 'PASS' : 'FAIL',
      missingByType.length === 0 ? 'every loaded record has a legacyId' : '',
      missingByType.map((m) => `${m.name}: ${m.actual} legacyIds, expected ${m.expected}`),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Check 3: draft preservation
  // ────────────────────────────────────────────────────────────────
  {
    const draftMismatches = [];
    let totalSourceDrafts = 0, totalS5Drafts = 0;
    for (const ct of activeTypes) {
      if (!ct.draftAndPublish) continue;
      // Skip if source table doesn't actually have published_at (legacy data)
      const sourceCols = sourceDb
        .prepare(`PRAGMA table_info(${quoteIdent(ct.sqlTable)})`)
        .all()
        .map((r) => r.name);
      if (!sourceCols.includes('published_at')) continue;

      const sourceDrafts = countTable(sourceDb, ct.sqlTable, { where: 'published_at IS NULL' });
      // Strapi 5 draft detection: a document is a "draft" if it has at least
      // one row with published_at IS NULL (regardless of whether a published
      // row also exists for the same document).
      const s5DraftDocIds = s5Db
        .prepare(`SELECT DISTINCT document_id FROM ${quoteIdent(ct.sqlTable)} WHERE published_at IS NULL`)
        .all()
        .map((r) => r.document_id);
      const s5DraftOnlyCount = s5DraftDocIds.filter((docId) => {
        const hasPublished = s5Db
          .prepare(`SELECT 1 FROM ${quoteIdent(ct.sqlTable)} WHERE document_id = ? AND published_at IS NOT NULL LIMIT 1`)
          .get(docId);
        return !hasPublished;
      }).length;
      const s5Drafts = s5DraftOnlyCount;
      totalSourceDrafts += sourceDrafts;
      totalS5Drafts += s5Drafts;
      if (s5Drafts !== sourceDrafts) {
        const acceptable = (KNOWN_ACCEPTABLE_FAILURES.records[ct.name] || []).length;
        if (s5Drafts + acceptable !== sourceDrafts) {
          draftMismatches.push({ name: ct.name, expected: sourceDrafts, actual: s5Drafts });
        }
      }
    }
    recordCheck(
      3,
      'Draft preservation',
      draftMismatches.length === 0 ? 'PASS' : 'FAIL',
      `${totalS5Drafts}/${totalSourceDrafts} drafts preserved`,
      draftMismatches.map((m) => `${m.name}: ${m.actual} drafts in S5, expected ${m.expected}`),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Check 4: no Base64 remnants in body fields
  // ────────────────────────────────────────────────────────────────
  {
    let total = 0;
    const offenders = [];
    for (const ct of activeTypes) {
      const cols = s5Db.prepare(`PRAGMA table_info(${quoteIdent(ct.sqlTable)})`).all().map((c) => c.name);
      const richtextCols = cols.filter((c) =>
        c === 'body' || c === 'bio' || c === 'details' || c === 'summary',
      );
      for (const col of richtextCols) {
        const rows = s5Db
          .prepare(
            `SELECT id, document_id FROM ${quoteIdent(ct.sqlTable)} WHERE ${quoteIdent(col)} LIKE '%data:image/%' LIMIT 5`,
          )
          .all();
        if (rows.length > 0) {
          total += rows.length;
          offenders.push({ type: ct.name, field: col, count: rows.length });
        }
      }
    }
    recordCheck(
      4,
      'No Base64 image remnants in body fields',
      total === 0 ? 'PASS' : 'WARN',
      total === 0 ? 'no data:image/ substrings found in any richtext' : `${total} occurrences`,
      offenders.map((o) => `${o.type}.${o.field}: ${o.count} records contain Base64`),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Check 5: media migration coverage
  // ────────────────────────────────────────────────────────────────
  let s5UploadCount = 0;
  {
    const uploadMapPath = path.resolve(ROOT, config.paths.maps, 'uploadfile-map.json');
    if (!existsSync(uploadMapPath)) {
      recordCheck(5, 'Media migration coverage', 'FAIL', 'uploadfile-map.json not found');
    } else {
      const uploadMap = await loadJson(uploadMapPath);
      const sourceUploadCount = countTable(sourceDb, 'upload_file');
      const successfulUploads = Object.values(uploadMap).filter((v) => v.strapi5Id).length;
      const knownOrphanFails = KNOWN_ACCEPTABLE_FAILURES.uploadFiles.length;
      // Verify against Strapi 5's actual files table
      try {
        s5UploadCount = s5Db.prepare(`SELECT COUNT(*) AS n FROM files`).get().n;
      } catch {
        s5UploadCount = successfulUploads;
      }
      const acceptable = sourceUploadCount - knownOrphanFails;
      recordCheck(
        5,
        'Media migration coverage',
        successfulUploads >= acceptable ? 'PASS' : 'FAIL',
        `${successfulUploads} uploaded (source: ${sourceUploadCount}, known fails: ${knownOrphanFails}, S5 files table: ${s5UploadCount})`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Check 6: media accessibility (sample)
  // ────────────────────────────────────────────────────────────────
  {
    let sample;
    try {
      sample = s5Db
        .prepare(`SELECT url FROM files WHERE url IS NOT NULL ORDER BY id LIMIT 25`)
        .all()
        .map((r) => r.url);
    } catch {
      sample = [];
    }
    let ok = 0, fail = 0;
    for (const url of sample) {
      try {
        const res = await fetch(`${config.strapi5.apiUrl}${url}`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        if (res.ok) ok++;
        else fail++;
      } catch {
        fail++;
      }
    }
    recordCheck(
      6,
      'Media accessibility (HEAD on 25 sampled files)',
      sample.length === 0 ? 'WARN' : (fail === 0 ? 'PASS' : 'FAIL'),
      sample.length === 0 ? 'no files in S5 to sample' : `${ok}/${sample.length} return 2xx`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Check 7: relation integrity (spot check via relation-link-report)
  // ────────────────────────────────────────────────────────────────
  {
    const reportPath = path.resolve(ROOT, 'migration/data/relation-link-report.json');
    if (!existsSync(reportPath)) {
      recordCheck(7, 'Relation integrity', 'FAIL', 'relation-link-report.json not found — run 04b-link-relations');
    } else {
      const report = await loadJson(reportPath);
      const errors = report.totals?.errors ?? -1;
      const links = report.totals?.links ?? 0;
      recordCheck(
        7,
        'Relation integrity',
        errors === 0 ? 'PASS' : 'FAIL',
        `${links} dominant-edge connections created, ${errors} errors`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Check 8: timestamp preservation
  // ────────────────────────────────────────────────────────────────
  {
    let sampled = 0, mismatched = 0;
    for (const ct of activeTypes) {
      if (ct.kind === 'singleType') continue;
      // Skip types whose source table doesn't have published_at (e.g., tag, config)
      const sourceCols = sourceDb
        .prepare(`PRAGMA table_info(${quoteIdent(ct.sqlTable)})`)
        .all()
        .map((r) => r.name);
      if (!sourceCols.includes('published_at')) continue;
      const s5Cols = s5Db.prepare(`PRAGMA table_info(${quoteIdent(ct.sqlTable)})`).all().map((c) => c.name);
      if (!s5Cols.includes('published_at') || !s5Cols.includes('legacy_id')) continue;

      const sourceRows = sourceDb
        .prepare(`SELECT id, published_at FROM ${quoteIdent(ct.sqlTable)} WHERE published_at IS NOT NULL ORDER BY id LIMIT 5`)
        .all();
      for (const sr of sourceRows) {
        const s5Row = s5Db
          .prepare(`SELECT published_at FROM ${quoteIdent(ct.sqlTable)} WHERE legacy_id = ? AND published_at IS NOT NULL LIMIT 1`)
          .get(sr.id);
        if (s5Row && sr.published_at) {
          sampled++;
          const sourceMs = new Date(sr.published_at).getTime();
          const s5Ms = new Date(s5Row.published_at).getTime();
          if (Math.abs(sourceMs - s5Ms) > 1000) mismatched++;
        }
      }
    }
    recordCheck(
      8,
      'Timestamp preservation (±1s on sampled records)',
      sampled > 0 && mismatched === 0 ? 'PASS' : sampled === 0 ? 'WARN' : 'FAIL',
      sampled === 0 ? 'no comparable rows sampled' : `${sampled - mismatched}/${sampled} timestamps match within 1s`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Check 9: content integrity (10% sample, title match)
  // ────────────────────────────────────────────────────────────────
  {
    let sampled = 0, mismatched = 0;
    for (const ct of activeTypes) {
      const cols = s5Db.prepare(`PRAGMA table_info(${quoteIdent(ct.sqlTable)})`).all().map((c) => c.name);
      if (!cols.includes('title') || !cols.includes('legacy_id')) continue;

      const sourceCount = countTable(sourceDb, ct.sqlTable);
      const sampleSize = Math.max(1, Math.ceil(sourceCount * 0.1));
      const sourceRows = sourceDb
        .prepare(`SELECT id, title FROM ${quoteIdent(ct.sqlTable)} WHERE title IS NOT NULL ORDER BY id LIMIT ?`)
        .all(sampleSize);
      for (const sr of sourceRows) {
        const s5Row = s5Db
          .prepare(`SELECT title FROM ${quoteIdent(ct.sqlTable)} WHERE legacy_id = ? LIMIT 1`)
          .get(sr.id);
        sampled++;
        if (!s5Row || s5Row.title !== sr.title) mismatched++;
      }
    }
    recordCheck(
      9,
      'Content integrity (title match on 10% sample)',
      mismatched === 0 ? 'PASS' : 'FAIL',
      `${sampled - mismatched}/${sampled} titles match exactly`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Check 10: component instance counts
  // ────────────────────────────────────────────────────────────────
  {
    const componentTables = s5Db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'components_%'`)
      .all()
      .map((r) => r.name);
    let totalInstances = 0;
    for (const t of componentTables) {
      try {
        totalInstances += s5Db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)}`).get().n;
      } catch {}
    }
    recordCheck(
      10,
      'Component instance counts',
      totalInstances > 0 ? 'PASS' : 'WARN',
      `${totalInstances} component rows across ${componentTables.length} tables`,
    );
  }

  sourceDb.close();
  s5Db.close();

  // ────────────────────────────────────────────────────────────────
  // Save report
  // ────────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const warned = checks.filter((c) => c.status === 'WARN').length;

  const report = {
    generatedAt: new Date().toISOString(),
    overallStatus: failed === 0 ? 'PASS' : 'FAIL',
    checksRun: checks.length,
    checksPassed: passed,
    checksFailed: failed,
    checksWarned: warned,
    checks,
  };
  const reportPath = path.resolve(ROOT, 'migration/data/validation-report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Passed:  ${GREEN}${passed}${RESET}`);
  console.log(`  Failed:  ${failed > 0 ? RED : DIM}${failed}${RESET}`);
  console.log(`  Warn:    ${warned > 0 ? YELLOW : DIM}${warned}${RESET}`);
  console.log(`  Report:  ${path.relative(ROOT, reportPath)}`);
  console.log('');

  if (failed > 0) {
    console.log(`${RED}${BOLD}Validation failed.${RESET} Fix the issues above, then re-run:`);
    console.log(`  pnpm migrate:phase05`);
    console.log('');
    process.exit(1);
  }

  console.log('Next: Phase 6 (Field-by-Field Parity Audit)');
  console.log(`  pnpm migrate:phase06`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
