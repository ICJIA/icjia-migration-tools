/**
 * @module 03a-collect-media
 * @description Phase 3a: Collect every UploadFile reference for migration.
 *
 * Combines two sources of truth:
 *
 *   1. **Strapi 3 SQLite `upload_file` table** — the authoritative list of all
 *      uploaded files (2,110 rows in ICJIA). Includes orphans (files not
 *      referenced by any content), which we may still want to migrate.
 *
 *   2. **Extracted JSON in `migration/data/raw/`** — the actual references the
 *      content uses, including UploadFiles inside components (Slide.image,
 *      etc.) that aren't trivially obvious from the table.
 *
 * Outputs `migration/data/media/uploadfile-manifest.json` keyed by hash:
 *
 *   {
 *     "<hash>": {
 *       sourceId: 17,
 *       name: "chicago-02.jpg",
 *       hash: "chicago_02_min_171806b0",
 *       ext: ".jpg",
 *       mime: "image/jpeg",
 *       size: 738.83,
 *       sourceUrl: "/uploads/chicago_02_min_171806b0.jpg",
 *       width: 1200, height: 800,
 *       alternativeText: null, caption: null, formats: {...},
 *       referencedBy: [{type: "post", recordId: "15", path: "splash"}, ...],
 *       isOrphaned: false
 *     }
 *   }
 *
 * Idempotent — re-running rebuilds the manifest from current state.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { openSourceDb, readTable } from '../lib/sqlite-reader.js';
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

async function loadManifest() {
  const p = path.resolve(ROOT, config.paths.contentTypesManifest);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Walk a record looking for UploadFile-shaped objects (have id + url + hash).
 * Records the path where each was found.
 */
function findUploadFiles(value, basePath = []) {
  const refs = [];
  const visit = (v, p) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, [...p, i]));
      return;
    }
    if (typeof v === 'object') {
      const isUpload =
        v.id !== undefined &&
        typeof v.url === 'string' &&
        typeof v.hash === 'string' &&
        typeof v.ext === 'string';
      if (isUpload) {
        refs.push({ path: p.join('.'), file: v });
        return; // don't recurse into UploadFile internals
      }
      for (const [k, val] of Object.entries(v)) {
        visit(val, [...p, k]);
      }
    }
  };
  visit(value, basePath);
  return refs;
}

async function main() {
  console.log(`${BOLD}── Phase 3a: Collect media references ──${RESET}\n`);

  const contentManifest = await loadManifest();
  const activeTypes = contentManifest.contentTypes.filter((c) => !c.skipDefault);

  // ── Step 1: Read upload_file table ──────────────────────────────────
  console.log(`${BOLD}Reading upload_file table from SQLite...${RESET}`);
  const dbPath = path.resolve(ROOT, config.strapi3.sqliteDbPath);
  const db = openSourceDb(dbPath);
  const uploadRows = readTable(db, 'upload_file');
  db.close();
  console.log(`  ${uploadRows.length} rows in upload_file`);

  // Index by hash for quick lookup; also by id for ref resolution
  const byHash = new Map();
  const byId = new Map();
  for (const row of uploadRows) {
    const entry = {
      sourceId: row.id,
      name: row.name,
      hash: row.hash,
      ext: row.ext,
      mime: row.mime,
      size: row.size,
      sourceUrl: row.url,
      width: row.width,
      height: row.height,
      alternativeText: row.alternativeText,
      caption: row.caption,
      formats: row.formats ? safeJsonParse(row.formats) : null,
      referencedBy: [],
      isOrphaned: true,
    };
    byHash.set(row.hash, entry);
    byId.set(row.id, entry);
  }

  // ── Step 2: Walk extracted JSONs to find references ─────────────────
  console.log('');
  console.log(`${BOLD}Walking extracted JSON for UploadFile references...${RESET}`);
  const rawDir = path.resolve(ROOT, config.paths.rawData);

  let totalRefs = 0;
  let unmatchedRefs = 0;
  const unmatchedSamples = [];

  for (const ct of activeTypes) {
    const fileName = ct.queryName + '.json';
    const filePath = path.join(rawDir, fileName);
    if (!existsSync(filePath)) {
      console.log(`  ${YELLOW}skip${RESET} ${ct.name} (no extract found)`);
      continue;
    }
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : [parsed];

    let typeRefs = 0;
    for (const record of records) {
      const refs = findUploadFiles(record, []);
      for (const ref of refs) {
        const id = typeof ref.file.id === 'string' ? parseInt(ref.file.id, 10) : ref.file.id;
        const entry = byId.get(id);
        if (entry) {
          entry.isOrphaned = false;
          entry.referencedBy.push({
            type: ct.name,
            recordId: String(record.id),
            path: ref.path,
          });
          typeRefs++;
          totalRefs++;
        } else {
          unmatchedRefs++;
          if (unmatchedSamples.length < 5) {
            unmatchedSamples.push({
              type: ct.name,
              recordId: String(record.id),
              path: ref.path,
              file: ref.file,
            });
          }
        }
      }
    }
    console.log(`  ${ct.name.padEnd(16)} ${typeRefs.toString().padStart(5)} refs from ${records.length} records`);
  }

  // ── Step 3: Compute orphans ─────────────────────────────────────────
  const orphans = uploadRows.filter((r) => byHash.get(r.hash).isOrphaned);

  console.log('');
  console.log(`${BOLD}Reference summary:${RESET}`);
  console.log(`  Total UploadFile rows:      ${uploadRows.length}`);
  console.log(`  Referenced by content:      ${uploadRows.length - orphans.length}`);
  console.log(`  Orphans (no references):    ${orphans.length}`);
  console.log(`  Total references in extract: ${totalRefs}`);
  if (unmatchedRefs > 0) {
    console.log(`  ${YELLOW}Unmatched refs (id not in upload_file): ${unmatchedRefs}${RESET}`);
    for (const s of unmatchedSamples) {
      console.log(`    - ${s.type}.${s.recordId}.${s.path}: id=${s.file.id} hash=${s.file.hash}`);
    }
  }

  // ── Step 4: Persist manifest ────────────────────────────────────────
  const mediaDir = path.resolve(ROOT, config.paths.media);
  await fs.mkdir(mediaDir, { recursive: true });
  const manifestPath = path.join(mediaDir, 'uploadfile-manifest.json');

  const manifestData = {
    generatedAt: new Date().toISOString(),
    totals: {
      uploadFiles: uploadRows.length,
      referenced: uploadRows.length - orphans.length,
      orphans: orphans.length,
      referencesInContent: totalRefs,
      unmatchedRefs,
    },
    files: Object.fromEntries([...byHash.entries()].map(([k, v]) => [k, v])),
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, 2));
  console.log('');
  console.log(`${GREEN}Saved${RESET} → ${path.relative(ROOT, manifestPath)}`);
  console.log('');
  console.log('Next: 03b-download-media (download files from agency.icjia-api.cloud)');
  console.log(`  ${CYAN}node migration/scripts/03b-download-media.js${RESET}`);
  console.log('');
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
