/**
 * @module 03a-scan-base64
 * @description Phase 3a: Scan articles and apps for Base64-encoded images.
 *
 * Scans every article's `splash`, `thumbnail`, `images` (json), and `markdown`
 * fields, plus every app's `image` field, for Base64 image data. Produces a
 * manifest at `migration/data/media/manifest.json` listing every image found.
 *
 * Filename conventions:
 * - Splash:    `{slug}-splash.{ext}`
 * - Thumbnail: `{slug}-thumbnail.{ext}`
 * - Inline:    `{slug}-{NNN}.{ext}` (zero-padded 3-digit index)
 * - App image: `app-{slug}-image.{ext}`
 *
 * @example
 *   node migration/scripts/03a-scan-base64.js
 *
 * Prerequisites:
 * - Phase 2 complete (data/raw/articles.json and data/raw/apps.json exist)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
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
 * Sanitize a slug for use in filenames.
 * Replaces non-alphanumeric characters (except hyphens) with hyphens, truncates to 80 chars.
 *
 * @param {string} slug - Raw slug value
 * @returns {string} Sanitized slug
 */
function sanitizeSlug(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

/**
 * Get the file extension for a MIME type.
 * @param {string} mime - MIME type string (e.g., 'image/png')
 * @returns {string} File extension without dot
 */
function extFromMime(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return map[mime] || 'png';
}

/**
 * Estimate file size from Base64 string length.
 * Base64 encodes 3 bytes into 4 characters.
 * @param {number} base64Length - Length of the Base64 string
 * @returns {string} Human-readable estimated size
 */
function estimateSize(base64Length) {
  const bytes = Math.ceil((base64Length * 3) / 4);
  if (bytes < 1024) return `~${bytes} B`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)} KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  console.log('=== Phase 3a: Scan for Base64 Images ===\n');

  // Show config
  console.log('Configuration:');
  console.log(`  Raw data dir:  ${config.paths.rawData}`);
  console.log(`  Media dir:     ${config.paths.media}`);
  console.log('');

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const mediaDir = path.resolve(ROOT, config.paths.media);

  // Load raw data
  let articles, apps;
  try {
    articles = JSON.parse(await fs.readFile(path.join(rawDir, 'articles.json'), 'utf-8'));
    console.log(`Loaded ${articles.length} articles from articles.json`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read articles.json: ${err.message}${RESET}`);
    console.error(`${RED}Run Phase 2 first: pnpm migrate:phase02${RESET}`);
    process.exit(1);
  }

  try {
    apps = JSON.parse(await fs.readFile(path.join(rawDir, 'apps.json'), 'utf-8'));
    console.log(`Loaded ${apps.length} apps from apps.json`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read apps.json: ${err.message}${RESET}`);
    console.error(`${RED}Run Phase 2 first: pnpm migrate:phase02${RESET}`);
    process.exit(1);
  }

  console.log('');

  const images = [];
  const summary = {
    totalImages: 0,
    splashImages: 0,
    thumbnailImages: 0,
    inlineImages: 0,
    htmlImages: 0,
    imagesFieldImages: 0,
    appImages: 0,
    articlesWithNoSplash: 0,
    articlesWithNoThumbnail: 0,
    articlesWithNoInlineImages: 0,
    byMimeType: {},
  };

  // ── Scan Articles ──────────────────────────────────────────────────

  console.log(`Scanning ${articles.length} articles for Base64 images...`);

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const rawSlug = sanitizeSlug(article.slug);
    const slug = rawSlug || `article-${article.id}`;
    let splashCount = 0;
    let thumbCount = 0;
    let inlineCount = 0;

    // 1. Splash field
    const splashResult = scanStringField(article.splash);
    if (splashResult && splashResult.found) {
      const ext = extFromMime(splashResult.mimeType);
      const filename = `${slug}-splash.${ext}`;
      images.push({
        articleId: article.id,
        articleSlug: slug,
        contentType: 'article',
        location: 'splash',
        mimeType: splashResult.mimeType,
        filename,
        altText: null,
        base64Length: splashResult.base64Data.length,
        estimatedFileSize: estimateSize(splashResult.base64Data.length),
      });
      summary.splashImages++;
      summary.byMimeType[splashResult.mimeType] = (summary.byMimeType[splashResult.mimeType] || 0) + 1;
      splashCount = 1;
    } else {
      summary.articlesWithNoSplash++;
    }

    // 2. Thumbnail field
    const thumbResult = scanStringField(article.thumbnail);
    if (thumbResult && thumbResult.found) {
      const ext = extFromMime(thumbResult.mimeType);
      const filename = `${slug}-thumbnail.${ext}`;
      images.push({
        articleId: article.id,
        articleSlug: slug,
        contentType: 'article',
        location: 'thumbnail',
        mimeType: thumbResult.mimeType,
        filename,
        altText: null,
        base64Length: thumbResult.base64Data.length,
        estimatedFileSize: estimateSize(thumbResult.base64Data.length),
      });
      summary.thumbnailImages++;
      summary.byMimeType[thumbResult.mimeType] = (summary.byMimeType[thumbResult.mimeType] || 0) + 1;
      thumbCount = 1;
    } else {
      summary.articlesWithNoThumbnail++;
    }

    // 3. Images field (JSON)
    const jsonResults = scanJsonField(article.images, slug);
    for (let j = 0; j < jsonResults.length; j++) {
      const jr = jsonResults[j];
      const ext = extFromMime(jr.mimeType);
      const filename = `${slug}-imgfield-${String(j).padStart(3, '0')}.${ext}`;
      images.push({
        articleId: article.id,
        articleSlug: slug,
        contentType: 'article',
        location: 'images-json',
        index: j,
        jsonPath: jr.path,
        mimeType: jr.mimeType,
        filename,
        altText: null,
        base64Length: jr.base64Data.length,
        estimatedFileSize: estimateSize(jr.base64Data.length),
      });
      summary.imagesFieldImages++;
      summary.byMimeType[jr.mimeType] = (summary.byMimeType[jr.mimeType] || 0) + 1;
    }

    // 4. Markdown inline images
    const mdImages = scanMarkdownImages(article.markdown);
    for (let j = 0; j < mdImages.length; j++) {
      const img = mdImages[j];
      const ext = extFromMime(img.mimeType);
      const filename = `${slug}-${String(j).padStart(3, '0')}.${ext}`;
      images.push({
        articleId: article.id,
        articleSlug: slug,
        contentType: 'article',
        location: 'inline',
        index: j,
        mimeType: img.mimeType,
        filename,
        altText: img.altText || null,
        base64Length: img.base64Data.length,
        estimatedFileSize: estimateSize(img.base64Data.length),
      });
      summary.inlineImages++;
      summary.byMimeType[img.mimeType] = (summary.byMimeType[img.mimeType] || 0) + 1;
      inlineCount++;
    }

    if (mdImages.length === 0) {
      summary.articlesWithNoInlineImages++;
    }

    // 5. HTML fallback scan
    const htmlImages = scanHtmlImages(article.markdown);
    for (let j = 0; j < htmlImages.length; j++) {
      const img = htmlImages[j];
      const ext = extFromMime(img.mimeType);
      const filename = `${slug}-html-${String(j).padStart(3, '0')}.${ext}`;
      images.push({
        articleId: article.id,
        articleSlug: slug,
        contentType: 'article',
        location: 'html-inline',
        index: j,
        mimeType: img.mimeType,
        filename,
        altText: null,
        base64Length: img.base64Data.length,
        estimatedFileSize: estimateSize(img.base64Data.length),
      });
      summary.htmlImages++;
      summary.byMimeType[img.mimeType] = (summary.byMimeType[img.mimeType] || 0) + 1;
    }

    console.log(`  Article ${i + 1}/${articles.length}: ${slug} — ${splashCount} splash + ${thumbCount} thumbnail + ${inlineCount} inline${htmlImages.length ? ` + ${htmlImages.length} html` : ''}${jsonResults.length ? ` + ${jsonResults.length} images-json` : ''}`);
  }

  // ── Scan Apps ──────────────────────────────────────────────────────

  console.log(`\nScanning ${apps.length} apps for Base64 images...`);

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const rawSlug = sanitizeSlug(app.slug);
    const slug = rawSlug || `app-${app.id}`;

    const imageResult = scanStringField(app.image);
    if (imageResult && imageResult.found) {
      const ext = extFromMime(imageResult.mimeType);
      const filename = `app-${slug}-image.${ext}`;
      images.push({
        appId: app.id,
        appSlug: slug,
        contentType: 'app',
        location: 'image',
        mimeType: imageResult.mimeType,
        filename,
        altText: null,
        base64Length: imageResult.base64Data.length,
        estimatedFileSize: estimateSize(imageResult.base64Data.length),
      });
      summary.appImages++;
      summary.byMimeType[imageResult.mimeType] = (summary.byMimeType[imageResult.mimeType] || 0) + 1;
      console.log(`  App ${i + 1}/${apps.length}: ${slug} — 1 image`);
    } else {
      console.log(`  App ${i + 1}/${apps.length}: ${slug} — no Base64 image`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────

  summary.totalImages = images.length;

  // Estimate total size
  const totalBase64Chars = images.reduce((sum, img) => sum + img.base64Length, 0);
  summary.estimatedTotalSize = estimateSize(totalBase64Chars);

  // Check for duplicate filenames
  const filenames = images.map(img => img.filename);
  const dupes = filenames.filter((f, i) => filenames.indexOf(f) !== i);
  if (dupes.length > 0) {
    console.log(`\n${YELLOW}WARNING: ${dupes.length} duplicate filenames detected:${RESET}`);
    for (const d of [...new Set(dupes)]) {
      console.log(`  ${YELLOW}${d}${RESET}`);
    }
  }

  // Save manifest
  const manifest = { images, summary };
  await fs.mkdir(mediaDir, { recursive: true });
  const manifestPath = path.join(mediaDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n${GREEN}Scan complete: ${images.length} images found (${summary.splashImages} splash, ${summary.thumbnailImages} thumbnail, ${summary.inlineImages} inline, ${summary.htmlImages} html, ${summary.imagesFieldImages} images-json, ${summary.appImages} app images)${RESET}`);
  console.log(`Estimated total size: ${summary.estimatedTotalSize}`);
  console.log(`Manifest saved to ${path.relative(ROOT, manifestPath)}`);
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
