/**
 * @module 03b-download-media
 * @description Phase 3b: Download every UploadFile from the Strapi 3 source.
 *
 * Reads `migration/data/media/uploadfile-manifest.json` (built by 03a) and
 * fetches each file from `<strapi3.apiUrl><sourceUrl>` (e.g.,
 * `https://agency.icjia-api.cloud/uploads/<hash><ext>`) into
 * `migration/data/media/files/<hash><ext>`.
 *
 * Idempotent — files already present on disk with matching size are skipped.
 * Throttled via `config.settings.requestDelayMs` to avoid overwhelming the
 * source server.
 *
 * Also downloads orphan files (in `upload_file` but not referenced by any
 * content) so the migration is complete. Pass `--skip-orphans` to skip them
 * if bandwidth is a concern.
 *
 * @example
 *   pnpm phase03b                     # download everything (default)
 *   node migration/scripts/03b-download-media.js --skip-orphans
 *   node migration/scripts/03b-download-media.js --retry-failed
 */

import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from '../lib/load-config.js';
import { assertSafeUrl } from '../lib/security.js';

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
const RETRY_FAILED = argv.includes('--retry-failed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Download a single file via streaming. Writes to .partial then renames on success.
 */
async function downloadFile(sourceUrl, destPath, timeoutMs) {
  const tmp = `${destPath}.partial`;
  const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  // Use Node stream pipeline for memory-safe large-file handling
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await fs.rename(tmp, destPath);
  const stat = statSync(destPath);
  return stat.size;
}

async function main() {
  console.log(`${BOLD}── Phase 3b: Download media files ──${RESET}\n`);

  const mediaDir = path.resolve(ROOT, config.paths.media);
  const filesDir = path.join(mediaDir, 'files');
  const manifestPath = path.join(mediaDir, 'uploadfile-manifest.json');

  if (!existsSync(manifestPath)) {
    console.error(`${RED}ERROR${RESET} ${path.relative(ROOT, manifestPath)} not found.`);
    console.error(`Run ${CYAN}node migration/scripts/03a-collect-media.js${RESET} first.`);
    process.exit(1);
  }

  await fs.mkdir(filesDir, { recursive: true });

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const allFiles = Object.values(manifest.files);

  let queue = SKIP_ORPHANS
    ? allFiles.filter((f) => !f.isOrphaned)
    : allFiles;

  // If retry-failed, also restrict to entries previously marked failed
  const downloadStatusPath = path.join(mediaDir, 'download-status.json');
  let priorStatus = {};
  if (existsSync(downloadStatusPath)) {
    priorStatus = JSON.parse(await fs.readFile(downloadStatusPath, 'utf8')).files || {};
  }
  if (RETRY_FAILED) {
    queue = queue.filter((f) => priorStatus[f.hash]?.status === 'failed');
    console.log(`${YELLOW}--retry-failed${RESET}: limiting to ${queue.length} previously-failed files`);
  }

  const baseUrl = config.strapi3.apiUrl.replace(/\/$/, '');
  const timeout = config.settings?.requestTimeoutMs || 30000;
  const delay = config.settings?.requestDelayMs || 100;

  console.log(`Configuration:`);
  console.log(`  Source base URL:    ${CYAN}${baseUrl}${RESET}`);
  console.log(`  Local files dir:    ${CYAN}${path.relative(ROOT, filesDir)}${RESET}`);
  console.log(`  Files in queue:     ${queue.length}` +
    (SKIP_ORPHANS ? ` ${DIM}(orphans skipped)${RESET}` : ` ${DIM}(includes ${manifest.totals.orphans} orphans)${RESET}`));
  console.log(`  Throttle delay:     ${delay}ms`);
  console.log('');

  const status = { ...priorStatus };
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  for (let i = 0; i < queue.length; i++) {
    const f = queue[i];
    const fileName = `${f.hash}${f.ext}`;
    const destPath = path.join(filesDir, fileName);
    let sourceUrl;
    try {
      // Reject absolute / protocol-relative URLs in the manifest — the source
      // DB is semi-trusted and a poisoned `sourceUrl` field could redirect
      // downloads to an internal service (SSRF).
      sourceUrl = assertSafeUrl(f.sourceUrl, baseUrl).toString();
    } catch (err) {
      failed++;
      status[f.hash] = { status: 'failed', error: `Unsafe URL rejected: ${err.message}`, sourceUrl: f.sourceUrl };
      continue;
    }

    // Idempotent skip — file already on disk with matching size (within 1KB tolerance)
    if (existsSync(destPath)) {
      const localSize = statSync(destPath).size;
      // Source size is in KB (Strapi 3 convention); convert
      const expectedBytes = Math.round((f.size || 0) * 1024);
      if (Math.abs(localSize - expectedBytes) < 1024) {
        skipped++;
        status[f.hash] = { status: 'cached', localPath: fileName, localSize };
        if ((i + 1) % 100 === 0 || i === queue.length - 1) {
          process.stdout.write(`\r  ${DIM}${i + 1}/${queue.length}${RESET}  ${GREEN}${downloaded} downloaded${RESET}, ${DIM}${skipped} skipped${RESET}, ${RED}${failed} failed${RESET}, ${formatBytes(totalBytes)}    `);
        }
        continue;
      }
    }

    try {
      const bytes = await downloadFile(sourceUrl, destPath, timeout);
      downloaded++;
      totalBytes += bytes;
      status[f.hash] = { status: 'downloaded', localPath: fileName, localSize: bytes };
      if (delay > 0) await sleep(delay);
    } catch (err) {
      failed++;
      status[f.hash] = { status: 'failed', error: err.message, sourceUrl };
    }

    if ((i + 1) % 25 === 0 || i === queue.length - 1) {
      process.stdout.write(`\r  ${DIM}${i + 1}/${queue.length}${RESET}  ${GREEN}${downloaded} downloaded${RESET}, ${DIM}${skipped} skipped${RESET}, ${RED}${failed} failed${RESET}, ${formatBytes(totalBytes)}    `);
    }
  }

  const elapsed = Date.now() - startTime;

  // Persist status
  await fs.writeFile(
    downloadStatusPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        elapsedMs: elapsed,
        totals: { queued: queue.length, downloaded, skipped, failed, totalBytes },
        files: status,
      },
      null,
      2,
    ),
  );

  console.log(''); // newline after progress line
  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Files queued:     ${queue.length}`);
  console.log(`  Downloaded:       ${downloaded}`);
  console.log(`  Skipped (cached): ${skipped}`);
  console.log(`  Failed:           ${failed}`);
  console.log(`  Bytes downloaded: ${formatBytes(totalBytes)}`);
  console.log(`  Elapsed:          ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  Status file:      ${path.relative(ROOT, downloadStatusPath)}`);
  console.log('');

  if (failed > 0) {
    console.log(`${YELLOW}${failed} file(s) failed to download.${RESET}`);
    console.log(`Retry just the failures with: ${CYAN}node migration/scripts/03b-download-media.js --retry-failed${RESET}`);
    console.log('');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Phase 3b complete.${RESET}`);
  console.log('');
  console.log('Next: 03c-upload-media (re-upload to Strapi 5)');
  console.log(`  ${CYAN}node migration/scripts/03c-upload-media.js${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
