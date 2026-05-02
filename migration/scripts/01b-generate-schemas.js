/**
 * @module 01b-generate-schemas
 * @description Phase 1b: Generate Strapi 5 Schemas
 *
 * Reads Strapi 3 model data (produced by 01a) and the field type mapping config,
 * then generates complete Strapi 5 schema.json files and boilerplate for all
 * three content types (article, dataset, app).
 *
 * Steps:
 * 1. Read `data/introspection/strapi3-models.json` (output of 01a)
 * 2. Read `config/field-type-map.json` (static mapping rules)
 * 3. Call `generateStrapi5Schemas()` from lib/schema-generator.js
 * 4. Write schema.json + route/controller/service to `output/strapi5-schemas/`
 * 5. Write field mapping details to `config/field-map.json`
 *
 * After running, copy the output to a Strapi 5 project:
 *   cp -r output/strapi5-schemas/* /path/to/strapi5-project/src/api/
 *
 * @example
 *   node migration/scripts/01b-generate-schemas.js
 *
 * Prerequisites:
 * - Phase 1a complete (`data/introspection/strapi3-models.json` exists)
 * - `config/field-type-map.json` exists
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateStrapi5Schemas } from '../lib/schema-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

/** ANSI color codes for terminal output */
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
const config = await loadConfig();

async function main() {
  console.log('=== Phase 1b: Generate Strapi 5 Schemas ===\n');

  // Read inputs
  const modelsPath = path.resolve(ROOT, config.paths.introspection, 'strapi3-models.json');
  const fieldTypeMapPath = path.resolve(ROOT, config.paths.fieldTypeMap);

  let models, fieldTypeMap;

  try {
    models = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read ${modelsPath}${RESET}`);
    console.error(`${RED}Run 'node scripts/01a-introspect.js' first.${RESET}`);
    process.exit(1);
  }

  try {
    fieldTypeMap = JSON.parse(await fs.readFile(fieldTypeMapPath, 'utf8'));
  } catch (err) {
    console.error(`${RED}ERROR: Cannot read ${fieldTypeMapPath}${RESET}`);
    process.exit(1);
  }

  console.log(`Loaded ${Object.keys(models).length} Strapi 3 models: ${Object.keys(models).join(', ')}`);
  console.log(`Loaded field type map: ${Object.keys(fieldTypeMap.directMappings).length} direct, ${Object.keys(fieldTypeMap.overrides).length} overrides\n`);

  // Generate schemas
  const result = generateStrapi5Schemas(models, fieldTypeMap);

  // Write output files
  const outputBase = path.resolve(ROOT, config.paths.output);
  let totalFields = 0;
  let totalOverrides = 0;

  for (const [ctName, { schema, boilerplate, fieldMap }] of Object.entries(result)) {
    const fieldCount = Object.keys(schema.attributes).length;
    totalFields += fieldCount;

    const overrideCount = Object.values(fieldMap).filter(f => f.overridden).length;
    totalOverrides += overrideCount;

    // schema.json
    const schemaDir = path.join(outputBase, ctName, 'content-types', ctName);
    await fs.mkdir(schemaDir, { recursive: true });
    await fs.writeFile(
      path.join(schemaDir, 'schema.json'),
      JSON.stringify(schema, null, 2) + '\n'
    );

    // Route
    const routesDir = path.join(outputBase, ctName, 'routes');
    await fs.mkdir(routesDir, { recursive: true });
    await fs.writeFile(path.join(routesDir, `${ctName}.js`), boilerplate.route);

    // Controller
    const controllersDir = path.join(outputBase, ctName, 'controllers');
    await fs.mkdir(controllersDir, { recursive: true });
    await fs.writeFile(path.join(controllersDir, `${ctName}.js`), boilerplate.controller);

    // Service
    const servicesDir = path.join(outputBase, ctName, 'services');
    await fs.mkdir(servicesDir, { recursive: true });
    await fs.writeFile(path.join(servicesDir, `${ctName}.js`), boilerplate.service);

    console.log(`  ${ctName}: ${fieldCount} fields (${overrideCount} overrides) → ${path.relative(ROOT, schemaDir)}/schema.json`);
  }

  // Write field map
  const fieldMapDir = path.dirname(path.resolve(ROOT, config.paths.fieldMap));
  await fs.mkdir(fieldMapDir, { recursive: true });
  const fieldMapData = {};
  for (const [ctName, { fieldMap }] of Object.entries(result)) {
    fieldMapData[ctName] = fieldMap;
  }
  await fs.writeFile(
    path.resolve(ROOT, config.paths.fieldMap),
    JSON.stringify(fieldMapData, null, 2) + '\n'
  );

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Content types generated: ${Object.keys(result).length}`);
  console.log(`Total fields: ${totalFields}`);
  console.log(`Overrides applied: ${totalOverrides}`);
  console.log(`Output directory: ${path.relative(ROOT, outputBase)}/`);
  console.log(`Field map: ${config.paths.fieldMap}`);

  console.log('\n--- Next steps ---');
  console.log(`1. Review the generated schemas in ${path.relative(ROOT, outputBase)}/`);
  console.log('2. Copy to your Strapi 5 project:');
  console.log(`   cp -r ${path.relative(ROOT, outputBase)}/* /path/to/strapi5-project/src/api/`);
  console.log('3. Start Strapi 5 in dev mode:');
  console.log('   cd /path/to/strapi5-project && pnpm develop');
  console.log('4. Run verification:');
  console.log('   node migration/scripts/01c-verify-schemas.js');
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
