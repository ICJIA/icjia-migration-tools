/**
 * @module 04b2-publish
 * @description Phase 4 step 2.5: Publish every document whose source was
 * published. Skips documents whose source was a draft.
 *
 * Why this step exists:
 *   Strapi 5 stores `draftAndPublish` content types as TWO database rows per
 *   document — one draft, one published. POST creates both rows in sync.
 *   PUT to `/api/<plural>/<documentId>` updates the **draft row only**.
 *
 *   Phase 4b (link-relations) does PUTs to attach m2m/m2o relations, which
 *   updates the draft. Now draft has the relations, published doesn't, so the
 *   admin UI shows the document with status "Modified" — forcing an editor to
 *   manually re-publish each one.
 *
 *   This step calls `POST /api/<plural>/<documentId>/actions/publish` for
 *   every loaded record whose source had `published_at` set, syncing draft →
 *   published. Records whose source was a draft (`published_at IS NULL`) are
 *   skipped — they should remain as drafts in S5.
 *
 * Idempotent:
 *   Re-running the publish action on an already-up-to-date document is a
 *   no-op. Safe to re-run any time. Records missing from the map (failed loads)
 *   are skipped.
 *
 * @example
 *   pnpm migrate:phase04b2
 *   node migration/scripts/04b2-publish.js
 *   node migration/scripts/04b2-publish.js --type=biography
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { RestClient } from '../lib/rest-client.js';
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

const argv = process.argv.slice(2);
const TYPE_FILTER = argv.find((a) => a.startsWith('--type='))?.slice('--type='.length);

function restPluralName(ct) {
  if (ct.kind === 'singleType') return ct.name;
  return (ct.queryName || ct.name)
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

async function loadManifest() {
  return JSON.parse(await fs.readFile(path.resolve(ROOT, config.paths.contentTypesManifest), 'utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Phase 4 step 2.5: Publish documents whose source was    ║${RESET}`);
  console.log(`${BOLD}║  published. Drafts stay as drafts.                       ║${RESET}`);
  console.log(`${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  const manifest = await loadManifest();
  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings?.requestTimeoutMs ?? 30000,
  });

  const delay = config.settings?.requestDelayMs ?? 100;
  const transformedDir = path.resolve(ROOT, config.paths.transformedData || 'migration/data/transformed');
  const mapsDir = path.resolve(ROOT, config.paths.maps || 'migration/data/maps');

  const overall = { types: 0, published: 0, skippedDrafts: 0, skippedMissing: 0, failed: 0, errors: [] };

  for (const ct of manifest.contentTypes) {
    if (ct.skipDefault) continue;
    if (ct.kind === 'singleType') continue; // singletons handled differently; PUT is direct
    if (TYPE_FILTER && ct.name !== TYPE_FILTER) continue;
    // Content types with draftAndPublish: false don't have a publish action;
    // their records are always-published in Strapi 5. Skip them.
    if (ct.draftAndPublish === false) {
      console.log(`${DIM}— ${ct.name}: draftAndPublish=false in source — skipping (no draft/published distinction)${RESET}`);
      continue;
    }

    const plural = ct.queryName || `${ct.name}s`;
    const transformedPath = path.join(transformedDir, `${plural}.json`);
    const mapPath = path.join(mapsDir, `${plural}.json`);

    if (!existsSync(transformedPath)) {
      console.log(`${YELLOW}!${RESET} ${ct.name}: no transformed extract at ${path.relative(ROOT, transformedPath)} — skipping`);
      continue;
    }
    if (!existsSync(mapPath)) {
      console.log(`${YELLOW}!${RESET} ${ct.name}: no ID map at ${path.relative(ROOT, mapPath)} — run 04-load first. Skipping.`);
      continue;
    }

    const transformed = JSON.parse(await fs.readFile(transformedPath, 'utf8'));
    const records = Array.isArray(transformed) ? transformed : (transformed.data || []);
    const map = JSON.parse(await fs.readFile(mapPath, 'utf8'));

    const stats = { published: 0, skippedDrafts: 0, skippedMissing: 0, failed: 0, errors: [] };

    console.log('');
    console.log(`${BOLD}── ${ct.name} (${records.length} source records)${RESET}`);

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const sourceId = String(rec.id);
      const entry = map[sourceId];

      if (!entry || !entry.documentId || entry.error) {
        stats.skippedMissing++;
        continue;
      }

      // Source was a draft? Leave as draft in S5.
      if (!rec.published_at) {
        stats.skippedDrafts++;
        continue;
      }

      // Strapi 5 publishes via PUT with ?status=published query param and an
      // empty data body. The /actions/publish route exists in the admin
      // plugin only — not on the public REST API.
      const apiPath = `/api/${restPluralName(ct)}/${entry.documentId}?status=published`;
      try {
        await client.put(apiPath, {});
        stats.published++;
        if (delay > 0) await sleep(delay);
      } catch (err) {
        stats.failed++;
        const msg = err.message.slice(0, 300);
        stats.errors.push({ sourceId, documentId: entry.documentId, message: msg });
      }

      if ((i + 1) % 50 === 0) {
        process.stdout.write(`  ${DIM}${i + 1}/${records.length} processed (published ${stats.published}, drafts ${stats.skippedDrafts}, failed ${stats.failed})${RESET}\r`);
      }
    }

    process.stdout.write(' '.repeat(80) + '\r');
    const colorOk = stats.failed === 0 ? GREEN : YELLOW;
    console.log(`  ${colorOk}✓${RESET} published=${stats.published}  drafts=${stats.skippedDrafts}  missing=${stats.skippedMissing}  failed=${stats.failed}`);
    if (stats.errors.length > 0) {
      console.log(`  ${RED}First 3 errors:${RESET}`);
      for (const e of stats.errors.slice(0, 3)) {
        console.log(`    ${DIM}sourceId=${e.sourceId} docId=${e.documentId}${RESET}: ${e.message}`);
      }
    }

    overall.types++;
    overall.published += stats.published;
    overall.skippedDrafts += stats.skippedDrafts;
    overall.skippedMissing += stats.skippedMissing;
    overall.failed += stats.failed;
    overall.errors.push(...stats.errors.map((e) => ({ ...e, type: ct.name })));
  }

  console.log('');
  console.log(`${BOLD}── Phase 4b2 summary ──${RESET}`);
  console.log(`  types processed:  ${overall.types}`);
  console.log(`  ${GREEN}published:${RESET}        ${overall.published}`);
  console.log(`  ${DIM}skipped (drafts):${RESET} ${overall.skippedDrafts}`);
  console.log(`  ${DIM}skipped (missing):${RESET}${overall.skippedMissing}`);
  console.log(`  ${overall.failed > 0 ? RED : GREEN}failed:${RESET}           ${overall.failed}`);
  console.log('');

  if (overall.failed > 0) {
    console.log(`${YELLOW}!${RESET} Some publish actions failed. Re-run this step or check the affected records.`);
    console.log(`  ${CYAN}node migration/scripts/04b2-publish.js${RESET}`);
    process.exit(1);
  }

  console.log(`${GREEN}✓ Publish complete.${RESET} All non-draft records should now show "Published" in the Strapi 5 admin.`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
