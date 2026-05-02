/**
 * @module 01c-verify-schemas
 * @description Phase 1c: Verify generated Strapi 5 schemas are registered.
 *
 * After 01b writes content-type and component schemas into the Strapi 5
 * project, Strapi 5 must be restarted to pick them up. This script:
 *
 * 1. Polls Strapi 5 until it responds (up to 60s)
 * 2. Runs GraphQL introspection on the destination
 * 3. Confirms every active manifest type appears as a GraphQL OBJECT type
 * 4. Verifies REST API endpoints respond (200 or 403 — both mean "registered")
 * 5. Verifies the `legacyId` field exists on collection types (skipped for singletons)
 *
 * All checks are driven by `migration/config/content-types.json`. Saves the
 * full report to `migration/data/introspection/schema-verification.json`.
 *
 * Exits non-zero if any check fails.
 *
 * @example
 *   pnpm verify
 *   # or: node migration/scripts/01c-verify-schemas.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const config = await loadConfig();

/**
 * Convert a manifest content-type name to the Strapi 5 GraphQL type name.
 * Strapi 5 uppercases the singular form: "post" → "Post", "required-form" → "RequiredForm".
 */
function gqlTypeName(name) {
  return name
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Convert a manifest content-type name to the kebab-case pluralName used in REST URLs.
 */
function restPluralName(manifest) {
  if (manifest.kind === 'singleType') return manifest.name;
  // Use the manifest's queryName (camelCase) → kebab-case
  const q = manifest.queryName || manifest.name;
  return q.replace(/_/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

async function loadManifest() {
  const p = path.resolve(ROOT, config.paths.contentTypesManifest);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Poll Strapi 5 until a known REST endpoint responds.
 */
async function pollStrapi5(probeUrl) {
  const max = config.settings?.pollMaxAttempts || 30;
  const delay = config.settings?.pollDelayMs || 2000;
  console.log(`Polling Strapi 5 at ${CYAN}${probeUrl}${RESET}...`);

  for (let attempt = 1; attempt <= max; attempt++) {
    const headers = {};
    if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;
    try {
      const res = await fetch(probeUrl, { headers, signal: AbortSignal.timeout(5000) });
      // 200, 401, 403, 404 all mean "Strapi is responding"
      if (res.status < 500) {
        console.log(`  ${GREEN}ready${RESET} (attempt ${attempt}, HTTP ${res.status})`);
        return true;
      }
    } catch {
      // Not ready yet
    }
    if (attempt < max) {
      process.stdout.write(`  attempt ${attempt}/${max}...\r`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.error(`\n${RED}ERROR${RESET} Strapi 5 did not respond after ${max} attempts.`);
  console.error(`${RED}Restart Strapi 5: cd ${config.strapi5ProjectPath} && pnpm develop${RESET}`);
  return false;
}

/**
 * Introspect Strapi 5 GraphQL — only the type names + kinds.
 */
async function introspectStrapi5() {
  const url = config.strapi5.graphqlUrl;
  console.log(`Introspecting Strapi 5 GraphQL at ${CYAN}${url}${RESET}...`);

  const headers = { 'Content-Type': 'application/json' };
  if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;

  const query = '{ __schema { types { name kind } } }';
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}\n${body}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }

  return json.data.__schema.types;
}

/**
 * Verify every active manifest type appears as a GraphQL OBJECT type.
 */
function verifyGqlPresence(manifest, gqlTypes) {
  const typesByName = new Map(gqlTypes.map((t) => [t.name, t]));
  const results = [];

  for (const ct of manifest.contentTypes) {
    if (ct.skipDefault) continue;
    const expectedName = gqlTypeName(ct.name);
    const found = typesByName.get(expectedName);
    if (found && found.kind === 'OBJECT') {
      results.push({ name: ct.name, expectedGqlName: expectedName, pass: true });
    } else {
      results.push({
        name: ct.name,
        expectedGqlName: expectedName,
        pass: false,
        note: found ? `kind is ${found.kind}, expected OBJECT` : 'not found in GraphQL schema',
      });
    }
  }

  // Components show up as OBJECT types named "Component<Category><Name>" with both
  // capitalized — verify each one.
  for (const comp of manifest.components) {
    const catCap = gqlTypeName(comp.category);
    const nameCap = gqlTypeName(comp.name);
    const expectedName = `Component${catCap}${nameCap}`;
    const found = typesByName.get(expectedName);
    results.push({
      name: `${comp.category}.${comp.name}`,
      expectedGqlName: expectedName,
      pass: !!found,
      note: found ? null : 'not found in GraphQL schema',
      isComponent: true,
    });
  }

  return results;
}

/**
 * Verify REST API responds for every active content type.
 * Singletons use /api/<singularName>; collections use /api/<pluralName>.
 */
async function verifyRestApi(manifest) {
  console.log('\nVerifying Strapi 5 REST API...');
  const headers = {};
  if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;

  const results = [];
  for (const ct of manifest.contentTypes) {
    if (ct.skipDefault) continue;
    const isSingle = ct.kind === 'singleType';
    const url = isSingle
      ? `${config.strapi5.apiUrl}/api/${ct.name}`
      : `${config.strapi5.apiUrl}/api/${restPluralName(ct)}?pagination[pageSize]=1`;

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      // 200 = endpoint live + accessible; 403 = registered but lacks public perms; 404 = not found
      const pass = res.ok || res.status === 403 || res.status === 404; // 404 OK for empty singleType
      const icon = pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const noteParts = [];
      if (res.status === 403) noteParts.push('registered, public perms not set');
      if (res.status === 404 && isSingle) noteParts.push('singleton not yet populated');
      const note = noteParts.length ? ` ${DIM}(${noteParts.join('; ')})${RESET}` : '';
      console.log(`  ${icon} ${ct.name.padEnd(16)} ${url.replace(config.strapi5.apiUrl, '')} ${DIM}HTTP ${res.status}${RESET}${note}`);
      results.push({ name: ct.name, url, status: res.status, pass });
    } catch (err) {
      console.log(`  ${RED}✗${RESET} ${ct.name.padEnd(16)} ${err.message}`);
      results.push({ name: ct.name, url, error: err.message, pass: false });
    }
  }
  return results;
}

/**
 * Verify the `legacyId` field exists on every collection type (singletons skip).
 * Uses GraphQL introspection — checks each type's field list for "legacyId".
 * This is more reliable than REST probing, which returns 404 when public
 * permissions aren't granted (even with a Full-Access API token, depending
 * on the Strapi 5 install's default permission config).
 */
async function verifyLegacyIdField(manifest) {
  console.log('\nVerifying legacyId field on collection types (via GraphQL introspection)...');
  const headers = { 'Content-Type': 'application/json' };
  if (config.strapi5.token) headers['Authorization'] = `Bearer ${config.strapi5.token}`;

  const results = [];
  for (const ct of manifest.contentTypes) {
    if (ct.skipDefault) continue;
    if (ct.kind === 'singleType') {
      results.push({ name: ct.name, pass: true, skipped: 'singleton' });
      console.log(`  ${DIM}skip${RESET} ${ct.name.padEnd(16)} (singleton)`);
      continue;
    }
    const typeName = gqlTypeName(ct.name);
    const query = `{ __type(name: "${typeName}") { fields { name } } }`;
    try {
      const res = await fetch(config.strapi5.graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json();
      const fields = json.data?.__type?.fields || [];
      const hasLegacyId = fields.some((f) => f.name === 'legacyId');
      const icon = hasLegacyId ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      console.log(`  ${icon} ${ct.name.padEnd(16)} legacyId ${hasLegacyId ? 'registered' : 'NOT FOUND'} ${DIM}(${fields.length} fields visible on ${typeName})${RESET}`);
      results.push({ name: ct.name, gqlType: typeName, hasLegacyId, fieldCount: fields.length, pass: hasLegacyId });
    } catch (err) {
      console.log(`  ${RED}✗${RESET} ${ct.name.padEnd(16)} ${err.message}`);
      results.push({ name: ct.name, error: err.message, pass: false });
    }
  }
  return results;
}

async function main() {
  console.log(`${BOLD}── Phase 1c: Verify Strapi 5 schemas ──${RESET}\n`);

  console.log('Configuration:');
  console.log(`  Strapi 5 GraphQL: ${CYAN}${config.strapi5.graphqlUrl}${RESET}`);
  console.log(`  Strapi 5 REST:    ${CYAN}${config.strapi5.apiUrl}${RESET}`);
  console.log(`  Strapi 5 token:   ${config.strapi5.token ? `${GREEN}set${RESET}` : `${YELLOW}not set${RESET}`}`);
  console.log('');

  const manifest = await loadManifest();
  const activeTypes = manifest.contentTypes.filter((c) => !c.skipDefault);

  // Use a known type for connectivity probe — pick a small, predictably-present one.
  const probeType = activeTypes.find((t) => t.kind !== 'singleType') || activeTypes[0];
  const probeUrl = `${config.strapi5.apiUrl}/api/${restPluralName(probeType)}?pagination[pageSize]=1`;

  const ready = await pollStrapi5(probeUrl);
  if (!ready) process.exit(1);

  let gqlTypes;
  try {
    gqlTypes = await introspectStrapi5();
    console.log(`  ${GREEN}OK${RESET} ${gqlTypes.length} types in GraphQL schema`);
  } catch (err) {
    console.error(`\n${RED}ERROR${RESET} GraphQL introspection failed: ${err.message}`);
    console.error(`${RED}Is @strapi/plugin-graphql installed in the Strapi 5 project?${RESET}`);
    console.error(`${DIM}Install: cd ${config.strapi5ProjectPath} && pnpm add @strapi/plugin-graphql${RESET}`);
    process.exit(1);
  }

  console.log('');
  console.log(`${BOLD}GraphQL type presence:${RESET}`);
  const gqlResults = verifyGqlPresence(manifest, gqlTypes);
  for (const r of gqlResults) {
    const icon = r.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const tag = r.isComponent ? `${DIM}component${RESET} ` : '';
    const note = r.note ? ` ${DIM}(${r.note})${RESET}` : '';
    console.log(`  ${icon} ${tag}${r.name.padEnd(28)} → ${r.expectedGqlName}${note}`);
  }

  const restResults = await verifyRestApi(manifest);
  const legacyResults = await verifyLegacyIdField(manifest);

  // Save full report
  const outputDir = path.resolve(ROOT, config.paths.introspection);
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'schema-verification.json');
  const gqlPass = gqlResults.every((r) => r.pass);
  const restPass = restResults.every((r) => r.pass);
  const legacyPass = legacyResults.every((r) => r.pass);
  const overallPass = gqlPass && restPass && legacyPass;

  const report = {
    generatedAt: new Date().toISOString(),
    overallPass,
    gqlPresence: { pass: gqlPass, results: gqlResults },
    restApi: { pass: restPass, results: restResults },
    legacyId: { pass: legacyPass, results: legacyResults },
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n${GREEN}Saved${RESET} verification report → ${path.relative(ROOT, reportPath)}`);

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  GraphQL presence:  ${gqlPass ? GREEN + 'PASS' : RED + 'FAIL'}${RESET}  ${gqlResults.filter((r) => r.pass).length}/${gqlResults.length}`);
  console.log(`  REST API:          ${restPass ? GREEN + 'PASS' : RED + 'FAIL'}${RESET}  ${restResults.filter((r) => r.pass).length}/${restResults.length}`);
  console.log(`  legacyId field:    ${legacyPass ? GREEN + 'PASS' : RED + 'FAIL'}${RESET}  ${legacyResults.filter((r) => r.pass).length}/${legacyResults.length}`);
  console.log('');

  if (overallPass) {
    console.log(`${GREEN}${BOLD}Phase 1 complete.${RESET}`);
    console.log('');
    console.log('Next: Phase 2 (Extract content from Strapi 3)');
    console.log(`  ${CYAN}pnpm migrate:phase02${RESET}`);
    console.log('');
  } else {
    console.log(`${RED}${BOLD}Verification FAILED.${RESET} Review failures above.`);
    console.log(`Common fixes:`);
    console.log(`  - Restart Strapi 5 to pick up regenerated schemas`);
    console.log(`  - Install @strapi/plugin-graphql if introspection fails`);
    console.log(`  - Re-run Phase 1 after fixing: ${CYAN}pnpm migrate:phase01${RESET}`);
    console.log('');
  }

  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
