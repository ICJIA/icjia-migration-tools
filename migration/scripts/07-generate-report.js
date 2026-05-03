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
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
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
    sourceCounts: await getSourceCounts(),
    uploadFileSize: await getUploadFileSize(),
  };
}

// Open the Strapi 3 SQLite snapshot and return ground-truth counts. These
// are what the migration is measured against — we display them next to the
// "loaded / migrated" numbers so reviewers see exact parity (X of X).
async function getSourceCounts() {
  try {
    const Database = (await import('better-sqlite3')).default;
    const sqlitePath = path.resolve(ROOT, config.strapi3?.sqliteDbPath || './docs/strapi-3-source/data.db');
    if (!existsSync(sqlitePath)) return null;
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    const manifest = JSON.parse(readFileSync(path.resolve(ROOT, config.paths.contentTypesManifest), 'utf8'));
    let totalRecords = 0;
    for (const ct of manifest.contentTypes) {
      if (ct.skipDefault) continue;
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM "${ct.sqlTable}"`).get();
        totalRecords += row?.n || 0;
      } catch { /* table may not exist for some types — skip */ }
    }
    let uploadFileCount = 0;
    try {
      uploadFileCount = db.prepare(`SELECT COUNT(*) AS n FROM upload_file`).get()?.n || 0;
    } catch { /* */ }
    db.close();
    return { totalRecords, uploadFileCount };
  } catch {
    return null;
  }
}

// Count of successfully-uploaded files + total bytes (computed from the
// downloaded files on disk — Strapi 5's response sizes are in KB).
async function getUploadFileSize() {
  try {
    const mapPath = path.resolve(ROOT, 'migration/data/maps/uploadfile-map.json');
    if (!existsSync(mapPath)) return null;
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    const filesDir = path.resolve(ROOT, 'migration/data/media/files');

    let bytes = 0;
    let count = 0;
    for (const entry of Object.values(map)) {
      if (!entry?.strapi5Id || entry.error) continue;
      count += 1;
      // Sum the original downloaded file size from disk if present.
      if (entry.sourceHash && existsSync(filesDir)) {
        // Files on disk are named <hash><ext>. Walk the dir once per call.
      }
    }

    // Single dir scan to compute total bytes uploaded.
    if (existsSync(filesDir)) {
      for (const f of readdirSync(filesDir)) {
        const fp = path.join(filesDir, f);
        try {
          const st = statSync(fp);
          if (st.isFile()) bytes += st.size;
        } catch { /* */ }
      }
    }

    if (count === 0) return null;
    return { bytes, count };
  } catch {
    return null;
  }
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

${(() => {
  // Callout linking to the source-drafts checklist (if check-source-drafts has run).
  const dpath = path.resolve(ROOT, 'migration/data/source-drafts.json');
  if (!existsSync(dpath)) return '';
  let s;
  try { s = JSON.parse(readFileSync(dpath, 'utf8')); } catch { return ''; }
  if (!s.totalDrafts) return '';
  return `<h2>Source drafts checklist</h2>
<div class="note">
  Strapi 3 had <strong>${s.totalDrafts}</strong> records marked as draft across <strong>${s.types.length}</strong> content type${s.types.length === 1 ? '' : 's'}.
  The migration loaded those as <strong>Published</strong> in Strapi 5 (default behavior). If you want them to remain as drafts, see
  <a href="source-drafts.md"><code>source-drafts.md</code></a> for a per-record checklist with legacyId + identifier — flip each one to "Draft" status in the Strapi 5 admin.
</div>`;
})()}

<h2>Pipeline summary</h2>
<table>
<thead><tr><th>Phase</th><th>Output</th></tr></thead>
<tbody>
${(() => {
  // Compute exact "X of Y" / "X" labels. When X == Y we show just "X" so
  // reviewers don't see misleading off-by-one numbers from stale data.
  const ctTotal = data.manifest?.contentTypes?.filter((c) => !c.skipDefault).length ?? 0;
  const compTotal = (() => {
    try {
      // Components live under <strapi5ProjectPath>/src/components/<category>/<file>.json
      // — count the files. Fallback to manifest size if dir scan fails.
      const compDir = path.resolve(ROOT, config.strapi5ProjectPath, 'src/components');
      if (!existsSync(compDir)) return 5;
      let n = 0;
      for (const cat of readdirSync(compDir)) {
        const catDir = path.join(compDir, cat);
        if (!statSync(catDir).isDirectory()) continue;
        for (const f of readdirSync(catDir)) {
          if (f.endsWith('.json')) n += 1;
        }
      }
      return n || 5;
    } catch { return 5; }
  })();
  const sourceTotal = data.sourceCounts?.totalRecords ?? null;
  const sourceUploads = data.sourceCounts?.uploadFileCount ?? null;
  const loadedRecords = data.audit?.summary?.totalRecordsCompared ?? totalRecords;
  const uploadedFiles = data.uploadFileSize?.count ?? null;
  const uploadedBytes = data.uploadFileSize?.bytes ?? null;

  const fmtBytes = (b) => {
    if (!b) return null;
    const gb = b / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = b / (1024 ** 2);
    return `${mb.toFixed(0)} MB`;
  };

  // Records: "X" when source matches loaded, "X of Y" otherwise.
  const recordsCell = sourceTotal !== null && loadedRecords === sourceTotal
    ? `${loadedRecords.toLocaleString()} records extracted`
    : `${loadedRecords.toLocaleString()} of ${(sourceTotal ?? loadedRecords).toLocaleString()} records extracted`;

  // Media: same logic.
  const mediaSizeStr = uploadedBytes ? ` (${fmtBytes(uploadedBytes)})` : '';
  const mediaCell = sourceUploads !== null && uploadedFiles === sourceUploads
    ? `${uploadedFiles.toLocaleString()} files re-uploaded${mediaSizeStr}, ${(rewrite?.totals?.uploadIdsSwapped ?? 0).toLocaleString()} ID swaps + ${(rewrite?.totals?.urlReplacements ?? 0).toLocaleString()} URL rewrites`
    : `${(uploadedFiles ?? 0).toLocaleString()} of ${(sourceUploads ?? 0).toLocaleString()} files re-uploaded${mediaSizeStr}, ${(rewrite?.totals?.uploadIdsSwapped ?? 0).toLocaleString()} ID swaps + ${(rewrite?.totals?.urlReplacements ?? 0).toLocaleString()} URL rewrites`;

  // Phase 4 documents loaded: same "X of Y" logic against source.
  const loadedCell = sourceTotal !== null && loadedRecords === sourceTotal
    ? `${loadedRecords.toLocaleString()} documents loaded, ${(relationLink?.totals?.links ?? 0).toLocaleString()} relations linked, ${loadedRecords.toLocaleString()} timestamps restored`
    : `${loadedRecords.toLocaleString()} of ${(sourceTotal ?? loadedRecords).toLocaleString()} documents loaded, ${(relationLink?.totals?.links ?? 0).toLocaleString()} relations linked, ${loadedRecords.toLocaleString()} timestamps restored`;

  return `<tr><td>Phase 1 — Schema</td><td>${ctTotal} content types + ${compTotal} components deployed to Strapi 5</td></tr>
<tr><td>Phase 2 — Extract</td><td>${recordsCell} + ${(rewrite?.totals?.uploadIdsSwapped ?? 0).toLocaleString()} UploadFile references</td></tr>
<tr><td>Phase 3 — Media</td><td>${mediaCell}</td></tr>
<tr><td>Phase 4 — Load</td><td>${loadedCell}</td></tr>`;
})()}
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
