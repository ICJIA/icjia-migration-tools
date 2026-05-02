/**
 * @module 02-verify
 * @description Phase 2 verify: cross-check extracted JSON against SQLite ground truth.
 *
 * For each active content type:
 *   - Compares extracted JSON record count to the SQLite total (the source of
 *     truth, since it includes both published and draft rows).
 *   - Verifies every record has a non-null `id`.
 *   - Verifies UploadFile references have the required metadata fields
 *     (`id`, `url`, `hash`, `mime`, `name`).
 *   - Reports per-type pass/fail.
 *
 * Run after `pnpm extract`. Idempotent — read-only.
 *
 * @example
 *   pnpm migrate:phase02   # runs extract + verify
 *   # or just verify after a manual extract:
 *   node migration/scripts/02-verify.js
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const REQUIRED_UPLOAD_FILE_FIELDS = ['id', 'url', 'hash', 'mime', 'name'];

async function loadManifest() {
  const p = path.resolve(ROOT, config.paths.contentTypesManifest);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Walk a value (recursively) to find UploadFile-shaped objects (have id + url + hash).
 * Returns counts of well-formed and malformed.
 */
function inspectUploadFiles(value) {
  const stats = { wellFormed: 0, malformed: [] };
  const visit = (v, p) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, [...p, i]));
      return;
    }
    if (typeof v === 'object') {
      // UploadFile heuristic: has id + url + hash
      const isUpload = v.id !== undefined && typeof v.url === 'string' && typeof v.hash === 'string';
      if (isUpload) {
        const missing = REQUIRED_UPLOAD_FILE_FIELDS.filter((f) => v[f] === undefined || v[f] === null);
        if (missing.length === 0) stats.wellFormed++;
        else stats.malformed.push({ path: p.join('.'), missing });
      }
      for (const [k, val] of Object.entries(v)) {
        visit(val, [...p, k]);
      }
    }
  };
  visit(value, []);
  return stats;
}

async function main() {
  console.log(`${BOLD}── Phase 2 verify: cross-check extracted JSON ──${RESET}\n`);

  const manifest = await loadManifest();
  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  if (!existsSync(rawDir)) {
    console.error(`${RED}ERROR${RESET} ${path.relative(ROOT, rawDir)} not found. Run ${CYAN}pnpm extract${RESET} first.`);
    process.exit(1);
  }

  const dbPath = path.resolve(ROOT, config.strapi3.sqliteDbPath);
  const db = openSourceDb(dbPath);

  const results = [];
  let totalRecords = 0;
  let totalUploads = 0;

  for (const ct of activeTypes) {
    const fileName = ct.queryName + '.json';
    const filePath = path.join(rawDir, fileName);
    const result = { name: ct.name, file: fileName, checks: {} };

    if (!existsSync(filePath)) {
      result.checks.fileExists = { pass: false, detail: 'extract JSON not found' };
      console.log(`  ${RED}✗${RESET} ${ct.name.padEnd(16)} ${RED}NOT EXTRACTED${RESET}`);
      results.push(result);
      continue;
    }

    let records;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      records = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      result.checks.fileExists = { pass: false, detail: `cannot parse JSON: ${err.message}` };
      console.log(`  ${RED}✗${RESET} ${ct.name.padEnd(16)} ${RED}JSON parse error${RESET}`);
      results.push(result);
      continue;
    }

    result.checks.fileExists = { pass: true };

    const expectedCount = ct.kind === 'singleType' ? 1 : countTable(db, ct.sqlTable);
    const countPass = records.length === expectedCount;
    result.checks.recordCount = {
      pass: countPass,
      extracted: records.length,
      sqliteTotal: expectedCount,
    };

    const missingIds = records.filter((r) => r.id === undefined || r.id === null);
    result.checks.idCoverage = {
      pass: missingIds.length === 0,
      missingCount: missingIds.length,
    };

    const uploadStats = inspectUploadFiles(records);
    const uploadPass = uploadStats.malformed.length === 0;
    result.checks.uploadFiles = {
      pass: uploadPass,
      wellFormed: uploadStats.wellFormed,
      malformedCount: uploadStats.malformed.length,
      malformedSample: uploadStats.malformed.slice(0, 3),
    };

    totalRecords += records.length;
    totalUploads += uploadStats.wellFormed;

    const allPass = countPass && result.checks.idCoverage.pass && uploadPass;
    const icon = allPass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const uploadNote = uploadStats.wellFormed > 0 ? `${DIM}, ${uploadStats.wellFormed} UploadFiles${RESET}` : '';
    const countNote = countPass ? '' : ` ${YELLOW}(SQLite has ${expectedCount})${RESET}`;
    const idNote = result.checks.idCoverage.pass ? '' : ` ${RED}${missingIds.length} missing id${RESET}`;
    console.log(`  ${icon} ${ct.name.padEnd(16)} ${records.length.toString().padStart(5)} records${uploadNote}${countNote}${idNote}`);

    if (uploadStats.malformed.length > 0) {
      console.log(`    ${YELLOW}${uploadStats.malformed.length} malformed UploadFile refs:${RESET}`);
      for (const m of uploadStats.malformed.slice(0, 3)) {
        console.log(`      - ${m.path}: missing ${m.missing.join(', ')}`);
      }
    }

    results.push(result);
  }

  db.close();

  const reportPath = path.resolve(ROOT, 'migration/data/extract-verification.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: { records: totalRecords, uploadFiles: totalUploads, types: results.length },
        types: results,
      },
      null,
      2,
    ),
  );

  const passed = results.filter((r) =>
    r.checks.fileExists?.pass &&
    r.checks.recordCount?.pass &&
    r.checks.idCoverage?.pass &&
    r.checks.uploadFiles?.pass,
  ).length;
  const failed = results.length - passed;

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Types:          ${results.length}`);
  console.log(`  Passed:         ${passed}`);
  console.log(`  Failed:         ${failed}`);
  console.log(`  Total records:  ${totalRecords}`);
  console.log(`  UploadFile refs: ${totalUploads}`);
  console.log(`  Report:         ${path.relative(ROOT, reportPath)}`);
  console.log('');

  if (failed > 0) {
    console.log(`${RED}${BOLD}Phase 2 verify FAILED.${RESET} Re-run extract for failing types:`);
    console.log(`  ${CYAN}pnpm extract -- --type=<name> --force${RESET}`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 2 verify PASSED.${RESET}`);
  console.log('');
  console.log('Next: Phase 3 (Media — download + re-upload UploadFiles)');
  console.log(`  ${CYAN}pnpm migrate:phase03${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
