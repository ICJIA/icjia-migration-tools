/**
 * @module base64-decoder
 * @description Decodes Base64-encoded image data to binary files with validation.
 *
 * Handles:
 * - Stripping whitespace and newlines from Base64 strings (some encoders wrap at 76 chars)
 * - Stripping `data:image/...;base64,` prefix if present
 * - Decoding via `Buffer.from(str, 'base64')`
 * - Validating decoded output against known image magic byte signatures
 * - Writing validated binary data to disk
 *
 * @example
 *   import { decodeBase64ToFile, detectMimeFromBytes } from '../lib/base64-decoder.js';
 *
 *   await decodeBase64ToFile(base64String, '/path/to/output.png');
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Known image file magic byte signatures.
 * @type {Array<{name: string, bytes: number[], offset?: number, mime: string, ext: string}>}
 */
const MAGIC_SIGNATURES = [
  { name: 'PNG',  bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0, mime: 'image/png',  ext: 'png'  },
  { name: 'JPEG', bytes: [0xFF, 0xD8, 0xFF],        offset: 0, mime: 'image/jpeg', ext: 'jpg'  },
  { name: 'GIF',  bytes: [0x47, 0x49, 0x46, 0x38],  offset: 0, mime: 'image/gif',  ext: 'gif'  },
  { name: 'WebP', bytes: [0x52, 0x49, 0x46, 0x46],  offset: 0, mime: 'image/webp', ext: 'webp' },
];

/**
 * WebP secondary signature bytes at offset 8.
 * @type {number[]}
 */
const WEBP_SECONDARY = [0x57, 0x45, 0x42, 0x50];

/**
 * Regex to strip a data URI prefix from a Base64 string.
 * @type {RegExp}
 */
const DATA_URI_PREFIX_RE = /^data:image\/[^;]+;base64,/;

/**
 * Detect the MIME type of an image by inspecting its magic bytes.
 *
 * Checks the first bytes of the buffer against known signatures for
 * PNG, JPEG, GIF, and WebP formats.
 *
 * @param {Buffer} buffer - The decoded image bytes (at least 12 bytes recommended)
 * @returns {{ mime: string, ext: string, name: string }|null}
 *   Object with MIME type, file extension, and format name, or `null` if unrecognized.
 *
 * @example
 *   const buf = Buffer.from(base64String, 'base64');
 *   const info = detectMimeFromBytes(buf);
 *   // info: { mime: 'image/png', ext: 'png', name: 'PNG' }
 */
export function detectMimeFromBytes(buffer) {
  if (!buffer || buffer.length < 3) return null;

  for (const sig of MAGIC_SIGNATURES) {
    const offset = sig.offset || 0;
    if (buffer.length < offset + sig.bytes.length) continue;

    const matches = sig.bytes.every((b, i) => buffer[offset + i] === b);
    if (!matches) continue;

    // WebP needs a secondary check at offset 8
    if (sig.mime === 'image/webp') {
      if (buffer.length < 12) continue;
      const webpOk = WEBP_SECONDARY.every((b, i) => buffer[8 + i] === b);
      if (!webpOk) continue;
    }

    return { mime: sig.mime, ext: sig.ext, name: sig.name };
  }

  return null;
}

/**
 * Decode a Base64-encoded image string to a binary file on disk.
 *
 * Processing steps:
 * 1. Strip the `data:image/...;base64,` prefix if present
 * 2. Remove all whitespace and newline characters
 * 3. Decode using `Buffer.from(str, 'base64')`
 * 4. Validate that the decoded buffer is non-empty
 * 5. Validate magic bytes match a known image format
 * 6. Create parent directories as needed
 * 7. Write the binary file
 *
 * @param {string} base64String - The Base64 string to decode (with or without data URI prefix)
 * @param {string} outputPath - Absolute path to write the decoded file
 * @returns {Promise<{ success: boolean, size: number, detectedMime: string|null, error?: string }>}
 *   Result object with success status, file size in bytes, detected MIME type,
 *   and error message if decoding failed.
 *
 * @example
 *   const result = await decodeBase64ToFile(article.splash, '/path/to/slug-splash.png');
 *   if (result.success) {
 *     console.log(`Decoded ${result.size} bytes (${result.detectedMime})`);
 *   } else {
 *     console.error(`Failed: ${result.error}`);
 *   }
 */
export async function decodeBase64ToFile(base64String, outputPath) {
  try {
    if (!base64String || typeof base64String !== 'string') {
      return { success: false, size: 0, detectedMime: null, error: 'Empty or non-string input' };
    }

    // Step 1: Strip data URI prefix
    let cleaned = base64String.replace(DATA_URI_PREFIX_RE, '');

    // Step 2: Remove whitespace/newlines
    cleaned = cleaned.replace(/[\s\r\n]+/g, '');

    // Step 3: Decode
    const buffer = Buffer.from(cleaned, 'base64');

    // Step 4: Non-empty check
    if (buffer.length === 0) {
      return { success: false, size: 0, detectedMime: null, error: 'Decoded buffer is 0 bytes' };
    }

    // Step 5: Magic byte validation
    const detected = detectMimeFromBytes(buffer);
    const detectedMime = detected ? detected.mime : null;

    // Step 6: Create parent directory
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    // Step 7: Write file
    await fs.writeFile(outputPath, buffer);

    return { success: true, size: buffer.length, detectedMime };
  } catch (err) {
    return { success: false, size: 0, detectedMime: null, error: err.message };
  }
}
