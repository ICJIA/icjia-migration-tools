/**
 * @module 03b-decode-base64
 * @description Phase 3b: Decode Base64 image data to binary files.
 *
 * Reads the manifest produced by 03a, extracts Base64 payloads from
 * the raw article/app data, decodes them, validates magic bytes, and
 * writes binary files to `migration/data/media/files/`.
 *
 * Individual image failures are logged but do not abort the script.
 *
 * @example
 *   node migration/scripts/03b-decode-base64.js
 *
 * Prerequisites:
 * - Phase 3a complete (data/media/manifest.json exists)
 * - Phase 2 complete (data/raw/articles.json and data/raw/apps.json exist)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeBase64ToFile, detectMimeFromBytes } from '../lib/base64-decoder.js';
import { scanStringField, scanMarkdownImages, scanHtmlImages, scanJsonField } from '../lib/base64-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

/**
 * Extract the Base64 data for a manifest entry from the raw content.
 *
 * @param {Object} entry - Manifest image entry
 * @param {Object} articlesById - Map of article ID to raw article
 * @param {Object} appsById - Map of app ID to raw app
 * @returns {string|null} The raw Base64 string, or null if not found
 */
function extractBase64(entry, articlesById, appsById) {
  if (entry.contentType === 'app') {
    const app = appsById[entry.appId];
    if (!app) return null;

    if (entry.location === 'image') {
      const result = scanStringField(app.image);
      return result && result.found ? result.base64Data : null;
    }
    return null;
  }

  // Article
  const article = articlesById[entry.articleId];
  if (!article) return null;

  if (entry.location === 'splash') {
    const result = scanStringField(article.splash);
    return result && result.found ? result.base64Data : null;
  }

  if (entry.location === 'thumbnail') {
    const result = scanStringField(article.thumbnail);
    return result && result.found ? result.base64Data : null;
  }

  if (entry.location === 'inline') {
    const mdImages = scanMarkdownImages(article.markdown);
    const idx = entry.index;
    return idx < mdImages.length ? mdImages[idx].base64Data : null;
  }

  if (entry.location === 'html-inline') {
    const htmlImages = scanHtmlImages(article.markdown);
    const idx = entry.index;
    return idx < htmlImages.length ? htmlImages[idx].base64Data : null;
  }

  if (entry.location === 'images-json') {
    const jsonResults = scanJsonField(article.images, entry.articleSlug);
    const idx = entry.index;
    return idx < jsonResults.length ? jsonResults[idx].base64Data : null;
  }

  return null;
}

async function main() {
  console.log('=== Phase 3b: Decode Base64 to Binary Files ===\n');

  // Show config
  console.log('Configuration:');
  console.log(`  Raw data dir:  ${config.paths.rawData}`);
  console.log(`  Media dir:     ${config.paths.media}`);
  console.log('');

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const mediaDir = path.resolve(ROOT, config.paths.media);
  const filesDir = path.join(mediaDir, 'files');

  // Load manifest
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(mediaDir, 'manifest.json'), 'utf-8'));
    console.log(`Loaded manifest: ${manifest.images.length} images to decode`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read manifest.json: ${err.message}${RESET}`);
    console.error(`${RED}Run Phase 3 first: pnpm migrate:phase03${RESET}`);
    process.exit(1);
  }

  // Load raw articles and apps
  let articles, apps;
  try {
    articles = JSON.parse(await fs.readFile(path.join(rawDir, 'articles.json'), 'utf-8'));
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read articles.json: ${err.message}${RESET}`);
    process.exit(1);
  }

  try {
    apps = JSON.parse(await fs.readFile(path.join(rawDir, 'apps.json'), 'utf-8'));
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read apps.json: ${err.message}${RESET}`);
    process.exit(1);
  }

  // Build lookup maps
  const articlesById = {};
  for (const a of articles) {
    articlesById[a.id] = a;
  }
  const appsById = {};
  for (const a of apps) {
    appsById[a.id] = a;
  }

  // Create output directory
  await fs.mkdir(filesDir, { recursive: true });

  // Decode each image
  const failures = [];
  let successCount = 0;

  console.log(`\nDecoding ${manifest.images.length} images...\n`);

  for (let i = 0; i < manifest.images.length; i++) {
    const entry = manifest.images[i];
    const progress = `[${i + 1}/${manifest.images.length}]`;

    // Extract Base64 data from raw content
    const base64Data = extractBase64(entry, articlesById, appsById);

    if (!base64Data) {
      const errMsg = 'Base64 data not found in raw content';
      console.log(`  ${progress} ${entry.filename} — ${RED}FAILED (${errMsg})${RESET}`);
      failures.push({ ...entry, error: errMsg });
      continue;
    }

    // Decode and write
    const outputPath = path.join(filesDir, entry.filename);
    const result = await decodeBase64ToFile(base64Data, outputPath);

    if (!result.success) {
      console.log(`  ${progress} ${entry.filename} — ${RED}FAILED (${result.error})${RESET}`);
      failures.push({ ...entry, error: result.error });
      continue;
    }

    // Check for MIME mismatch
    const sizeKB = Math.round(result.size / 1024);
    if (result.detectedMime && result.detectedMime !== entry.mimeType) {
      console.log(`  ${progress} ${entry.filename} — ${sizeKB} KB ${YELLOW}(MIME mismatch: declared ${entry.mimeType}, detected ${result.detectedMime})${RESET}`);
    } else {
      console.log(`  ${progress} ${entry.filename} — ${sizeKB} KB ${GREEN}\u2713${RESET}`);
    }

    successCount++;
  }

  // Update manifest with failures
  manifest.failures = failures;
  await fs.writeFile(path.join(mediaDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Summary
  console.log(`\n${GREEN}Decode complete: ${successCount} succeeded, ${failures.length} failed${RESET}`);
  if (failures.length > 0) {
    console.log(`${YELLOW}Failures logged in manifest.json under "failures"${RESET}`);
    for (const f of failures) {
      console.log(`  ${RED}\u2717 ${f.filename}: ${f.error}${RESET}`);
    }
  }
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
