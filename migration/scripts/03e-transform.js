/**
 * @module 03e-transform
 * @description Phase 3e: Download/re-upload dataset datafiles, article mainfile/extrafile,
 * and transform datasets and apps.
 *
 * Handles three content types:
 *
 * **Datasets:**
 * - Downloads `datafile` from Strapi 3, re-uploads to Strapi 5
 * - Maps all fields, preserves timestamps and legacyId
 *
 * **Article media files (mainfile/extrafile):**
 * - Reads `data/transformed/articles.json` (output from 03d)
 * - Downloads mainfile/extrafile from Strapi 3, re-uploads to Strapi 5
 * - Updates the transformed articles with integer media IDs
 *
 * **Apps:**
 * - Maps image field to Strapi 5 media ID (from media map)
 * - Preserves all fields, timestamps, and relation IDs
 * - Apps get `_relatedDatasetIds` AND `_relatedArticleIds` (app is dominant on both)
 *
 * @example
 *   node migration/scripts/03e-transform.js
 *
 * Prerequisites:
 * - Phase 3d complete (data/transformed/articles.json exists)
 * - Strapi 3 running (for downloading files)
 * - Strapi 5 running with API token (for uploading files)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanStringField } from '../lib/base64-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

/**
 * Sanitize a slug for use in filenames (must match 03a logic).
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
 * @param {string} mime - MIME type string
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
 * Download a file from Strapi 3.
 *
 * @param {string} fileUrl - Relative or absolute URL (e.g., `/uploads/file.xlsx`)
 * @param {string} outputPath - Absolute path to save the downloaded file
 * @returns {Promise<{ success: boolean, size: number, error?: string }>}
 */
async function downloadFromStrapi3(fileUrl, outputPath) {
  try {
    const baseUrl = config.strapi3.apiUrl;
    const url = fileUrl.startsWith('http') ? fileUrl : `${baseUrl}${fileUrl}`;

    const headers = {};
    if (config.strapi3.token) {
      headers['Authorization'] = `Bearer ${config.strapi3.token}`;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 30000),
    });

    if (!res.ok) {
      return { success: false, size: 0, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buffer);

    return { success: true, size: buffer.length };
  } catch (err) {
    return { success: false, size: 0, error: err.message };
  }
}

/**
 * Check if a file already exists in Strapi 5 media library.
 *
 * @param {string} filename - Filename to check
 * @returns {Promise<Object|null>} Existing media record or null
 */
async function checkExistingMedia(filename) {
  const url = `${config.strapi5.apiUrl}/api/upload/files?filters[name][$eq]=${encodeURIComponent(filename)}`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${config.strapi5.token}` },
      signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch {
    return null;
  }
}

/**
 * Upload a file to Strapi 5 media library.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {string} filename - Desired filename
 * @param {string} mimeType - MIME type
 * @returns {Promise<Object>} Strapi 5 media record
 */
async function uploadToStrapi5(filePath, filename, mimeType) {
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' });

  const form = new FormData();
  form.append('files', blob, filename);

  const res = await fetch(`${config.strapi5.apiUrl}/api/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.strapi5.token}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) return data[0];
  throw new Error('Upload succeeded but response was empty');
}

/**
 * Download a file from Strapi 3, upload to Strapi 5, return the new media ID.
 * Idempotent — checks if file already exists in Strapi 5.
 *
 * @param {Object} mediaRef - Strapi 3 media object with `url`, `name`, `mime`
 * @param {string} filesDir - Directory to save downloaded files
 * @param {Object} mediaMap - Media map for recording the entry
 * @param {string} label - Label for logging
 * @returns {Promise<number|null>} Strapi 5 media ID or null on failure
 */
async function downloadAndReupload(mediaRef, filesDir, mediaMap, label) {
  if (!mediaRef || !mediaRef.url) return null;

  const filename = mediaRef.name || path.basename(mediaRef.url);
  const localPath = path.join(filesDir, filename);
  const mime = mediaRef.mime || 'application/octet-stream';

  // Check if already in media map
  if (mediaMap[filename] && mediaMap[filename].strapi5MediaId) {
    console.log(`    ${label}: ${filename} — already in map (ID: ${mediaMap[filename].strapi5MediaId})`);
    return mediaMap[filename].strapi5MediaId;
  }

  // Check if already in Strapi 5
  const existing = await checkExistingMedia(filename);
  if (existing) {
    mediaMap[filename] = {
      location: label,
      strapi5MediaId: existing.id,
      strapi5Url: existing.url,
    };
    console.log(`    ${label}: ${filename} — already in Strapi 5 (ID: ${existing.id})`);
    return existing.id;
  }

  // Download from Strapi 3
  const dlResult = await downloadFromStrapi3(mediaRef.url, localPath);
  if (!dlResult.success) {
    console.log(`    ${label}: ${filename} — ${RED}download failed: ${dlResult.error}${RESET}`);
    return null;
  }

  // Upload to Strapi 5
  try {
    const uploaded = await uploadToStrapi5(localPath, filename, mime);
    mediaMap[filename] = {
      location: label,
      strapi5MediaId: uploaded.id,
      strapi5Url: uploaded.url,
    };
    console.log(`    ${label}: ${filename} — ${GREEN}uploaded (ID: ${uploaded.id})${RESET}`);
    return uploaded.id;
  } catch (err) {
    console.log(`    ${label}: ${filename} — ${RED}upload failed: ${err.message}${RESET}`);
    return null;
  }
}

/**
 * Delay for the specified number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Phase 3e: Transform Datasets, Article Media, and Apps ===\n');

  const strapi3Url = config.strapi3.apiUrl;
  const strapi5Url = config.strapi5.apiUrl;
  const token = config.strapi5.token;
  const delayMs = config.settings?.requestDelayMs || 100;

  // Show config
  console.log('Configuration:');
  console.log(`  Strapi 3 API:       ${strapi3Url}`);
  console.log(`  Strapi 5 API:       ${strapi5Url}`);
  console.log(`  Strapi 5 token:     ${token ? '(set)' : `${RED}(NOT SET)${RESET}`}`);
  console.log(`  Raw data dir:       ${config.paths.rawData}`);
  console.log(`  Transformed dir:    ${config.paths.transformedData}`);
  console.log(`  Media dir:          ${config.paths.media}`);
  console.log(`  Maps dir:           ${config.paths.maps}`);
  console.log('');

  if (!token) {
    console.error(`${RED}ERROR: Strapi 5 API token is not configured.${RESET}`);
    process.exit(1);
  }

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);
  const mediaDir = path.resolve(ROOT, config.paths.media);
  const filesDir = path.join(mediaDir, 'files');
  const mapsDir = path.resolve(ROOT, config.paths.maps);

  await fs.mkdir(filesDir, { recursive: true });
  await fs.mkdir(transformedDir, { recursive: true });

  // Load media map (shared across all steps)
  let mediaMap = {};
  const mediaMapPath = path.join(mapsDir, 'media.json');
  try {
    mediaMap = JSON.parse(await fs.readFile(mediaMapPath, 'utf-8'));
    console.log(`Loaded existing media map: ${Object.keys(mediaMap).length} entries`);
  } catch {
    console.log('No existing media map — starting fresh');
  }

  // ══════════════════════════════════════════════════════════════════
  // PART 1: Transform Datasets
  // ══════════════════════════════════════════════════════════════════

  console.log('\n── Part 1: Transform Datasets ──\n');

  let rawDatasets;
  try {
    rawDatasets = JSON.parse(await fs.readFile(path.join(rawDir, 'datasets.json'), 'utf-8'));
    console.log(`Loaded ${rawDatasets.length} raw datasets`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read datasets.json: ${err.message}${RESET}`);
    process.exit(1);
  }

  const transformedDatasets = [];

  for (let i = 0; i < rawDatasets.length; i++) {
    const ds = rawDatasets[i];
    const slug = ds.slug || `dataset-${ds.id}`;

    // Download and re-upload datafile
    let datafileId = null;
    if (ds.datafile && typeof ds.datafile === 'object' && ds.datafile.url) {
      datafileId = await downloadAndReupload(ds.datafile, filesDir, mediaMap, 'datafile');
      if (delayMs > 0) await delay(delayMs);
    }

    transformedDatasets.push({
      legacyId: ds.id,
      title: ds.title || null,
      status: ds.status || null,
      slug: ds.slug || null,
      date: ds.date || null,
      external: ds.external ?? false,
      categories: ds.categories || null,
      tags: ds.tags || null,
      project: ds.project ?? false,
      sources: ds.sources || null,
      unit: ds.unit || null,
      timeperiod: ds.timeperiod || null,
      description: ds.description || null,
      notes: ds.notes || null,
      variables: ds.variables || null,
      funding: ds.funding || null,
      citation: ds.citation || null,
      datafile: datafileId,
      _originalCreatedAt: ds.createdAt || null,
      _originalUpdatedAt: ds.updatedAt || null,
    });

    const dfStatus = datafileId ? `${GREEN}datafile \u2713${RESET}` : (ds.datafile ? `${YELLOW}datafile failed${RESET}` : 'no datafile');
    console.log(`  Dataset ${i + 1}/${rawDatasets.length}: ${slug} — ${dfStatus}`);
  }

  const datasetsPath = path.join(transformedDir, 'datasets.json');
  await fs.writeFile(datasetsPath, JSON.stringify(transformedDatasets, null, 2));
  console.log(`\n${GREEN}${transformedDatasets.length} datasets saved to ${path.relative(ROOT, datasetsPath)}${RESET}`);

  // Save media map after datasets
  await fs.writeFile(mediaMapPath, JSON.stringify(mediaMap, null, 2));

  // ══════════════════════════════════════════════════════════════════
  // PART 2: Article mainfile/extrafile download+reupload
  // ══════════════════════════════════════════════════════════════════

  console.log('\n── Part 2: Article Mainfile/Extrafile ──\n');

  let transformedArticles;
  try {
    transformedArticles = JSON.parse(await fs.readFile(path.join(transformedDir, 'articles.json'), 'utf-8'));
    console.log(`Loaded ${transformedArticles.length} transformed articles (from 03d)`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read transformed articles.json: ${err.message}${RESET}`);
    console.error(`${RED}Run Phase 3 first: pnpm migrate:phase03${RESET}`);
    process.exit(1);
  }

  let mainfileCount = 0;
  let extrafileCount = 0;

  for (let i = 0; i < transformedArticles.length; i++) {
    const article = transformedArticles[i];
    const slug = article.slug || `article-${article.legacyId}`;
    const statusParts = [];

    // Mainfile
    if (article.mainfile && typeof article.mainfile === 'object' && article.mainfile.url) {
      const mediaId = await downloadAndReupload(article.mainfile, filesDir, mediaMap, 'mainfile');
      if (mediaId) {
        article.mainfile = mediaId;
        mainfileCount++;
        statusParts.push(`mainfile ${GREEN}\u2713${RESET}`);
      } else {
        article.mainfile = null;
        statusParts.push(`mainfile ${RED}failed${RESET}`);
      }
      if (delayMs > 0) await delay(delayMs);
    } else if (article.mainfile && typeof article.mainfile === 'number') {
      // Already an integer (idempotent re-run)
      statusParts.push(`mainfile (already ID: ${article.mainfile})`);
      mainfileCount++;
    } else {
      article.mainfile = null;
    }

    // Extrafile
    if (article.extrafile && typeof article.extrafile === 'object' && article.extrafile.url) {
      const mediaId = await downloadAndReupload(article.extrafile, filesDir, mediaMap, 'extrafile');
      if (mediaId) {
        article.extrafile = mediaId;
        extrafileCount++;
        statusParts.push(`extrafile ${GREEN}\u2713${RESET}`);
      } else {
        article.extrafile = null;
        statusParts.push(`extrafile ${RED}failed${RESET}`);
      }
      if (delayMs > 0) await delay(delayMs);
    } else if (article.extrafile && typeof article.extrafile === 'number') {
      statusParts.push(`extrafile (already ID: ${article.extrafile})`);
      extrafileCount++;
    } else {
      article.extrafile = null;
    }

    if (statusParts.length > 0) {
      console.log(`  Article ${i + 1}/${transformedArticles.length}: ${slug} — ${statusParts.join(', ')}`);
    }
  }

  // Save updated articles
  const articlesPath = path.join(transformedDir, 'articles.json');
  await fs.writeFile(articlesPath, JSON.stringify(transformedArticles, null, 2));
  console.log(`\n${GREEN}${transformedArticles.length} articles updated (${mainfileCount} mainfiles, ${extrafileCount} extrafiles)${RESET}`);
  console.log(`Saved to ${path.relative(ROOT, articlesPath)}`);

  // Save media map after article media
  await fs.writeFile(mediaMapPath, JSON.stringify(mediaMap, null, 2));

  // ══════════════════════════════════════════════════════════════════
  // PART 3: Transform Apps
  // ══════════════════════════════════════════════════════════════════

  console.log('\n── Part 3: Transform Apps ──\n');

  let rawApps;
  try {
    rawApps = JSON.parse(await fs.readFile(path.join(rawDir, 'apps.json'), 'utf-8'));
    console.log(`Loaded ${rawApps.length} raw apps`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read apps.json: ${err.message}${RESET}`);
    process.exit(1);
  }

  const transformedApps = [];

  for (let i = 0; i < rawApps.length; i++) {
    const app = rawApps[i];
    const rawSlug = sanitizeSlug(app.slug);
    const slug = rawSlug || `app-${app.id}`;

    // Process image field
    let imageValue = null;
    const imageResult = scanStringField(app.image);
    if (imageResult && imageResult.found) {
      const ext = extFromMime(imageResult.mimeType);
      const filename = `app-${slug}-image.${ext}`;
      const entry = mediaMap[filename];
      if (entry) {
        imageValue = entry.strapi5MediaId;
      } else {
        console.log(`  ${YELLOW}App ${slug}: no media entry for ${filename}${RESET}`);
      }
    } else if (app.image != null && app.image !== '') {
      // Non-Base64 image (possibly a URL) — preserve as-is
      imageValue = app.image;
    }

    // Relation IDs — app is dominant on BOTH datasets and articles
    const relatedDatasetIds = Array.isArray(app.datasets)
      ? app.datasets.map(d => d.id || d)
      : [];
    const relatedArticleIds = Array.isArray(app.articles)
      ? app.articles.map(a => a.id || a)
      : [];

    transformedApps.push({
      legacyId: app.id,
      title: app.title || null,
      status: app.status || null,
      slug: app.slug || null,
      date: app.date || null,
      external: app.external ?? false,
      categories: app.categories || null,
      tags: app.tags || null,
      contributors: app.contributors || null,
      image: imageValue,
      description: app.description || null,
      url: app.url || null,
      funding: app.funding || null,
      citation: app.citation || null,
      _originalCreatedAt: app.createdAt || null,
      _originalUpdatedAt: app.updatedAt || null,
      _relatedDatasetIds: relatedDatasetIds,
      _relatedArticleIds: relatedArticleIds,
    });

    const imgStatus = imageValue !== null
      ? (typeof imageValue === 'number' ? `image ${GREEN}\u2713${RESET} (ID: ${imageValue})` : 'image (non-b64, preserved)')
      : 'no image';
    console.log(`  App ${i + 1}/${rawApps.length}: ${slug} — ${imgStatus}, ${relatedDatasetIds.length} datasets, ${relatedArticleIds.length} articles`);
  }

  const appsPath = path.join(transformedDir, 'apps.json');
  await fs.writeFile(appsPath, JSON.stringify(transformedApps, null, 2));
  console.log(`\n${GREEN}${transformedApps.length} apps saved to ${path.relative(ROOT, appsPath)}${RESET}`);

  // Final media map save
  await fs.writeFile(mediaMapPath, JSON.stringify(mediaMap, null, 2));

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${GREEN}Phase 3e complete.${RESET}`);
  console.log(`  Datasets:  ${transformedDatasets.length} records → ${path.relative(ROOT, datasetsPath)}`);
  console.log(`  Articles:  ${transformedArticles.length} records updated → ${path.relative(ROOT, articlesPath)}`);
  console.log(`  Apps:      ${transformedApps.length} records → ${path.relative(ROOT, appsPath)}`);
  console.log(`  Media map: ${Object.keys(mediaMap).length} entries → ${path.relative(ROOT, mediaMapPath)}`);
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
