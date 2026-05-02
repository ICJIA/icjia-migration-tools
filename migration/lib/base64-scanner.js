/**
 * @module base64-scanner
 * @description Detects Base64-encoded images in article and app fields.
 *
 * Provides scanning functions for:
 * - String fields (splash, thumbnail, app image) that may contain Base64 data URIs
 * - Markdown fields with inline `![alt](data:image/...;base64,...)` images
 * - HTML `<img>` tags with Base64 src attributes (safety net)
 * - JSON fields (article `images`) that may contain Base64 data
 *
 * All functions are stateless and side-effect-free.
 *
 * @example
 *   import { scanStringField, scanMarkdownImages, scanHtmlImages } from '../lib/base64-scanner.js';
 *
 *   const result = scanStringField(article.splash);
 *   if (result && result.found) {
 *     console.log(`Found ${result.mimeType} image, ${result.base64Data.length} chars`);
 *   }
 */

/**
 * Regex for markdown images with Base64 data URIs.
 * Captures: [1] alt text, [2] MIME subtype, [3] Base64 payload.
 * @type {RegExp}
 */
const MARKDOWN_BASE64_RE = /!\[([^\]]*)\]\(data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)\)/g;

/**
 * Regex for HTML img tags with Base64 src attributes.
 * Captures: [1] MIME subtype, [2] Base64 payload.
 * @type {RegExp}
 */
const HTML_BASE64_RE = /<img[^>]+src="data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)"[^>]*>/g;

/**
 * Regex to detect a data URI prefix on a string field.
 * Captures: [1] MIME subtype, [2] Base64 payload.
 * @type {RegExp}
 */
const DATA_URI_RE = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,(.+)$/s;

/**
 * Known image magic byte signatures for raw Base64 detection fallback.
 * @type {Array<{bytes: number[], mime: string}>}
 */
const MAGIC_BYTES = [
  { bytes: [0x89, 0x50, 0x4E, 0x47], mime: 'image/png' },
  { bytes: [0xFF, 0xD8, 0xFF], mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  // WebP: RIFF at 0, WEBP at 8 — check first 4 bytes for RIFF
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
];

/**
 * Attempt to detect MIME type from the first bytes of a decoded Base64 string.
 *
 * @param {Buffer} buffer - Decoded bytes (at least 16 bytes recommended)
 * @returns {string|null} MIME type string or null if unrecognized
 */
function detectMimeFromBuffer(buffer) {
  if (!buffer || buffer.length < 3) return null;

  for (const sig of MAGIC_BYTES) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) {
      // Extra check for WebP: bytes 8-11 must be WEBP
      if (sig.mime === 'image/webp') {
        if (buffer.length >= 12 &&
            buffer[8] === 0x57 && buffer[9] === 0x45 &&
            buffer[10] === 0x42 && buffer[11] === 0x50) {
          return 'image/webp';
        }
        return null; // RIFF but not WebP
      }
      return sig.mime;
    }
  }
  return null;
}

/**
 * Scan a string field (splash, thumbnail, or app image) for Base64 image data.
 *
 * Detection strategy:
 * 1. If the string starts with `data:image/...;base64,`, extract MIME and payload.
 * 2. Otherwise, attempt to decode as raw Base64 and check magic bytes.
 *
 * @param {*} fieldValue - The field value to inspect (may be null, string, or other type)
 * @returns {{ found: boolean, mimeType: string, base64Data: string }|null}
 *   Returns an object with `found: true` and the extracted data if Base64 is detected,
 *   or `null` if the field is empty or not Base64.
 *
 * @example
 *   const result = scanStringField(article.splash);
 *   // result: { found: true, mimeType: 'image/png', base64Data: 'iVBORw0KGgo...' }
 */
export function scanStringField(fieldValue) {
  if (fieldValue == null || typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    return null;
  }

  const trimmed = fieldValue.trim();

  // Strategy 1: Data URI prefix
  const uriMatch = trimmed.match(DATA_URI_RE);
  if (uriMatch) {
    const subtype = uriMatch[1];
    const mime = subtype === 'jpg' ? 'image/jpeg' : `image/${subtype}`;
    return { found: true, mimeType: mime, base64Data: uriMatch[2] };
  }

  // Strategy 2: Raw Base64 — try decoding the first 64 chars to check magic bytes
  // Only attempt if the string looks like Base64 (long enough, valid chars)
  if (trimmed.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed.substring(0, 200))) {
    try {
      const sample = trimmed.replace(/\s/g, '').substring(0, 64);
      const decoded = Buffer.from(sample, 'base64');
      const mime = detectMimeFromBuffer(decoded);
      if (mime) {
        return { found: true, mimeType: mime, base64Data: trimmed };
      }
    } catch {
      // Not valid Base64
    }
  }

  return null;
}

/**
 * Scan a markdown string for inline images with Base64 data URIs.
 *
 * Finds all occurrences of `![alt](data:image/TYPE;base64,DATA)` in the markdown text.
 *
 * @param {string} markdown - The markdown text to scan
 * @returns {Array<{ altText: string, mimeType: string, base64Data: string, matchIndex: number }>}
 *   Array of found images, each with alt text, MIME type, raw Base64 data, and
 *   the character index where the match starts. Returns empty array if no matches.
 *
 * @example
 *   const images = scanMarkdownImages(article.markdown);
 *   // images: [{ altText: 'Chart', mimeType: 'image/png', base64Data: '...', matchIndex: 1234 }]
 */
export function scanMarkdownImages(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const results = [];
  // Reset the regex lastIndex before each use
  const re = new RegExp(MARKDOWN_BASE64_RE.source, MARKDOWN_BASE64_RE.flags);
  let match;

  while ((match = re.exec(markdown)) !== null) {
    const subtype = match[2];
    const mime = subtype === 'jpg' ? 'image/jpeg' : `image/${subtype}`;
    results.push({
      altText: match[1],
      mimeType: mime,
      base64Data: match[3],
      matchIndex: match.index,
    });
  }

  return results;
}

/**
 * Scan a markdown/HTML string for `<img>` tags with Base64 src attributes.
 *
 * This is a safety net for any HTML-style images embedded in markdown content
 * that would not be caught by the markdown image regex.
 *
 * @param {string} markdown - The text to scan (may contain mixed markdown and HTML)
 * @returns {Array<{ mimeType: string, base64Data: string, matchIndex: number }>}
 *   Array of found HTML images, each with MIME type, Base64 data, and match position.
 *   Returns empty array if no matches.
 *
 * @example
 *   const htmlImages = scanHtmlImages(article.markdown);
 *   // htmlImages: [{ mimeType: 'image/jpeg', base64Data: '...', matchIndex: 500 }]
 */
export function scanHtmlImages(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const results = [];
  const re = new RegExp(HTML_BASE64_RE.source, HTML_BASE64_RE.flags);
  let match;

  while ((match = re.exec(markdown)) !== null) {
    const subtype = match[1];
    const mime = subtype === 'jpg' ? 'image/jpeg' : `image/${subtype}`;
    results.push({
      mimeType: mime,
      base64Data: match[2],
      matchIndex: match.index,
    });
  }

  return results;
}

/**
 * Inspect an article's `images` JSON field for Base64 data.
 *
 * The `images` field is typed as JSON in Strapi 3 and its structure is unknown.
 * This function logs the structure for manual review and returns any Base64 data found.
 *
 * @param {*} jsonValue - The parsed JSON value of the `images` field
 * @param {string} articleSlug - Slug for logging context
 * @returns {Array<{ mimeType: string, base64Data: string, path: string }>}
 *   Array of Base64 entries found within the JSON structure, with dot-path locations.
 *   Returns empty array if null, empty, or no Base64 found.
 *
 * @example
 *   const found = scanJsonField(article.images, article.slug);
 */
export function scanJsonField(jsonValue, articleSlug) {
  if (jsonValue == null) return [];

  const results = [];

  function walk(obj, currentPath) {
    if (typeof obj === 'string') {
      const scan = scanStringField(obj);
      if (scan && scan.found) {
        results.push({
          mimeType: scan.mimeType,
          base64Data: scan.base64Data,
          path: currentPath,
        });
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${currentPath}[${i}]`));
    } else if (obj && typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        walk(val, `${currentPath}.${key}`);
      }
    }
  }

  walk(jsonValue, 'images');

  if (jsonValue != null && results.length === 0) {
    const type = Array.isArray(jsonValue) ? 'array' : typeof jsonValue;
    const preview = JSON.stringify(jsonValue).substring(0, 200);
    console.log(`    [images field] ${articleSlug}: type=${type}, preview: ${preview}${preview.length >= 200 ? '...' : ''}`);
  }

  return results;
}
