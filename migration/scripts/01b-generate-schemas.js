/**
 * @module 01b-generate-schemas
 * @description Phase 1b: Generate Strapi 5 schemas from the normalized source.
 *
 * Reads:
 * - `migration/data/introspection/source-schema.json` (output of 01a)
 * - `migration/config/field-type-map.json` (static mapping rules)
 *
 * Generates:
 * - Content-type schemas + boilerplate at `migration/output/strapi5-schemas/<name>/`
 * - Component schemas at `migration/output/strapi5-components/<category>/<name>.json`
 * - Field map at `migration/config/field-map.json`
 * - Relation graph at `migration/data/relation-graph.json` (consumed by Phase 4)
 *
 * Auto-copies content-type and component schemas into the Strapi 5 project at
 * `<strapi5ProjectPath>/src/api/` and `<strapi5ProjectPath>/src/components/` if
 * the project directory exists. Otherwise prints copy instructions.
 *
 * @example
 *   pnpm generate
 *   # or: node migration/scripts/01b-generate-schemas.js
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { generateStrapi5Schemas } from '../lib/schema-generator.js';
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

async function readJson(absPath, errMsg) {
  try {
    return JSON.parse(await fs.readFile(absPath, 'utf8'));
  } catch (err) {
    console.error(`${RED}ERROR${RESET} ${errMsg}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Write the four files for one content type into the destination structure
 * Strapi 5 expects: schema.json + routes/<name>.js + controllers/<name>.js + services/<name>.js
 */
async function writeContentType(baseDir, ctName, { schema, boilerplate }) {
  // schema.json
  const schemaDir = path.join(baseDir, ctName, 'content-types', ctName);
  await fs.mkdir(schemaDir, { recursive: true });
  await fs.writeFile(path.join(schemaDir, 'schema.json'), JSON.stringify(schema, null, 2) + '\n');

  // routes/controllers/services
  for (const [folder, content] of [
    ['routes', boilerplate.route],
    ['controllers', boilerplate.controller],
    ['services', boilerplate.service],
  ]) {
    const dir = path.join(baseDir, ctName, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${ctName}.js`), content);
  }
}

async function writeComponent(componentsBaseDir, { category, name, schema }) {
  const dir = path.join(componentsBaseDir, category);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(schema, null, 2) + '\n');
}

/**
 * Recursively copy a directory tree (Node 22 has cp with recursive option).
 */
async function copyDir(srcDir, destDir) {
  await fs.cp(srcDir, destDir, { recursive: true, force: true });
}

async function main() {
  console.log(`${BOLD}── Phase 1b: Generate Strapi 5 schemas ──${RESET}\n`);

  // Inputs
  const sourceSchemaPath = path.resolve(ROOT, config.paths.introspection, 'source-schema.json');
  const fieldTypeMapPath = path.resolve(ROOT, config.paths.fieldTypeMap);

  if (!existsSync(sourceSchemaPath)) {
    console.error(`${RED}ERROR${RESET} ${path.relative(ROOT, sourceSchemaPath)} not found.`);
    console.error(`Run Phase 1a first: ${CYAN}pnpm introspect${RESET}`);
    process.exit(1);
  }

  const sourceSchema = await readJson(sourceSchemaPath, `cannot read ${sourceSchemaPath}`);
  const fieldTypeMap = await readJson(fieldTypeMapPath, `cannot read ${fieldTypeMapPath}`);

  const activeContentTypeCount = sourceSchema.contentTypes.filter((e) => e.model).length;
  const componentCount = sourceSchema.components.filter((e) => e.model).length;

  console.log(`Loaded normalized schema: ${activeContentTypeCount} content types, ${componentCount} components`);
  console.log(
    `Field type map: ${Object.keys(fieldTypeMap.directMappings).length} direct mappings, ` +
    `${Object.keys(fieldTypeMap.overrides || {}).filter((k) => k !== '_comment').length} overrides, ` +
    `${Object.keys(fieldTypeMap.incompleteRelations || {}).filter((k) => k !== '_comment').length} incomplete-relation fixes`
  );
  console.log('');

  // Generate
  const result = generateStrapi5Schemas(sourceSchema, fieldTypeMap);

  // Output directories (in the migration repo's working area)
  const outputBase = path.resolve(ROOT, config.paths.output);
  const contentTypesOut = path.join(outputBase, 'content-types');
  const componentsOut = path.join(outputBase, 'components');

  // Clean prior output to avoid stale files
  if (existsSync(outputBase)) {
    await fs.rm(outputBase, { recursive: true, force: true });
  }
  await fs.mkdir(contentTypesOut, { recursive: true });
  await fs.mkdir(componentsOut, { recursive: true });

  // Write content types
  console.log(`${BOLD}Writing content-type schemas:${RESET}`);
  let totalFields = 0;
  let totalOverrides = 0;
  let totalIncompleteFixed = 0;
  for (const [ctName, ct] of Object.entries(result.contentTypes)) {
    await writeContentType(contentTypesOut, ctName, ct);
    const fieldCount = Object.keys(ct.schema.attributes).length;
    totalFields += fieldCount;
    const overridden = Object.values(ct.fieldMap).filter((f) => f.overridden).length;
    const fixed = Object.values(ct.fieldMap).filter((f) => f.incompleteRelationFixed).length;
    totalOverrides += overridden;
    totalIncompleteFixed += fixed;
    const kind = ct.schema.kind === 'singleType' ? `${YELLOW}single${RESET}` : `${DIM}collection${RESET}`;
    const flags = [];
    if (overridden > 0) flags.push(`${overridden} overrides`);
    if (fixed > 0) flags.push(`${fixed} relation fixes`);
    const flagStr = flags.length > 0 ? ` ${DIM}[${flags.join(', ')}]${RESET}` : '';
    console.log(`  ${ctName.padEnd(16)} ${kind.padEnd(20)} ${fieldCount} fields${flagStr}`);
  }
  console.log('');

  // Write components
  console.log(`${BOLD}Writing component schemas:${RESET}`);
  for (const [key, comp] of Object.entries(result.components)) {
    await writeComponent(componentsOut, comp);
    const fieldCount = Object.keys(comp.schema.attributes).length;
    console.log(`  ${key.padEnd(28)} ${fieldCount} fields`);
  }
  console.log('');

  // Field map
  const fieldMapPath = path.resolve(ROOT, config.paths.fieldMap);
  await fs.mkdir(path.dirname(fieldMapPath), { recursive: true });
  const fieldMapData = {};
  for (const [ctName, ct] of Object.entries(result.contentTypes)) {
    fieldMapData[ctName] = ct.fieldMap;
  }
  await fs.writeFile(fieldMapPath, JSON.stringify(fieldMapData, null, 2) + '\n');

  // Relation graph (consumed by Phase 4)
  const relationGraphPath = path.resolve(ROOT, config.paths.relationGraph);
  await fs.mkdir(path.dirname(relationGraphPath), { recursive: true });
  await fs.writeFile(relationGraphPath, JSON.stringify(result.relationGraph, null, 2) + '\n');

  console.log(`${GREEN}Saved${RESET} field map → ${path.relative(ROOT, fieldMapPath)}`);
  console.log(`${GREEN}Saved${RESET} relation graph → ${path.relative(ROOT, relationGraphPath)}`);
  console.log('');

  // Auto-copy into the Strapi 5 project if the directory exists
  const s5ProjectPath = path.resolve(ROOT, config.strapi5ProjectPath);
  const s5ApiDir = path.join(s5ProjectPath, 'src', 'api');
  const s5ComponentsDir = path.join(s5ProjectPath, 'src', 'components');

  if (existsSync(s5ProjectPath)) {
    console.log(`${BOLD}Copying schemas to Strapi 5 project:${RESET}`);
    console.log(`  ${DIM}target:${RESET} ${path.relative(ROOT, s5ProjectPath)}`);
    await copyDir(contentTypesOut, s5ApiDir);
    console.log(`  ${GREEN}✓${RESET} src/api/ ← ${Object.keys(result.contentTypes).length} content types`);
    await copyDir(componentsOut, s5ComponentsDir);
    console.log(`  ${GREEN}✓${RESET} src/components/ ← ${Object.keys(result.components).length} components`);
    console.log('');
    console.log(`${YELLOW}!${RESET} Restart Strapi 5 so it picks up the new schemas:`);
    console.log(`    ${DIM}cd ${path.relative(ROOT, s5ProjectPath)} && pnpm develop${RESET}`);
    console.log('');
  } else {
    console.log(`${YELLOW}!${RESET} Strapi 5 project not found at ${path.relative(ROOT, s5ProjectPath)} — skipping auto-copy.`);
    console.log(`  Manual copy:`);
    console.log(`    ${DIM}cp -r ${path.relative(ROOT, contentTypesOut)}/* <strapi5-project>/src/api/${RESET}`);
    console.log(`    ${DIM}cp -r ${path.relative(ROOT, componentsOut)}/* <strapi5-project>/src/components/${RESET}`);
    console.log('');
  }

  // Summary
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  Content types generated: ${Object.keys(result.contentTypes).length} (${activeContentTypeCount} active)`);
  console.log(`  Components generated:    ${Object.keys(result.components).length}`);
  console.log(`  Total fields:            ${totalFields}`);
  console.log(`  Overrides applied:       ${totalOverrides}`);
  console.log(`  Incomplete relation fixes: ${totalIncompleteFixed}`);
  console.log(`  Relation graph edges:    ${result.relationGraph.length} ` +
    `(${result.relationGraph.filter((r) => r.dominant).length} dominant, ` +
    `${result.relationGraph.filter((r) => !r.dominant).length} inverse)`);
  console.log('');

  console.log('Next: 01c-verify-schemas (after restarting Strapi 5)');
  console.log(`  ${CYAN}pnpm migrate:phase01${RESET}  ${DIM}(runs all of 1a + 1b + 1c)${RESET}`);
  console.log(`  ${CYAN}pnpm verify${RESET}            ${DIM}(just 1c, against running Strapi 5)${RESET}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
