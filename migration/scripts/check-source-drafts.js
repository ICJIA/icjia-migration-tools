/**
 * @module check-source-drafts
 * @description Lists every record that was a DRAFT in Strapi 3 (published_at
 * IS NULL), grouped by content type, with identifying fields and a direct
 * link into the Strapi 5 admin.
 *
 * Use case: when migration runs with `preserveSourceDrafts: false` (the
 * default), every record loads as Published in Strapi 5. This report tells
 * an editor exactly which records to flip back to "Draft" status manually.
 *
 * Outputs:
 *   - migration/data/source-drafts.json (machine-readable)
 *   - migration/data/source-drafts.md   (human-readable, included in the
 *                                        Phase 7 report and postflight links)
 *
 * @example
 *   pnpm check-drafts
 *   node migration/scripts/check-source-drafts.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
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
const sourceDbPath = path.resolve(ROOT, config.strapi3.sqliteDbPath);
const adminBase = (config.strapi5?.apiUrl || 'http://localhost:1337').replace(/\/+$/, '') + '/admin';

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

// Best-effort identifying string for a record. Different content types use
// different fields — title, fullName, firstName+lastName, slug, name, etc.
function identifierFor(row) {
  const parts = [];
  if (row.title) parts.push(row.title);
  if (row.fullName) parts.push(row.fullName);
  else if (row.first_name || row.last_name) {
    const fn = [row.first_name, row.last_name].filter(Boolean).join(' ');
    if (fn) parts.push(fn);
  }
  if (row.name && !parts.includes(row.name)) parts.push(row.name);
  if (parts.length === 0 && row.slug) parts.push(`<${row.slug}>`);
  if (parts.length === 0) parts.push('<no title>');
  return parts.join(' — ');
}

async function main() {
  console.log(`${BOLD}── Source drafts report (records with published_at IS NULL in Strapi 3) ──${RESET}\n`);

  const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  const manifest = JSON.parse(
    await fs.readFile(path.resolve(ROOT, config.paths.contentTypesManifest), 'utf8'),
  );

  const results = []; // [{name, sqlTable, total, drafts: [{id, identifier, slug, created_at, updated_at}]}]
  let totalDrafts = 0;

  for (const ct of manifest.contentTypes) {
    if (ct.skipDefault) continue;
    if (!ct.draftAndPublish) continue;

    // Skip types that don't actually have published_at in source (legacy)
    const cols = sourceDb.prepare(`PRAGMA table_info(${quoteIdent(ct.sqlTable)})`).all().map((r) => r.name);
    if (!cols.includes('published_at')) continue;

    // Pick available identifying columns. Build a defensive SELECT that won't
    // fail on schemas where a column doesn't exist.
    const interesting = ['id', 'title', 'fullName', 'first_name', 'last_name', 'name', 'slug', 'created_at', 'updated_at'];
    const select = interesting.filter((c) => cols.includes(c));
    if (!select.includes('id')) select.unshift('id');

    const rows = sourceDb
      .prepare(`SELECT ${select.map(quoteIdent).join(', ')} FROM ${quoteIdent(ct.sqlTable)} WHERE published_at IS NULL ORDER BY id`)
      .all();

    if (rows.length === 0) continue;

    const drafts = rows.map((r) => ({
      id: r.id,
      identifier: identifierFor(r),
      slug: r.slug || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
    }));

    const totalRows = sourceDb.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(ct.sqlTable)}`).get().n;

    results.push({
      name: ct.name,
      pluralName: ct.queryName || ct.sqlTable,
      sqlTable: ct.sqlTable,
      total: totalRows,
      drafts,
    });
    totalDrafts += drafts.length;

    console.log(`  ${CYAN}${ct.name.padEnd(15)}${RESET} ${drafts.length} draft${drafts.length === 1 ? '' : 's'} of ${totalRows} total`);
  }

  sourceDb.close();

  console.log('');
  console.log(`${BOLD}Total: ${totalDrafts} source drafts across ${results.length} content type${results.length === 1 ? '' : 's'}.${RESET}`);

  // ── Write JSON ───────────────────────────────────────────────────
  const jsonPath = path.resolve(ROOT, 'migration/data/source-drafts.json');
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), totalDrafts, types: results }, null, 2));
  console.log(`${GREEN}✓${RESET} JSON  → ${path.relative(ROOT, jsonPath)}`);

  // ── Write Markdown ───────────────────────────────────────────────
  const lines = [];
  lines.push('# Source drafts — Strapi 3 records that were marked as draft');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Total: **${totalDrafts}** source drafts across **${results.length}** content type${results.length === 1 ? '' : 's'}.`);
  lines.push('');
  lines.push(`> The migration loaded these as **Published** in Strapi 5 (because \`preserveSourceDrafts: false\`).  `);
  lines.push(`> If you want them to remain as drafts, manually flip each one to "Draft" in the Strapi 5 admin.  `);
  lines.push('> This report lists the source IDs (now \`legacyId\` in Strapi 5) and identifying fields so you can find them quickly.');
  lines.push('');

  if (results.length === 0) {
    lines.push('_No source drafts found — every record in Strapi 3 was published._');
  } else {
    for (const t of results) {
      lines.push(`## ${t.name} — ${t.drafts.length} draft${t.drafts.length === 1 ? '' : 's'} of ${t.total}`);
      lines.push('');
      lines.push(`Strapi 5 admin: [${adminBase}/content-manager/collection-types/api::${t.name}.${t.name}](${adminBase}/content-manager/collection-types/api::${t.name}.${t.name})`);
      lines.push('');
      lines.push('| legacyId | identifier | slug | source updated_at |');
      lines.push('|---:|---|---|---|');
      for (const d of t.drafts) {
        const ident = d.identifier.replace(/\|/g, '\\|');
        const slug = d.slug ? `\`${d.slug}\`` : '—';
        const upd = d.updated_at || '—';
        lines.push(`| ${d.id} | ${ident} | ${slug} | ${upd} |`);
      }
      lines.push('');
    }
  }

  const mdPath = path.resolve(ROOT, 'migration/data/source-drafts.md');
  await fs.writeFile(mdPath, lines.join('\n'));
  console.log(`${GREEN}✓${RESET} MD    → ${path.relative(ROOT, mdPath)}`);

  // ── Copy MD into Strapi 5 public/ for in-browser access (best effort)
  const s5Public = config.strapi5ProjectPath
    ? path.resolve(ROOT, config.strapi5ProjectPath, 'public', 'source-drafts.md')
    : null;
  if (s5Public) {
    try {
      await fs.copyFile(mdPath, s5Public);
      console.log(`${GREEN}✓${RESET} Copied to Strapi 5 public/ → served at ${CYAN}${config.strapi5.apiUrl}/source-drafts.md${RESET}`);
    } catch (err) {
      console.log(`${DIM}(skipped Strapi 5 public copy — ${err.code || err.message})${RESET}`);
    }
  }

  console.log('');
  console.log(`${BOLD}To find a record in Strapi 5 admin:${RESET}`);
  console.log(`  Filter the content type's list by ${CYAN}legacyId${RESET} = the source id from the report,`);
  console.log(`  open the record, and click ${CYAN}"Unpublish"${RESET} or set status to Draft.`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
