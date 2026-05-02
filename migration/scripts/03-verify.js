/**
 * @module 03-verify
 * @description Phase 3 verification: validates all Phase 3 outputs.
 *
 * Runs all automated gate checks specified in the design doc:
 * - Scan & Decode: manifest integrity, file counts, magic bytes
 * - Upload: media map completeness, Strapi 5 accessibility
 * - Rewrite: zero Base64 remnants, media ID types, field parity
 * - Dataset & App transform: record counts, field integrity
 *
 * Exits 0 if all pass, exits 1 if any fail.
 *
 * @example
 *   node migration/scripts/03-verify.js
 *
 * Prerequisites:
 * - All Phase 3 sub-steps (03a through 03e) complete
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectMimeFromBytes } from '../lib/base64-decoder.js';
import { scanStringField } from '../lib/base64-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

/**
 * Log a check result.
 * @param {boolean} pass - Whether the check passed
 * @param {string} description - What was checked
 * @param {string} [detail] - Additional detail on failure
 */
function check(pass, description, detail) {
  totalChecks++;
  if (pass) {
    passedChecks++;
    console.log(`  ${GREEN}\u2713 ${description}${RESET}`);
  } else {
    failedChecks++;
    console.log(`  ${RED}\u2717 ${description}${RESET}`);
    if (detail) console.log(`    ${RED}${detail}${RESET}`);
  }
}

/**
 * Load a JSON file, returning null on failure.
 * @param {string} filePath - Absolute path
 * @returns {Promise<any|null>}
 */
async function loadJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function main() {
  console.log('=== Phase 3 Verification ===\n');

  const rawDir = path.resolve(ROOT, config.paths.rawData);
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);
  const mediaDir = path.resolve(ROOT, config.paths.media);
  const filesDir = path.join(mediaDir, 'files');
  const mapsDir = path.resolve(ROOT, config.paths.maps);

  // Load all data files
  const manifest = await loadJson(path.join(mediaDir, 'manifest.json'));
  const mediaMap = await loadJson(path.join(mapsDir, 'media.json'));
  const rawArticles = await loadJson(path.join(rawDir, 'articles.json'));
  const rawDatasets = await loadJson(path.join(rawDir, 'datasets.json'));
  const rawApps = await loadJson(path.join(rawDir, 'apps.json'));
  const tArticles = await loadJson(path.join(transformedDir, 'articles.json'));
  const tDatasets = await loadJson(path.join(transformedDir, 'datasets.json'));
  const tApps = await loadJson(path.join(transformedDir, 'apps.json'));

  // ══════════════════════════════════════════════════════════════════
  // SCAN & DECODE CHECKS
  // ══════════════════════════════════════════════════════════════════

  console.log(`${BOLD}── Scan & Decode ──${RESET}\n`);

  check(manifest !== null, 'data/media/manifest.json exists');
  check(
    manifest && Array.isArray(manifest.images),
    'Manifest contains an images array'
  );

  if (manifest && Array.isArray(manifest.images)) {
    // Every entry has required fields
    const requiredFields = ['location', 'mimeType', 'filename'];
    const allHaveFields = manifest.images.every(img =>
      requiredFields.every(f => img[f] != null) &&
      (img.articleId != null || img.appId != null)
    );
    check(allHaveFields, 'Every manifest entry has required fields (articleId/appId, location, mimeType, filename)');

    // No duplicate filenames
    const filenames = manifest.images.map(img => img.filename);
    const uniqueFilenames = new Set(filenames);
    check(
      filenames.length === uniqueFilenames.size,
      `No duplicate filenames in manifest (${filenames.length} entries, ${uniqueFilenames.size} unique)`,
      filenames.length !== uniqueFilenames.size
        ? `Found ${filenames.length - uniqueFilenames.size} duplicates`
        : undefined
    );

    // File count check
    const failureCount = (manifest.failures || []).length;
    const expectedFileCount = manifest.images.length - failureCount;

    let actualFileCount = 0;
    try {
      const files = await fs.readdir(filesDir);
      actualFileCount = files.length;
    } catch {
      // directory may not exist
    }

    check(
      actualFileCount >= expectedFileCount,
      `File count in data/media/files/ (${actualFileCount}) matches manifest totalImages (${manifest.images.length}) minus failures (${failureCount}) = ${expectedFileCount}`,
      actualFileCount < expectedFileCount ? `Expected ${expectedFileCount}, found ${actualFileCount}` : undefined
    );

    // Every file > 0 bytes
    let zeroByteFiles = 0;
    try {
      const files = await fs.readdir(filesDir);
      for (const file of files) {
        const stat = await fs.stat(path.join(filesDir, file));
        if (stat.size === 0) zeroByteFiles++;
      }
    } catch {
      // skip if dir missing
    }
    check(zeroByteFiles === 0, `Every file in data/media/files/ is > 0 bytes`, zeroByteFiles > 0 ? `${zeroByteFiles} empty files found` : undefined);

    // Magic bytes validation (sample up to 50 files)
    let magicMismatches = 0;
    let magicChecked = 0;
    try {
      const files = await fs.readdir(filesDir);
      const sample = files.slice(0, 50);
      for (const file of sample) {
        const buf = await fs.readFile(path.join(filesDir, file));
        if (buf.length < 4) continue;
        const detected = detectMimeFromBytes(buf);
        if (!detected) {
          // Could be a non-image file (PDF, XLSX, etc.) — skip
          continue;
        }
        // Find the manifest entry to compare
        const entry = manifest.images.find(img => img.filename === file);
        if (entry && detected.mime !== entry.mimeType) {
          magicMismatches++;
        }
        magicChecked++;
      }
    } catch {
      // skip
    }
    check(
      magicMismatches === 0,
      `Magic bytes match declared MIME type (${magicChecked} files checked)`,
      magicMismatches > 0 ? `${magicMismatches} mismatches found` : undefined
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // UPLOAD CHECKS
  // ══════════════════════════════════════════════════════════════════

  console.log(`\n${BOLD}── Upload ──${RESET}\n`);

  check(mediaMap !== null, 'data/maps/media.json exists');

  if (mediaMap) {
    const mapEntryCount = Object.keys(mediaMap).length;
    check(mapEntryCount > 0, `Media map has ${mapEntryCount} entries`);

    // Every entry has strapi5MediaId and strapi5Url
    const allHaveIds = Object.values(mediaMap).every(
      e => typeof e.strapi5MediaId === 'number' && typeof e.strapi5Url === 'string' && e.strapi5Url.startsWith('/uploads/')
    );
    check(allHaveIds, 'Every media map entry has strapi5MediaId (integer) and strapi5Url (starts with /uploads/)');

    // Spot-check media accessibility (sample up to 20)
    const entries = Object.values(mediaMap);
    const sample = entries.slice(0, Math.min(20, entries.length));
    let accessible = 0;
    let inaccessible = 0;

    for (const entry of sample) {
      try {
        const res = await fetch(`${config.strapi5.apiUrl}${entry.strapi5Url}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) accessible++;
        else inaccessible++;
      } catch {
        inaccessible++;
      }
    }

    check(
      inaccessible === 0,
      `Media URLs accessible in Strapi 5 (${accessible}/${sample.length} checked)`,
      inaccessible > 0 ? `${inaccessible} URLs returned non-200 responses` : undefined
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // ARTICLE REWRITE CHECKS
  // ══════════════════════════════════════════════════════════════════

  console.log(`\n${BOLD}── Article Rewrite ──${RESET}\n`);

  check(tArticles !== null, 'data/transformed/articles.json exists');

  if (tArticles && rawArticles) {
    check(
      tArticles.length === rawArticles.length,
      `Record count matches raw (${tArticles.length} transformed vs ${rawArticles.length} raw)`,
      tArticles.length !== rawArticles.length ? 'Count mismatch!' : undefined
    );

    // Zero Base64 remnants in markdown
    let remnantCount = 0;
    for (const a of tArticles) {
      if (a.markdown && a.markdown.includes('data:image/')) {
        remnantCount++;
      }
    }
    check(remnantCount === 0, `Zero data:image/ substrings in transformed markdown fields`, remnantCount > 0 ? `${remnantCount} articles still contain Base64` : undefined);

    // Splash parity
    const rawSplashCount = rawArticles.filter(a => {
      const r = scanStringField(a.splash);
      return r && r.found;
    }).length;
    const tSplashIntCount = tArticles.filter(a => typeof a.splash === 'number').length;
    check(
      tSplashIntCount >= rawSplashCount,
      `Splash parity: ${rawSplashCount} Base64 in raw, ${tSplashIntCount} integer IDs in transformed`,
      tSplashIntCount < rawSplashCount ? `Missing ${rawSplashCount - tSplashIntCount} splash conversions` : undefined
    );

    // Null splash parity
    const rawNullSplash = rawArticles.filter(a => a.splash == null || a.splash === '').length;
    const tNullSplash = tArticles.filter(a => a.splash === null).length;
    check(
      tNullSplash >= rawNullSplash,
      `Null splash preserved: ${rawNullSplash} null in raw, ${tNullSplash} null in transformed`
    );

    // Thumbnail parity
    const rawThumbCount = rawArticles.filter(a => {
      const r = scanStringField(a.thumbnail);
      return r && r.found;
    }).length;
    const tThumbIntCount = tArticles.filter(a => typeof a.thumbnail === 'number').length;
    check(
      tThumbIntCount >= rawThumbCount,
      `Thumbnail parity: ${rawThumbCount} Base64 in raw, ${tThumbIntCount} integer IDs in transformed`,
      tThumbIntCount < rawThumbCount ? `Missing ${rawThumbCount - tThumbIntCount} thumbnail conversions` : undefined
    );

    // Mainfile parity
    const rawMainfileCount = rawArticles.filter(a => a.mainfile != null && typeof a.mainfile === 'object' && a.mainfile.url).length;
    const tMainfileIntCount = tArticles.filter(a => typeof a.mainfile === 'number').length;
    check(
      tMainfileIntCount >= rawMainfileCount,
      `Mainfile parity: ${rawMainfileCount} with media in raw, ${tMainfileIntCount} integer IDs in transformed`,
      tMainfileIntCount < rawMainfileCount ? `Missing ${rawMainfileCount - tMainfileIntCount} mainfile conversions` : undefined
    );

    // Extrafile parity
    const rawExtrafileCount = rawArticles.filter(a => a.extrafile != null && typeof a.extrafile === 'object' && a.extrafile.url).length;
    const tExtrafileIntCount = tArticles.filter(a => typeof a.extrafile === 'number').length;
    check(
      tExtrafileIntCount >= rawExtrafileCount,
      `Extrafile parity: ${rawExtrafileCount} with media in raw, ${tExtrafileIntCount} integer IDs in transformed`,
      tExtrafileIntCount < rawExtrafileCount ? `Missing ${rawExtrafileCount - tExtrafileIntCount} extrafile conversions` : undefined
    );

    // All transformed articles have legacyId, timestamps
    const allHaveLegacyId = tArticles.every(a => a.legacyId != null);
    check(allHaveLegacyId, 'Every transformed article has legacyId');

    const allHaveTimestamps = tArticles.every(a => a._originalCreatedAt != null && a._originalUpdatedAt != null);
    check(allHaveTimestamps, 'Every transformed article has _originalCreatedAt and _originalUpdatedAt');

    // No _relatedAppIds on articles
    const hasRelatedAppIds = tArticles.some(a => a._relatedAppIds != null);
    check(!hasRelatedAppIds, 'No article has _relatedAppIds (articles are non-dominant on article-app)');
  }

  // ══════════════════════════════════════════════════════════════════
  // DATASET CHECKS
  // ══════════════════════════════════════════════════════════════════

  console.log(`\n${BOLD}── Dataset Transform ──${RESET}\n`);

  check(tDatasets !== null, 'data/transformed/datasets.json exists');

  if (tDatasets && rawDatasets) {
    check(
      tDatasets.length === rawDatasets.length,
      `Record count matches raw (${tDatasets.length} transformed vs ${rawDatasets.length} raw)`,
      tDatasets.length !== rawDatasets.length ? 'Count mismatch!' : undefined
    );

    // Datafile parity
    const rawDatafileCount = rawDatasets.filter(d => d.datafile != null && typeof d.datafile === 'object' && d.datafile.url).length;
    const tDatafileIntCount = tDatasets.filter(d => typeof d.datafile === 'number').length;
    check(
      tDatafileIntCount >= rawDatafileCount,
      `Datafile parity: ${rawDatafileCount} with media in raw, ${tDatafileIntCount} integer IDs in transformed`,
      tDatafileIntCount < rawDatafileCount ? `Missing ${rawDatafileCount - tDatafileIntCount} datafile conversions` : undefined
    );

    // Legacy IDs
    const allHaveLegacyId = tDatasets.every(d => d.legacyId != null);
    check(allHaveLegacyId, 'Every transformed dataset has legacyId');

    // Timestamps
    const allHaveTimestamps = tDatasets.every(d => d._originalCreatedAt != null && d._originalUpdatedAt != null);
    check(allHaveTimestamps, 'Every transformed dataset has _originalCreatedAt and _originalUpdatedAt');
  }

  // ══════════════════════════════════════════════════════════════════
  // APP CHECKS
  // ══════════════════════════════════════════════════════════════════

  console.log(`\n${BOLD}── App Transform ──${RESET}\n`);

  check(tApps !== null, 'data/transformed/apps.json exists');

  if (tApps && rawApps) {
    check(
      tApps.length === rawApps.length,
      `Record count matches raw (${tApps.length} transformed vs ${rawApps.length} raw)`,
      tApps.length !== rawApps.length ? 'Count mismatch!' : undefined
    );

    // App image parity
    const rawAppImageCount = rawApps.filter(a => {
      const r = scanStringField(a.image);
      return r && r.found;
    }).length;
    const tAppImageIntCount = tApps.filter(a => typeof a.image === 'number').length;
    check(
      tAppImageIntCount >= rawAppImageCount,
      `App image parity: ${rawAppImageCount} Base64 in raw, ${tAppImageIntCount} integer IDs in transformed`,
      tAppImageIntCount < rawAppImageCount ? `Missing ${rawAppImageCount - tAppImageIntCount} image conversions` : undefined
    );

    // Every app has _relatedDatasetIds and _relatedArticleIds
    const allHaveRelations = tApps.every(a => Array.isArray(a._relatedDatasetIds) && Array.isArray(a._relatedArticleIds));
    check(allHaveRelations, 'Every app has _relatedDatasetIds and _relatedArticleIds arrays');

    // Legacy IDs
    const allHaveLegacyId = tApps.every(a => a.legacyId != null);
    check(allHaveLegacyId, 'Every transformed app has legacyId');

    // Timestamps
    const allHaveTimestamps = tApps.every(a => a._originalCreatedAt != null && a._originalUpdatedAt != null);
    check(allHaveTimestamps, 'Every transformed app has _originalCreatedAt and _originalUpdatedAt');
  }

  // ══════════════════════════════════════════════════════════════════
  // LEGACY ID FORMAT CHECK (all three content types)
  // ══════════════════════════════════════════════════════════════════

  console.log(`\n${BOLD}── Legacy ID Format ──${RESET}\n`);

  // MongoDB ObjectId is a 24-char hex string
  const objectIdRe = /^[a-f0-9]{24}$/;

  if (tArticles) {
    const articleIdsValid = tArticles.every(a => typeof a.legacyId === 'string' && objectIdRe.test(a.legacyId));
    check(articleIdsValid, `All article legacyIds match MongoDB ObjectId format (24 hex chars)`);
  }

  if (tDatasets) {
    const datasetIdsValid = tDatasets.every(d => typeof d.legacyId === 'string' && objectIdRe.test(d.legacyId));
    check(datasetIdsValid, `All dataset legacyIds match MongoDB ObjectId format (24 hex chars)`);
  }

  if (tApps) {
    const appIdsValid = tApps.every(a => typeof a.legacyId === 'string' && objectIdRe.test(a.legacyId));
    check(appIdsValid, `All app legacyIds match MongoDB ObjectId format (24 hex chars)`);
  }

  // ══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${BOLD}Phase 3 Verification Summary${RESET}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Total checks:  ${totalChecks}`);
  console.log(`  ${GREEN}Passed:  ${passedChecks}${RESET}`);
  if (failedChecks > 0) {
    console.log(`  ${RED}Failed:  ${failedChecks}${RESET}`);
  }
  console.log('');

  if (failedChecks === 0) {
    console.log(`${GREEN}\u2713 All Phase 3 checks passed. Ready for Phase 4.${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}\u2717 ${failedChecks} check(s) failed. Review issues above before proceeding.${RESET}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
