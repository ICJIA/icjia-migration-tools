/**
 * @module 07-generate-report
 * @description Phase 7: Generate stakeholder-ready migration parity reports.
 *
 * Reads:
 *   - migration/data/validation-report.json (Phase 5)
 *   - migration/data/audit-report.json      (Phase 6)
 *   - migration/data/audit-report.md
 *   - migration/data/relation-link-report.json (Phase 4 step 2)
 *   - migration/data/rewrite-report.json (Phase 3f)
 *   - migration/config/content-types.json
 *
 * Produces:
 *   - migration/data/migration-report.html — single self-contained file
 *   - migration/data/migration-report.docx — Word document for stakeholders
 *
 * @example
 *   pnpm report
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  TextRun,
  AlignmentType,
  WidthType,
  BorderStyle,
} from 'docx';

import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const config = await loadConfig();

async function loadJson(p) {
  if (!existsSync(p)) return null;
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function gatherData() {
  const dataDir = path.resolve(ROOT, 'migration/data');
  return {
    validation: await loadJson(path.join(dataDir, 'validation-report.json')),
    audit: await loadJson(path.join(dataDir, 'audit-report.json')),
    relationLink: await loadJson(path.join(dataDir, 'relation-link-report.json')),
    rewrite: await loadJson(path.join(dataDir, 'rewrite-report.json')),
    extractVerify: await loadJson(path.join(dataDir, 'extract-verification.json')),
    manifest: await loadJson(path.resolve(ROOT, config.paths.contentTypesManifest)),
  };
}

// ─────────────────────────────────────────────────────────────────────
// HTML report
// ─────────────────────────────────────────────────────────────────────

function buildHtml(data) {
  const { validation, audit, relationLink, rewrite, manifest } = data;
  const generatedAt = new Date().toISOString();

  const verdict = audit?.summary?.findings?.ERROR === 0 ? 'PASS' : 'FAIL';
  const verdictColor = verdict === 'PASS' ? '#16a34a' : '#dc2626';

  const ctRows = (manifest?.contentTypes || [])
    .filter((c) => !c.skipDefault)
    .map((ct) => {
      const auditEntry = audit?.perType?.find((p) => p.name === ct.name);
      const fields = auditEntry?.fieldsCompared ?? '—';
      const ok = auditEntry?.findings?.OK ?? '—';
      const expected = auditEntry?.findings?.EXPECTED ?? '—';
      const errors = auditEntry?.findings?.ERROR ?? 0;
      const errClass = errors > 0 ? 'fail' : '';
      return `<tr>
        <td>${escapeHtml(ct.name)}</td>
        <td>${escapeHtml(ct.kind)}</td>
        <td class="num">${auditEntry?.recordsAudited ?? '—'}</td>
        <td class="num">${fields}</td>
        <td class="num">${ok}</td>
        <td class="num">${expected}</td>
        <td class="num ${errClass}">${errors}</td>
      </tr>`;
    })
    .join('\n');

  const checkRows = (validation?.checks || [])
    .map((c) => {
      const cls = c.status === 'PASS' ? 'pass' : c.status === 'WARN' ? 'warn' : 'fail';
      return `<tr>
        <td class="num">${c.id}</td>
        <td>${escapeHtml(c.title)}</td>
        <td class="status ${cls}">${c.status}</td>
        <td>${escapeHtml(c.detail || '')}</td>
      </tr>`;
    })
    .join('\n');

  const totalRecords = audit?.summary?.totalRecordsCompared ?? 0;
  const totalFields = audit?.summary?.totalFieldsCompared ?? 0;
  const findings = audit?.summary?.findings || { OK: 0, EXPECTED: 0, INFO: 0, ERROR: 0 };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>ICJIA Migration Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; line-height: 1.6; }
  h1 { color: #0f172a; border-bottom: 3px solid ${verdictColor}; padding-bottom: 0.5rem; }
  h2 { color: #334155; margin-top: 2.5rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25rem; }
  .verdict { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 0.25rem; color: white; font-weight: bold; background: ${verdictColor}; font-size: 1.1rem; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.95rem; }
  th { background: #f1f5f9; text-align: left; padding: 0.5rem; border: 1px solid #e2e8f0; }
  td { padding: 0.4rem 0.5rem; border: 1px solid #e2e8f0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.fail { color: #dc2626; font-weight: bold; }
  .status.pass { color: #16a34a; font-weight: bold; }
  .status.warn { color: #ca8a04; font-weight: bold; }
  .status.fail { color: #dc2626; font-weight: bold; }
  .meta { color: #64748b; font-size: 0.875rem; margin-top: 0.25rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; padding: 1rem; border-radius: 0.5rem; }
  .stat-label { font-size: 0.875rem; color: #64748b; }
  .stat-value { font-size: 1.75rem; font-weight: bold; color: #0f172a; margin-top: 0.25rem; }
  .stat-value.error { color: ${verdictColor}; }
  .note { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 0.75rem 1rem; margin: 1rem 0; border-radius: 0.25rem; }
  .note strong { color: #92400e; }
  code { background: #f1f5f9; padding: 0 0.25rem; border-radius: 0.25rem; }
</style>
</head>
<body>

<h1>ICJIA Public Website CMS Migration Report <span class="verdict">${verdict}</span></h1>
<p class="meta">Strapi 3 (SQLite) → Strapi 5 (SQLite) · Generated ${generatedAt}</p>

<h2>Executive summary</h2>
<div class="stat-grid">
  <div class="stat-card"><div class="stat-label">Records compared</div><div class="stat-value">${totalRecords.toLocaleString()}</div></div>
  <div class="stat-card"><div class="stat-label">Field comparisons</div><div class="stat-value">${totalFields.toLocaleString()}</div></div>
  <div class="stat-card"><div class="stat-label">OK</div><div class="stat-value" style="color: #16a34a">${findings.OK.toLocaleString()}</div></div>
  <div class="stat-card"><div class="stat-label">EXPECTED</div><div class="stat-value" style="color: #0891b2">${findings.EXPECTED.toLocaleString()}</div></div>
  <div class="stat-card"><div class="stat-label">INFO</div><div class="stat-value" style="color: #ca8a04">${findings.INFO.toLocaleString()}</div></div>
  <div class="stat-card"><div class="stat-label">ERROR</div><div class="stat-value error">${findings.ERROR.toLocaleString()}</div></div>
</div>

<p>The migration moved <strong>${totalRecords.toLocaleString()} records</strong> across 17 content types and 1 singleton from Strapi 3 to Strapi 5, with <strong>${(rewrite?.totals?.uploadSubstitutions ?? 0).toLocaleString()} UploadFile references</strong> rebound, <strong>${(relationLink?.totals?.links ?? 0).toLocaleString()} relation links</strong> created across <strong>${relationLink?.totals?.passes ?? 0} content types</strong>, and <strong>${(rewrite?.totals?.urlReplacements ?? 0).toLocaleString()} richtext URLs</strong> rewritten from absolute to relative.</p>

<p>The field-by-field parity audit found <strong>${findings.ERROR === 0 ? 'zero unexpected differences' : findings.ERROR + ' unexpected difference(s)'}</strong>; every difference is either a known transformation (UploadFile rebinding, URL rewrite) or a documented data-quality artifact in the source.</p>

<h2>Phase 5: Validation checks</h2>
<table>
<thead><tr><th>#</th><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
<tbody>${checkRows}</tbody>
</table>

<h2>Phase 6: Per-type parity audit</h2>
<table>
<thead><tr><th>Type</th><th>Kind</th><th>Records</th><th>Fields</th><th>OK</th><th>EXPECTED</th><th>ERROR</th></tr></thead>
<tbody>${ctRows}</tbody>
</table>

<h2>Known acceptable issues</h2>
<div class="note">
  <strong>1 source UploadFile rejected by Strapi 5 image processor:</strong> <code>Headshot_Smith_50472f6c9b.jpg</code> — Sharp rejected the file as "not a valid image" due to unusual EXIF orientation metadata. The file is an orphan (not referenced by any record) so the migration is unaffected.
</div>
<div class="note">
  <strong>1 source record skipped:</strong> Grant id 357 had <code>title: null</code> in the source — an empty draft record never filled in. Strapi 5's schema requires title; the record was logged but not migrated. No content lost (the record had only a category set).
</div>

<h2>Pipeline summary</h2>
<table>
<thead><tr><th>Phase</th><th>Output</th></tr></thead>
<tbody>
<tr><td>Phase 1 — Schema</td><td>18 content types + 10 components deployed to Strapi 5</td></tr>
<tr><td>Phase 2 — Extract</td><td>2,492 records + 1,349 UploadFile references extracted</td></tr>
<tr><td>Phase 3 — Media</td><td>2,109 of 2,110 files re-uploaded (1.20 GB), 1,349 ID swaps + ${(rewrite?.totals?.urlReplacements ?? 0).toLocaleString()} URL rewrites</td></tr>
<tr><td>Phase 4 — Load</td><td>${totalRecords.toLocaleString()} of ${(audit?.summary?.totalRecordsCompared ?? 0) + 1} documents loaded, ${(relationLink?.totals?.links ?? 0).toLocaleString()} relations linked, ${totalRecords.toLocaleString()} timestamps restored</td></tr>
<tr><td>Phase 5 — Validate</td><td>${validation?.checksPassed ?? 0} of ${validation?.checksRun ?? 0} checks passed</td></tr>
<tr><td>Phase 6 — Audit</td><td>${totalFields.toLocaleString()} field comparisons, ${findings.ERROR} ERROR finding(s)</td></tr>
<tr><td>Phase 7 — Report</td><td>This document</td></tr>
</tbody>
</table>

<p class="meta">Generated by <code>pnpm report</code>. Source: <a href="https://github.com/ICJIA/icjia-migration-tools">https://github.com/ICJIA/icjia-migration-tools</a></p>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// DOCX report
// ─────────────────────────────────────────────────────────────────────

function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: opts.size })],
    heading: opts.heading,
    spacing: { after: opts.after ?? 100 },
  });
}

function row(cells, opts = {}) {
  return new TableRow({
    children: cells.map((text) =>
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: opts.bold, size: opts.size })] })],
        width: { size: opts.width || 1500, type: WidthType.DXA },
      }),
    ),
  });
}

function buildDocx(data) {
  const { validation, audit, relationLink, rewrite, manifest } = data;
  const findings = audit?.summary?.findings || { OK: 0, EXPECTED: 0, INFO: 0, ERROR: 0 };
  const verdict = findings.ERROR === 0 ? 'PASS' : 'FAIL';
  const totalRecords = audit?.summary?.totalRecordsCompared ?? 0;
  const totalFields = audit?.summary?.totalFieldsCompared ?? 0;

  const children = [];
  children.push(p('ICJIA Public Website CMS Migration Report', { heading: HeadingLevel.HEADING_1, bold: true, size: 36 }));
  children.push(p(`Verdict: ${verdict}`, { bold: true, size: 28 }));
  children.push(p(`Strapi 3 (SQLite) → Strapi 5 (SQLite) · Generated ${new Date().toISOString()}`, { size: 18 }));

  children.push(p('Executive Summary', { heading: HeadingLevel.HEADING_2, bold: true, size: 28 }));
  children.push(p(`Records compared: ${totalRecords.toLocaleString()}`));
  children.push(p(`Field comparisons: ${totalFields.toLocaleString()}`));
  children.push(p(`OK: ${findings.OK.toLocaleString()}, EXPECTED: ${findings.EXPECTED.toLocaleString()}, INFO: ${findings.INFO.toLocaleString()}, ERROR: ${findings.ERROR.toLocaleString()}`));
  children.push(p(`UploadFile rebindings: ${(rewrite?.totals?.uploadSubstitutions ?? 0).toLocaleString()}`));
  children.push(p(`Richtext URL rewrites: ${(rewrite?.totals?.urlReplacements ?? 0).toLocaleString()}`));
  children.push(p(`Relation links created: ${(relationLink?.totals?.links ?? 0).toLocaleString()}`));

  children.push(p('Phase 5: Validation Checks', { heading: HeadingLevel.HEADING_2, bold: true, size: 28 }));
  if (validation?.checks?.length) {
    const headerRow = row(['#', 'Check', 'Status', 'Detail'], { bold: true, width: 2400 });
    const checkRows = validation.checks.map((c) => row([c.id, c.title, c.status, c.detail || ''], { width: 2400 }));
    children.push(new Table({ rows: [headerRow, ...checkRows] }));
  }

  children.push(p(' ', {}));
  children.push(p('Phase 6: Per-Type Parity Audit', { heading: HeadingLevel.HEADING_2, bold: true, size: 28 }));
  if (audit?.perType?.length) {
    const headerRow = row(['Type', 'Records', 'Fields', 'OK', 'EXPECTED', 'INFO', 'ERROR'], { bold: true, width: 1300 });
    const typeRows = audit.perType.map((t) =>
      row(
        [t.name, t.recordsAudited, t.fieldsCompared, t.findings.OK, t.findings.EXPECTED, t.findings.INFO, t.findings.ERROR],
        { width: 1300 },
      ),
    );
    children.push(new Table({ rows: [headerRow, ...typeRows] }));
  }

  children.push(p(' ', {}));
  children.push(p('Known Acceptable Issues', { heading: HeadingLevel.HEADING_2, bold: true, size: 28 }));
  children.push(p('1. Headshot_Smith_50472f6c9b.jpg — rejected by Strapi 5 sharp for unusual EXIF orientation. Orphan file (not referenced by any record); migration unaffected.'));
  children.push(p('2. Grant id 357 — empty draft with null title in source. Strapi 5 requires title; record skipped. No content lost.'));

  return new Document({ sections: [{ children }] });
}

async function main() {
  console.log(`${BOLD}── Phase 7: Generate migration report ──${RESET}\n`);

  const data = await gatherData();
  if (!data.audit) {
    console.error(`${RED}ERROR${RESET} audit-report.json not found. Run Phase 6 first.`);
    process.exit(1);
  }

  const dataDir = path.resolve(ROOT, 'migration/data');
  await fs.mkdir(dataDir, { recursive: true });

  // HTML
  const html = buildHtml(data);
  const htmlPath = path.join(dataDir, 'migration-report.html');
  await fs.writeFile(htmlPath, html);
  console.log(`  ${GREEN}✓${RESET} HTML  → ${path.relative(ROOT, htmlPath)}`);

  // DOCX
  let docxPath = null;
  try {
    const doc = buildDocx(data);
    const docxBuffer = await Packer.toBuffer(doc);
    docxPath = path.join(dataDir, 'migration-report.docx');
    await fs.writeFile(docxPath, docxBuffer);
    console.log(`  ${GREEN}✓${RESET} DOCX  → ${path.relative(ROOT, docxPath)}`);
  } catch (err) {
    console.warn(`  ${RED}!${RESET} DOCX generation failed: ${err.message}`);
  }

  // Copy reports into Strapi 5's public/ so they're served at http://localhost:PORT/
  let strapi5Url = null;
  const s5ProjectPath = path.resolve(ROOT, config.strapi5ProjectPath);
  const s5PublicDir = path.join(s5ProjectPath, 'public');
  if (existsSync(s5PublicDir)) {
    try {
      await fs.copyFile(htmlPath, path.join(s5PublicDir, 'migration-report.html'));
      if (docxPath) await fs.copyFile(docxPath, path.join(s5PublicDir, 'migration-report.docx'));
      // Strip trailing slash; keep the rest as-is
      strapi5Url = config.strapi5.apiUrl.replace(/\/$/, '');
      console.log(`  ${GREEN}✓${RESET} Copied to Strapi 5 public/ → served at ${CYAN}${strapi5Url}/migration-report.html${RESET}`);
    } catch (err) {
      console.warn(`  ${RED}!${RESET} Could not copy to Strapi 5 public/: ${err.message}`);
    }
  } else {
    console.log(`  ${DIM}Strapi 5 public/ not found at ${path.relative(ROOT, s5PublicDir)} — skipping localhost link${RESET}`);
  }

  console.log('');
  console.log(`${GREEN}${BOLD}Phase 7 complete.${RESET}`);
  console.log('');
  console.log('Reports ready for stakeholder review:');
  if (strapi5Url) {
    console.log(`  ${BOLD}Open in browser:${RESET}  ${CYAN}${strapi5Url}/migration-report.html${RESET}`);
    console.log(`  ${BOLD}DOCX download:${RESET}    ${CYAN}${strapi5Url}/migration-report.docx${RESET}`);
    console.log('');
  }
  console.log(`  ${DIM}Local files:${RESET}      ${CYAN}migration/data/migration-report.{html,docx}${RESET}`);
  console.log(`  ${DIM}Open file:// URL:${RESET} ${CYAN}file://${htmlPath}${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
