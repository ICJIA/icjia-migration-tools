/**
 * @module 03c-upload-media
 * @description Phase 3c: Upload decoded media files to Strapi 5.
 *
 * Reads the media manifest, uploads each decoded file from `data/media/files/`
 * to Strapi 5's media library via `POST /api/upload`, and records the mapping
 * (filename -> Strapi 5 media ID and URL) in `data/maps/media.json`.
 *
 * Idempotent: checks if a file with the same name already exists in Strapi 5
 * before uploading. Safe to re-run after partial completion.
 *
 * @example
 *   node migration/scripts/03c-upload-media.js
 *
 * Prerequisites:
 * - Phase 3b complete (decoded files in data/media/files/)
 * - Strapi 5 running at configured URL with valid API token
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

/**
 * Check if a file already exists in the Strapi 5 media library.
 *
 * @param {string} filename - The filename to check
 * @param {string} apiUrl - Strapi 5 API base URL
 * @param {string} token - API token
 * @returns {Promise<Object|null>} Existing media record or null
 */
async function checkExistingMedia(filename, apiUrl, token) {
  const url = `${apiUrl}/api/upload/files?filters[name][$eq]=${encodeURIComponent(filename)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 30000),
  });

  if (!res.ok) return null;

  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }
  return null;
}

/**
 * Upload a file to Strapi 5 media library.
 *
 * Uses native Node.js FormData (Node 18+) with a Blob created from the file buffer.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {string} filename - Desired filename
 * @param {string} mimeType - MIME type of the file
 * @param {string} apiUrl - Strapi 5 API base URL
 * @param {string} token - API token
 * @returns {Promise<Object>} Strapi 5 media record
 */
async function uploadFile(filePath, filename, mimeType, apiUrl, token) {
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: mimeType });

  const form = new FormData();
  form.append('files', blob, filename);

  const res = await fetch(`${apiUrl}/api/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }
  throw new Error('Upload succeeded but response was empty');
}

/**
 * Delay for the specified number of milliseconds.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Phase 3c: Upload Media to Strapi 5 ===\n');

  const apiUrl = config.strapi5.apiUrl;
  const token = config.strapi5.token;
  const delayMs = config.settings?.requestDelayMs || 100;

  // Show config
  console.log('Configuration:');
  console.log(`  Strapi 5 API:  ${apiUrl}`);
  console.log(`  Strapi 5 token: ${token ? '(set)' : `${RED}(NOT SET)${RESET}`}`);
  console.log(`  Upload delay:  ${delayMs}ms`);
  console.log(`  Media dir:     ${config.paths.media}`);
  console.log(`  Maps dir:      ${config.paths.maps}`);
  console.log('');

  if (!token) {
    console.error(`${RED}ERROR: Strapi 5 API token is not configured.${RESET}`);
    console.error(`${RED}Set strapi5.token in config.js or STRAPI5_TOKEN env var.${RESET}`);
    process.exit(1);
  }

  const mediaDir = path.resolve(ROOT, config.paths.media);
  const filesDir = path.join(mediaDir, 'files');
  const mapsDir = path.resolve(ROOT, config.paths.maps);

  // Load manifest
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(mediaDir, 'manifest.json'), 'utf-8'));
    console.log(`Loaded manifest: ${manifest.images.length} images`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read manifest.json: ${err.message}${RESET}`);
    console.error(`${RED}Run Phase 3 first: pnpm migrate:phase03${RESET}`);
    process.exit(1);
  }

  // Load existing media map (for resume support)
  let mediaMap = {};
  await fs.mkdir(mapsDir, { recursive: true });
  const mediaMapPath = path.join(mapsDir, 'media.json');
  try {
    mediaMap = JSON.parse(await fs.readFile(mediaMapPath, 'utf-8'));
    console.log(`Loaded existing media map: ${Object.keys(mediaMap).length} entries`);
  } catch {
    // No existing map — starting fresh
  }

  // Filter to only successfully decoded images (exclude failures)
  const failedFilenames = new Set((manifest.failures || []).map(f => f.filename));
  const toProcess = manifest.images.filter(img => !failedFilenames.has(img.filename));

  console.log(`\nUploading ${toProcess.length} files to Strapi 5 media library...\n`);

  // Check Strapi 5 connectivity
  try {
    const healthRes = await fetch(`${apiUrl}/api/upload/files?pagination[pageSize]=1`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 30000),
    });
    if (!healthRes.ok) {
      throw new Error(`HTTP ${healthRes.status}: ${await healthRes.text()}`);
    }
    console.log(`${GREEN}\u2713 Strapi 5 is reachable and API token is valid${RESET}\n`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot connect to Strapi 5: ${err.message}${RESET}`);
    console.error(`${RED}Ensure Strapi 5 is running at ${apiUrl} with a valid API token.${RESET}`);
    process.exit(1);
  }

  let uploadedCount = 0;
  let skippedCount = 0;
  let failCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const entry = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;

    // Skip if already in our map
    if (mediaMap[entry.filename]) {
      console.log(`  ${progress} ${entry.filename} — already in map (ID: ${mediaMap[entry.filename].strapi5MediaId}), skipping`);
      skippedCount++;
      continue;
    }

    try {
      // Check if already exists in Strapi 5
      const existing = await checkExistingMedia(entry.filename, apiUrl, token);

      if (existing) {
        mediaMap[entry.filename] = {
          sourceArticleId: entry.articleId || null,
          sourceAppId: entry.appId || null,
          location: entry.location,
          index: entry.index ?? null,
          strapi5MediaId: existing.id,
          strapi5Url: existing.url,
        };
        console.log(`  ${progress} ${entry.filename} — already exists (ID: ${existing.id}), skipping`);
        skippedCount++;
      } else {
        // Upload the file
        const filePath = path.join(filesDir, entry.filename);
        const result = await uploadFile(filePath, entry.filename, entry.mimeType, apiUrl, token);

        mediaMap[entry.filename] = {
          sourceArticleId: entry.articleId || null,
          sourceAppId: entry.appId || null,
          location: entry.location,
          index: entry.index ?? null,
          strapi5MediaId: result.id,
          strapi5Url: result.url,
        };
        console.log(`  ${progress} ${entry.filename} — ${GREEN}uploaded (ID: ${result.id})${RESET}`);
        uploadedCount++;
      }

      // Save map incrementally (resume support)
      await fs.writeFile(mediaMapPath, JSON.stringify(mediaMap, null, 2));

      // Rate-limit delay
      if (delayMs > 0) await delay(delayMs);

    } catch (err) {
      console.log(`  ${progress} ${entry.filename} — ${RED}FAILED: ${err.message}${RESET}`);
      failCount++;
    }
  }

  // Final save
  await fs.writeFile(mediaMapPath, JSON.stringify(mediaMap, null, 2));

  // Summary
  console.log(`\n${GREEN}Upload complete: ${toProcess.length} files processed (${uploadedCount} uploaded, ${skippedCount} already existed, ${failCount} failed)${RESET}`);
  console.log(`Media map saved to ${path.relative(ROOT, mediaMapPath)}`);

  if (failCount > 0) {
    console.log(`${YELLOW}WARNING: ${failCount} uploads failed. Review errors above and re-run to retry.${RESET}`);
  }
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
