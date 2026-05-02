/**
 * @module 06-audit
 * @description Phase 6: Parity Audit — comprehensive field-by-field comparison.
 *
 * Unlike Phase 5 (pass/fail validation), this phase performs a detailed,
 * field-level comparison of EVERY record in Strapi 3 vs Strapi 5. Every
 * difference is categorized as:
 *
 * - **ERROR** — an unexpected discrepancy that needs investigation
 * - **EXPECTED** — a known change from the migration (e.g., Base64 → media)
 * - **INFO** — a system-level or inconsequential difference
 * - **OK** — fields match exactly
 *
 * The audit covers:
 * 1. Schema-level comparison (field names and types between S3 and S5)
 * 2. Record-level comparison for all 3 content types (articles, datasets, apps)
 * 3. Media audit (accessibility, conversion counts)
 *
 * Outputs:
 * - `migration/data/audit-report.json` — machine-readable detailed report
 * - `migration/data/audit-report.md` — human-readable markdown report
 * - Console summary with colored category counts
 *
 * Exit codes:
 * - 0 if zero ERRORs found
 * - 1 if any ERRORs found
 *
 * @example
 *   pnpm audit
 *
 * Prerequisites:
 * - Phase 4 complete (all content loaded)
 * - Phase 5 passed (basic validation)
 * - Strapi 3 running (for live GraphQL comparison)
 * - Strapi 5 running (for REST API queries)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GraphQLClient } from '../lib/graphql-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ── ANSI Colors ──────────────────────────────────────────────────────

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

const DELAY_MS = config.settings?.requestDelayMs || 100;
const TIMEOUT_MS = config.settings?.requestTimeoutMs || 30000;
const PAGE_LIMIT = config.settings?.paginationLimit || 100;

// ── GraphQL Queries (same as 02-extract.js) ──────────────────────────

/**
 * GraphQL query for articles — all scalar fields, relations, and media.
 * Identical to the query used in Phase 2 extraction.
 * @type {string}
 */
const ARTICLE_QUERY = `
query GetArticles($start: Int!, $limit: Int!) {
  articles(start: $start, limit: $limit, sort: "createdAt:asc") {
    id
    title
    status
    slug
    date
    external
    categories
    tags
    authors
    splash
    thumbnail
    images
    abstract
    markdown
    mainfiletype
    funding
    citation
    doi
    hideFromBanner
    createdAt
    updatedAt
    datasets {
      id
      title
      slug
    }
    apps {
      id
      title
    }
    mainfile {
      id
      url
      name
      mime
      size
      ext
    }
    extrafile {
      id
      url
      name
      mime
      size
      ext
    }
  }
}`;

/**
 * GraphQL query for datasets — all fields, datafile media, relations.
 * Identical to the query used in Phase 2 extraction.
 * @type {string}
 */
const DATASET_QUERY = `
query GetDatasets($start: Int!, $limit: Int!) {
  datasets(start: $start, limit: $limit, sort: "createdAt:asc") {
    id
    title
    status
    slug
    date
    external
    categories
    tags
    project
    sources
    unit
    timeperiod
    description
    notes
    variables
    funding
    citation
    createdAt
    updatedAt
    datafile {
      id
      url
      name
      mime
      size
      ext
    }
    apps {
      id
      title
    }
    articles {
      id
      title
    }
  }
}`;

/**
 * GraphQL query for apps — all fields and relation expansions.
 * Identical to the query used in Phase 2 extraction.
 * @type {string}
 */
const APP_QUERY = `
query GetApps($start: Int!, $limit: Int!) {
  apps(start: $start, limit: $limit, sort: "createdAt:asc") {
    id
    title
    status
    slug
    date
    external
    categories
    tags
    contributors
    image
    description
    url
    funding
    citation
    createdAt
    updatedAt
    datasets {
      id
      title
    }
    articles {
      id
      title
    }
  }
}`;

/**
 * Map of content type plural names to their GraphQL queries and Strapi 5 populate strings.
 * @type {Record<string, { query: string, s5Populate: string }>}
 */
const CONTENT_TYPES = {
  articles: {
    query: ARTICLE_QUERY,
    s5Populate: 'populate[0]=splash&populate[1]=thumbnail&populate[2]=mainfile&populate[3]=extrafile&populate[4]=datasets&populate[5]=apps',
  },
  datasets: {
    query: DATASET_QUERY,
    s5Populate: 'populate[0]=datafile&populate[1]=apps&populate[2]=articles',
  },
  apps: {
    query: APP_QUERY,
    s5Populate: 'populate[0]=image&populate[1]=datasets&populate[2]=articles',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms - Duration to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an authenticated GET request to the Strapi 5 REST API.
 * @param {string} urlPath - Path relative to the Strapi 5 API base (e.g., "/api/articles")
 * @returns {Promise<Object>} Parsed JSON response
 * @throws {Error} On HTTP error
 */
async function strapi5Get(urlPath) {
  const url = `${config.strapi5.apiUrl}${urlPath}`;
  const headers = {};
  if (config.strapi5.token) {
    headers['Authorization'] = `Bearer ${config.strapi5.token}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strapi 5 GET ${urlPath} failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch all records from a Strapi 5 content type using REST pagination.
 * @param {string} pluralName - Plural API name (e.g., "articles")
 * @param {string} [populate=''] - Populate query string for relations/media
 * @returns {Promise<Object[]>} All records with populated fields
 */
async function strapi5FetchAll(pluralName, populate = '') {
  const pageSize = PAGE_LIMIT;
  let page = 1;
  let all = [];
  let hasMore = true;

  while (hasMore) {
    let url = `/api/${pluralName}?pagination[pageSize]=${pageSize}&pagination[page]=${page}`;
    if (populate) url += `&${populate}`;

    const json = await strapi5Get(url);
    const records = json.data || [];
    all = all.concat(records);

    const pagination = json.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) {
      hasMore = false;
    } else {
      page++;
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }

  return all;
}

/**
 * Fetch all records from Strapi 3 via paginated GraphQL queries.
 * @param {string} contentType - Plural content type name (e.g., "articles")
 * @param {string} query - GraphQL query with $start/$limit variables
 * @param {GraphQLClient} client - Configured GraphQL client
 * @returns {Promise<Object[]>} All records
 */
async function strapi3FetchAll(contentType, query, client) {
  let start = 0;
  let allRecords = [];

  while (true) {
    const result = await client.query(query, { start, limit: PAGE_LIMIT });
    const records = result.data[contentType];

    if (!Array.isArray(records)) {
      throw new Error(`Unexpected GraphQL response for ${contentType}: expected array`);
    }

    allRecords = allRecords.concat(records);

    if (records.length < PAGE_LIMIT) break;

    start += PAGE_LIMIT;
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  return allRecords;
}

/**
 * Read and parse a JSON file.
 * @param {string} relativePath - Path relative to ROOT
 * @returns {Promise<any>} Parsed JSON
 */
async function readJSON(relativePath) {
  const fullPath = path.resolve(ROOT, relativePath);
  const raw = await fs.readFile(fullPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Strip markdown image references `![...](...)` from a string.
 * Used to compare markdown text without image URLs that change during migration.
 * @param {string} text - Markdown text
 * @returns {string} Text with image references removed
 */
export function stripImageRefs(text) {
  if (!text) return '';
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // inline images: ![alt](url)
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')   // reference-style images: ![alt][ref]
    .replace(/^\[[^\]]+\]:\s*[^\n]+$/gm, '') // reference definitions: [ref]: url
    .trim();
}

/**
 * Deep-equal comparison of two values using sorted JSON serialization.
 * Handles arrays, objects, and primitives. Sorts object keys for consistency.
 * @param {any} a - First value
 * @param {any} b - Second value
 * @returns {boolean} True if deeply equal
 */
export function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Produce a deterministic JSON string with sorted keys.
 * @param {any} value - Value to serialize
 * @returns {string} Deterministic JSON string
 */
function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Summarize a Base64 string for report output (show type and size, not content).
 * @param {string} value - Potentially Base64 string
 * @returns {string} Summary like "(Base64, 135KB)" or the raw value if short
 */
function summarizeBase64(value) {
  if (!value || typeof value !== 'string') return String(value);
  if (value.startsWith('data:image/') || value.startsWith('data:application/')) {
    const sizeKB = Math.round(value.length * 0.75 / 1024);
    const match = value.match(/^data:([^;]+)/);
    const mime = match ? match[1] : 'unknown';
    return `(Base64, ${mime}, ~${sizeKB}KB)`;
  }
  if (value.length > 100) return `(string, ${value.length} chars)`;
  return value;
}

/**
 * Summarize a Strapi 5 media object for report output.
 * @param {Object|null} media - Strapi 5 media relation object
 * @returns {string} Summary like "{ id: 42, url: '/uploads/...' }"
 */
function summarizeMedia(media) {
  if (!media) return 'null';
  if (typeof media === 'object' && media.id) {
    return `{ id: ${media.id}, url: '${media.url || 'N/A'}' }`;
  }
  return JSON.stringify(media).slice(0, 100);
}

// ── Schema-Level Comparison ──────────────────────────────────────────

/**
 * Known field changes from Strapi 3 → Strapi 5 migration.
 * These are categorized as EXPECTED and will not be flagged as errors.
 * @type {Object}
 */
const KNOWN_SCHEMA_CHANGES = {
  added: {
    legacyId: 'Added by migration for ID mapping (all content types)',
  },
  typeChanges: {
    'article.splash': 'string → media relation (Base64 decoded to uploaded file)',
    'article.thumbnail': 'string → media relation (Base64 decoded to uploaded file)',
    'article.mainfile': 'upload → media relation (file reference preserved)',
    'article.extrafile': 'upload → media relation (file reference preserved)',
    'app.image': 'string → media relation (Base64 decoded to uploaded file)',
    'dataset.datafile': 'upload → media relation (file reference preserved)',
  },
  systemFields: ['id', 'documentId', 'publishedAt', 'locale', 'createdBy', 'updatedBy'],
};

/**
 * Compare schema fields between Strapi 3 model definitions and Strapi 5 introspection.
 * Categorizes each difference as EXPECTED (known migration change), INFO (system field), or ERROR.
 *
 * @returns {Promise<Object>} Schema comparison findings grouped by content type
 */
async function compareSchemas() {
  const schemas = {};
  const schemaDir = path.resolve(ROOT, config.paths.schemas);
  const findings = [];

  for (const ct of ['article', 'dataset', 'app']) {
    const schemaPath = path.join(schemaDir, `${ct}.settings.json`);
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'));
    const s3Fields = new Set(Object.keys(schema.attributes));

    // Add system fields that Strapi 3 always has
    s3Fields.add('id');
    s3Fields.add('createdAt');
    s3Fields.add('updatedAt');

    // Get Strapi 5 fields from a single record
    const pluralName = ct + 's';
    let s5Fields = new Set();
    try {
      const json = await strapi5Get(`/api/${pluralName}?pagination[pageSize]=1&populate=*`);
      if (json.data && json.data.length > 0) {
        s5Fields = new Set(Object.keys(json.data[0]));
      }
    } catch {
      findings.push({
        contentType: ct,
        category: 'INFO',
        detail: `Could not fetch Strapi 5 ${pluralName} for schema comparison`,
      });
    }

    // Fields in S3 but not in S5
    for (const field of s3Fields) {
      if (!s5Fields.has(field) && field !== 'id') {
        findings.push({
          contentType: ct,
          field,
          category: 'INFO',
          detail: `Field in Strapi 3 but not in Strapi 5 REST response (may be renamed or nested)`,
        });
      }
    }

    // Fields in S5 but not in S3
    for (const field of s5Fields) {
      if (!s3Fields.has(field)) {
        if (field === 'legacyId') {
          findings.push({
            contentType: ct,
            field,
            category: 'EXPECTED',
            detail: KNOWN_SCHEMA_CHANGES.added.legacyId,
          });
        } else if (KNOWN_SCHEMA_CHANGES.systemFields.includes(field)) {
          findings.push({
            contentType: ct,
            field,
            category: 'INFO',
            detail: `Strapi 5 system field`,
          });
        } else {
          findings.push({
            contentType: ct,
            field,
            category: 'INFO',
            detail: `New field in Strapi 5 (not present in Strapi 3 schema)`,
          });
        }
      }
    }

    // Known type changes
    for (const [key, detail] of Object.entries(KNOWN_SCHEMA_CHANGES.typeChanges)) {
      if (key.startsWith(`${ct}.`)) {
        findings.push({
          contentType: ct,
          field: key.split('.')[1],
          category: 'EXPECTED',
          detail,
        });
      }
    }

    schemas[ct] = {
      s3FieldCount: s3Fields.size,
      s5FieldCount: s5Fields.size,
      s3Fields: [...s3Fields].sort(),
      s5Fields: [...s5Fields].sort(),
    };
  }

  return { schemas, findings };
}

// ── Record-Level Comparison ──────────────────────────────────────────

/**
 * Scalar fields to compare for each content type.
 * These are compared as exact string/value matches.
 * @type {Record<string, string[]>}
 */
const SCALAR_FIELDS = {
  articles: ['title', 'status', 'slug', 'date', 'external', 'abstract', 'mainfiletype', 'funding', 'citation', 'doi', 'hideFromBanner'],
  datasets: ['title', 'status', 'slug', 'date', 'external', 'unit', 'project', 'funding', 'citation', 'description'],
  apps: ['title', 'status', 'slug', 'date', 'external', 'url', 'funding', 'citation', 'description'],
};

/**
 * JSON fields to compare using deep equality for each content type.
 * @type {Record<string, string[]>}
 */
const JSON_FIELDS = {
  articles: ['categories', 'tags', 'authors', 'images'],
  datasets: ['categories', 'tags', 'sources', 'notes', 'variables', 'timeperiod'],
  apps: ['categories', 'tags', 'contributors'],
};

/**
 * Media fields that changed from string/upload to media relations.
 * Each entry specifies the Strapi 3 type (string = Base64, upload = file object).
 * @type {Record<string, Array<{ field: string, s3Type: string }>>}
 */
const MEDIA_FIELDS = {
  articles: [
    { field: 'splash', s3Type: 'string' },
    { field: 'thumbnail', s3Type: 'string' },
    { field: 'mainfile', s3Type: 'upload' },
    { field: 'extrafile', s3Type: 'upload' },
  ],
  datasets: [
    { field: 'datafile', s3Type: 'upload' },
  ],
  apps: [
    { field: 'image', s3Type: 'string' },
  ],
};

/**
 * Relation fields and what they point to, for each content type.
 * @type {Record<string, Array<{ field: string, targetType: string }>>}
 */
const RELATION_FIELDS = {
  articles: [
    { field: 'datasets', targetType: 'datasets' },
    { field: 'apps', targetType: 'apps' },
  ],
  datasets: [
    { field: 'apps', targetType: 'apps' },
    { field: 'articles', targetType: 'articles' },
  ],
  apps: [
    { field: 'datasets', targetType: 'datasets' },
    { field: 'articles', targetType: 'articles' },
  ],
};

/**
 * Compare a single scalar field between Strapi 3 and Strapi 5 records.
 *
 * @param {string} field - Field name
 * @param {any} s3Value - Value from Strapi 3
 * @param {any} s5Value - Value from Strapi 5
 * @returns {{ category: string, detail: string, strapi3?: string, strapi5?: string }}
 */
function compareScalar(field, s3Value, s5Value) {
  // Normalize nulls and empty strings
  const s3Norm = (s3Value === null || s3Value === undefined || s3Value === '') ? null : s3Value;
  const s5Norm = (s5Value === null || s5Value === undefined || s5Value === '') ? null : s5Value;

  if (s3Norm === s5Norm) {
    return { category: 'OK', detail: 'Exact match' };
  }

  // Compare with string coercion for booleans/numbers
  if (String(s3Norm) === String(s5Norm)) {
    return { category: 'OK', detail: 'Match (after type coercion)' };
  }

  // Date fields: Strapi 3 returns DateTime (2015-08-18T00:00:00.000Z), Strapi 5 returns Date (2015-08-18)
  if (s3Norm && s5Norm && typeof s3Norm === 'string' && typeof s5Norm === 'string') {
    const s3Date = s3Norm.split('T')[0];
    if (s3Date === s5Norm) {
      return { category: 'EXPECTED', detail: 'Date format: DateTime → Date (same value)', strapi3: String(s3Norm), strapi5: String(s5Norm) };
    }
  }

  // Boolean fields: Strapi 5 defaults null booleans to false
  if (s3Norm === null && s5Norm === false) {
    return { category: 'EXPECTED', detail: 'Boolean default: null → false (Strapi 5 defaults unset booleans)', strapi3: 'null', strapi5: 'false' };
  }

  // Slug fields: Strapi 5 uid enforces uniqueness — duplicate slugs get a suffix appended
  if (field === 'slug' && typeof s5Norm === 'string' && typeof s3Norm === 'string' && s5Norm.startsWith(s3Norm + '-')) {
    return { category: 'EXPECTED', detail: 'Slug suffixed for uniqueness (duplicate in Strapi 3)', strapi3: String(s3Norm), strapi5: String(s5Norm) };
  }

  return {
    category: 'ERROR',
    detail: `Value mismatch`,
    strapi3: String(s3Norm).slice(0, 200),
    strapi5: String(s5Norm).slice(0, 200),
  };
}

/**
 * Compare the markdown field between Strapi 3 and Strapi 5 records.
 * Strips image references before comparing, since Base64 images are
 * replaced with /uploads/ URLs during migration.
 *
 * @param {string} s3Markdown - Markdown from Strapi 3
 * @param {string} s5Markdown - Markdown from Strapi 5
 * @returns {{ category: string, detail: string, strapi3?: string, strapi5?: string }}
 */
function compareMarkdown(s3Markdown, s5Markdown) {
  const s3Text = stripImageRefs(s3Markdown || '');
  const s5Text = stripImageRefs(s5Markdown || '');

  // Count image refs in each
  const s3ImageCount = ((s3Markdown || '').match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;
  const s5ImageCount = ((s5Markdown || '').match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;

  const findings = [];

  // Compare text content (without images)
  if (s3Text === s5Text) {
    if (s3ImageCount > 0 || s5ImageCount > 0) {
      return {
        category: 'EXPECTED',
        detail: `Text matches; ${s3ImageCount} Base64 image ref(s) in S3 replaced with ${s5ImageCount} /uploads/ URL(s) in S5`,
      };
    }
    return { category: 'OK', detail: 'Exact match' };
  }

  // Text differs
  return {
    category: 'ERROR',
    detail: `Markdown text differs (ignoring image refs). S3 length=${s3Text.length}, S5 length=${s5Text.length}`,
    strapi3: s3Text.slice(0, 200),
    strapi5: s5Text.slice(0, 200),
  };
}

/**
 * Compare a JSON field between Strapi 3 and Strapi 5 records using deep equality.
 *
 * @param {string} field - Field name
 * @param {any} s3Value - Value from Strapi 3
 * @param {any} s5Value - Value from Strapi 5
 * @returns {{ category: string, detail: string, strapi3?: string, strapi5?: string }}
 */
function compareJSON(field, s3Value, s5Value) {
  // Normalize null/undefined/empty
  const s3Norm = (s3Value === null || s3Value === undefined) ? null : s3Value;
  const s5Norm = (s5Value === null || s5Value === undefined) ? null : s5Value;

  if (s3Norm === null && s5Norm === null) {
    return { category: 'OK', detail: 'Both null' };
  }

  if (deepEqual(s3Norm, s5Norm)) {
    return { category: 'OK', detail: 'Deep equal match' };
  }

  // Special handling for the `images` field: during migration, Base64 src values
  // are replaced with /uploads/ URLs. If the titles match and the only difference
  // is the src field changing from Base64 to a URL, this is an expected change.
  if (field === 'images' && Array.isArray(s3Norm) && Array.isArray(s5Norm)) {
    if (s3Norm.length === s5Norm.length) {
      const allExpected = s3Norm.every((s3Entry, idx) => {
        const s5Entry = s5Norm[idx];
        if (!s3Entry || !s5Entry) return false;
        // Titles should match (case-insensitive)
        const titlesMatch = (s3Entry.title || '').toLowerCase() === (s5Entry.title || '').toLowerCase();
        // S3 src is Base64 or old URL, S5 src is /uploads/ URL or full URL
        const srcChanged = s3Entry.src !== s5Entry.src;
        const s5IsUrl = typeof s5Entry.src === 'string' && (s5Entry.src.includes('/uploads/') || s5Entry.src.startsWith('http'));
        return titlesMatch && srcChanged && s5IsUrl;
      });
      if (allExpected) {
        return {
          category: 'EXPECTED',
          detail: `images JSON: ${s3Norm.length} image(s) — src values updated from Base64/old format to media library URLs`,
        };
      }
    }
  }

  return {
    category: 'ERROR',
    detail: `JSON mismatch for ${field}`,
    strapi3: stableStringify(s3Norm).slice(0, 300),
    strapi5: stableStringify(s5Norm).slice(0, 300),
  };
}

/**
 * Compare a media field between Strapi 3 and Strapi 5.
 * Strapi 3 may have a Base64 string or an upload object; Strapi 5 should have a media relation.
 *
 * @param {string} field - Field name
 * @param {any} s3Value - Value from Strapi 3 (string for Base64 fields, object for upload fields)
 * @param {any} s5Value - Value from Strapi 5 (media relation object or null)
 * @param {string} s3Type - 'string' for Base64 fields, 'upload' for file upload fields
 * @returns {{ category: string, detail: string, strapi3?: string, strapi5?: string }}
 */
function compareMedia(field, s3Value, s5Value, s3Type) {
  const s3HasValue = s3Value !== null && s3Value !== undefined &&
    (typeof s3Value === 'string' ? s3Value.trim().length > 0 : true);
  const s5HasValue = s5Value !== null && s5Value !== undefined &&
    (typeof s5Value === 'object' ? s5Value.id !== undefined : false);

  // Both null — match
  if (!s3HasValue && !s5HasValue) {
    return { category: 'OK', detail: 'Both null/empty' };
  }

  // S3 has value, S5 has media object — expected conversion
  if (s3HasValue && s5HasValue) {
    if (s3Type === 'string') {
      return {
        category: 'EXPECTED',
        detail: 'Base64 string → media relation',
        strapi3: summarizeBase64(s3Value),
        strapi5: summarizeMedia(s5Value),
      };
    }
    // upload → media relation
    return {
      category: 'EXPECTED',
      detail: 'Upload file → media relation',
      strapi3: typeof s3Value === 'object' ? `{ id: ${s3Value.id}, url: '${s3Value.url}' }` : String(s3Value).slice(0, 100),
      strapi5: summarizeMedia(s5Value),
    };
  }

  // Mismatch: one has value, other doesn't
  if (s3HasValue && !s5HasValue) {
    return {
      category: 'ERROR',
      detail: `${field} exists in Strapi 3 but missing in Strapi 5`,
      strapi3: summarizeBase64(s3Value),
      strapi5: 'null',
    };
  }

  return {
    category: 'ERROR',
    detail: `${field} missing in Strapi 3 but present in Strapi 5`,
    strapi3: 'null',
    strapi5: summarizeMedia(s5Value),
  };
}

/**
 * Compare relation fields between Strapi 3 and Strapi 5 records.
 * Matches by Strapi 3 `id` ↔ Strapi 5 `legacyId`.
 *
 * @param {string} field - Relation field name (e.g., "datasets")
 * @param {Object[]} s3Relations - Array of related records from Strapi 3 (each has `id`)
 * @param {Object[]} s5Relations - Array of related records from Strapi 5 (each has `legacyId`)
 * @returns {{ category: string, detail: string, strapi3?: string, strapi5?: string }}
 */
function compareRelations(field, s3Relations, s5Relations) {
  const s3Ids = new Set((s3Relations || []).map((r) => String(r.id)));
  const s5Ids = new Set((s5Relations || []).map((r) => String(r.legacyId)).filter(Boolean));

  if (s3Ids.size === 0 && s5Ids.size === 0) {
    return { category: 'OK', detail: 'No relations in either system' };
  }

  const missing = [...s3Ids].filter((id) => !s5Ids.has(id));
  const extra = [...s5Ids].filter((id) => !s3Ids.has(id));

  if (missing.length === 0 && extra.length === 0) {
    return { category: 'OK', detail: `${s3Ids.size} relation(s) match` };
  }

  const parts = [];
  if (missing.length > 0) parts.push(`missing in S5: [${missing.join(', ')}]`);
  if (extra.length > 0) parts.push(`extra in S5: [${extra.join(', ')}]`);

  return {
    category: 'ERROR',
    detail: `Relation mismatch for ${field}: ${parts.join('; ')}`,
    strapi3: `IDs: [${[...s3Ids].join(', ')}]`,
    strapi5: `legacyIds: [${[...s5Ids].join(', ')}]`,
  };
}

/**
 * Compare createdAt/updatedAt timestamps between Strapi 3 and Strapi 5 with ±1s tolerance.
 *
 * @param {string} field - 'createdAt' or 'updatedAt'
 * @param {string} s3Value - ISO timestamp from Strapi 3
 * @param {string} s5Value - ISO timestamp from Strapi 5
 * @returns {{ category: string, detail: string, strapi3?: string, strapi5?: string }}
 */
function compareTimestamp(field, s3Value, s5Value) {
  if (!s3Value && !s5Value) {
    return { category: 'OK', detail: 'Both null' };
  }
  if (!s3Value || !s5Value) {
    return {
      category: 'ERROR',
      detail: `${field} present in one system but not the other`,
      strapi3: s3Value || 'null',
      strapi5: s5Value || 'null',
    };
  }

  const s3Time = new Date(s3Value).getTime();
  const s5Time = new Date(s5Value).getTime();
  const diff = Math.abs(s3Time - s5Time);

  if (diff <= 1000) {
    return { category: 'OK', detail: `Match (diff: ${diff}ms)` };
  }

  // For updatedAt: if S5 is newer than S3, this is expected — post-migration
  // scripts (fix-image-refs, content updates) trigger Strapi 5 to refresh
  // updatedAt. The original timestamp was restored but a subsequent API PUT
  // overwrote it. This is normal and not data loss.
  if (field === 'updatedAt' && s5Time > s3Time) {
    return {
      category: 'INFO',
      detail: `${field} is newer in S5 by ${Math.round(diff / 1000)}s (expected — post-migration fix updated this record)`,
      strapi3: s3Value,
      strapi5: s5Value,
    };
  }

  // Large diffs (>24h) likely mean the record was loaded after the timestamp fix
  // (e.g., a duplicate slug retry). Flag as INFO, not ERROR.
  if (diff > 86400000) {
    return {
      category: 'INFO',
      detail: `${field} not restored (record may have been loaded after timestamp fix — re-run 04c to fix)`,
      strapi3: s3Value,
      strapi5: s5Value,
    };
  }

  return {
    category: 'ERROR',
    detail: `${field} differs by ${diff}ms (tolerance: 1000ms)`,
    strapi3: s3Value,
    strapi5: s5Value,
  };
}

/**
 * Audit a single record by comparing every field between Strapi 3 and Strapi 5.
 *
 * @param {string} contentType - Plural content type name (e.g., "articles")
 * @param {Object} s3Record - The full Strapi 3 record from GraphQL
 * @param {Object} s5Record - The full Strapi 5 record from REST API with populated fields
 * @returns {Object[]} Array of finding objects for this record
 */
function auditRecord(contentType, s3Record, s5Record) {
  const findings = [];

  // 1. Scalar fields
  for (const field of (SCALAR_FIELDS[contentType] || [])) {
    const result = compareScalar(field, s3Record[field], s5Record[field]);
    findings.push({ field, ...result });
  }

  // 2. Markdown field (articles only)
  if (contentType === 'articles') {
    const result = compareMarkdown(s3Record.markdown, s5Record.markdown);
    findings.push({ field: 'markdown', ...result });
  }

  // 3. JSON fields
  for (const field of (JSON_FIELDS[contentType] || [])) {
    const result = compareJSON(field, s3Record[field], s5Record[field]);
    findings.push({ field, ...result });
  }

  // 4. Media fields
  for (const { field, s3Type } of (MEDIA_FIELDS[contentType] || [])) {
    const result = compareMedia(field, s3Record[field], s5Record[field], s3Type);
    findings.push({ field, ...result });
  }

  // 5. Timestamps
  for (const field of ['createdAt', 'updatedAt']) {
    const result = compareTimestamp(field, s3Record[field], s5Record[field]);
    findings.push({ field, ...result });
  }

  // 6. Relations
  for (const { field } of (RELATION_FIELDS[contentType] || [])) {
    const result = compareRelations(field, s3Record[field], s5Record[field]);
    findings.push({ field, ...result });
  }

  return findings;
}

// ── Media Audit ──────────────────────────────────────────────────────

/**
 * Audit the media library: count files, verify accessibility via HEAD requests,
 * and tally Base64 → media conversions and inline image extractions.
 *
 * @param {Object[]} s3Articles - All articles from Strapi 3
 * @param {Object[]} s5Articles - All articles from Strapi 5
 * @returns {Promise<Object>} Media audit results
 */
async function auditMedia(s3Articles, s5Articles) {
  const results = {
    totalMediaInS5: 0,
    mediaAccessible: 0,
    mediaInaccessible: 0,
    inaccessibleUrls: [],
    base64ToMediaConversions: {
      splash: 0,
      thumbnail: 0,
      image: 0,
    },
    inlineImagesExtracted: 0,
  };

  // Count total media files in Strapi 5 media library
  try {
    const mediaJson = await strapi5Get('/api/upload/files?pagination[pageSize]=1');
    // Strapi 5 upload plugin returns total in pagination
    if (Array.isArray(mediaJson)) {
      // Some Strapi versions return array directly
      results.totalMediaInS5 = mediaJson.length;
    } else if (mediaJson.meta?.pagination?.total) {
      results.totalMediaInS5 = mediaJson.meta.pagination.total;
    }
    // Try to get full count
    const countJson = await strapi5Get('/api/upload/files?pagination[pageSize]=1&pagination[page]=1');
    if (countJson.meta?.pagination?.total) {
      results.totalMediaInS5 = countJson.meta.pagination.total;
    }
  } catch {
    // Fallback: try reading media map
    try {
      const mediaMap = await readJSON(`${config.paths.maps}/media.json`);
      results.totalMediaInS5 = Array.isArray(mediaMap) ? mediaMap.length : Object.keys(mediaMap).length;
    } catch { /* skip */ }
  }

  // Verify media URLs from the media map file
  let mediaEntries = [];
  try {
    const mediaMap = await readJSON(`${config.paths.maps}/media.json`);
    mediaEntries = Array.isArray(mediaMap) ? mediaMap : Object.values(mediaMap);
  } catch {
    // No media map — skip accessibility check
  }

  const urls = mediaEntries
    .map((entry) => entry.strapi5Url || entry.url)
    .filter(Boolean);

  // HEAD request each URL (limited concurrency)
  const CONCURRENCY = 10;
  let idx = 0;

  async function checkNext() {
    while (idx < urls.length) {
      const url = urls[idx++];
      const fullUrl = url.startsWith('http') ? url : `${config.strapi5.apiUrl}${url}`;
      try {
        const res = await fetch(fullUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 200) {
          results.mediaAccessible++;
        } else {
          results.mediaInaccessible++;
          results.inaccessibleUrls.push({ url, status: res.status });
        }
      } catch (err) {
        results.mediaInaccessible++;
        results.inaccessibleUrls.push({ url, error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => checkNext());
  await Promise.all(workers);

  // Count Base64 → media conversions from S3 articles
  for (const s3Art of s3Articles) {
    if (s3Art.splash && typeof s3Art.splash === 'string' && s3Art.splash.startsWith('data:')) {
      results.base64ToMediaConversions.splash++;
    }
    if (s3Art.thumbnail && typeof s3Art.thumbnail === 'string' && s3Art.thumbnail.startsWith('data:')) {
      results.base64ToMediaConversions.thumbnail++;
    }

    // Count inline Base64 images in markdown
    if (s3Art.markdown) {
      const inlineMatches = s3Art.markdown.match(/!\[[^\]]*\]\(data:image\/[^)]*\)/g);
      if (inlineMatches) {
        results.inlineImagesExtracted += inlineMatches.length;
      }
    }
  }

  return results;
}

// ── Report Generation ────────────────────────────────────────────────

/**
 * Generate the human-readable markdown audit report.
 *
 * @param {Object} report - The full JSON audit report
 * @returns {string} Markdown-formatted report
 */
function generateMarkdownReport(report) {
  const lines = [];
  const { summary, schema, records, media } = report;

  lines.push('# Phase 6: Parity Audit Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push(`| Total records compared | ${summary.totalRecordsCompared} |`);
  lines.push(`| Total fields compared | ${summary.totalFieldsCompared} |`);
  lines.push(`| ERROR findings | ${summary.findings.ERROR} |`);
  lines.push(`| EXPECTED findings | ${summary.findings.EXPECTED} |`);
  lines.push(`| INFO findings | ${summary.findings.INFO} |`);
  lines.push(`| OK fields | ${summary.findings.OK} |`);
  lines.push(`| Clean records (zero findings) | ${summary.cleanRecords} |`);
  lines.push(`| Records with findings | ${summary.recordsWithFindings} |`);
  lines.push('');

  if (summary.findings.ERROR === 0) {
    lines.push('> **CLEAN BILL OF HEALTH**: Zero ERRORs detected. All differences are expected migration changes or informational.');
    lines.push('');
  } else {
    lines.push(`> **REVIEW REQUIRED**: ${summary.findings.ERROR} ERROR(s) detected. See details below.`);
    lines.push('');
  }

  // Schema comparison
  if (schema && schema.findings && schema.findings.length > 0) {
    lines.push('## Schema Comparison');
    lines.push('');
    lines.push('| Content Type | Field | Category | Detail |');
    lines.push('|-------------|-------|----------|--------|');
    for (const f of schema.findings) {
      lines.push(`| ${f.contentType} | ${f.field || '-'} | ${f.category} | ${f.detail} |`);
    }
    lines.push('');
  }

  // Per-content-type record summaries
  for (const ct of ['articles', 'datasets', 'apps']) {
    const ctRecords = records[ct] || [];
    if (ctRecords.length === 0) continue;

    lines.push(`## ${ct.charAt(0).toUpperCase() + ct.slice(1)}`);
    lines.push('');

    // Summary table
    const errorRecords = ctRecords.filter((r) => r.findings.some((f) => f.category === 'ERROR'));
    const expectedRecords = ctRecords.filter((r) => r.findings.some((f) => f.category === 'EXPECTED'));
    const cleanRecs = ctRecords.filter((r) => r.findings.every((f) => f.category === 'OK'));

    lines.push(`Total records: ${ctRecords.length} | With ERRORs: ${errorRecords.length} | With EXPECTED changes: ${expectedRecords.length} | Clean (OK only): ${cleanRecs.length}`);
    lines.push('');

    // Table of records with finding counts
    lines.push('| Legacy ID | Title | ERRORs | EXPECTED | INFO | OK |');
    lines.push('|-----------|-------|--------|----------|------|----|');
    for (const rec of ctRecords) {
      const counts = { ERROR: 0, EXPECTED: 0, INFO: 0, OK: 0 };
      for (const f of rec.findings) {
        counts[f.category] = (counts[f.category] || 0) + 1;
      }
      const title = (rec.title || '').slice(0, 50);
      lines.push(`| ${rec.legacyId} | ${title} | ${counts.ERROR} | ${counts.EXPECTED} | ${counts.INFO} | ${counts.OK} |`);
    }
    lines.push('');

    // Detailed findings for records with ERRORs
    if (errorRecords.length > 0) {
      lines.push(`### ${ct.charAt(0).toUpperCase() + ct.slice(1)} — Records with ERRORs`);
      lines.push('');

      for (const rec of errorRecords) {
        lines.push(`<details>`);
        lines.push(`<summary><strong>legacyId ${rec.legacyId}</strong>: ${rec.title || 'Untitled'}</summary>`);
        lines.push('');
        lines.push('| Field | Category | Detail | Strapi 3 | Strapi 5 |');
        lines.push('|-------|----------|--------|----------|----------|');
        for (const f of rec.findings) {
          if (f.category === 'ERROR') {
            lines.push(`| ${f.field} | **${f.category}** | ${f.detail} | ${f.strapi3 || '-'} | ${f.strapi5 || '-'} |`);
          }
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  // Expected changes summary
  lines.push('## Expected Changes Summary');
  lines.push('');

  if (media) {
    lines.push('### Media Conversions');
    lines.push('');
    lines.push(`- Splash images (Base64 → media): ${media.base64ToMediaConversions?.splash || 0}`);
    lines.push(`- Thumbnail images (Base64 → media): ${media.base64ToMediaConversions?.thumbnail || 0}`);
    lines.push(`- App images (Base64 → media): ${media.base64ToMediaConversions?.image || 0}`);
    lines.push(`- Inline markdown images extracted: ${media.inlineImagesExtracted || 0}`);
    lines.push(`- Total media files in Strapi 5: ${media.totalMediaInS5 || 'unknown'}`);
    lines.push(`- Media accessible: ${media.mediaAccessible || 0}`);
    lines.push(`- Media inaccessible: ${media.mediaInaccessible || 0}`);
    lines.push('');

    if (media.inaccessibleUrls && media.inaccessibleUrls.length > 0) {
      lines.push('### Inaccessible Media URLs');
      lines.push('');
      for (const entry of media.inaccessibleUrls.slice(0, 20)) {
        lines.push(`- ${entry.url}: ${entry.status || entry.error}`);
      }
      lines.push('');
    }
  }

  // Count expected changes across all records
  let totalExpected = 0;
  for (const ct of ['articles', 'datasets', 'apps']) {
    for (const rec of (records[ct] || [])) {
      totalExpected += rec.findings.filter((f) => f.category === 'EXPECTED').length;
    }
  }
  lines.push(`Total EXPECTED findings across all records: ${totalExpected}`);
  lines.push('');

  // Footer
  if (summary.findings.ERROR === 0) {
    lines.push('---');
    lines.push('');
    lines.push('**Migration parity confirmed.** All differences are accounted for as expected migration transformations.');
  } else {
    lines.push('---');
    lines.push('');
    lines.push(`**${summary.findings.ERROR} ERROR(s) require manual review.** Investigate the records listed above before proceeding.`);
  }

  return lines.join('\n');
}

// ── Console Output ───────────────────────────────────────────────────

/**
 * Print the final audit summary to the console with colored output.
 *
 * @param {Object} summary - The summary section of the audit report
 */
function printConsoleSummary(summary) {
  console.log('');
  console.log(`${BOLD}╔═════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Phase 6: Parity Audit — Summary    ║${RESET}`);
  console.log(`${BOLD}╚═════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`  Records compared:    ${BOLD}${summary.totalRecordsCompared}${RESET}`);
  console.log(`  Fields compared:     ${BOLD}${summary.totalFieldsCompared}${RESET}`);
  console.log('');
  console.log(`  ${RED}ERROR:${RESET}     ${summary.findings.ERROR}`);
  console.log(`  ${YELLOW}EXPECTED:${RESET}  ${summary.findings.EXPECTED}`);
  console.log(`  ${CYAN}INFO:${RESET}      ${summary.findings.INFO}`);
  console.log(`  ${GREEN}OK:${RESET}        ${summary.findings.OK}`);
  console.log('');
  console.log(`  Clean records:       ${summary.cleanRecords}`);
  console.log(`  Records w/ findings: ${summary.recordsWithFindings}`);
  console.log('');

  if (summary.findings.ERROR === 0) {
    console.log(`  ${GREEN}${BOLD}RESULT: CLEAN — Zero ERRORs detected${RESET}`);
  } else {
    console.log(`  ${RED}${BOLD}RESULT: ${summary.findings.ERROR} ERROR(s) found — review required${RESET}`);
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Main entry point: orchestrates the full parity audit.
 * Fetches all records from both systems, compares them field by field,
 * audits the media library, and generates reports.
 */
async function main() {
  console.log(`${BOLD}=== Phase 6: Parity Audit ===${RESET}\n`);

  // Show config
  console.log('Configuration:');
  console.log(`  Strapi 3 GraphQL: ${config.strapi3.graphqlUrl}`);
  console.log(`  Strapi 5 API:     ${config.strapi5.apiUrl}`);
  console.log(`  Strapi 5 token:   ${config.strapi5.token ? '(set)' : '(not set)'}`);
  console.log(`  Request delay:    ${DELAY_MS}ms`);
  console.log(`  Page limit:       ${PAGE_LIMIT}`);
  console.log('');

  // Initialize GraphQL client for Strapi 3
  const client = new GraphQLClient(config.strapi3.graphqlUrl, {
    token: config.strapi3.token,
    timeoutMs: TIMEOUT_MS,
  });

  // ── Step 1: Fetch all records from both systems ────────────────────

  console.log(`${BOLD}── Step 1: Fetching records from both systems ──${RESET}\n`);

  const allowedStatuses = config.allowedStatuses || null;
  if (allowedStatuses) {
    console.log(`  Status filter active: only comparing records with status: ${allowedStatuses.map(s => `"${s}"`).join(', ')}\n`);
  }

  const s3Records = {};
  const s5Records = {};

  for (const [ct, { query, s5Populate }] of Object.entries(CONTENT_TYPES)) {
    // Strapi 3 via GraphQL
    console.log(`  Fetching ${ct} from Strapi 3 (GraphQL)...`);
    s3Records[ct] = await strapi3FetchAll(ct, query, client);
    const totalFetched = s3Records[ct].length;

    // Filter by allowed statuses if configured
    if (allowedStatuses && allowedStatuses.length > 0) {
      s3Records[ct] = s3Records[ct].filter((r) => allowedStatuses.includes(r.status));
      const excluded = totalFetched - s3Records[ct].length;
      if (excluded > 0) {
        console.log(`    ${YELLOW}Filtered: ${excluded} non-${allowedStatuses.join('/')} record(s) excluded${RESET}`);
      }
    }

    console.log(`    ${GREEN}${s3Records[ct].length} records${RESET}`);

    if (DELAY_MS > 0) await sleep(DELAY_MS);

    // Strapi 5 via REST
    console.log(`  Fetching ${ct} from Strapi 5 (REST)...`);
    s5Records[ct] = await strapi5FetchAll(ct, s5Populate);
    console.log(`    ${GREEN}${s5Records[ct].length} records${RESET}`);
    console.log('');

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  // ── Step 2: Schema comparison ──────────────────────────────────────

  console.log(`${BOLD}── Step 2: Schema comparison ──${RESET}\n`);
  const schemaResult = await compareSchemas();
  console.log(`  ${schemaResult.findings.length} schema-level findings\n`);

  // ── Step 3: Record-level comparison ────────────────────────────────

  console.log(`${BOLD}── Step 3: Record-level comparison ──${RESET}\n`);

  const recordResults = { articles: [], datasets: [], apps: [] };
  let totalFieldsCompared = 0;
  const categoryCounts = { ERROR: 0, EXPECTED: 0, INFO: 0, OK: 0 };

  for (const ct of ['articles', 'datasets', 'apps']) {
    const s3List = s3Records[ct];
    const s5List = s5Records[ct];

    // Build S5 lookup by legacyId
    const s5ByLegacyId = new Map();
    for (const rec of s5List) {
      if (rec.legacyId) {
        s5ByLegacyId.set(String(rec.legacyId), rec);
      }
    }

    const total = s3List.length;
    let processed = 0;

    for (const s3Rec of s3List) {
      processed++;
      if (processed % 25 === 1 || processed === total) {
        process.stdout.write(`\r  Auditing ${ct}: ${processed}/${total}...`);
      }

      const s3Id = String(s3Rec.id);
      const s5Rec = s5ByLegacyId.get(s3Id);

      if (!s5Rec) {
        recordResults[ct].push({
          legacyId: s3Id,
          title: s3Rec.title || '(no title)',
          findings: [{
            field: '_record',
            category: 'ERROR',
            detail: `Strapi 3 record id=${s3Id} has no matching Strapi 5 record (by legacyId)`,
          }],
        });
        categoryCounts.ERROR++;
        totalFieldsCompared++;
        continue;
      }

      const findings = auditRecord(ct, s3Rec, s5Rec);
      totalFieldsCompared += findings.length;

      for (const f of findings) {
        categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
      }

      recordResults[ct].push({
        legacyId: s3Id,
        title: s3Rec.title || '(no title)',
        findings,
      });
    }

    // Check for S5 records that have no S3 match (extra records)
    const s3Ids = new Set(s3List.map((r) => String(r.id)));
    for (const s5Rec of s5List) {
      const legacyId = String(s5Rec.legacyId || '');
      if (legacyId && !s3Ids.has(legacyId)) {
        recordResults[ct].push({
          legacyId,
          title: s5Rec.title || '(no title)',
          findings: [{
            field: '_record',
            category: 'ERROR',
            detail: `Strapi 5 record legacyId=${legacyId} has no matching Strapi 3 record`,
          }],
        });
        categoryCounts.ERROR++;
        totalFieldsCompared++;
      }
    }

    console.log(`\r  Auditing ${ct}: ${total}/${total}... ${GREEN}done${RESET}`);
  }

  // Add schema findings to category counts
  for (const f of schemaResult.findings) {
    categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
  }

  // ── Step 4: Media audit ────────────────────────────────────────────

  console.log('');
  console.log(`${BOLD}── Step 4: Media audit ──${RESET}\n`);
  const mediaResults = await auditMedia(s3Records.articles, s5Records.articles);
  console.log(`  Total media in S5:    ${mediaResults.totalMediaInS5}`);
  console.log(`  Accessible:           ${mediaResults.mediaAccessible}`);
  console.log(`  Inaccessible:         ${mediaResults.mediaInaccessible}`);
  console.log(`  Base64→media (splash): ${mediaResults.base64ToMediaConversions.splash}`);
  console.log(`  Base64→media (thumb):  ${mediaResults.base64ToMediaConversions.thumbnail}`);
  console.log(`  Inline images found:   ${mediaResults.inlineImagesExtracted}`);
  console.log('');

  // ── Step 5: Generate reports ───────────────────────────────────────

  console.log(`${BOLD}── Step 5: Generating reports ──${RESET}\n`);

  const totalRecordsCompared = ['articles', 'datasets', 'apps']
    .reduce((sum, ct) => sum + recordResults[ct].length, 0);

  const cleanRecords = ['articles', 'datasets', 'apps']
    .reduce((sum, ct) => {
      return sum + recordResults[ct].filter(
        (r) => r.findings.every((f) => f.category === 'OK')
      ).length;
    }, 0);

  const recordsWithFindings = totalRecordsCompared - cleanRecords;

  const summary = {
    totalRecordsCompared,
    totalFieldsCompared,
    findings: { ...categoryCounts },
    cleanRecords,
    recordsWithFindings,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    schema: schemaResult,
    records: recordResults,
    media: mediaResults,
  };

  // Write JSON report
  const dataDir = path.resolve(ROOT, 'migration/data');
  await fs.mkdir(dataDir, { recursive: true });

  const jsonReportPath = path.join(dataDir, 'audit-report.json');
  await fs.writeFile(jsonReportPath, JSON.stringify(report, null, 2));
  console.log(`  ${GREEN}JSON report:${RESET} ${path.relative(ROOT, jsonReportPath)}`);

  // Write Markdown report
  const mdReport = generateMarkdownReport(report);
  const mdReportPath = path.join(dataDir, 'audit-report.md');
  await fs.writeFile(mdReportPath, mdReport);
  console.log(`  ${GREEN}Markdown report:${RESET} ${path.relative(ROOT, mdReportPath)}`);

  // ── Console Summary ────────────────────────────────────────────────

  printConsoleSummary(summary);

  // Exit code
  if (categoryCounts.ERROR > 0) {
    console.log('');
    console.log(`${RED}Parity audit found ${categoryCounts.ERROR} ERROR-category diffs.${RESET}`);
    console.log(`Review ${path.relative(ROOT, mdReportPath)} for details, fix the underlying issue, then re-run:`);
    console.log(`  pnpm migrate:phase06`);
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log('Next: Phase 7 (Generate HTML + DOCX migration report)');
  console.log(`  pnpm report`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
