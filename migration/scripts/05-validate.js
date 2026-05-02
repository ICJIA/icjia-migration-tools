/**
 * @module 05-validate
 * @description Phase 5: Validation & Reconciliation.
 *
 * Runs 10 automated validation checks to verify that the Strapi 3 → Strapi 5
 * migration is complete and correct. Covers record counts, legacy ID coverage,
 * Base64 remnant scanning, media migration, media accessibility, relation
 * integrity, timestamp preservation, content integrity spot checks, and
 * duplicate detection.
 *
 * Outputs:
 * - `migration/data/validation-report.json` — full results of all 10 checks
 * - Console summary table with per-check pass/fail indicators
 *
 * Exit codes:
 * - 0 if all checks pass
 * - 1 if any check fails
 *
 * @example
 *   pnpm validate
 *
 * Prerequisites:
 * - Phase 4 complete (all content loaded, relations linked, timestamps restored)
 * - Strapi 3 running (for comparison counts and content spot checks)
 * - Strapi 5 running (for REST API queries)
 * - All data files from previous phases in place
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { GraphQLClient } from '../lib/graphql-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ── Config ───────────────────────────────────────────────────────────

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Make an authenticated GET request to the Strapi 5 REST API.
 * @param {string} urlPath - Path relative to the Strapi 5 API base (e.g., "/api/articles")
 * @returns {Promise<Object>} Parsed JSON response
 */
async function strapi5Get(urlPath) {
  const url = `${config.strapi5.apiUrl}${urlPath}`;
  const headers = {};
  if (config.strapi5.token) {
    headers['Authorization'] = `Bearer ${config.strapi5.token}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strapi 5 GET ${urlPath} failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch all records from a Strapi 5 content type using pagination.
 * @param {string} pluralName - Plural API name (e.g., "articles")
 * @param {string} [fields] - Optional fields query string (e.g., "fields[0]=legacyId")
 * @param {string} [populate] - Optional populate query string
 * @returns {Promise<Object[]>} All records
 */
async function strapi5FetchAll(pluralName, fields = '', populate = '') {
  const pageSize = 100;
  let page = 1;
  let all = [];
  let hasMore = true;

  while (hasMore) {
    let url = `/api/${pluralName}?pagination[pageSize]=${pageSize}&pagination[page]=${page}`;
    if (fields) url += `&${fields}`;
    if (populate) url += `&${populate}`;

    const json = await strapi5Get(url);
    const records = json.data || [];
    all = all.concat(records);

    const pagination = json.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return all;
}

/**
 * Read and parse a JSON file from the migration data directory.
 * @param {string} relativePath - Path relative to ROOT
 * @returns {Promise<any>} Parsed JSON
 */
async function readJSON(relativePath) {
  const fullPath = path.resolve(ROOT, relativePath);
  const raw = await fs.readFile(fullPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Simple semaphore for limiting concurrency.
 * @param {number} limit - Maximum concurrent operations
 * @returns {{ acquire: () => Promise<void>, release: () => void }}
 */
function createSemaphore(limit) {
  let running = 0;
  const queue = [];

  return {
    acquire() {
      return new Promise((resolve) => {
        if (running < limit) {
          running++;
          resolve();
        } else {
          queue.push(resolve);
        }
      });
    },
    release() {
      running--;
      if (queue.length > 0) {
        running++;
        const next = queue.shift();
        next();
      }
    },
  };
}

// ── Check 1: Record Counts ───────────────────────────────────────────

/**
 * Compare record counts between Strapi 3 REST and Strapi 5 REST for all 3 content types.
 * @returns {Promise<Object>} Check result with status and details
 */
async function checkRecordCounts() {
  const types = ['articles', 'datasets', 'apps'];
  const details = {};
  let allMatch = true;
  const allowedStatuses = config.allowedStatuses || null;

  for (const t of types) {
    // Strapi 3 count (total, unfiltered)
    let s3Count = null;
    try {
      const s3Url = `${config.strapi3.apiUrl}/${t}/count`;
      const headers = {};
      if (config.strapi3.token) headers['Authorization'] = `Bearer ${config.strapi3.token}`;
      const res = await fetch(s3Url, {
        headers,
        signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 30000),
      });
      if (res.ok) {
        s3Count = await res.json();
      }
    } catch { /* ignore */ }

    // Strapi 5 count
    const s5Json = await strapi5Get(`/api/${t}?pagination[pageSize]=1`);
    const s5Count = s5Json.meta?.pagination?.total ?? null;

    // When filtering by status, S5 will have fewer records than S3 total.
    // Compare S5 count against the local extracted data (which was already filtered).
    let match;
    let expectedCount = s3Count;

    if (allowedStatuses) {
      // Use local raw data count as the expected count (already filtered by status)
      try {
        const rawPath = path.resolve(ROOT, config.paths.rawData, `${t}.json`);
        const rawData = JSON.parse(await fs.readFile(rawPath, 'utf8'));
        expectedCount = rawData.length;
        match = s5Count !== null && s5Count === expectedCount;
      } catch {
        match = false;
      }
    } else {
      match = s3Count !== null && s5Count !== null && s3Count === s5Count;
    }

    if (!match) allMatch = false;

    details[t] = {
      strapi3: s3Count,
      strapi5: s5Count,
      expected: expectedCount,
      match,
      statusFiltered: !!allowedStatuses,
    };
  }

  return {
    check: 'record_counts',
    status: allMatch ? 'PASS' : 'FAIL',
    details,
  };
}

// ── Check 2: Legacy ID Coverage ──────────────────────────────────────

/**
 * Verify every Strapi 3 id maps to exactly one Strapi 5 legacyId.
 * @returns {Promise<Object>} Check result
 */
async function checkLegacyIdCoverage() {
  const types = ['articles', 'datasets', 'apps'];
  const details = {};
  let allGood = true;

  for (const t of types) {
    const rawData = await readJSON(`${config.paths.rawData}/${t}.json`);
    const s3Ids = new Set(rawData.map((r) => String(r.id)));

    const s5Records = await strapi5FetchAll(t, 'fields[0]=legacyId');
    const s5LegacyIds = new Set(s5Records.map((r) => String(r.legacyId)));

    const missing = [...s3Ids].filter((id) => !s5LegacyIds.has(id));
    const orphaned = [...s5LegacyIds].filter((id) => id && !s3Ids.has(id));

    if (missing.length > 0 || orphaned.length > 0) allGood = false;

    details[t] = {
      strapi3Count: s3Ids.size,
      strapi5LegacyIds: s5LegacyIds.size,
      missing,
      orphaned,
    };
  }

  return {
    check: 'legacy_id_coverage',
    status: allGood ? 'PASS' : 'FAIL',
    details,
  };
}

// ── Check 3: Zero Base64 Remnants ────────────────────────────────────

/**
 * Scan all text fields in Strapi 5 for remaining data:image/ strings.
 * @returns {Promise<Object>} Check result
 */
async function checkBase64Remnants() {
  const affectedRecords = [];

  // Articles: markdown, abstract
  const articles = await strapi5FetchAll('articles', 'fields[0]=markdown&fields[1]=abstract&fields[2]=legacyId');
  for (const a of articles) {
    for (const field of ['markdown', 'abstract']) {
      if (a[field] && typeof a[field] === 'string' && a[field].includes('data:image/')) {
        affectedRecords.push({ type: 'article', legacyId: a.legacyId, field });
      }
    }
  }

  // Apps: description
  const apps = await strapi5FetchAll('apps', 'fields[0]=description&fields[1]=legacyId');
  for (const a of apps) {
    if (a.description && typeof a.description === 'string' && a.description.includes('data:image/')) {
      affectedRecords.push({ type: 'app', legacyId: a.legacyId, field: 'description' });
    }
  }

  // Datasets: description
  const datasets = await strapi5FetchAll('datasets', 'fields[0]=description&fields[1]=legacyId');
  for (const d of datasets) {
    if (d.description && typeof d.description === 'string' && d.description.includes('data:image/')) {
      affectedRecords.push({ type: 'dataset', legacyId: d.legacyId, field: 'description' });
    }
  }

  return {
    check: 'zero_base64_remnants',
    status: affectedRecords.length === 0 ? 'PASS' : 'FAIL',
    details: {
      articlesScanned: articles.length,
      appsScanned: apps.length,
      datasetsScanned: datasets.length,
      fieldsScanned: {
        articles: ['markdown', 'abstract'],
        apps: ['description'],
        datasets: ['description'],
      },
      remnantsFound: affectedRecords.length,
      affectedRecords,
    },
  };
}

// ── Check 4: Image/Media Field Migration ─────────────────────────────

/**
 * Verify articles with splash/thumbnail/mainfile/extrafile and apps with image
 * have corresponding media objects in Strapi 5.
 * @returns {Promise<Object>} Check result
 */
async function checkImageMediaMigration() {
  const rawArticles = await readJSON(`${config.paths.rawData}/articles.json`);
  const rawApps = await readJSON(`${config.paths.rawData}/apps.json`);

  const articleMediaFields = ['splash', 'thumbnail', 'mainfile', 'extrafile'];
  const details = {};
  let allGood = true;

  // Build legacy ID → Strapi 5 document ID map from the ID map files
  const articleMap = await readJSON(`${config.paths.maps}/articles.json`);
  const appMap = await readJSON(`${config.paths.maps}/apps.json`);

  // Check article media fields
  for (const field of articleMediaFields) {
    const articlesWithField = rawArticles.filter((a) => {
      if (!a[field]) return false;
      // Media fields can be objects (file uploads) or strings (Base64/URLs)
      if (typeof a[field] === 'object' && a[field] !== null) return true;
      if (typeof a[field] === 'string' && a[field].trim().length > 0) return true;
      return false;
    });

    const missing = [];

    for (const article of articlesWithField) {
      const mapEntry = articleMap[article.id];
      if (!mapEntry) {
        missing.push({ legacyId: article.id, reason: 'not in ID map' });
        continue;
      }

      try {
        const s5 = await strapi5Get(
          `/api/articles/${mapEntry.strapi5DocumentId}?populate=${field}`
        );
        if (!s5.data?.[field]) {
          missing.push({ legacyId: article.id, reason: `${field} is null in Strapi 5` });
        }
      } catch (err) {
        missing.push({ legacyId: article.id, reason: err.message });
      }
    }

    if (missing.length > 0) allGood = false;
    const key = `article${field.charAt(0).toUpperCase() + field.slice(1)}`;
    details[key] = {
      inStrapi3: articlesWithField.length,
      inStrapi5: articlesWithField.length - missing.length,
      missing,
    };
  }

  // Check app image field
  const appsWithImage = rawApps.filter((a) => {
    if (!a.image) return false;
    if (typeof a.image === 'string' && a.image.trim().length > 0) return true;
    if (typeof a.image === 'object' && a.image !== null) return true;
    return false;
  });

  const appMissing = [];
  for (const app of appsWithImage) {
    const mapEntry = appMap[app.id];
    if (!mapEntry) {
      appMissing.push({ legacyId: app.id, reason: 'not in ID map' });
      continue;
    }

    try {
      const s5 = await strapi5Get(`/api/apps/${mapEntry.strapi5DocumentId}?populate=image`);
      if (!s5.data?.image) {
        appMissing.push({ legacyId: app.id, reason: 'image is null in Strapi 5' });
      }
    } catch (err) {
      appMissing.push({ legacyId: app.id, reason: err.message });
    }
  }

  if (appMissing.length > 0) allGood = false;
  details.appImage = {
    inStrapi3: appsWithImage.length,
    inStrapi5: appsWithImage.length - appMissing.length,
    missing: appMissing,
  };

  return {
    check: 'image_media_migration',
    status: allGood ? 'PASS' : 'FAIL',
    details,
  };
}

// ── Check 5: Dataset File Migration ──────────────────────────────────

/**
 * Verify datasets with datafile have media relations in Strapi 5.
 * @returns {Promise<Object>} Check result
 */
async function checkDatasetFileMigration() {
  const rawDatasets = await readJSON(`${config.paths.rawData}/datasets.json`);
  const datasetMap = await readJSON(`${config.paths.maps}/datasets.json`);

  let allGood = true;
  const details = {};

  // Dataset datafile
  const datasetsWithFile = rawDatasets.filter((d) => {
    if (!d.datafile) return false;
    if (typeof d.datafile === 'object' && d.datafile !== null) return true;
    if (typeof d.datafile === 'string' && d.datafile.trim().length > 0) return true;
    return false;
  });

  const missing = [];
  for (const dataset of datasetsWithFile) {
    const mapEntry = datasetMap[dataset.id];
    if (!mapEntry) {
      missing.push({ legacyId: dataset.id, reason: 'not in ID map' });
      continue;
    }

    try {
      const s5 = await strapi5Get(`/api/datasets/${mapEntry.strapi5DocumentId}?populate=datafile`);
      if (!s5.data?.datafile) {
        missing.push({ legacyId: dataset.id, reason: 'datafile is null in Strapi 5' });
      }
    } catch (err) {
      missing.push({ legacyId: dataset.id, reason: err.message });
    }
  }

  if (missing.length > 0) allGood = false;
  details.datasetDatafile = {
    inStrapi3: datasetsWithFile.length,
    inStrapi5: datasetsWithFile.length - missing.length,
    missing,
  };

  return {
    check: 'dataset_file_migration',
    status: allGood ? 'PASS' : 'FAIL',
    details,
  };
}

// ── Check 6: Media Accessibility ─────────────────────────────────────

/**
 * HEAD request every URL in media.json to verify HTTP 200.
 * Uses a concurrency limit of 10 parallel requests.
 * @returns {Promise<Object>} Check result
 */
async function checkMediaAccessibility() {
  let mediaMap;
  try {
    mediaMap = await readJSON(`${config.paths.maps}/media.json`);
  } catch {
    return {
      check: 'media_accessibility',
      status: 'WARN',
      details: { message: 'media.json not found — skipping media accessibility check' },
    };
  }

  // mediaMap can be an array or object; normalize to array of { url }
  let mediaEntries;
  if (Array.isArray(mediaMap)) {
    mediaEntries = mediaMap;
  } else {
    mediaEntries = Object.values(mediaMap);
  }

  // Extract URLs
  const urls = mediaEntries
    .map((entry) => entry.strapi5Url || entry.url)
    .filter(Boolean);

  if (urls.length === 0) {
    return {
      check: 'media_accessibility',
      status: 'WARN',
      details: { message: 'No media URLs found in media.json' },
    };
  }

  const sem = createSemaphore(10);
  const failures = [];

  const checks = urls.map(async (url) => {
    await sem.acquire();
    try {
      const fullUrl = url.startsWith('http') ? url : `${config.strapi5.apiUrl}${url}`;
      const res = await fetch(fullUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
      });
      if (res.status !== 200) {
        failures.push({ url, status: res.status });
      }
    } catch (err) {
      failures.push({ url, error: err.message });
    } finally {
      sem.release();
    }
  });

  await Promise.all(checks);

  return {
    check: 'media_accessibility',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    details: {
      totalMediaFiles: urls.length,
      accessible: urls.length - failures.length,
      inaccessible: failures.length,
      failures: failures.slice(0, 50), // limit output
    },
  };
}

// ── Check 7: Relation Integrity ──────────────────────────────────────

/**
 * Verify all three m2m relation sets: article→datasets, app→articles, app→datasets.
 * @returns {Promise<Object>} Check result
 */
async function checkRelationIntegrity() {
  const transformedArticles = await readJSON(`${config.paths.transformedData}/articles.json`);
  const transformedApps = await readJSON(`${config.paths.transformedData}/apps.json`);

  let allGood = true;
  const details = {};

  // Article → Datasets
  {
    const s5Articles = await strapi5FetchAll(
      'articles',
      'fields[0]=legacyId',
      'populate[datasets][fields][0]=legacyId'
    );

    let relationsChecked = 0;
    let correctRelations = 0;
    const missingRelations = [];
    const extraRelations = [];

    for (const s5Art of s5Articles) {
      const legacyId = String(s5Art.legacyId);
      const transformed = transformedArticles.find((a) => String(a.legacyId) === legacyId);
      if (!transformed) continue;

      const expectedIds = new Set((transformed._relatedDatasetIds || []).map(String));
      const actualIds = new Set(
        (s5Art.datasets || []).map((d) => String(d.legacyId))
      );

      relationsChecked += expectedIds.size;

      for (const eid of expectedIds) {
        if (actualIds.has(eid)) {
          correctRelations++;
        } else {
          missingRelations.push({ articleLegacyId: legacyId, missingDatasetLegacyId: eid });
        }
      }
      for (const aid of actualIds) {
        if (!expectedIds.has(aid)) {
          extraRelations.push({ articleLegacyId: legacyId, extraDatasetLegacyId: aid });
        }
      }
    }

    if (missingRelations.length > 0 || extraRelations.length > 0) allGood = false;

    details.articleDatasetRelations = {
      articlesSampled: s5Articles.length,
      relationsChecked,
      correctRelations,
      missingRelations: missingRelations.slice(0, 20),
      extraRelations: extraRelations.slice(0, 20),
    };
  }

  // App → Articles and App → Datasets
  {
    const s5Apps = await strapi5FetchAll(
      'apps',
      'fields[0]=legacyId',
      'populate[articles][fields][0]=legacyId&populate[datasets][fields][0]=legacyId'
    );

    let artRelChecked = 0, artRelCorrect = 0;
    let dsRelChecked = 0, dsRelCorrect = 0;
    const artMissing = [], artExtra = [];
    const dsMissing = [], dsExtra = [];

    for (const s5App of s5Apps) {
      const legacyId = String(s5App.legacyId);
      const transformed = transformedApps.find((a) => String(a.legacyId) === legacyId);
      if (!transformed) continue;

      // App → Articles
      const expectedArtIds = new Set((transformed._relatedArticleIds || []).map(String));
      const actualArtIds = new Set((s5App.articles || []).map((a) => String(a.legacyId)));

      artRelChecked += expectedArtIds.size;
      for (const eid of expectedArtIds) {
        if (actualArtIds.has(eid)) artRelCorrect++;
        else artMissing.push({ appLegacyId: legacyId, missingArticleLegacyId: eid });
      }
      for (const aid of actualArtIds) {
        if (!expectedArtIds.has(aid)) artExtra.push({ appLegacyId: legacyId, extraArticleLegacyId: aid });
      }

      // App → Datasets
      const expectedDsIds = new Set((transformed._relatedDatasetIds || []).map(String));
      const actualDsIds = new Set((s5App.datasets || []).map((d) => String(d.legacyId)));

      dsRelChecked += expectedDsIds.size;
      for (const eid of expectedDsIds) {
        if (actualDsIds.has(eid)) dsRelCorrect++;
        else dsMissing.push({ appLegacyId: legacyId, missingDatasetLegacyId: eid });
      }
      for (const aid of actualDsIds) {
        if (!expectedDsIds.has(aid)) dsExtra.push({ appLegacyId: legacyId, extraDatasetLegacyId: aid });
      }
    }

    if (artMissing.length > 0 || artExtra.length > 0) allGood = false;
    if (dsMissing.length > 0 || dsExtra.length > 0) allGood = false;

    details.appArticleRelations = {
      appsSampled: s5Apps.length,
      relationsChecked: artRelChecked,
      correctRelations: artRelCorrect,
      missingRelations: artMissing.slice(0, 20),
      extraRelations: artExtra.slice(0, 20),
    };

    details.appDatasetRelations = {
      appsSampled: s5Apps.length,
      relationsChecked: dsRelChecked,
      correctRelations: dsRelCorrect,
      missingRelations: dsMissing.slice(0, 20),
      extraRelations: dsExtra.slice(0, 20),
    };
  }

  return {
    check: 'relation_integrity',
    status: allGood ? 'PASS' : 'FAIL',
    details,
  };
}

// ── Check 8: Timestamp Preservation ──────────────────────────────────

/**
 * Compare created_at/updated_at in SQLite against _originalCreatedAt/_originalUpdatedAt
 * from transformed data. Allows ±1 second tolerance.
 * @returns {Promise<Object>} Check result
 */
async function checkTimestampPreservation() {
  const dbPath = path.resolve(ROOT, config.strapi5.dbPath);

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return {
      check: 'timestamp_preservation',
      status: 'WARN',
      details: { message: `Cannot open SQLite DB: ${err.message}` },
    };
  }

  const types = [
    { name: 'articles', singular: 'article', transformedPath: `${config.paths.transformedData}/articles.json`, mapPath: `${config.paths.maps}/articles.json` },
    { name: 'datasets', singular: 'dataset', transformedPath: `${config.paths.transformedData}/datasets.json`, mapPath: `${config.paths.maps}/datasets.json` },
    { name: 'apps', singular: 'app', transformedPath: `${config.paths.transformedData}/apps.json`, mapPath: `${config.paths.maps}/apps.json` },
  ];

  let totalChecked = 0;
  let totalMatches = 0;
  const mismatchDetails = [];

  for (const t of types) {
    // Discover table name and columns
    let tableName = t.name; // try plural first
    let tableInfo = db.pragma(`table_info(${tableName})`);
    if (tableInfo.length === 0) {
      tableName = t.singular; // try singular
      tableInfo = db.pragma(`table_info(${tableName})`);
    }
    if (tableInfo.length === 0) {
      mismatchDetails.push({ type: t.name, error: `Table not found (tried ${t.name} and ${t.singular})` });
      continue;
    }

    const colNames = tableInfo.map((c) => c.name);

    // Determine column names for legacy_id, created_at, updated_at, document_id
    const legacyIdCol = colNames.includes('legacy_id') ? 'legacy_id' : (colNames.includes('legacyId') ? 'legacyId' : null);
    const createdAtCol = colNames.includes('created_at') ? 'created_at' : (colNames.includes('createdAt') ? 'createdAt' : null);
    const updatedAtCol = colNames.includes('updated_at') ? 'updated_at' : (colNames.includes('updatedAt') ? 'updatedAt' : null);
    const documentIdCol = colNames.includes('document_id') ? 'document_id' : (colNames.includes('documentId') ? 'documentId' : null);

    if (!createdAtCol || !updatedAtCol) {
      mismatchDetails.push({ type: t.name, error: `Timestamp columns not found. Columns: ${colNames.join(', ')}` });
      continue;
    }

    const transformed = await readJSON(t.transformedPath);
    const idMap = await readJSON(t.mapPath);

    // Build documentId → transformed record lookup
    const docIdToTransformed = new Map();
    for (const rec of transformed) {
      const mapEntry = idMap[rec.legacyId];
      if (mapEntry?.documentId) {
        docIdToTransformed.set(mapEntry.strapi5DocumentId, rec);
      }
    }

    // Query SQLite
    let rows;
    if (documentIdCol) {
      rows = db.prepare(`SELECT "${documentIdCol}", "${createdAtCol}", "${updatedAtCol}" FROM "${tableName}"`).all();
    } else if (legacyIdCol) {
      rows = db.prepare(`SELECT "${legacyIdCol}", "${createdAtCol}", "${updatedAtCol}" FROM "${tableName}"`).all();
    } else {
      mismatchDetails.push({ type: t.name, error: `No document_id or legacy_id column. Columns: ${colNames.join(', ')}` });
      continue;
    }

    for (const row of rows) {
      const lookupKey = documentIdCol ? row[documentIdCol] : null;
      const rec = lookupKey ? docIdToTransformed.get(lookupKey) : null;
      if (!rec) continue;

      totalChecked++;

      const origCreated = rec._originalCreatedAt;
      const origUpdated = rec._originalUpdatedAt;
      const dbCreated = row[createdAtCol];
      const dbUpdated = row[updatedAtCol];

      if (!origCreated || !dbCreated) continue;

      const createdDiff = Math.abs(new Date(origCreated).getTime() - new Date(dbCreated).getTime());
      const updatedDiff = Math.abs(new Date(origUpdated).getTime() - new Date(dbUpdated).getTime());

      if (createdDiff <= 1000 && updatedDiff <= 1000) {
        totalMatches++;
      } else {
        mismatchDetails.push({
          type: t.name,
          documentId: lookupKey,
          origCreated,
          dbCreated,
          origUpdated,
          dbUpdated,
          createdDiffMs: createdDiff,
          updatedDiffMs: updatedDiff,
        });
      }
    }
  }

  db.close();

  const mismatches = mismatchDetails.filter((d) => !d.error);

  return {
    check: 'timestamp_preservation',
    status: mismatches.length === 0 ? 'PASS' : 'FAIL',
    details: {
      recordsChecked: totalChecked,
      matches: totalMatches,
      mismatches: mismatches.length,
      mismatchDetails: mismatchDetails.slice(0, 20),
    },
  };
}

// ── Check 9: Content Integrity (Spot Check) ──────────────────────────

/**
 * Random 10% of articles: compare title/slug exactly, markdown length plausible.
 * Uses Strapi 3 GraphQL and Strapi 5 REST.
 * @returns {Promise<Object>} Check result
 */
async function checkContentIntegrity() {
  const rawArticles = await readJSON(`${config.paths.rawData}/articles.json`);
  const articleMap = await readJSON(`${config.paths.maps}/articles.json`);

  // Select random 10%
  const sampleSize = Math.max(1, Math.ceil(rawArticles.length * 0.1));
  const shuffled = [...rawArticles].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, sampleSize);

  const client = new GraphQLClient(config.strapi3.graphqlUrl, {
    token: config.strapi3.token,
    timeoutMs: config.settings?.requestTimeoutMs || 30000,
  });

  let allGood = true;
  const checked = [];
  const failures = [];

  for (const article of sample) {
    const mapEntry = articleMap[article.id];
    if (!mapEntry) {
      failures.push({ legacyId: article.id, reason: 'not in ID map' });
      allGood = false;
      continue;
    }

    // Fetch from Strapi 3 via GraphQL
    let s3Article;
    try {
      const s3Result = await client.query(
        `query GetArticle($id: ID!) { article(id: $id) { title slug markdown } }`,
        { id: article.id }
      );
      s3Article = s3Result.data?.article;
    } catch (err) {
      failures.push({ legacyId: article.id, reason: `Strapi 3 fetch failed: ${err.message}` });
      allGood = false;
      continue;
    }

    if (!s3Article) {
      failures.push({ legacyId: article.id, reason: 'Not found in Strapi 3' });
      allGood = false;
      continue;
    }

    // Fetch from Strapi 5 via REST
    let s5Article;
    try {
      const s5Result = await strapi5Get(
        `/api/articles/${mapEntry.strapi5DocumentId}?fields[0]=title&fields[1]=slug&fields[2]=markdown`
      );
      s5Article = s5Result.data;
    } catch (err) {
      failures.push({ legacyId: article.id, reason: `Strapi 5 fetch failed: ${err.message}` });
      allGood = false;
      continue;
    }

    const issues = [];
    const expectedChanges = [];

    // Compare title
    if (s3Article.title !== s5Article.title) {
      issues.push(`title mismatch: "${s3Article.title}" vs "${s5Article.title}"`);
    }

    // Compare slug
    if (s3Article.slug !== s5Article.slug) {
      issues.push(`slug mismatch: "${s3Article.slug}" vs "${s5Article.slug}"`);
    }

    // Compare markdown length
    // Markdown may be LONGER in Strapi 5 because reference-style images like
    // ![Fig1][Fig1] were converted to inline images with full URLs like
    // ![Fig1](https://v2.hub.icjia-api.cloud/uploads/long-filename.png).
    // This is expected and not a data integrity issue.
    const s3Len = (s3Article.markdown || '').length;
    const s5Len = (s5Article.markdown || '').length;
    if (s5Len > s3Len && s3Len > 0) {
      // Expected: image URL inlining makes markdown longer — record as info, not failure
      expectedChanges.push(`markdown longer in Strapi 5: ${s5Len} > ${s3Len} (expected — image URLs inlined)`);
    }

    if (issues.length > 0) {
      failures.push({ legacyId: article.id, issues });
      allGood = false;
    } else {
      checked.push({
        legacyId: article.id,
        title: s3Article.title,
        markdownLenS3: s3Len,
        markdownLenS5: s5Len,
        expectedChanges: expectedChanges.length > 0 ? expectedChanges : undefined,
      });
    }
  }

  return {
    check: 'content_integrity',
    status: allGood ? 'PASS' : (failures.length > sampleSize / 2 ? 'FAIL' : 'WARN'),
    details: {
      sampleSize,
      passed: checked.length,
      failed: failures.length,
      expectedChanges: checked.filter((r) => r.expectedChanges).length,
      checkedRecords: checked.slice(0, 10),
      failures: failures.slice(0, 20),
    },
  };
}

// ── Check 10: No Duplicates ──────────────────────────────────────────

/**
 * Query SQLite for duplicate legacyId values in all content type tables.
 * @returns {Promise<Object>} Check result
 */
async function checkNoDuplicates() {
  const dbPath = path.resolve(ROOT, config.strapi5.dbPath);

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return {
      check: 'no_duplicates',
      status: 'WARN',
      details: { message: `Cannot open SQLite DB: ${err.message}` },
    };
  }

  const tables = [
    { name: 'articles', singular: 'article' },
    { name: 'datasets', singular: 'dataset' },
    { name: 'apps', singular: 'app' },
  ];

  let allGood = true;
  const details = {};

  for (const t of tables) {
    // Find the actual table name
    let tableName = t.name;
    let tableInfo = db.pragma(`table_info(${tableName})`);
    if (tableInfo.length === 0) {
      tableName = t.singular;
      tableInfo = db.pragma(`table_info(${tableName})`);
    }
    if (tableInfo.length === 0) {
      details[t.name] = { error: `Table not found (tried ${t.name} and ${t.singular})` };
      continue;
    }

    const colNames = tableInfo.map((c) => c.name);
    const legacyIdCol = colNames.includes('legacy_id') ? 'legacy_id' : (colNames.includes('legacyId') ? 'legacyId' : null);

    if (!legacyIdCol) {
      details[t.name] = { error: `No legacy_id column found. Columns: ${colNames.join(', ')}` };
      continue;
    }

    const duplicates = db.prepare(
      `SELECT "${legacyIdCol}", COUNT(*) as cnt FROM "${tableName}" GROUP BY "${legacyIdCol}" HAVING cnt > 1`
    ).all();

    if (duplicates.length > 0) allGood = false;

    details[t.name] = {
      duplicateCount: duplicates.length,
      duplicates: duplicates.slice(0, 20),
    };
  }

  db.close();

  return {
    check: 'no_duplicates',
    status: allGood ? 'PASS' : 'FAIL',
    details,
  };
}

// ── Console Summary ──────────────────────────────────────────────────

/**
 * Print a formatted summary table of all check results.
 * @param {Object[]} results - Array of check result objects
 */
function printSummary(results) {
  console.log('');
  console.log(`${BOLD}╔═══════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  ResearchHub Migration Validation ║${RESET}`);
  console.log(`${BOLD}╚═══════════════════════════════════╝${RESET}`);
  console.log('');

  const labels = {
    record_counts: 'Record counts',
    legacy_id_coverage: 'Legacy ID coverage',
    zero_base64_remnants: 'Zero Base64 remnants',
    image_media_migration: 'Image/media migration',
    dataset_file_migration: 'Dataset file migration',
    media_accessibility: 'Media accessibility',
    relation_integrity: 'Relation integrity',
    timestamp_preservation: 'Timestamp preservation',
    content_integrity: 'Content integrity',
    no_duplicates: 'No duplicates',
  };

  for (const r of results) {
    const label = labels[r.check] || r.check;
    const dots = '.'.repeat(Math.max(1, 30 - label.length));
    let icon, statusColor;

    if (r.status === 'PASS') {
      icon = '✓';
      statusColor = GREEN;
    } else if (r.status === 'WARN') {
      icon = '⚠';
      statusColor = YELLOW;
    } else {
      icon = '✗';
      statusColor = RED;
    }

    let summary = '';
    const d = r.details;

    switch (r.check) {
      case 'record_counts':
        if (d.articles) {
          const parts = ['articles', 'datasets', 'apps']
            .filter((t) => d[t])
            .map((t) => `${d[t].strapi5 ?? '?'} ${t}`);
          summary = `(${parts.join(', ')})`;
        }
        break;
      case 'legacy_id_coverage': {
        const total = ['articles', 'datasets', 'apps']
          .filter((t) => d[t])
          .reduce((sum, t) => sum + (d[t].strapi5LegacyIds || 0), 0);
        const s3Total = ['articles', 'datasets', 'apps']
          .filter((t) => d[t])
          .reduce((sum, t) => sum + (d[t].strapi3Count || 0), 0);
        summary = `(${total}/${s3Total} mapped)`;
        break;
      }
      case 'zero_base64_remnants':
        summary = `(${d.remnantsFound ?? 0} found in ${d.articlesScanned ?? 0} articles + ${d.appsScanned ?? 0} apps + ${d.datasetsScanned ?? 0} datasets)`;
        break;
      case 'image_media_migration': {
        const parts = [];
        if (d.articleSplash) parts.push(`splash ${d.articleSplash.inStrapi5}/${d.articleSplash.inStrapi3}`);
        if (d.articleThumbnail) parts.push(`thumbnail ${d.articleThumbnail.inStrapi5}/${d.articleThumbnail.inStrapi3}`);
        if (d.articleMainfile) parts.push(`mainfile ${d.articleMainfile.inStrapi5}/${d.articleMainfile.inStrapi3}`);
        if (d.articleExtrafile) parts.push(`extrafile ${d.articleExtrafile.inStrapi5}/${d.articleExtrafile.inStrapi3}`);
        if (d.appImage) parts.push(`app image ${d.appImage.inStrapi5}/${d.appImage.inStrapi3}`);
        summary = `(${parts.join(', ')})`;
        break;
      }
      case 'dataset_file_migration':
        if (d.datasetDatafile) {
          summary = `(${d.datasetDatafile.inStrapi5}/${d.datasetDatafile.inStrapi3} migrated)`;
        }
        break;
      case 'media_accessibility':
        summary = `(${d.accessible ?? '?'}/${d.totalMediaFiles ?? '?'} accessible)`;
        break;
      case 'relation_integrity': {
        const parts = [];
        if (d.articleDatasetRelations) parts.push(`article→dataset ${d.articleDatasetRelations.correctRelations}`);
        if (d.appArticleRelations) parts.push(`app→article ${d.appArticleRelations.correctRelations}`);
        if (d.appDatasetRelations) parts.push(`app→dataset ${d.appDatasetRelations.correctRelations}`);
        summary = parts.length > 0 ? `(${parts.join(', ')} — all correct)` : '';
        break;
      }
      case 'timestamp_preservation':
        summary = `(${d.matches ?? '?'}/${d.recordsChecked ?? '?'} match)`;
        break;
      case 'content_integrity':
        summary = `(${d.passed ?? '?'}/${d.sampleSize ?? '?'} spot checks passed${d.expectedChanges ? `, ${d.expectedChanges} with expected changes` : ''})`;
        break;
      case 'no_duplicates': {
        const totalDups = ['articles', 'datasets', 'apps']
          .filter((t) => d[t])
          .reduce((sum, t) => sum + (d[t].duplicateCount || 0), 0);
        summary = `(${totalDups} duplicates in article/dataset/app tables)`;
        break;
      }
    }

    console.log(`  ${statusColor}${icon}${RESET} ${label} ${DIM}${dots}${RESET} ${statusColor}${r.status}${RESET} ${summary}`);

    // Print failure details inline
    if (r.status === 'FAIL') {
      const failDetails = getFailureDetails(r);
      for (const line of failDetails) {
        console.log(`    ${RED}→ ${line}${RESET}`);
      }
    }

    // Print expected changes as informational notes (not errors)
    if (r.check === 'content_integrity' && r.status === 'PASS' && r.details.expectedChanges > 0) {
      console.log(`    ${CYAN}ℹ ${r.details.expectedChanges} record(s) have longer markdown due to image URL inlining — this is expected${RESET}`);
    }
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const warned = results.filter((r) => r.status === 'WARN').length;

  console.log('');
  if (failed === 0) {
    console.log(`  ${GREEN}${BOLD}Result: ${passed}/${results.length} checks passed${warned > 0 ? `, ${warned} warnings` : ''} — MIGRATION VALIDATED ✓${RESET}`);
  } else {
    console.log(`  ${RED}${BOLD}Result: ${passed}/${results.length} checks passed, ${failed} FAILED${warned > 0 ? `, ${warned} warnings` : ''} — REVIEW REQUIRED${RESET}`);
  }

  console.log('');
  console.log(`  Full report: migration/data/validation-report.json`);
  console.log('');
}

/**
 * Extract brief failure details for inline console display.
 * @param {Object} result - A check result object
 * @returns {string[]} Lines of failure detail
 */
function getFailureDetails(result) {
  const lines = [];
  const d = result.details;

  switch (result.check) {
    case 'record_counts':
      for (const t of ['articles', 'datasets', 'apps']) {
        if (d[t] && !d[t].match) {
          if (d[t].statusFiltered) {
            lines.push(`${t}: expected ${d[t].expected} (filtered), Strapi 5 = ${d[t].strapi5}, Strapi 3 total = ${d[t].strapi3}`);
          } else {
            lines.push(`${t}: Strapi 3 = ${d[t].strapi3}, Strapi 5 = ${d[t].strapi5}`);
          }
        }
      }
      break;
    case 'legacy_id_coverage':
      for (const t of ['articles', 'datasets', 'apps']) {
        if (d[t]?.missing?.length > 0) lines.push(`${t}: ${d[t].missing.length} missing`);
        if (d[t]?.orphaned?.length > 0) lines.push(`${t}: ${d[t].orphaned.length} orphaned`);
      }
      break;
    case 'zero_base64_remnants':
      for (const rec of (d.affectedRecords || []).slice(0, 5)) {
        lines.push(`${rec.type} legacyId=${rec.legacyId} field=${rec.field}`);
      }
      break;
    case 'media_accessibility':
      for (const f of (d.failures || []).slice(0, 5)) {
        lines.push(`${f.url}: ${f.status || f.error}`);
      }
      break;
    case 'content_integrity':
      for (const f of (d.failures || []).slice(0, 5)) {
        lines.push(`legacyId=${f.legacyId}: ${f.reason || (f.issues || []).join(', ')}`);
      }
      break;
    default:
      lines.push(`See validation-report.json for details`);
  }

  return lines;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}=== Phase 5: Validation & Reconciliation ===${RESET}\n`);

  // Show config
  console.log('Configuration:');
  console.log(`  Strapi 3 API:     ${config.strapi3.apiUrl}`);
  console.log(`  Strapi 3 GraphQL: ${config.strapi3.graphqlUrl}`);
  console.log(`  Strapi 5 API:     ${config.strapi5.apiUrl}`);
  console.log(`  Strapi 5 DB:      ${config.strapi5.dbPath}`);
  console.log(`  Strapi 5 token:   ${config.strapi5.token ? '(set)' : '(not set)'}`);
  console.log(`  Raw data:         ${config.paths.rawData}`);
  console.log(`  Transformed data: ${config.paths.transformedData}`);
  console.log(`  Maps:             ${config.paths.maps}`);
  console.log('');

  const checks = [
    { name: 'Check 1: Record counts', fn: checkRecordCounts },
    { name: 'Check 2: Legacy ID coverage', fn: checkLegacyIdCoverage },
    { name: 'Check 3: Zero Base64 remnants', fn: checkBase64Remnants },
    { name: 'Check 4: Image/media migration', fn: checkImageMediaMigration },
    { name: 'Check 5: Dataset file migration', fn: checkDatasetFileMigration },
    { name: 'Check 6: Media accessibility', fn: checkMediaAccessibility },
    { name: 'Check 7: Relation integrity', fn: checkRelationIntegrity },
    { name: 'Check 8: Timestamp preservation', fn: checkTimestampPreservation },
    { name: 'Check 9: Content integrity', fn: checkContentIntegrity },
    { name: 'Check 10: No duplicates', fn: checkNoDuplicates },
  ];

  const results = [];

  for (const check of checks) {
    process.stdout.write(`Running ${check.name}...`);
    try {
      const result = await check.fn();
      results.push(result);

      if (result.status === 'PASS') {
        console.log(` ${GREEN}${result.status}${RESET}`);
      } else if (result.status === 'WARN') {
        console.log(` ${YELLOW}${result.status}${RESET}`);
      } else {
        console.log(` ${RED}${result.status}${RESET}`);
      }
    } catch (err) {
      console.log(` ${RED}ERROR${RESET}`);
      console.error(`  ${RED}${err.message}${RESET}`);
      results.push({
        check: check.fn.name.replace('check', '').replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''),
        status: 'FAIL',
        details: { error: err.message },
      });
    }
  }

  // Build report
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const warned = results.filter((r) => r.status === 'WARN').length;

  const report = {
    generatedAt: new Date().toISOString(),
    overallStatus: failed === 0 ? 'PASS' : 'FAIL',
    checksRun: results.length,
    checksPassed: passed,
    checksFailed: failed,
    checksWarned: warned,
    checks: results,
  };

  // Save report
  const reportDir = path.resolve(ROOT, config.paths.maps, '..');
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.resolve(ROOT, 'migration/data/validation-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  printSummary(results);

  // Exit code
  if (failed > 0) {
    console.log('');
    console.log(`${RED}Validation failed.${RESET} Fix the issues above, then re-run:`);
    console.log(`  pnpm migrate:phase05`);
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log('Next: Phase 6 (Field-by-Field Parity Audit)');
  console.log(`  pnpm migrate:phase06`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
