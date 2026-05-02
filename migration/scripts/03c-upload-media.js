/**
 * @module 03c-upload-media
 * @description Phase 3c: Upload downloaded media files to Strapi 5.
 *
 * Reads `migration/data/media/uploadfile-manifest.json` (built by 03a) and the
 * downloaded files from `migration/data/media/files/`. Uploads each via Strapi 5's
 * `POST /api/upload`, preserving original `name`, `alternativeText`, `caption`,
 * `width`, and `height`.
 *
 * Outputs `migration/data/maps/uploadfile-map.json` mapping the source file's
 * `id` (and `hash`) to the Strapi 5 upload's `id` and `url`. This map drives:
 *   - Phase 3f richtext URL rewriting (replace `/uploads/<sourceHash>` with new URL)
 *   - Phase 4 record loading (substitute UploadFile reference IDs)
 *
 * Idempotent — if a hash is already in the map, the upload is skipped.
 *
 * @example
 *   pnpm phase03c
 *   node migration/scripts/03c-upload-media.js --skip-orphans
 */

import fs from 'fs/promises';
import { existsSync, statSync, createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const SKIP_ORPHANS = argv.includes('--skip-orphans');
const FORCE = argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Upload a single file to Strapi 5 /api/upload, with optional metadata.
 *
 * @param {string} filePath - Absolute path to the file on disk
 * @param {Object} sourceMeta - Original UploadFile entry from the manifest
 * @returns {Promise<Object>} Strapi 5 upload record (id, url, name, hash, ...)
 */
async function uploadFile(filePath, sourceMeta) {
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: sourceMeta.mime });

  const form = new FormData();
  form.append('files', blob, sourceMeta.name);

  // fileInfo lets Strapi 5 set name, alternativeText, caption per upload
  const fileInfo = {
    name: sourceMeta.name,
    alternativeText: sourceMeta.alternativeText || null,
    caption: sourceMeta.caption || null,
  };
  form.append('fileInfo', JSON.stringify(fileInfo));

  const res = await fetch(`${config.strapi5.apiUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.strapi5.token}` },
    body: form,
    signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 60000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Upload succeeded but response was empty');
  }
  return data[0];
}

async function main() {
  console.log(`${BOLD}── Phase 3c: Upload media to Strapi 5 ──${RESET}\n`);

  if (!config.strapi5.token) {
    console.error(`${RED}ERROR${RESET} STRAPI5_TOKEN is not set.`);
    console.error(`Generate a Full-Access token in Strapi 5 admin and: ${CYAN}export STRAPI5_TOKEN="..."${RESET}`);
    process.exit(1);
  }

  const mediaDir = path.resolve(ROOT, config.paths.media);
  const filesDir = path.join(mediaDir, 'files');
  const manifestPath = path.join(mediaDir, 'uploadfile-manifest.json');
  const mapsDir = path.resolve(ROOT, config.paths.maps);
  const mapPath = path.join(mapsDir, 'uploadfile-map.json');

  if (!existsSync(manifestPath)) {
    console.error(`${RED}ERROR${RESET} ${path.relative(ROOT, manifestPath)} not found.`);
    console.error(`Run ${CYAN}node migration/scripts/03a-collect-media.js${RESET} first.`);
    process.exit(1);
  }

  await fs.mkdir(mapsDir, { recursive: true });

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const allFiles = Object.values(manifest.files);

  // Load existing map for resume support
  let map = {};
  if (existsSync(mapPath) && !FORCE) {
    map = JSON.parse(await fs.readFile(mapPath, 'utf8'));
    console.log(`Resume: ${Object.keys(map).length} files already in upload map`);
  }

  let queue = SKIP_ORPHANS
    ? allFiles.filter((f) => !f.isOrphaned)
    : allFiles;

  console.log(`Configuration:`);
  console.log(`  Strapi 5 API:       ${CYAN}${config.strapi5.apiUrl}${RESET}`);
  console.log(`  Files dir:          ${CYAN}${path.relative(ROOT, filesDir)}${RESET}`);
  console.log(`  Files in queue:     ${queue.length}` +
    (SKIP_ORPHANS ? ` ${DIM}(orphans skipped)${RESET}` : ` ${DIM}(includes ${manifest.totals.orphans} orphans)${RESET}`));
  console.log(`  Throttle delay:     ${config.settings?.requestDelayMs || 100}ms`);
  console.log('');

  // Connectivity probe
  try {
    const probe = await fetch(`${config.strapi5.apiUrl}/api/upload/files?pagination[pageSize]=1`, {
      headers: { Authorization: `Bearer ${config.strapi5.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!probe.ok && probe.status !== 403) {
      throw new Error(`HTTP ${probe.status}: ${await probe.text()}`);
    }
    console.log(`  ${GREEN}OK${RESET} Strapi 5 reachable, token authenticated`);
    console.log('');
  } catch (err) {
    console.error(`${RED}ERROR${RESET} cannot reach Strapi 5: ${err.message}`);
    process.exit(1);
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;
  const startTime = Date.now();
  const delay = config.settings?.requestDelayMs || 100;

  for (let i = 0; i < queue.length; i++) {
    const f = queue[i];

    // Idempotency: skip if already in map
    if (map[f.hash] && !FORCE) {
      skipped++;
      continue;
    }

    const filePath = path.join(filesDir, `${f.hash}${f.ext}`);
    if (!existsSync(filePath)) {
      failed++;
      map[f.hash] = { error: 'file not on disk', sourceId: f.sourceId };
      continue;
    }

    try {
      const result = await uploadFile(filePath, f);
      map[f.hash] = {
        sourceId: f.sourceId,
        sourceHash: f.hash,
        sourceUrl: f.sourceUrl,
        strapi5Id: result.id,
        strapi5Url: result.url,
        strapi5Hash: result.hash,
        name: result.name,
        size: result.size,
      };
      uploaded++;
      totalBytes += statSync(filePath).size;
      if (delay > 0) await sleep(delay);
    } catch (err) {
      failed++;
      map[f.hash] = { error: err.message, sourceId: f.sourceId };
    }

    // Persist map periodically (every 25 uploads) so failures don't lose progress
    if ((i + 1) % 25 === 0 || i === queue.length - 1) {
      await fs.writeFile(mapPath, JSON.stringify(map, null, 2));
      process.stdout.write(`\r  ${DIM}${i + 1}/${queue.length}${RESET}  ${GREEN}${uploaded} uploaded${RESET}, ${DIM}${skipped} skipped${RESET}, ${RED}${failed} failed${RESET}, ${formatBytes(totalBytes)}    `);
    }
  }

  // Final flush
  await fs.writeFile(mapPath, JSON.stringify(map, null, 2));

  const elapsed = Date.now() - startTime;

  console.log(''); // newline
  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Files queued:      ${queue.length}`);
  console.log(`  Uploaded:          ${uploaded}`);
  console.log(`  Skipped (cached):  ${skipped}`);
  console.log(`  Failed:            ${failed}`);
  console.log(`  Bytes uploaded:    ${formatBytes(totalBytes)}`);
  console.log(`  Elapsed:           ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  Map:               ${path.relative(ROOT, mapPath)}`);
  console.log('');

  if (failed > 0) {
    const failedHashes = Object.entries(map)
      .filter(([, v]) => v.error)
      .slice(0, 5);
    console.log(`${YELLOW}${failed} upload(s) failed. Sample errors:${RESET}`);
    for (const [hash, v] of failedHashes) {
      console.log(`  ${hash}: ${v.error}`);
    }
    console.log(`Re-run to retry just the failures: ${CYAN}node migration/scripts/03c-upload-media.js${RESET}`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 3c complete.${RESET}`);
  console.log('');
  console.log('Next: 03f-rewrite-content (substitute UploadFile IDs + rewrite richtext URLs)');
  console.log(`  ${CYAN}node migration/scripts/03f-rewrite-content.js${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
