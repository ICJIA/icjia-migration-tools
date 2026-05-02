/**
 * @module 04b-link-relations
 * @description Phase 4 step 2: Link m2m and m2o relations across content types.
 *
 * Reads:
 *   - migration/data/relation-graph.json      (Phase 1 output)
 *   - migration/data/maps/<plural>.json       (Phase 4 step 1 — sourceId → docId)
 *   - migration/data/raw/<plural>.json        (Phase 2 — original relation arrays)
 *
 * Uses the generic `relation-engine` library to iterate every dominant edge
 * (19 m2m + 1 m2o = 20 total for ICJIA) and PUT connect operations on the
 * dominant side.
 *
 * Idempotent — Strapi 5's connect syntax silently ignores already-existing
 * connections, so re-running is a no-op for already-linked records.
 *
 * @example
 *   pnpm migrate:phase04   # full Phase 4 (load + link + timestamps + verify)
 *   node migration/scripts/04b-link-relations.js
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { RestClient } from '../lib/rest-client.js';
import { linkAllRelations } from '../lib/relation-engine.js';
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

async function main() {
  console.log(`${BOLD}── Phase 4 step 2: Link relations ──${RESET}\n`);

  if (!config.strapi5.token) {
    console.error(`${RED}ERROR${RESET} STRAPI5_TOKEN is not set.`);
    process.exit(1);
  }

  const manifest = await loadJson(path.resolve(ROOT, config.paths.contentTypesManifest));
  const relationGraphPath = path.resolve(ROOT, config.paths.relationGraph);
  if (!existsSync(relationGraphPath)) {
    console.error(`${RED}ERROR${RESET} relation graph not found at ${path.relative(ROOT, relationGraphPath)}.`);
    console.error(`Run Phase 1 first: ${CYAN}pnpm migrate:phase01${RESET}`);
    process.exit(1);
  }
  const relationGraph = await loadJson(relationGraphPath);

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const mapsDir = path.resolve(ROOT, config.paths.maps);

  // Build idMapsByType — Map<typeName, Map<sourceId, documentId>>
  const idMapsByType = new Map();
  const rawRecordsByType = new Map();
  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  for (const ct of activeTypes) {
    const mapPath = path.join(mapsDir, ct.queryName + '.json');
    if (existsSync(mapPath)) {
      const rawMap = await loadJson(mapPath);
      const idMap = new Map();
      for (const [sourceId, info] of Object.entries(rawMap)) {
        if (info?.documentId) idMap.set(String(sourceId), info.documentId);
      }
      idMapsByType.set(ct.name, idMap);
    }
    const rawPath = path.join(rawDir, ct.queryName + '.json');
    if (existsSync(rawPath)) {
      const parsed = await loadJson(rawPath);
      rawRecordsByType.set(ct.name, Array.isArray(parsed) ? parsed : [parsed]);
    }
  }

  const dominantEdges = relationGraph.filter((e) => e.dominant || e.isModel);
  console.log(`Configuration:`);
  console.log(`  Strapi 5 API:    ${CYAN}${config.strapi5.apiUrl}${RESET}`);
  console.log(`  Active types:    ${activeTypes.length} (${idMapsByType.size} have ID maps)`);
  console.log(`  Relation edges:  ${relationGraph.length} (${dominantEdges.length} dominant/m2o to link)`);
  console.log('');

  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings?.requestTimeoutMs || 30000,
  });

  const result = await linkAllRelations(client, manifest, {
    relationGraph,
    idMapsByType,
    rawRecordsByType,
    requestDelayMs: config.settings?.requestDelayMs || 100,
  });

  // Per-pass summary
  console.log(`${BOLD}Per-content-type linking:${RESET}`);
  for (const pass of result.passes) {
    const fields = pass.edges.map((e) => `${e.field}→${e.target}`).join(', ');
    const errNote = pass.errors.length > 0 ? ` ${RED}${pass.errors.length} errors${RESET}` : '';
    const missNote = pass.missingTargets.length > 0
      ? ` ${YELLOW}${pass.missingTargets.length} unresolved IDs${RESET}` : '';
    const icon = pass.errors.length === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${pass.contentType.padEnd(16)} ${pass.recordsLinked.toString().padStart(5)} records, ${pass.links} links ${DIM}(${fields})${RESET}${errNote}${missNote}`);

    for (const err of pass.errors.slice(0, 3)) {
      console.log(`    ${RED}[${err.sourceId} → ${err.docId}]${RESET} ${err.error.slice(0, 200)}`);
    }
  }

  // Save report
  const reportPath = path.resolve(ROOT, 'migration/data/relation-link-report.json');
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: result.totals,
        passes: result.passes,
      },
      null,
      2,
    ),
  );

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Passes run:       ${result.totals.passes}`);
  console.log(`  Records linked:   ${result.totals.recordsLinked}`);
  console.log(`  Links created:    ${result.totals.links}`);
  console.log(`  Errors:           ${result.totals.errors}`);
  console.log(`  Report:           ${path.relative(ROOT, reportPath)}`);
  console.log('');

  if (result.totals.errors > 0) {
    console.log(`${RED}${BOLD}Phase 4 link-relations had errors.${RESET}`);
    console.log(`Review ${path.relative(ROOT, reportPath)} for details.`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 4 link-relations complete.${RESET}`);
  console.log('');
  console.log('Next: 04c-fix-timestamps (restore created_at/updated_at via direct SQLite UPDATE)');
  console.log(`  ${CYAN}node migration/scripts/04c-fix-timestamps.js${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
