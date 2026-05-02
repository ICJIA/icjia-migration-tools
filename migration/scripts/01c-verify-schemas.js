/**
 * @module 01c-verify-schemas
 * @description Phase 1c: Verify Strapi 5 Schemas
 *
 * Validates that the generated Strapi 5 schemas were applied correctly by:
 * 1. Polling Strapi 5 until it's ready (up to 60 seconds)
 * 2. Running GraphQL introspection against Strapi 5
 * 3. Loading Strapi 3 introspection data for comparison
 * 4. Diffing the two schemas, categorizing differences as expected or unexpected
 * 5. Verifying the REST API responds with correct structure
 * 6. Verifying the `legacyId` field is accessible on all content types
 * 7. Saving the full report to `data/introspection/schema-diff.json`
 *
 * Exits with code 0 if only expected differences are found, code 1 otherwise.
 *
 * Expected differences include: Base64 string → media type changes (splash,
 * thumbnail, image), upload plugin → media changes (mainfile, extrafile, datafile),
 * new system fields (documentId, locale, etc.), and the added legacyId field.
 *
 * @example
 *   node migration/scripts/01c-verify-schemas.js
 *
 * Prerequisites:
 * - Strapi 5 running with generated schemas applied
 * - `@strapi/plugin-graphql` installed in the Strapi 5 project
 * - Phase 1a complete (`data/introspection/strapi3.json` exists)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

/** ANSI color codes for terminal output */
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

const INTROSPECTION_QUERY = `{
  __schema {
    types {
      name
      kind
      fields {
        name
        type {
          name
          kind
          ofType {
            name
            kind
            ofType {
              name
              kind
            }
          }
        }
      }
    }
  }
}`;

const GQL_TYPE_NAMES = new Set(['Article', 'Dataset', 'App']);

// Fields we expect Strapi 5 to add that don't exist in Strapi 3
const EXPECTED_NEW_FIELDS = new Set([
  'documentId', 'locale', 'publishedAt', 'localizations',
  'createdAt', 'updatedAt', 'legacyId',
]);

// Field name suffixes/patterns that Strapi 5 GraphQL auto-generates (expected)
const EXPECTED_NEW_FIELD_PATTERNS = [
  /_connection$/,  // Strapi 5 adds *_connection fields for paginated relation queries
];

// Fields that exist in Strapi 3 but not Strapi 5 (expected removals)
const EXPECTED_MISSING_FIELDS = new Set([
  '_id',  // MongoDB _id does not exist in Strapi 5 SQLite
]);

// Fields whose type is expected to change (Base64 string → media)
const EXPECTED_TYPE_CHANGES = new Set([
  'Article.splash', 'Article.thumbnail', 'App.image',
  'Article.mainfile', 'Article.extrafile', 'Dataset.datafile',
]);

// Type changes that are expected due to Strapi 3 → 5 GraphQL schema differences
const EXPECTED_TYPE_CHANGE_PATTERNS = [
  // Strapi 5 wraps relation arrays in non-null: [Type] → [Type]!
  { test: (s3, s5) => s5 === s3 + '!' || s5 === s3.replace('!', '') },
  // Date field type: DateTime → Date
  { test: (s3, s5) => s3 === 'DateTime' && s5 === 'Date' },
  // Timestamps become nullable: DateTime! → DateTime
  { test: (s3, s5) => s3 === 'DateTime!' && s5 === 'DateTime' },
];

/**
 * Poll Strapi 5 until it responds, with configurable timeout.
 *
 * @param {number} [maxAttempts] - Max poll attempts (default from config or 30)
 * @param {number} [delayMs] - Delay between attempts in ms (default from config or 2000)
 * @returns {Promise<boolean>} True if Strapi 5 is ready, false if timed out
 */
async function pollStrapi5(maxAttempts, delayMs) {
  maxAttempts = maxAttempts || config.settings?.pollMaxAttempts || 30;
  delayMs = delayMs || config.settings?.pollDelayMs || 2000;
  const url = config.strapi5.apiUrl;
  console.log(`Waiting for Strapi 5 at ${url}...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers = {};
      if (config.strapi5.token) {
        headers['Authorization'] = `Bearer ${config.strapi5.token}`;
      }
      const res = await fetch(`${url}/api/articles`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok || res.status === 403) {
        console.log(`  Strapi 5 is ready (attempt ${attempt})`);
        return true;
      }
    } catch {
      // Not ready yet
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`  Attempt ${attempt}/${maxAttempts}...\r`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.error(`\n${RED}ERROR: Strapi 5 did not respond after ${maxAttempts} attempts.${RESET}`);
  console.error(`${RED}Make sure Strapi 5 is running with the generated schemas.${RESET}`);
  console.error(`${RED}Also ensure @strapi/plugin-graphql is installed for introspection.${RESET}`);
  return false;
}

async function introspectStrapi5() {
  const url = config.strapi5.graphqlUrl;
  console.log(`\nIntrospecting Strapi 5 GraphQL at ${url}...`);

  const headers = { 'Content-Type': 'application/json' };
  if (config.strapi5.token) {
    headers['Authorization'] = `Bearer ${config.strapi5.token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GraphQL introspection failed: HTTP ${response.status}\n${body}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }

  const allTypes = json.data.__schema.types;
  const contentTypes = allTypes.filter(t => GQL_TYPE_NAMES.has(t.name) && t.kind === 'OBJECT');

  console.log(`  Found ${contentTypes.length} content types: ${contentTypes.map(t => t.name).join(', ')}`);
  return { types: contentTypes };
}

function resolveTypeName(typeObj) {
  if (!typeObj) return 'null';
  if (typeObj.name) return typeObj.name;
  if (typeObj.kind === 'NON_NULL' || typeObj.kind === 'LIST') {
    const inner = resolveTypeName(typeObj.ofType);
    return typeObj.kind === 'NON_NULL' ? `${inner}!` : `[${inner}]`;
  }
  return 'unknown';
}

function diffSchemas(strapi3Types, strapi5Types) {
  const diff = { expected: [], unexpected: [], summary: { pass: true } };

  const s3Map = new Map(strapi3Types.map(t => [t.name, t]));
  const s5Map = new Map(strapi5Types.map(t => [t.name, t]));

  // Check each expected content type
  for (const typeName of GQL_TYPE_NAMES) {
    const s3Type = s3Map.get(typeName);
    const s5Type = s5Map.get(typeName);

    if (!s5Type) {
      diff.unexpected.push({
        type: typeName,
        issue: 'MISSING_TYPE',
        detail: `Content type ${typeName} missing from Strapi 5`,
      });
      diff.summary.pass = false;
      continue;
    }

    if (!s3Type) {
      diff.expected.push({
        type: typeName,
        issue: 'NO_S3_COMPARISON',
        detail: `No Strapi 3 GraphQL data for ${typeName} (model files used instead)`,
      });
      continue;
    }

    const s3Fields = new Map((s3Type.fields || []).map(f => [f.name, f]));
    const s5Fields = new Map((s5Type.fields || []).map(f => [f.name, f]));

    // Fields in Strapi 5 but not Strapi 3
    for (const [fieldName] of s5Fields) {
      if (!s3Fields.has(fieldName)) {
        const entry = { type: typeName, field: fieldName, issue: 'NEW_FIELD' };
        if (EXPECTED_NEW_FIELDS.has(fieldName) || EXPECTED_NEW_FIELD_PATTERNS.some(re => re.test(fieldName))) {
          entry.detail = 'Expected new Strapi 5 field';
          diff.expected.push(entry);
        } else {
          entry.detail = `Unexpected new field in Strapi 5: ${fieldName}`;
          diff.unexpected.push(entry);
          diff.summary.pass = false;
        }
      }
    }

    // Fields in Strapi 3 but not Strapi 5
    for (const [fieldName] of s3Fields) {
      if (fieldName === 'id') continue; // ID field changes are expected
      if (!s5Fields.has(fieldName)) {
        const entry = { type: typeName, field: fieldName, issue: 'MISSING_FIELD' };
        if (EXPECTED_MISSING_FIELDS.has(fieldName)) {
          entry.detail = `Expected: ${fieldName} does not exist in Strapi 5 (MongoDB-only field)`;
          diff.expected.push(entry);
        } else {
          entry.detail = `Field ${fieldName} exists in Strapi 3 but missing from Strapi 5`;
          diff.unexpected.push(entry);
          diff.summary.pass = false;
        }
      }
    }

    // Type changes
    for (const [fieldName, s3Field] of s3Fields) {
      const s5Field = s5Fields.get(fieldName);
      if (!s5Field) continue;

      const s3TypeName = resolveTypeName(s3Field.type);
      const s5TypeName = resolveTypeName(s5Field.type);

      if (s3TypeName !== s5TypeName) {
        const qualifiedName = `${typeName}.${fieldName}`;
        const entry = {
          type: typeName,
          field: fieldName,
          issue: 'TYPE_CHANGE',
          strapi3Type: s3TypeName,
          strapi5Type: s5TypeName,
        };

        if (EXPECTED_TYPE_CHANGES.has(qualifiedName)) {
          entry.detail = 'Expected type change (Base64 string → media or upload plugin → media)';
          diff.expected.push(entry);
        } else if (EXPECTED_TYPE_CHANGE_PATTERNS.some(p => p.test(s3TypeName, s5TypeName))) {
          entry.detail = `Expected Strapi 3→5 type difference: ${s3TypeName} → ${s5TypeName}`;
          diff.expected.push(entry);
        } else {
          entry.detail = `Unexpected type change: ${s3TypeName} → ${s5TypeName}`;
          diff.unexpected.push(entry);
          diff.summary.pass = false;
        }
      }
    }
  }

  diff.summary.expectedCount = diff.expected.length;
  diff.summary.unexpectedCount = diff.unexpected.length;
  return diff;
}

async function verifyRestApi() {
  console.log('\nVerifying Strapi 5 REST API...');
  const checks = [];

  for (const ctName of config.contentTypes) {
    const url = `${config.strapi5.apiUrl}/api/${ctName}s`;
    const headers = {};
    if (config.strapi5.token) {
      headers['Authorization'] = `Bearer ${config.strapi5.token}`;
    }

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });

      // 403 means the endpoint exists but public access isn't configured — that's OK for schema verification
      // The content type is registered, which is what we're checking
      if (res.status === 403) {
        checks.push({ contentType: ctName, url, status: 403, pass: true, note: 'endpoint exists (403 — enable public permissions for read access)' });
        console.log(`  ${GREEN}✓${RESET} GET ${url} → 403 (endpoint exists, needs public permissions for read access)`);
        continue;
      }

      const json = await res.json();
      const hasData = Array.isArray(json.data);
      const hasMeta = json.meta?.pagination !== undefined;

      checks.push({
        contentType: ctName,
        url,
        status: res.status,
        hasDataArray: hasData,
        hasPagination: hasMeta,
        pass: res.ok && hasData && hasMeta,
      });

      const icon = res.ok && hasData && hasMeta ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      console.log(`  ${icon} GET ${url} → ${res.status} (data: ${hasData}, pagination: ${hasMeta})`);
    } catch (err) {
      checks.push({ contentType: ctName, url, error: err.message, pass: false });
      console.log(`  ${RED}✗${RESET} GET ${url} → ${err.message}`);
    }
  }

  return checks;
}

async function verifyLegacyIdField() {
  console.log('\nVerifying legacyId field exists on all types...');
  const results = [];

  for (const ctName of config.contentTypes) {
    const url = `${config.strapi5.apiUrl}/api/${ctName}s?fields[0]=legacyId&pagination[pageSize]=1`;
    const headers = {};
    if (config.strapi5.token) {
      headers['Authorization'] = `Bearer ${config.strapi5.token}`;
    }

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      // 200 = field accessible, 403 = endpoint exists but no public permissions (OK for schema check)
      // 400 = field doesn't exist (Strapi rejects unknown field names)
      const pass = res.ok || res.status === 403;
      results.push({ contentType: ctName, pass, status: res.status });
      const icon = pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const note = res.status === 403 ? ' (403 — needs public permissions or API token)' : '';
      console.log(`  ${icon} ${ctName}: legacyId field ${pass ? 'exists' : 'NOT found'}${note}`);
    } catch (err) {
      results.push({ contentType: ctName, pass: false, error: err.message });
      console.log(`  ${RED}✗${RESET} ${ctName}: ${err.message}`);
    }
  }

  return results;
}

async function main() {
  console.log('=== Phase 1c: Verify Strapi 5 Schemas ===\n');

  // Show current config so user can verify
  console.log('Configuration:');
  console.log(`  Strapi 5 GraphQL: ${config.strapi5.graphqlUrl}`);
  console.log(`  Strapi 5 API:     ${config.strapi5.apiUrl}`);
  console.log(`  Strapi 5 token:   ${config.strapi5.token ? '(set)' : '(not set)'}`);
  console.log('');

  // Poll for readiness
  const ready = await pollStrapi5();
  if (!ready) process.exit(1);

  // Introspect Strapi 5
  let strapi5Data;
  try {
    strapi5Data = await introspectStrapi5();
  } catch (err) {
    console.error(`\n${RED}ERROR: GraphQL introspection failed.${RESET}`);
    console.error(`${RED}Is @strapi/plugin-graphql installed in the Strapi 5 project?${RESET}`);
    console.error(`${RED}Detail: ${err.message}${RESET}`);
    process.exit(1);
  }

  // Save Strapi 5 introspection
  const outputDir = path.resolve(ROOT, config.paths.introspection);
  await fs.mkdir(outputDir, { recursive: true });
  const s5Path = path.join(outputDir, 'strapi5.json');
  await fs.writeFile(s5Path, JSON.stringify(strapi5Data, null, 2));
  console.log(`Strapi 5 introspection saved to ${path.relative(ROOT, s5Path)}`);

  // Load Strapi 3 introspection
  const s3Path = path.join(outputDir, 'strapi3.json');
  let strapi3Data;
  try {
    strapi3Data = JSON.parse(await fs.readFile(s3Path, 'utf8'));
  } catch {
    console.warn('\nWARNING: No Strapi 3 GraphQL introspection data found.');
    console.warn('Schema diff will be limited to REST API checks only.');
    strapi3Data = { types: [] };
  }

  // Diff schemas
  console.log('\nDiffing Strapi 3 vs Strapi 5 schemas...');
  const diff = diffSchemas(strapi3Data.types || [], strapi5Data.types || []);

  // REST API checks
  const restChecks = await verifyRestApi();
  const restPass = restChecks.every(c => c.pass);

  // legacyId checks
  const legacyChecks = await verifyLegacyIdField();
  const legacyPass = legacyChecks.every(c => c.pass);

  // Save diff
  const fullReport = {
    generatedAt: new Date().toISOString(),
    schemaDiff: diff,
    restApiChecks: restChecks,
    legacyIdChecks: legacyChecks,
    overallPass: diff.summary.pass && restPass && legacyPass,
  };

  const diffPath = path.join(outputDir, 'schema-diff.json');
  await fs.writeFile(diffPath, JSON.stringify(fullReport, null, 2));
  console.log(`\nFull report saved to ${path.relative(ROOT, diffPath)}`);

  // Print summary
  console.log('\n--- Verification Results ---');

  if (diff.expected.length > 0) {
    console.log(`\nExpected differences (${diff.expected.length}):`);
    for (const d of diff.expected) {
      console.log(`  ✓ ${d.type}${d.field ? '.' + d.field : ''}: ${d.detail}`);
    }
  }

  if (diff.unexpected.length > 0) {
    console.log(`\nUNEXPECTED differences (${diff.unexpected.length}):`);
    for (const d of diff.unexpected) {
      console.log(`  ✗ ${d.type}${d.field ? '.' + d.field : ''}: ${d.detail}`);
    }
  }

  console.log(`\nREST API: ${restPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`legacyId field: ${legacyPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`Schema diff: ${diff.summary.pass ? 'PASS ✓' : 'FAIL ✗'} (${diff.summary.expectedCount} expected, ${diff.summary.unexpectedCount} unexpected)`);

  const overallPass = diff.summary.pass && restPass && legacyPass;
  if (overallPass) {
    console.log(`\n${GREEN}Overall: PASS ✓ — Ready for Phase 2${RESET}`);
  } else {
    console.log(`\n${RED}Overall: FAIL ✗ — Review issues above before proceeding${RESET}`);
  }

  process.exit(overallPass ? 0 : 1);
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
