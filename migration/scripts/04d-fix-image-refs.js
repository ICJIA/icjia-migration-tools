/**
 * @module 04d-fix-image-refs
 * @description Fix reference-style markdown images by appending [title]: url definitions.
 *
 * Many articles use reference-style markdown images like `![Figure 1][figure1]` where
 * the actual image data lives in the `images` JSON field as `{title, src}` objects.
 * During migration, the Base64 images were extracted, decoded, and uploaded to
 * Strapi 5's media library (03a-03c), but the markdown was never updated with
 * reference definitions pointing to the uploaded URLs.
 *
 * This script:
 * 1. Reads the media map to find all `images-json` entries (already uploaded)
 * 2. For each article with reference-style images, builds `[title]: /uploads/...` definitions
 * 3. Appends the definitions to the markdown
 * 4. Updates the `images` JSON field to use URLs instead of Base64
 * 5. PUTs the updated article to Strapi 5 via REST API
 *
 * Safe to re-run — checks for existing definitions before appending.
 *
 * @example
 *   node migration/scripts/04d-fix-image-refs.js
 *
 * Prerequisites:
 * - Phase 3c complete (images uploaded, media.json exists)
 * - Phase 4a complete (articles loaded in Strapi 5)
 * - Strapi 5 running with valid API token
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { RestClient } from '../lib/rest-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitize a slug for use in filenames (must match 03a/03d logic).
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

async function main() {
  console.log(`${BOLD}=== Phase 4d: Fix Reference-Style Image Links ===${RESET}\n`);

  const DELAY_MS = config.settings?.requestDelayMs || 200;

  console.log('Configuration:');
  console.log(`  Strapi 5 API:   ${config.strapi5.apiUrl}`);
  console.log(`  Strapi 5 token: ${config.strapi5.token ? '(set)' : '(not set)'}`);
  console.log(`  Maps dir:       ${config.paths.maps}`);
  console.log(`  Raw data dir:   ${config.paths.rawData}`);
  console.log('');

  const client = new RestClient(config.strapi5.apiUrl, {
    token: config.strapi5.token,
    timeoutMs: config.settings?.requestTimeoutMs || 60000,
  });

  // Load raw articles (for the images JSON field)
  const rawArticles = JSON.parse(
    await fs.readFile(path.resolve(ROOT, config.paths.rawData, 'articles.json'), 'utf8'),
  );
  console.log(`Loaded ${rawArticles.length} raw articles`);

  // Load media map
  const mediaMap = JSON.parse(
    await fs.readFile(path.resolve(ROOT, config.paths.maps, 'media.json'), 'utf8'),
  );

  // Build a lookup: articleId -> array of {title, strapi5Url, index}
  const imagesByArticle = {};
  for (const [filename, entry] of Object.entries(mediaMap)) {
    if (entry.location === 'images-json' && entry.sourceArticleId) {
      if (!imagesByArticle[entry.sourceArticleId]) {
        imagesByArticle[entry.sourceArticleId] = [];
      }
      imagesByArticle[entry.sourceArticleId].push({
        filename,
        strapi5Url: entry.strapi5Url,
        index: entry.index,
      });
    }
  }

  const articlesWithImages = Object.keys(imagesByArticle).length;
  console.log(`Found ${articlesWithImages} articles with uploaded images-json entries`);
  console.log('');

  // Load ID map for legacyId -> documentId lookup
  const idMap = JSON.parse(
    await fs.readFile(path.resolve(ROOT, config.paths.maps, 'articles.json'), 'utf8'),
  );

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < rawArticles.length; i++) {
    const article = rawArticles[i];
    const articleId = article.id;
    const uploadedImages = imagesByArticle[articleId];

    if (!uploadedImages || uploadedImages.length === 0) {
      continue; // No images-json entries for this article
    }

    const mapping = idMap[articleId];
    if (!mapping) {
      console.log(`  ${YELLOW}SKIP: No ID mapping for ${articleId}${RESET}`);
      skipped++;
      continue;
    }

    // Get the images JSON field to find titles
    const imagesField = article.images;
    if (!imagesField || !Array.isArray(imagesField) || imagesField.length === 0) {
      skipped++;
      continue;
    }

    // Sort uploaded images by index
    uploadedImages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    // Build title -> URL map by matching index to images array
    const refDefs = [];
    const rewrittenImages = [];

    for (const uploaded of uploadedImages) {
      const idx = uploaded.index ?? 0;
      const imgEntry = imagesField[idx];
      if (!imgEntry) continue;

      const title = imgEntry.title || `figure${idx + 1}`;
      const fullUrl = `${config.strapi5.apiUrl}${uploaded.strapi5Url}`;

      refDefs.push({ title, url: fullUrl });
      rewrittenImages.push({ title, src: fullUrl });
    }

    if (refDefs.length === 0) {
      skipped++;
      continue;
    }

    // Fetch current article markdown from Strapi 5
    let s5Article;
    try {
      const result = await client.get(`/api/articles`, {
        'filters[legacyId][$eq]': articleId,
        'fields[0]': 'markdown',
        'fields[1]': 'images',
      });
      s5Article = result.data?.[0];
    } catch (err) {
      console.log(`  ${RED}ERROR fetching ${articleId}: ${err.message}${RESET}`);
      errors++;
      continue;
    }

    if (!s5Article) {
      console.log(`  ${YELLOW}SKIP: No Strapi 5 record for legacyId ${articleId}${RESET}`);
      skipped++;
      continue;
    }

    let markdown = s5Article.markdown || '';

    // Build a title -> URL lookup (case-insensitive)
    const titleToUrl = {};
    for (const ref of refDefs) {
      titleToUrl[ref.title.toLowerCase()] = ref.url;
    }

    // Replace reference-style images ![alt][ref] with inline images ![alt](url)
    // This is more reliable than appending reference definitions since not all
    // markdown renderers (or Strapi's rich text) support reference-style syntax.
    let replacements = 0;
    markdown = markdown.replace(/!\[([^\]]*)\]\[([^\]]+)\]/g, (match, alt, ref) => {
      const url = titleToUrl[ref.toLowerCase()];
      if (url) {
        replacements++;
        return `![${alt}](${url})`;
      }
      return match; // No matching image — leave as-is
    });

    // Also remove any existing reference definitions that we're replacing
    for (const ref of refDefs) {
      const escaped = ref.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      markdown = markdown.replace(new RegExp(`\\n?\\[${escaped}\\]:\\s*[^\\n]+`, 'gm'), '');
    }

    if (replacements === 0) {
      skipped++;
      continue;
    }

    // Update via API
    try {
      await client.put(`/api/articles/${s5Article.documentId}`, {
        markdown,
        images: rewrittenImages,
      });
      updated++;
      const slug = sanitizeSlug(article.slug) || articleId;
      if (updated % 10 === 1 || updated === 1) {
        console.log(`  ${GREEN}✓${RESET} [${updated}] ${slug}: ${replacements} image(s) inlined`);
      }
    } catch (err) {
      console.log(`  ${RED}ERROR updating ${articleId}: ${err.message}${RESET}`);
      errors++;
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  ${GREEN}Updated:${RESET} ${updated} articles`);
  console.log(`  Skipped: ${skipped} (no images or already fixed)`);
  if (errors > 0) {
    console.log(`  ${RED}Errors: ${errors}${RESET}`);
  }
  console.log('');

  if (errors > 0) {
    console.log(`${YELLOW}Some articles failed to update. Re-run this script to retry.${RESET}`);
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}Image reference fix complete.${RESET}`);
  console.log('Verify by checking an article with figures in the Strapi 5 admin or frontend.');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
