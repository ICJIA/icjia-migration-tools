/**
 * @module 01-run-phase
 * @description Phase 1 orchestrator: runs all Phase 1 scripts in sequence.
 *
 * Executes 01a → 01b → auto-copy schemas → detect Strapi 5 → 01c.
 * Automates the schema copy step and detects if Strapi 5 is already running.
 * If a step fails, explains exactly what went wrong and how to resume.
 *
 * @example
 *   pnpm migrate:phase01
 *   # or: node migration/scripts/01-run-phase.js
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const config = await loadConfig();

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Run a Node.js script as a child process, streaming output to the console.
 * @param {string} scriptPath - Path relative to project root
 * @returns {Promise<number>} Exit code (0 = success)
 */
function runScript(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`${RED}Failed to start ${scriptPath}: ${err.message}${RESET}`);
      resolve(1);
    });
  });
}

/**
 * Prompt yes/no with default Y.
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const t = answer.trim().toLowerCase();
      resolve(t === '' || t === 'y' || t === 'yes');
    });
  });
}

/**
 * Wait for enter.
 * @param {string} message
 * @returns {Promise<void>}
 */
function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/**
 * Check if Strapi 5 is reachable at its configured URL.
 * @returns {Promise<boolean>}
 */
async function isStrapi5Running() {
  try {
    const res = await fetch(config.strapi5.apiUrl, { signal: AbortSignal.timeout(5000) });
    return res.ok || res.status === 403 || res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Copy generated schemas to the Strapi 5 project directory.
 * @returns {Promise<boolean>} True if copy succeeded
 */
async function copySchemas() {
  const outputDir = path.resolve(ROOT, config.paths.output);
  const strapi5Api = path.resolve(ROOT, config.strapi5ProjectPath, 'src/api');

  // Check source exists
  try {
    await fs.access(outputDir);
  } catch {
    console.error(`${RED}ERROR: Generated schemas not found at ${outputDir}${RESET}`);
    console.error(`${RED}Run 01b-generate-schemas.js first.${RESET}`);
    return false;
  }

  // Check destination exists
  try {
    await fs.access(strapi5Api);
  } catch {
    console.error(`${RED}ERROR: Strapi 5 project not found at ${path.resolve(ROOT, config.strapi5ProjectPath)}${RESET}`);
    console.error(`${RED}Set strapi5ProjectPath in config.js or config.dev.js${RESET}`);
    return false;
  }

  // Copy each content type directory
  const entries = await fs.readdir(outputDir);
  for (const entry of entries) {
    const src = path.join(outputDir, entry);
    const dest = path.join(strapi5Api, entry);
    await fs.cp(src, dest, { recursive: true });
    console.log(`  ${GREEN}✓${RESET} Copied ${entry}/ → ${path.relative(ROOT, dest)}/`);
  }

  return true;
}

/**
 * Print failure with recovery instructions.
 * @param {string} stepName
 * @param {string} scriptPath
 * @param {number} exitCode
 * @param {string} [hint]
 */
function printFailure(stepName, scriptPath, exitCode, hint) {
  console.log('');
  console.log(`${RED}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${RED}║  ${stepName} failed (exit code ${exitCode})${' '.repeat(Math.max(0, 38 - stepName.length - String(exitCode).length))}║${RESET}`);
  console.log(`${RED}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log(`${YELLOW}You do NOT need to start Phase 1 over from the beginning.${RESET}`);
  console.log(`${YELLOW}Fix the issue above, then resume by running:${RESET}`);
  console.log(`  ${CYAN}node ${scriptPath}${RESET}`);
  if (hint) console.log(`\n${YELLOW}Hint: ${hint}${RESET}`);
  console.log('');
}

async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║        Phase 1: Introspection & Schema Generation       ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('This will run all Phase 1 steps in sequence:');
  console.log(`  ${CYAN}Step 1:${RESET} Introspect Strapi 3 schemas (01a)`);
  console.log(`  ${CYAN}Step 2:${RESET} Generate Strapi 5 schema files (01b)`);
  console.log(`  ${CYAN}Step 3:${RESET} Copy schemas to Strapi 5 project (auto)`);
  console.log(`  ${CYAN}Step 4:${RESET} Verify schemas against running Strapi 5 (01c)`);
  console.log('');
  console.log(`Strapi 5 project: ${CYAN}${path.resolve(ROOT, config.strapi5ProjectPath)}${RESET}`);
  console.log('');

  // ── Step 1: Introspect ──────────────────────────────────────────────
  console.log(`${BOLD}── Step 1/4: Introspect Strapi 3 ──${RESET}\n`);

  const code1 = await runScript('migration/scripts/01a-introspect.js');
  if (code1 !== 0) {
    printFailure('Step 1 (Introspect)', 'migration/scripts/01a-introspect.js', code1,
      'Check that schemas/ directory contains the Strapi 3 model files.');
    process.exit(1);
  }

  console.log(`\n${GREEN}✓ Step 1 complete.${RESET}\n`);

  // ── Step 2: Generate ────────────────────────────────────────────────
  const continue2 = await promptYesNo(
    `${CYAN}Step 2/4: Generate Strapi 5 schemas.${RESET}\n` +
    'This reads the introspection data and generates schema.json files.\n' +
    'Continue? [Y/n] '
  );
  if (!continue2) {
    console.log(`\nPaused. Resume later with: ${CYAN}node migration/scripts/01b-generate-schemas.js${RESET}`);
    process.exit(0);
  }

  console.log(`\n${BOLD}── Step 2/4: Generate Strapi 5 Schemas ──${RESET}\n`);

  const code2 = await runScript('migration/scripts/01b-generate-schemas.js');
  if (code2 !== 0) {
    printFailure('Step 2 (Generate)', 'migration/scripts/01b-generate-schemas.js', code2,
      'Check the error above. Common causes: missing strapi3-models.json (run 01a first).');
    process.exit(1);
  }

  console.log(`\n${GREEN}✓ Step 2 complete.${RESET}\n`);

  // ── Step 3: Auto-copy schemas ───────────────────────────────────────
  console.log(`${BOLD}── Step 3/4: Copy schemas to Strapi 5 ──${RESET}\n`);

  const copied = await copySchemas();
  if (!copied) {
    console.log('');
    console.log(`${YELLOW}Auto-copy failed. You can copy manually:${RESET}`);
    console.log(`  ${CYAN}cp -r migration/output/strapi5-schemas/* /path/to/strapi5-project/src/api/${RESET}`);
    console.log('');
    await waitForEnter(`${YELLOW}Press Enter when schemas are copied and Strapi 5 is running...${RESET} `);
  } else {
    console.log(`\n${GREEN}✓ Schemas copied to Strapi 5 project.${RESET}\n`);

    // Check if Strapi 5 is already running
    const running = await isStrapi5Running();
    if (running) {
      console.log(`${GREEN}✓ Strapi 5 is already running at ${config.strapi5.apiUrl}${RESET}`);
      console.log(`${YELLOW}NOTE: You need to restart Strapi 5 to pick up the new schemas.${RESET}`);
      console.log(`  ${CYAN}cd ${path.resolve(ROOT, config.strapi5ProjectPath)} && npm run develop${RESET}`);
      console.log('');
      await waitForEnter(`${YELLOW}Press Enter after restarting Strapi 5...${RESET} `);
    } else {
      console.log(`Strapi 5 is not running. Start it now:`);
      console.log(`  ${CYAN}cd ${path.resolve(ROOT, config.strapi5ProjectPath)} && npm run develop${RESET}`);
      console.log('');

      // Check if GraphQL plugin is installed
      try {
        await fs.access(path.resolve(ROOT, config.strapi5ProjectPath, 'node_modules/@strapi/plugin-graphql'));
      } catch {
        console.log(`${YELLOW}NOTE: @strapi/plugin-graphql may not be installed. Install it:${RESET}`);
        console.log(`  ${CYAN}cd ${path.resolve(ROOT, config.strapi5ProjectPath)} && npm install @strapi/plugin-graphql${RESET}`);
        console.log('');
      }

      await waitForEnter(`${YELLOW}Press Enter when Strapi 5 is running (look for "Welcome back!")...${RESET} `);
    }
  }

  console.log('');

  // ── Step 4: Verify ──────────────────────────────────────────────────
  const continue4 = await promptYesNo(
    `${CYAN}Step 4/4: Verify schemas against Strapi 5.${RESET}\n` +
    'This introspects Strapi 5 via GraphQL, checks the REST API, and diffs\n' +
    'against Strapi 3 to confirm all content types and fields are correct.\n' +
    'Continue? [Y/n] '
  );
  if (!continue4) {
    console.log(`\nPaused. Resume later with: ${CYAN}node migration/scripts/01c-verify-schemas.js${RESET}`);
    process.exit(0);
  }

  console.log(`\n${BOLD}── Step 4/4: Verify Strapi 5 Schemas ──${RESET}\n`);

  const code4 = await runScript('migration/scripts/01c-verify-schemas.js');
  if (code4 !== 0) {
    printFailure('Step 4 (Verify)', 'migration/scripts/01c-verify-schemas.js', code4,
      'Common causes:\n' +
      '  - Strapi 5 is not running → npm run develop\n' +
      '  - @strapi/plugin-graphql not installed → npm install @strapi/plugin-graphql\n' +
      '  - Schemas not copied → check Step 3 output above\n' +
      '  - Unexpected schema differences → review migration/data/introspection/schema-diff.json');
    process.exit(1);
  }

  // ── Success ─────────────────────────────────────────────────────────
  console.log('');
  console.log(`${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}║         Phase 1 Complete — All steps passed ✓           ║${RESET}`);
  console.log(`${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
  console.log('Deliverables:');
  console.log(`  ${GREEN}✓${RESET} Strapi 3 introspection data     → migration/data/introspection/`);
  console.log(`  ${GREEN}✓${RESET} Strapi 5 schema.json files      → migration/output/strapi5-schemas/`);
  console.log(`  ${GREEN}✓${RESET} Schemas copied to Strapi 5      → ${path.resolve(ROOT, config.strapi5ProjectPath)}/src/api/`);
  console.log(`  ${GREEN}✓${RESET} Field mapping reference          → migration/config/field-map.json`);
  console.log(`  ${GREEN}✓${RESET} Schema diff report               → migration/data/introspection/schema-diff.json`);
  console.log('');
  console.log('Next: Phase 2 (Data Extraction)');
  console.log(`  ${CYAN}pnpm migrate:phase02${RESET}`);
  console.log('');
}

main().catch(err => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
