/**
 * @module 01a-introspect
 * @description Phase 1a: Introspect the Strapi 3 source.
 *
 * Reads two sources, in order of authority:
 *
 * 1. **Strapi 3 model files** (primary, authoritative)
 *    - `docs/strapi-3-source/api/<type>/models/<type>.settings.json` for content types
 *    - `docs/strapi-3-source/components/<category>/<name>.json` for components
 *    These files carry the full Strapi 3 schema including `dominant`, `via`,
 *    `allowedTypes`, defaults, indexes — none of which GraphQL exposes.
 *
 * 2. **GraphQL introspection** (secondary, defensive cross-check)
 *    - Confirms the model files match what the live Strapi 3 endpoint exposes.
 *    - Skipped gracefully if the endpoint is unreachable.
 *
 * Drives the type list from the manifest (`migration/config/content-types.json`),
 * skipping any entry with `skipDefault: true`.
 *
 * Outputs:
 * - `migration/data/introspection/source-schema.json` — normalized schema for downstream phases
 * - `migration/data/introspection/strapi3-models.json` — raw model files (for diffing)
 * - `migration/data/introspection/strapi3-graphql.json` — raw GraphQL introspection (or placeholder)
 *
 * @example
 *   pnpm introspect
 *   # or: node migration/scripts/01a-introspect.js
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
 * Load the central content-types manifest.
 * @returns {Promise<{contentTypes: Object[], components: Object[]}>}
 */
async function loadManifest() {
  const manifestPath = path.resolve(ROOT, config.paths.contentTypesManifest);
  const raw = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Read all Strapi 3 content-type model files driven by the manifest.
 * @param {Object[]} contentTypes - Manifest content type entries
 * @returns {Promise<Object>} Models keyed by content type name
 */
async function readContentTypeModels(contentTypes) {
  console.log('\nReading Strapi 3 content-type model files...');
  const models = {};
  const sourceDir = path.resolve(ROOT, config.strapi3SourcePath);

  for (const ct of contentTypes) {
    if (ct.skipDefault) {
      console.log(`  ${DIM}skip${RESET} ${ct.name} (skipDefault: true)`);
      continue;
    }
    const filePath = path.join(sourceDir, 'api', ct.name, 'models', `${ct.name}.settings.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      models[ct.name] = JSON.parse(raw);
      const attrs = Object.keys(models[ct.name].attributes || {});
      console.log(`  ${ct.name.padEnd(16)} ${attrs.length} attributes ${DIM}(${path.relative(ROOT, filePath)})${RESET}`);
    } catch (err) {
      console.error(`  ${RED}ERROR${RESET} ${ct.name}: ${err.message}`);
      console.error(`  ${RED}      expected at: ${path.relative(ROOT, filePath)}${RESET}`);
      process.exit(1);
    }
  }

  return models;
}

/**
 * Read all Strapi 3 component definition files driven by the manifest.
 * @param {Object[]} components - Manifest component entries
 * @returns {Promise<Object>} Components keyed by "category.name"
 */
async function readComponents(components) {
  console.log('\nReading Strapi 3 component files...');
  const result = {};
  const sourceDir = path.resolve(ROOT, config.strapi3SourcePath, 'components');

  for (const comp of components) {
    const filePath = path.join(sourceDir, comp.category, `${comp.name}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const def = JSON.parse(raw);
      const key = `${comp.category}.${comp.name}`;
      result[key] = def;
      const attrs = Object.keys(def.attributes || {});
      console.log(`  ${key.padEnd(28)} ${attrs.length} attributes`);
    } catch (err) {
      console.error(`  ${RED}ERROR${RESET} ${comp.category}/${comp.name}: ${err.message}`);
      process.exit(1);
    }
  }

  return result;
}

/**
 * Run a GraphQL introspection query against Strapi 3 (defensive cross-check).
 * Returns null if the endpoint is unreachable — model files are authoritative.
 */
async function introspectGraphQL() {
  const url = config.strapi3.graphqlUrl;
  console.log(`\nCross-checking with Strapi 3 GraphQL at ${url}...`);

  const headers = { 'Content-Type': 'application/json' };
  if (config.strapi3.token) {
    headers['Authorization'] = `Bearer ${config.strapi3.token}`;
  }

  const query = `{
    __schema {
      types {
        name
        kind
        fields {
          name
          type { name kind ofType { name kind ofType { name kind } } }
        }
      }
    }
  }`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(config.settings?.requestTimeoutMs || 30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    if (json.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
    }

    const allTypes = json.data.__schema.types;
    const objectTypes = allTypes.filter((t) => t.kind === 'OBJECT' && !t.name.startsWith('__'));

    console.log(`  ${GREEN}OK${RESET} ${objectTypes.length} object types visible`);
    return { types: objectTypes };
  } catch (err) {
    if (
      err.cause?.code === 'ECONNREFUSED' ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('fetch failed') ||
      err.name === 'TimeoutError'
    ) {
      console.warn(`  ${YELLOW}WARN${RESET} ${url} unreachable — skipping cross-check`);
      console.warn(`  ${YELLOW}     Model files are authoritative; this is non-blocking.${RESET}`);
      return null;
    }
    throw err;
  }
}

/**
 * Build a normalized schema document combining manifest, models, and components.
 * This is what downstream phases (01b-generate-schemas, 02-extract, 04-load) read.
 */
function buildNormalizedSchema(manifest, models, components) {
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    contentTypes: manifest.contentTypes
      .filter((ct) => !ct.skipDefault)
      .map((ct) => ({
        manifest: ct,
        model: models[ct.name] || null,
      })),
    components: manifest.components.map((comp) => ({
      manifest: comp,
      model: components[`${comp.category}.${comp.name}`] || null,
    })),
  };
}

async function main() {
  console.log(`${BOLD}── Phase 1a: Introspect Strapi 3 source ──${RESET}`);

  console.log('');
  console.log('Configuration:');
  console.log(`  Strapi 3 source path:  ${CYAN}${config.strapi3SourcePath}${RESET}`);
  console.log(`  Strapi 3 GraphQL URL:  ${CYAN}${config.strapi3.graphqlUrl}${RESET}`);
  console.log(`  Manifest path:         ${CYAN}${config.paths.contentTypesManifest}${RESET}`);

  const manifest = await loadManifest();
  const activeCount = manifest.contentTypes.filter((c) => !c.skipDefault).length;
  console.log(`  Content types:         ${activeCount} active, ${manifest.contentTypes.length - activeCount} skipped`);
  console.log(`  Components:            ${manifest.components.length}`);

  // Read in parallel
  const [models, components, gql] = await Promise.all([
    readContentTypeModels(manifest.contentTypes),
    readComponents(manifest.components),
    introspectGraphQL(),
  ]);

  // Output directory
  const outputDir = path.resolve(ROOT, config.paths.introspection);
  await fs.mkdir(outputDir, { recursive: true });

  // Normalized schema for downstream phases
  const normalized = buildNormalizedSchema(manifest, models, components);
  const normalizedPath = path.join(outputDir, 'source-schema.json');
  await fs.writeFile(normalizedPath, JSON.stringify(normalized, null, 2));
  console.log(`\n${GREEN}Saved${RESET} normalized schema → ${path.relative(ROOT, normalizedPath)}`);

  // Raw model files
  const modelsPath = path.join(outputDir, 'strapi3-models.json');
  await fs.writeFile(modelsPath, JSON.stringify(models, null, 2));
  console.log(`${GREEN}Saved${RESET} raw model files → ${path.relative(ROOT, modelsPath)}`);

  // Raw component files
  const componentsPath = path.join(outputDir, 'strapi3-components.json');
  await fs.writeFile(componentsPath, JSON.stringify(components, null, 2));
  console.log(`${GREEN}Saved${RESET} raw component files → ${path.relative(ROOT, componentsPath)}`);

  // GraphQL introspection
  const gqlPath = path.join(outputDir, 'strapi3-graphql.json');
  if (gql) {
    await fs.writeFile(gqlPath, JSON.stringify(gql, null, 2));
    console.log(`${GREEN}Saved${RESET} GraphQL introspection → ${path.relative(ROOT, gqlPath)}`);
  } else {
    await fs.writeFile(
      gqlPath,
      JSON.stringify({ types: [], note: 'GraphQL introspection skipped — endpoint unreachable' }, null, 2)
    );
    console.log(`${DIM}Saved${RESET} GraphQL placeholder → ${path.relative(ROOT, gqlPath)}`);
  }

  // Summary
  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Content types: ${Object.keys(models).length}`);
  for (const [ctName, model] of Object.entries(models)) {
    const attrs = Object.entries(model.attributes || {});
    const scalars = attrs.filter(([, d]) => d.type && !d.plugin && !d.collection && !d.model).length;
    const relations = attrs.filter(([, d]) => (d.collection || d.model) && !d.plugin).length;
    const media = attrs.filter(([, d]) => d.plugin === 'upload').length;
    const componentFields = attrs.filter(([, d]) => d.type === 'component').length;
    const dominantCount = attrs.filter(([, d]) => d.dominant === true).length;
    const parts = [
      `${scalars} scalar`,
      `${relations} relation${dominantCount > 0 ? ` (${dominantCount} dominant)` : ''}`,
      `${media} media`,
    ];
    if (componentFields > 0) parts.push(`${componentFields} component fields`);
    console.log(`  ${ctName.padEnd(16)} ${parts.join(', ')}`);
  }
  console.log(`  Components: ${Object.keys(components).length}`);

  console.log('');
  console.log('Next: 01b-generate-schemas (run via Phase 1 orchestrator)');
  console.log(`  ${CYAN}pnpm migrate:phase01${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
