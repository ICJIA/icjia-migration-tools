/**
 * @module 07-sync
 * @description Incremental sync: finds new/updated records in Strapi 3 that are
 * missing or stale in Strapi 5, and migrates them.
 *
 * Use this when Strapi 5 has been running in dev for a while and new content
 * has been added to Strapi 3. Instead of re-running the full 6-phase migration,
 * this script does an incremental catch-up.
 *
 * What it does:
 * 1. Fetches all record IDs + updatedAt from both Strapi 3 and Strapi 5
 * 2. Identifies NEW records (in S3 but not in S5)
 * 3. Identifies UPDATED records (updatedAt in S3 is newer than S5)
 * 4. For NEW records: extracts, transforms, uploads media, loads into S5, links relations
 * 5. For UPDATED records: flags them for review (does NOT auto-overwrite)
 *
 * What it does NOT do:
 * - Delete records from S5 that were deleted in S3 (flags them instead)
 * - Auto-update existing records (too risky — flags for manual review)
 * - Re-run timestamp fixes (new records get correct timestamps from the API)
 *
 * @example
 *   pnpm sync
 *   # or: node migration/scripts/07-sync.js
 *
 * Prerequisites:
 * - Strapi 3 running and accessible
 * - Strapi 5 running with API token configured
 * - Initial migration (Phases 1-4) already completed
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../lib/load-config.js';
import { GraphQLClient } from '../lib/graphql-client.js';
import { scanStringField, scanMarkdownImages } from '../lib/base64-scanner.js';
import { decodeBase64ToFile } from '../lib/base64-decoder.js';
import { rewriteMarkdownImages } from '../lib/markdown-rewriter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const config = await loadConfig();

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const DELAY_MS = config.settings?.requestDelayMs || 100;
const TIMEOUT_MS = config.settings?.requestTimeoutMs || 30000;

// ── Helpers ──────────────────────────────────────────────────────────

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make an authenticated GET request to Strapi 5.
 * @param {string} urlPath - Full URL path with query params
 * @returns {Promise<Object>}
 */
async function s5Get(urlPath) {
  const headers = {};
  if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;
  const res = await fetch(`${config.strapi5.apiUrl}${urlPath}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`S5 GET ${urlPath} failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * POST JSON to Strapi 5.
 * @param {string} urlPath
 * @param {Object} data - Will be wrapped in { data: ... }
 * @returns {Promise<Object>}
 */
async function s5Post(urlPath, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;
  const res = await fetch(`${config.strapi5.apiUrl}${urlPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`S5 POST ${urlPath} failed: ${res.status} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * PUT JSON to Strapi 5.
 * @param {string} urlPath
 * @param {Object} data
 * @returns {Promise<Object>}
 */
async function s5Put(urlPath, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;
  const res = await fetch(`${config.strapi5.apiUrl}${urlPath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`S5 PUT ${urlPath} failed: ${res.status} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Upload a file buffer to Strapi 5 media library.
 * @param {Buffer} fileBuffer
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<Object>} Upload response
 */
async function s5Upload(fileBuffer, filename, mimeType) {
  const formData = new FormData();
  formData.append('files', new Blob([fileBuffer], { type: mimeType }), filename);

  const headers = {};
  if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;

  const res = await fetch(`${config.strapi5.apiUrl}/api/upload`, {
    method: 'POST',
    headers,
    body: formData,
    signal: AbortSignal.timeout(TIMEOUT_MS * 3),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`S5 upload failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Download a file from Strapi 3.
 * @param {string} fileUrl - Relative URL (e.g., /uploads/file.xlsx)
 * @returns {Promise<Buffer>}
 */
async function s3Download(fileUrl) {
  const url = fileUrl.startsWith('http') ? fileUrl : `${config.strapi3.apiUrl}${fileUrl}`;
  const headers = {};
  if (config.strapi3.token) headers['Authorization'] = `Bearer ${config.strapi3.token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS * 3) });
  if (!res.ok) throw new Error(`S3 download ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Fetch all IDs + timestamps from both systems ────────────────────

/**
 * Fetch all legacyIds and updatedAt from Strapi 5 for a content type.
 * @param {string} pluralName - e.g., "articles"
 * @returns {Promise<Map<string, {documentId: string, updatedAt: string}>>} Map by legacyId
 */
async function fetchS5Records(pluralName) {
  const map = new Map();
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await s5Get(
      `/api/${pluralName}?fields[0]=legacyId&fields[1]=updatedAt&pagination[page]=${page}&pagination[pageSize]=100`
    );
    for (const rec of res.data || []) {
      if (rec.legacyId) {
        map.set(rec.legacyId, {
          documentId: rec.documentId,
          updatedAt: rec.updatedAt,
        });
      }
    }
    hasMore = res.meta?.pagination?.page < res.meta?.pagination?.pageCount;
    page++;
    await sleep(DELAY_MS);
  }

  return map;
}

// GraphQL queries — lightweight, just id + updatedAt + key fields for new record processing
const LIGHT_QUERIES = {
  articles: `query($start:Int!,$limit:Int!){articles(start:$start,limit:$limit,sort:"createdAt:asc"){
    id title status slug date external categories tags authors
    splash thumbnail images abstract markdown mainfiletype funding citation doi hideFromBanner
    createdAt updatedAt
    datasets{id} apps{id}
    mainfile{id url name mime size ext} extrafile{id url name mime size ext}
  }}`,
  datasets: `query($start:Int!,$limit:Int!){datasets(start:$start,limit:$limit,sort:"createdAt:asc"){
    id title status slug date external categories tags project sources unit timeperiod
    description notes variables funding citation createdAt updatedAt
    datafile{id url name mime size ext} apps{id} articles{id}
  }}`,
  apps: `query($start:Int!,$limit:Int!){apps(start:$start,limit:$limit,sort:"createdAt:asc"){
    id title status slug date external categories tags contributors
    image description url funding citation createdAt updatedAt
    datasets{id} articles{id}
  }}`,
};

/**
 * Fetch all records from Strapi 3 for a content type.
 * @param {string} pluralName
 * @param {GraphQLClient} client
 * @returns {Promise<Object[]>}
 */
async function fetchS3Records(pluralName, client) {
  const limit = config.settings?.paginationLimit || 100;
  let start = 0;
  let all = [];
  let batch;

  do {
    const res = await client.query(LIGHT_QUERIES[pluralName], { start, limit });
    batch = res.data[pluralName] || [];
    all = all.concat(batch);
    start += limit;
    await sleep(DELAY_MS);
  } while (batch.length === limit);

  return all;
}

// ── Process a single Base64 string field ────────────────────────────

/**
 * If a string field contains Base64, decode, upload, return media ID.
 * @param {string} value - The field value
 * @param {string} filename - Generated filename
 * @returns {Promise<number|null>} Strapi 5 media ID or null
 */
async function processBase64Field(value, filename) {
  if (!value || typeof value !== 'string') return null;

  const scan = scanStringField(value);
  if (!scan?.found) return null;

  // Decode
  let base64Data = scan.base64Data;
  const prefixMatch = base64Data.match(/^data:image\/[^;]+;base64,/);
  if (prefixMatch) base64Data = base64Data.slice(prefixMatch[0].length);
  const buffer = Buffer.from(base64Data.replace(/\s/g, ''), 'base64');

  if (buffer.length === 0) return null;

  // Upload
  const ext = scan.mimeType?.split('/')[1] || 'png';
  const fullFilename = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
  const uploaded = await s5Upload(buffer, fullFilename, scan.mimeType || 'image/png');
  return uploaded?.[0]?.id || null;
}

/**
 * Download a media file from Strapi 3 and upload to Strapi 5.
 * @param {Object} mediaRef - Media reference object with url, name, mime
 * @returns {Promise<number|null>} Strapi 5 media ID or null
 */
async function migrateUploadFile(mediaRef) {
  if (!mediaRef?.url) return null;
  try {
    const buffer = await s3Download(mediaRef.url);
    const uploaded = await s5Upload(buffer, mediaRef.name || 'file', mediaRef.mime || 'application/octet-stream');
    return uploaded?.[0]?.id || null;
  } catch (err) {
    console.warn(`  ${YELLOW}⚠ Failed to migrate file ${mediaRef.url}: ${err.message}${RESET}`);
    return null;
  }
}

// ── Transform + Load a single record ────────────────────────────────

/**
 * Transform and load a single new article into Strapi 5.
 * @param {Object} s3Rec - Raw Strapi 3 article record
 * @param {Map} datasetIdMap - legacyId → S5 documentId for datasets
 * @returns {Promise<{documentId: string}|null>}
 */
async function syncArticle(s3Rec, datasetIdMap) {
  // Process splash
  const splashId = await processBase64Field(s3Rec.splash, `${s3Rec.slug || s3Rec.id}-splash`);
  // Process thumbnail
  const thumbnailId = await processBase64Field(s3Rec.thumbnail, `${s3Rec.slug || s3Rec.id}-thumbnail`);
  // Process mainfile
  const mainfileId = await migrateUploadFile(s3Rec.mainfile);
  // Process extrafile
  const extrafileId = await migrateUploadFile(s3Rec.extrafile);

  // Rewrite markdown
  let markdown = s3Rec.markdown || '';
  const inlineImages = scanMarkdownImages(markdown);
  const imageMap = {};
  for (let i = 0; i < inlineImages.length; i++) {
    const img = inlineImages[i];
    const filename = `${s3Rec.slug || s3Rec.id}-${String(i + 1).padStart(3, '0')}`;
    const mediaId = await processBase64Field(
      `data:image/${img.mimeType?.split('/')[1] || 'png'};base64,${img.base64Data}`,
      filename
    );
    if (mediaId) {
      // Get the URL from the upload response — for now use a placeholder
      // We need the actual URL, so fetch it
      try {
        const mediaInfo = await s5Get(`/api/upload/files/${mediaId}`);
        imageMap[i] = { strapi5Url: mediaInfo.url };
      } catch {
        // skip
      }
    }
  }
  if (Object.keys(imageMap).length > 0) {
    markdown = rewriteMarkdownImages(markdown, imageMap);
  }

  // Build payload (strip relation fields — link after)
  const payload = {
    legacyId: s3Rec.id,
    title: s3Rec.title,
    status: s3Rec.status,
    slug: s3Rec.slug,
    date: s3Rec.date,
    external: s3Rec.external,
    categories: s3Rec.categories,
    tags: s3Rec.tags,
    authors: s3Rec.authors,
    splash: splashId,
    thumbnail: thumbnailId,
    images: s3Rec.images,
    abstract: s3Rec.abstract,
    markdown,
    mainfiletype: s3Rec.mainfiletype,
    funding: s3Rec.funding,
    citation: s3Rec.citation,
    doi: s3Rec.doi,
    hideFromBanner: s3Rec.hideFromBanner,
    mainfile: mainfileId,
    extrafile: extrafileId,
  };

  const result = await s5Post('/api/articles', payload);
  const docId = result.data?.documentId;

  // Link dataset relations (article is dominant on article-dataset)
  if (docId && s3Rec.datasets?.length > 0) {
    const connects = s3Rec.datasets
      .map((d) => datasetIdMap.get(d.id))
      .filter(Boolean)
      .map((documentId) => ({ documentId }));
    if (connects.length > 0) {
      await s5Put(`/api/articles/${docId}`, { datasets: { connect: connects } });
    }
  }

  return docId ? { documentId: docId } : null;
}

/**
 * Transform and load a single new dataset into Strapi 5.
 * @param {Object} s3Rec
 * @returns {Promise<{documentId: string}|null>}
 */
async function syncDataset(s3Rec) {
  const datafileId = await migrateUploadFile(s3Rec.datafile);

  const payload = {
    legacyId: s3Rec.id,
    title: s3Rec.title,
    status: s3Rec.status,
    slug: s3Rec.slug,
    date: s3Rec.date,
    external: s3Rec.external,
    categories: s3Rec.categories,
    tags: s3Rec.tags,
    project: s3Rec.project,
    sources: s3Rec.sources,
    unit: s3Rec.unit,
    timeperiod: s3Rec.timeperiod,
    description: s3Rec.description,
    notes: s3Rec.notes,
    variables: s3Rec.variables,
    funding: s3Rec.funding,
    citation: s3Rec.citation,
    datafile: datafileId,
  };

  const result = await s5Post('/api/datasets', payload);
  return result.data?.documentId ? { documentId: result.data.documentId } : null;
}

/**
 * Transform and load a single new app into Strapi 5.
 * @param {Object} s3Rec
 * @param {Map} articleIdMap - legacyId → S5 documentId for articles
 * @param {Map} datasetIdMap - legacyId → S5 documentId for datasets
 * @returns {Promise<{documentId: string}|null>}
 */
async function syncApp(s3Rec, articleIdMap, datasetIdMap) {
  const imageId = await processBase64Field(s3Rec.image, `app-${s3Rec.slug || s3Rec.id}-image`);

  const payload = {
    legacyId: s3Rec.id,
    title: s3Rec.title,
    status: s3Rec.status,
    slug: s3Rec.slug,
    date: s3Rec.date,
    external: s3Rec.external,
    categories: s3Rec.categories,
    tags: s3Rec.tags,
    contributors: s3Rec.contributors,
    image: imageId,
    description: s3Rec.description,
    url: s3Rec.url,
    funding: s3Rec.funding,
    citation: s3Rec.citation,
  };

  const result = await s5Post('/api/apps', payload);
  const docId = result.data?.documentId;

  // Link relations (app is dominant on both app-article and app-dataset)
  if (docId) {
    const relData = {};

    if (s3Rec.articles?.length > 0) {
      const connects = s3Rec.articles
        .map((a) => articleIdMap.get(a.id))
        .filter(Boolean)
        .map((documentId) => ({ documentId }));
      if (connects.length > 0) relData.articles = { connect: connects };
    }

    if (s3Rec.datasets?.length > 0) {
      const connects = s3Rec.datasets
        .map((d) => datasetIdMap.get(d.id))
        .filter(Boolean)
        .map((documentId) => ({ documentId }));
      if (connects.length > 0) relData.datasets = { connect: connects };
    }

    if (Object.keys(relData).length > 0) {
      await s5Put(`/api/apps/${docId}`, relData);
    }
  }

  return docId ? { documentId: docId } : null;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║           Incremental Sync: Strapi 3 → Strapi 5        ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('Configuration:');
  console.log(`  Strapi 3: ${config.strapi3.graphqlUrl}`);
  console.log(`  Strapi 5: ${config.strapi5.apiUrl}`);
  console.log(`  Token:    ${config.strapi5.token ? '(set)' : `${RED}(not set)${RESET}`}`);
  console.log('');

  if (!config.strapi5.token) {
    console.error(`${RED}ERROR: STRAPI5_TOKEN is required for sync.${RESET}`);
    process.exit(1);
  }

  const gqlClient = new GraphQLClient(config.strapi3.graphqlUrl, {
    token: config.strapi3.token,
    timeoutMs: TIMEOUT_MS,
  });

  // ── Step 1: Fetch IDs from both systems ─────────────────────────
  console.log(`${BOLD}── Step 1: Comparing Strapi 3 and Strapi 5 ──${RESET}\n`);

  const contentTypes = ['articles', 'datasets', 'apps'];
  const s3Data = {};
  const s5Data = {};

  for (const ct of contentTypes) {
    process.stdout.write(`  Fetching ${ct} from Strapi 3...`);
    s3Data[ct] = await fetchS3Records(ct, gqlClient);
    console.log(` ${s3Data[ct].length} records`);

    process.stdout.write(`  Fetching ${ct} from Strapi 5...`);
    s5Data[ct] = await fetchS5Records(ct);
    console.log(` ${s5Data[ct].size} records`);
  }

  // ── Step 2: Identify differences ────────────────────────────────
  console.log(`\n${BOLD}── Step 2: Identifying differences ──${RESET}\n`);

  const newRecords = {};
  const updatedRecords = {};
  const deletedRecords = {};

  for (const ct of contentTypes) {
    newRecords[ct] = [];
    updatedRecords[ct] = [];
    deletedRecords[ct] = [];

    const s5Map = s5Data[ct];

    for (const s3Rec of s3Data[ct]) {
      const s5Entry = s5Map.get(s3Rec.id);
      if (!s5Entry) {
        newRecords[ct].push(s3Rec);
      } else if (s3Rec.updatedAt && s5Entry.updatedAt) {
        const s3Time = new Date(s3Rec.updatedAt).getTime();
        const s5Time = new Date(s5Entry.updatedAt).getTime();
        if (s3Time - s5Time > 2000) { // More than 2 seconds newer
          updatedRecords[ct].push(s3Rec);
        }
      }
    }

    // Check for records in S5 that are missing from S3 (deleted in S3)
    const s3Ids = new Set(s3Data[ct].map((r) => r.id));
    for (const [legacyId] of s5Map) {
      if (!s3Ids.has(legacyId)) {
        deletedRecords[ct].push(legacyId);
      }
    }

    const icon = newRecords[ct].length === 0 && updatedRecords[ct].length === 0 ? `${GREEN}✓${RESET}` : `${YELLOW}!${RESET}`;
    console.log(`  ${icon} ${ct}: ${newRecords[ct].length} new, ${updatedRecords[ct].length} updated, ${deletedRecords[ct].length} deleted-in-S3`);
  }

  const totalNew = contentTypes.reduce((sum, ct) => sum + newRecords[ct].length, 0);
  const totalUpdated = contentTypes.reduce((sum, ct) => sum + updatedRecords[ct].length, 0);
  const totalDeleted = contentTypes.reduce((sum, ct) => sum + deletedRecords[ct].length, 0);

  if (totalNew === 0 && totalUpdated === 0 && totalDeleted === 0) {
    console.log(`\n${GREEN}Everything is in sync. No changes needed.${RESET}\n`);
    process.exit(0);
  }

  // ── Step 3: Sync new records ────────────────────────────────────
  if (totalNew > 0) {
    console.log(`\n${BOLD}── Step 3: Loading ${totalNew} new record(s) ──${RESET}\n`);

    // Build ID maps from existing S5 data for relation linking
    const datasetIdMap = new Map();
    for (const [legacyId, entry] of s5Data.datasets) {
      datasetIdMap.set(legacyId, entry.documentId);
    }
    const articleIdMap = new Map();
    for (const [legacyId, entry] of s5Data.articles) {
      articleIdMap.set(legacyId, entry.documentId);
    }

    // Load datasets first (no deps)
    for (const rec of newRecords.datasets) {
      process.stdout.write(`  + dataset: ${rec.title?.slice(0, 50)}...`);
      try {
        const result = await syncDataset(rec);
        if (result) datasetIdMap.set(rec.id, result.documentId);
        console.log(` ${GREEN}✓${RESET}`);
      } catch (err) {
        console.log(` ${RED}✗ ${err.message.slice(0, 100)}${RESET}`);
      }
      await sleep(DELAY_MS);
    }

    // Load apps second (dominant on app-article and app-dataset)
    for (const rec of newRecords.apps) {
      process.stdout.write(`  + app: ${rec.title?.slice(0, 50)}...`);
      try {
        await syncApp(rec, articleIdMap, datasetIdMap);
        console.log(` ${GREEN}✓${RESET}`);
      } catch (err) {
        console.log(` ${RED}✗ ${err.message.slice(0, 100)}${RESET}`);
      }
      await sleep(DELAY_MS);
    }

    // Load articles last (dominant on article-dataset)
    for (const rec of newRecords.articles) {
      process.stdout.write(`  + article: ${rec.title?.slice(0, 50)}...`);
      try {
        const result = await syncArticle(rec, datasetIdMap);
        if (result) articleIdMap.set(rec.id, result.documentId);
        console.log(` ${GREEN}✓${RESET}`);
      } catch (err) {
        console.log(` ${RED}✗ ${err.message.slice(0, 100)}${RESET}`);
      }
      await sleep(DELAY_MS);
    }
  }

  // ── Step 4: Report on updated/deleted records ───────────────────
  if (totalUpdated > 0 || totalDeleted > 0) {
    console.log(`\n${BOLD}── Items requiring manual review ──${RESET}\n`);

    if (totalUpdated > 0) {
      console.log(`${YELLOW}UPDATED in Strapi 3 since migration (${totalUpdated} records):${RESET}`);
      console.log(`${YELLOW}These records exist in both systems but Strapi 3 has newer data.${RESET}`);
      console.log(`${YELLOW}Review and update manually in Strapi 5 admin if needed.${RESET}\n`);
      for (const ct of contentTypes) {
        for (const rec of updatedRecords[ct]) {
          console.log(`  ${ct.slice(0, -1)}: ${rec.title || rec.id} (updated ${rec.updatedAt})`);
        }
      }
    }

    if (totalDeleted > 0) {
      console.log(`\n${YELLOW}DELETED from Strapi 3 (${totalDeleted} legacyIds in S5 with no S3 match):${RESET}`);
      console.log(`${YELLOW}These may have been removed from Strapi 3. Review before deleting from Strapi 5.${RESET}\n`);
      for (const ct of contentTypes) {
        for (const legacyId of deletedRecords[ct]) {
          console.log(`  ${ct.slice(0, -1)}: legacyId ${legacyId}`);
        }
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('');
  console.log(`${BOLD}── Sync Summary ──${RESET}`);
  console.log(`  ${GREEN}New records added:${RESET}    ${totalNew}`);
  console.log(`  ${YELLOW}Updated (flagged):${RESET}    ${totalUpdated}`);
  console.log(`  ${YELLOW}Deleted-in-S3:${RESET}        ${totalDeleted}`);
  console.log('');

  // Save sync report
  const reportDir = path.resolve(ROOT, config.paths.maps);
  await fs.mkdir(reportDir, { recursive: true });
  const report = {
    syncedAt: new Date().toISOString(),
    newRecords: Object.fromEntries(contentTypes.map((ct) => [ct, newRecords[ct].map((r) => r.id)])),
    updatedRecords: Object.fromEntries(contentTypes.map((ct) => [ct, updatedRecords[ct].map((r) => r.id)])),
    deletedRecords,
    counts: { new: totalNew, updated: totalUpdated, deleted: totalDeleted },
  };
  const reportPath = path.join(reportDir, 'sync-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Sync report saved to ${path.relative(ROOT, reportPath)}`);
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
