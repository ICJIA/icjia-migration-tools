/**
 * @module 03d-rewrite-content
 * @description Phase 3d: Rewrite article content — replace Base64 with media IDs/URLs.
 *
 * For each article in `data/raw/articles.json`:
 * - Replaces `splash` Base64 with Strapi 5 media ID (integer)
 * - Replaces `thumbnail` Base64 with Strapi 5 media ID (integer)
 * - Rewrites `markdown` inline Base64 images to `/uploads/` URLs
 * - Maps `id` -> `legacyId`
 * - Preserves `createdAt`/`updatedAt` as `_originalCreatedAt`/`_originalUpdatedAt`
 * - Preserves relation IDs as `_relatedDatasetIds`
 * - NEVER puts `_relatedAppIds` on articles (articles are non-dominant on article-app)
 * - Preserves mainfile/extrafile media references (download+reupload happens in 03e)
 *
 * Saves to `data/transformed/articles.json`.
 *
 * @example
 *   node migration/scripts/03d-rewrite-content.js
 *
 * Prerequisites:
 * - Phase 3c complete (data/maps/media.json exists)
 * - Phase 2 complete (data/raw/articles.json exists)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanStringField, scanMarkdownImages, scanHtmlImages } from '../lib/base64-scanner.js';
import { rewriteMarkdownImages, rewriteHtmlImages, checkForRemnants } from '../lib/markdown-rewriter.js';

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

async function main() {
  console.log('=== Phase 3d: Rewrite Article Content ===\n');

  // Show config
  console.log('Configuration:');
  console.log(`  Raw data dir:       ${config.paths.rawData}`);
  console.log(`  Transformed dir:    ${config.paths.transformedData}`);
  console.log(`  Maps dir:           ${config.paths.maps}`);
  console.log('');

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);
  const mapsDir = path.resolve(ROOT, config.paths.maps);

  // Load raw articles
  let articles;
  try {
    articles = JSON.parse(await fs.readFile(path.join(rawDir, 'articles.json'), 'utf-8'));
    console.log(`Loaded ${articles.length} raw articles`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read articles.json: ${err.message}${RESET}`);
    process.exit(1);
  }

  // Load media map
  let mediaMap;
  try {
    mediaMap = JSON.parse(await fs.readFile(path.join(mapsDir, 'media.json'), 'utf-8'));
    console.log(`Loaded media map: ${Object.keys(mediaMap).length} entries`);
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read media.json: ${err.message}${RESET}`);
    console.error(`${RED}Run Phase 3 first: pnpm migrate:phase03${RESET}`);
    process.exit(1);
  }

  console.log('');

  await fs.mkdir(transformedDir, { recursive: true });

  const transformed = [];

  console.log(`Rewriting ${articles.length} articles...\n`);

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const rawSlug = sanitizeSlug(article.slug);
    const slug = rawSlug || `article-${article.id}`;
    const statusParts = [];

    // ── Splash ────────────────────────────────────────────────────
    let splashValue = null;
    const splashResult = scanStringField(article.splash);
    if (splashResult && splashResult.found) {
      const ext = extFromMime(splashResult.mimeType);
      const filename = `${slug}-splash.${ext}`;
      const entry = mediaMap[filename];
      if (entry) {
        splashValue = entry.strapi5MediaId;
        statusParts.push(`splash ${GREEN}\u2713${RESET}`);
      } else {
        statusParts.push(`splash ${YELLOW}(no media entry)${RESET}`);
      }
    } else if (article.splash != null && article.splash !== '') {
      // Non-Base64 splash — preserve as-is (could be a URL)
      splashValue = article.splash;
      statusParts.push(`splash (non-b64, preserved)`);
    } else {
      statusParts.push(`splash (null)`);
    }

    // ── Thumbnail ─────────────────────────────────────────────────
    let thumbnailValue = null;
    const thumbResult = scanStringField(article.thumbnail);
    if (thumbResult && thumbResult.found) {
      const ext = extFromMime(thumbResult.mimeType);
      const filename = `${slug}-thumbnail.${ext}`;
      const entry = mediaMap[filename];
      if (entry) {
        thumbnailValue = entry.strapi5MediaId;
        statusParts.push(`thumbnail ${GREEN}\u2713${RESET}`);
      } else {
        statusParts.push(`thumbnail ${YELLOW}(no media entry)${RESET}`);
      }
    } else if (article.thumbnail != null && article.thumbnail !== '') {
      thumbnailValue = article.thumbnail;
      statusParts.push(`thumbnail (non-b64, preserved)`);
    } else {
      statusParts.push(`thumbnail (null)`);
    }

    // ── Markdown inline images ────────────────────────────────────
    let markdown = article.markdown || '';

    // Build inline image map (keyed by index)
    const mdImages = scanMarkdownImages(article.markdown);
    const inlineMap = {};
    for (let j = 0; j < mdImages.length; j++) {
      const ext = extFromMime(mdImages[j].mimeType);
      const filename = `${slug}-${String(j).padStart(3, '0')}.${ext}`;
      const entry = mediaMap[filename];
      if (entry) {
        inlineMap[j] = entry;
      }
    }

    markdown = rewriteMarkdownImages(markdown, inlineMap);
    statusParts.push(`${mdImages.length} inline images${mdImages.length > 0 ? ` ${GREEN}\u2713${RESET}` : ''}`);

    // Build HTML image map (keyed by index)
    const htmlImages = scanHtmlImages(article.markdown);
    if (htmlImages.length > 0) {
      const htmlMap = {};
      for (let j = 0; j < htmlImages.length; j++) {
        const ext = extFromMime(htmlImages[j].mimeType);
        const filename = `${slug}-html-${String(j).padStart(3, '0')}.${ext}`;
        const entry = mediaMap[filename];
        if (entry) {
          htmlMap[j] = entry;
        }
      }
      markdown = rewriteHtmlImages(markdown, htmlMap);
      statusParts.push(`${htmlImages.length} html images ${GREEN}\u2713${RESET}`);
    }

    // ── Reference-style images (images JSON field) ────────────────
    // Articles use `![Figure 1][figure1]` in markdown with the actual image
    // data stored in the `images` JSON field as [{title, src}, ...].
    // The Base64 images were uploaded in 03c as `images-json` entries.
    // Here we: (a) append [title]: url definitions to the markdown, and
    // (b) rewrite the images JSON field to use URLs instead of Base64.
    const imagesField = Array.isArray(article.images) ? article.images : [];
    let rewrittenImages = article.images || null;

    if (imagesField.length > 0) {
      const titleToUrl = new Map();
      const newImagesArr = [];

      for (let j = 0; j < imagesField.length; j++) {
        const imgEntry = imagesField[j];
        const idx = String(j).padStart(3, '0');
        // Try all common extensions — the scan uses the MIME type from the Base64 data
        const entry = mediaMap[`${slug}-imgfield-${idx}.png`]
          || mediaMap[`${slug}-imgfield-${idx}.jpg`]
          || mediaMap[`${slug}-imgfield-${idx}.gif`]
          || mediaMap[`${slug}-imgfield-${idx}.webp`];

        if (entry && entry.strapi5Url) {
          const title = imgEntry.title || `figure${j + 1}`;
          titleToUrl.set(title.toLowerCase(), entry.strapi5Url);
          newImagesArr.push({ title, src: entry.strapi5Url });
        } else {
          // No upload found — preserve original entry
          newImagesArr.push(imgEntry);
        }
      }

      if (titleToUrl.size > 0) {
        // Replace reference-style images ![alt][ref] with inline ![alt](url)
        markdown = markdown.replace(/!\[([^\]]*)\]\[([^\]]+)\]/g, (match, alt, ref) => {
          const url = titleToUrl.get(ref.toLowerCase());
          return url ? `![${alt}](${url})` : match;
        });
        rewrittenImages = newImagesArr;
        statusParts.push(`${titleToUrl.size} image refs ${GREEN}\u2713${RESET}`);
      }
    }

    // ── Mainfile / Extrafile ──────────────────────────────────────
    // Preserve the raw media reference objects for 03e to download and re-upload.
    // 03e will replace these with integer media IDs.
    let mainfileValue = article.mainfile || null;
    let extrafileValue = article.extrafile || null;

    if (mainfileValue && typeof mainfileValue === 'object' && mainfileValue.url) {
      statusParts.push(`mainfile ${GREEN}\u2713${RESET}`);
    } else if (mainfileValue) {
      statusParts.push(`mainfile (present)`);
    }

    if (extrafileValue && typeof extrafileValue === 'object' && extrafileValue.url) {
      statusParts.push(`extrafile ${GREEN}\u2713${RESET}`);
    }

    // ── Relation IDs ──────────────────────────────────────────────
    // Articles are dominant on article-dataset, so preserve dataset IDs
    // Articles are NON-dominant on article-app, so NEVER include _relatedAppIds
    const relatedDatasetIds = Array.isArray(article.datasets)
      ? article.datasets.map(d => d.id || d)
      : [];

    // ── Build transformed article ─────────────────────────────────
    const transformedArticle = {
      legacyId: article.id,
      title: article.title || null,
      status: article.status || null,
      slug: article.slug || null,
      date: article.date || null,
      external: article.external ?? false,
      categories: article.categories || null,
      tags: article.tags || null,
      authors: article.authors || null,
      splash: splashValue,
      thumbnail: thumbnailValue,
      images: rewrittenImages,
      abstract: article.abstract || null,
      markdown,
      mainfiletype: article.mainfiletype || null,
      funding: article.funding || null,
      citation: article.citation || null,
      doi: article.doi || null,
      hideFromBanner: article.hideFromBanner ?? false,
      mainfile: mainfileValue,
      extrafile: extrafileValue,
      _originalCreatedAt: article.createdAt || null,
      _originalUpdatedAt: article.updatedAt || null,
      _relatedDatasetIds: relatedDatasetIds,
    };

    transformed.push(transformedArticle);

    console.log(`  Article ${i + 1}/${articles.length}: ${slug} — ${statusParts.join(', ')}`);
  }

  // ── Post-rewrite verification ──────────────────────────────────────

  console.log('\nPost-rewrite scan for Base64 remnants...');
  let totalRemnants = 0;

  for (const article of transformed) {
    const remnants = checkForRemnants(article.markdown);
    if (remnants.length > 0) {
      totalRemnants += remnants.length;
      console.log(`  ${YELLOW}WARNING: ${article.legacyId} (${article.slug}) has ${remnants.length} Base64 remnant(s)${RESET}`);
      for (const r of remnants) {
        console.log(`    ${YELLOW}Position ${r.position}: ...${r.context}...${RESET}`);
      }
    }
  }

  if (totalRemnants === 0) {
    console.log(`  ${GREEN}0 Base64 remnants found \u2713${RESET}`);
  } else {
    console.log(`\n${YELLOW}WARNING: ${totalRemnants} Base64 remnant(s) found across all articles.${RESET}`);
    console.log(`${YELLOW}These may need manual review or an expanded regex pattern.${RESET}`);
  }

  // ── Save transformed articles ──────────────────────────────────────

  const outputPath = path.join(transformedDir, 'articles.json');
  await fs.writeFile(outputPath, JSON.stringify(transformed, null, 2));

  console.log(`\n${GREEN}Rewrite complete: ${transformed.length} articles processed${RESET}`);
  console.log(`Saved to ${path.relative(ROOT, outputPath)}`);
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
