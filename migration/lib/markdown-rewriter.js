/**
 * @module markdown-rewriter
 * @description Rewrites Base64-encoded images in markdown/HTML content to reference
 * uploaded media URLs.
 *
 * After media has been uploaded to Strapi 5, this module replaces inline Base64
 * data URIs with `/uploads/` URLs, making the content reference the media library
 * instead of embedding binary data.
 *
 * @example
 *   import { rewriteMarkdownImages, rewriteHtmlImages, checkForRemnants } from '../lib/markdown-rewriter.js';
 *
 *   let content = article.markdown;
 *   content = rewriteMarkdownImages(content, imageMap);
 *   content = rewriteHtmlImages(content, imageMap);
 *   const remnants = checkForRemnants(content);
 */

/**
 * Regex for markdown images with Base64 data URIs.
 * Captures: [1] alt text, [2] MIME subtype, [3] Base64 payload.
 * @type {RegExp}
 */
const MARKDOWN_BASE64_RE = /!\[([^\]]*)\]\(data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)\)/g;

/**
 * Regex for HTML img tags with Base64 src attributes.
 * Captures full match for replacement. Sub-captures: [1] pre-src content,
 * [2] MIME subtype, [3] Base64 payload, [4] post-src content.
 * @type {RegExp}
 */
const HTML_BASE64_RE = /(<img[^>]+src=")data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)("[^>]*>)/g;

/**
 * Rewrite markdown inline images that contain Base64 data URIs.
 *
 * Replaces each `![alt](data:image/TYPE;base64,DATA)` occurrence with
 * `![alt](/uploads/filename.ext)` using the provided image map.
 *
 * The image map is keyed by zero-based inline image index. Each entry must have
 * a `strapi5Url` property containing the replacement URL.
 *
 * If a replacement is not found in the image map, the original Base64 markdown
 * is preserved and a warning is logged.
 *
 * @param {string} markdown - The markdown text containing Base64 images
 * @param {Record<number, { strapi5Url: string }>} imageMap - Map of inline image index
 *   to Strapi 5 media entry with at least `strapi5Url`.
 * @returns {string} The markdown text with Base64 images replaced by media URLs
 *
 * @example
 *   const imageMap = {
 *     0: { strapi5Url: '/uploads/article-slug-001.png' },
 *     1: { strapi5Url: '/uploads/article-slug-002.jpg' },
 *   };
 *   const rewritten = rewriteMarkdownImages(article.markdown, imageMap);
 */
export function rewriteMarkdownImages(markdown, imageMap) {
  if (!markdown || typeof markdown !== 'string') return markdown;
  if (!imageMap) return markdown;

  let imageIndex = 0;
  const re = new RegExp(MARKDOWN_BASE64_RE.source, MARKDOWN_BASE64_RE.flags);

  return markdown.replace(re, (match, altText) => {
    const entry = imageMap[imageIndex];
    imageIndex++;

    if (!entry || !entry.strapi5Url) {
      console.warn(`    WARNING: No media entry for inline image index ${imageIndex - 1} — Base64 preserved`);
      return match;
    }

    return `![${altText}](${entry.strapi5Url})`;
  });
}

/**
 * Rewrite HTML `<img>` tags that contain Base64 src attributes.
 *
 * Replaces each `<img src="data:image/TYPE;base64,DATA" ...>` with
 * `<img src="/uploads/filename.ext" ...>` using the provided image map.
 *
 * The image map is keyed by zero-based HTML image index. Each entry must have
 * a `strapi5Url` property containing the replacement URL.
 *
 * @param {string} markdown - The text containing HTML img tags with Base64 src
 * @param {Record<number, { strapi5Url: string }>} imageMap - Map of HTML image index
 *   to Strapi 5 media entry with at least `strapi5Url`.
 * @returns {string} The text with Base64 img src replaced by media URLs
 *
 * @example
 *   const imageMap = {
 *     0: { strapi5Url: '/uploads/article-slug-html-001.png' },
 *   };
 *   const rewritten = rewriteHtmlImages(article.markdown, imageMap);
 */
export function rewriteHtmlImages(markdown, imageMap) {
  if (!markdown || typeof markdown !== 'string') return markdown;
  if (!imageMap) return markdown;

  let imageIndex = 0;
  const re = new RegExp(HTML_BASE64_RE.source, HTML_BASE64_RE.flags);

  return markdown.replace(re, (match, preSrc, _mimeSubtype, _base64, postSrc) => {
    const entry = imageMap[imageIndex];
    imageIndex++;

    if (!entry || !entry.strapi5Url) {
      console.warn(`    WARNING: No media entry for HTML image index ${imageIndex - 1} — Base64 preserved`);
      return match;
    }

    return `${preSrc}${entry.strapi5Url}${postSrc}`;
  });
}

/**
 * Check for remaining Base64 image references in text.
 *
 * After rewriting, this function scans for any leftover `data:image/` substrings
 * that were not caught by the rewrite process. Each occurrence is a potential
 * missed Base64 image that needs manual attention.
 *
 * @param {string} text - The text to scan for Base64 remnants
 * @returns {Array<{ position: number, context: string }>}
 *   Array of remnant locations, each with the character position and a short context
 *   snippet (50 chars before and after) for identification. Returns empty array if clean.
 *
 * @example
 *   const remnants = checkForRemnants(article.markdown);
 *   if (remnants.length > 0) {
 *     console.warn(`Found ${remnants.length} Base64 remnants!`);
 *   }
 */
export function checkForRemnants(text) {
  if (!text || typeof text !== 'string') return [];

  const remnants = [];
  const needle = 'data:image/';
  let pos = 0;

  while (true) {
    const idx = text.indexOf(needle, pos);
    if (idx === -1) break;

    const start = Math.max(0, idx - 50);
    const end = Math.min(text.length, idx + 60);
    const context = text.substring(start, end);

    remnants.push({ position: idx, context });
    pos = idx + needle.length;
  }

  return remnants;
}
