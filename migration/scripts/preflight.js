/**
 * @module preflight
 * @description Pre-flight environment check for the migration tool.
 *
 * Verifies every prerequisite is in place before running any migration phase:
 *   - Node + pnpm versions
 *   - node_modules + native bindings (better-sqlite3)
 *   - Configuration loaded with required fields populated
 *   - Strapi 3 source data: SQLite snapshot, .settings.json files, components
 *   - Strapi 3 remote: GraphQL endpoint reachability + introspection
 *   - Strapi 5 local/remote: server reachable on configured URL (any port),
 *     authenticated request succeeds with the configured API token
 *   - Strapi 5 project path: exists, is actually a Strapi 5 install
 *   - Content-types manifest: exists, valid JSON, has expected shape
 *
 * Prints a clear PASS/FAIL/WARN table with actionable guidance for each failure.
 * Exits non-zero if any CRITICAL check fails (warnings don't block).
 *
 * @example
 *   pnpm preflight                       # Run all checks against current config
 *   pnpm preflight --skip-strapi5        # Skip Strapi 5 checks (useful before S5 is set up)
 *   pnpm preflight --json                # Emit JSON-only report (for CI)
 *   STRAPI5_API_URL=http://localhost:1339 pnpm preflight   # Custom port
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { loadConfig } from '../lib/load-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ANSI colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const PASS = `${GREEN}PASS${RESET}`;
const FAIL = `${RED}FAIL${RESET}`;
const WARN = `${YELLOW}WARN${RESET}`;
const SKIP = `${DIM}SKIP${RESET}`;

const argv = new Set(process.argv.slice(2));
const SKIP_STRAPI5 = argv.has('--skip-strapi5');
const JSON_OUTPUT = argv.has('--json');

// Expected source files (mirrored from manifest)
const EXPECTED_CONTENT_TYPES = [
  'biography', 'build', 'config', 'event', 'form', 'grant', 'home',
  'job', 'meeting', 'page', 'policy', 'post', 'program', 'publication',
  'regulation', 'required-form', 'rule', 'tag', 'unit',
];

const EXPECTED_COMPONENTS = [
  ['banner', 'banner'],
  ['button', 'button'],
  ['carousel', 'carousel'],
  ['clickthrough', 'clickthrough'],
  ['countdown', 'countdown'],
  ['event', 'add-event'],
  ['external', 'external-url'],
  ['menu-item', 'menu-item'],
  ['slide', 'slide'],
  ['slider-button', 'slider-button'],
];

const EXPECTED_SQLITE_TABLES = [
  'publications', 'meetings', 'jobs', 'forms', 'posts', 'biographies',
  'grants', 'programs', 'pages', 'tags', 'required_forms', 'units',
  'policies', 'rules', 'events', 'configs', 'regulations', 'homes',
  'upload_file',
];

const checks = [];

/**
 * Register a check result.
 */
function record(section, name, status, detail = '', guidance = '') {
  checks.push({ section, name, status, detail, guidance });
}

/**
 * Format and print a single check line.
 */
function printCheck({ name, status, detail }) {
  if (JSON_OUTPUT) return;
  const prefix = status === 'PASS' ? PASS : status === 'FAIL' ? FAIL : status === 'WARN' ? WARN : SKIP;
  const line = `  [${prefix}] ${name}${detail ? '  ' + DIM + detail + RESET : ''}`;
  console.log(line);
}

function printSection(title) {
  if (JSON_OUTPUT) return;
  console.log('');
  console.log(`${BOLD}── ${title} ──${RESET}`);
}

/**
 * Run a check function; record + print the result.
 */
async function check(section, name, fn) {
  try {
    const result = await fn();
    const status = result.status || 'PASS';
    record(section, name, status, result.detail || '', result.guidance || '');
    printCheck({ name, status, detail: result.detail });
    return result;
  } catch (err) {
    record(section, name, 'FAIL', err.message, err.guidance || '');
    printCheck({ name, status: 'FAIL', detail: err.message });
    return { status: 'FAIL', detail: err.message, guidance: err.guidance };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Environment checks
// ─────────────────────────────────────────────────────────────────────

async function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  let nvmrc = '';
  try {
    nvmrc = (await fs.readFile(path.join(ROOT, '.nvmrc'), 'utf8')).trim();
  } catch {}
  const required = parseInt(nvmrc || '22', 10);
  if (major < required) {
    return {
      status: 'FAIL',
      detail: `Node ${process.versions.node} (need >= ${required})`,
      guidance: `Install Node ${required}+ via nvm: \`nvm install ${required} && nvm use ${required}\``,
    };
  }
  return { detail: `Node ${process.versions.node}` };
}

async function checkPnpm() {
  try {
    const v = execSync('pnpm --version', { encoding: 'utf8' }).trim();
    const major = parseInt(v.split('.')[0], 10);
    if (major < 10) {
      return {
        status: 'WARN',
        detail: `pnpm ${v} (10+ recommended)`,
        guidance: `npm install -g pnpm@latest`,
      };
    }
    return { detail: `pnpm ${v}` };
  } catch {
    return {
      status: 'FAIL',
      detail: 'pnpm not found on PATH',
      guidance: `npm install -g pnpm`,
    };
  }
}

async function checkNodeModules() {
  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    return {
      status: 'FAIL',
      detail: 'node_modules/ missing',
      guidance: `Run: pnpm install`,
    };
  }
  try {
    await import('better-sqlite3');
    return { detail: 'node_modules + better-sqlite3 binding OK' };
  } catch (err) {
    return {
      status: 'FAIL',
      detail: `better-sqlite3 binding broken: ${err.message}`,
      guidance: `Rebuild native deps: pnpm rebuild better-sqlite3 (may need: xcode-select --install on macOS)`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Configuration checks
// ─────────────────────────────────────────────────────────────────────

let CONFIG = null;

async function checkConfigLoad() {
  try {
    CONFIG = await loadConfig();
    let source = 'config.js';
    if (!existsSync(path.join(ROOT, 'config.js'))) {
      source = process.env.MIGRATION_ENV
        ? `config.${process.env.MIGRATION_ENV}.js (via MIGRATION_ENV)`
        : 'config.example.js (fallback)';
    }
    return { detail: `loaded from ${source}` };
  } catch (err) {
    return {
      status: 'FAIL',
      detail: err.message,
      guidance: `cp config.dev.js config.js  # or: cp config.example.js config.js`,
    };
  }
}

async function checkConfigFields() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  const required = [
    'strapi3.graphqlUrl',
    'strapi3.apiUrl',
    'strapi5.apiUrl',
    'strapi3SourcePath',
    'paths.contentTypesManifest',
  ];
  const missing = [];
  for (const key of required) {
    const value = key.split('.').reduce((o, k) => (o ? o[k] : undefined), CONFIG);
    if (!value) missing.push(key);
  }
  if (missing.length > 0) {
    return {
      status: 'FAIL',
      detail: `missing: ${missing.join(', ')}`,
      guidance: `Edit config.js and populate the missing fields`,
    };
  }
  return { detail: `all ${required.length} required fields populated` };
}

async function checkManifest() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  const manifestPath = path.resolve(ROOT, CONFIG.paths.contentTypesManifest);
  if (!existsSync(manifestPath)) {
    return {
      status: 'FAIL',
      detail: `not found at ${path.relative(ROOT, manifestPath)}`,
      guidance: `Restore migration/config/content-types.json from git: git checkout ${path.relative(ROOT, manifestPath)}`,
    };
  }
  try {
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const ctCount = m.contentTypes?.filter((c) => !c.skipDefault).length || 0;
    const compCount = m.components?.length || 0;
    if (ctCount === 0) {
      return {
        status: 'FAIL',
        detail: 'manifest has no active content types',
        guidance: `Check that contentTypes[].skipDefault is false for at least one entry`,
      };
    }
    return { detail: `${ctCount} active content types, ${compCount} components` };
  } catch (err) {
    return {
      status: 'FAIL',
      detail: `invalid JSON: ${err.message}`,
      guidance: `Fix JSON syntax in ${path.relative(ROOT, manifestPath)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Source data checks
// ─────────────────────────────────────────────────────────────────────

async function checkSqliteSnapshot() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  const dbPath = path.resolve(ROOT, CONFIG.strapi3.sqliteDbPath);
  if (!existsSync(dbPath)) {
    return {
      status: 'FAIL',
      detail: `not found at ${path.relative(ROOT, dbPath)}`,
      guidance: `Drop the Strapi 3 data.db into ${path.relative(ROOT, dbPath)}\n     ` +
        `(it's gitignored — each developer needs to obtain it separately)`,
    };
  }
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r) => r.name);
    db.close();
    const missing = EXPECTED_SQLITE_TABLES.filter((t) => !tables.includes(t));
    if (missing.length > 0) {
      return {
        status: 'WARN',
        detail: `${tables.length} tables, missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`,
        guidance: `Source DB may be incomplete or from a different Strapi 3 instance`,
      };
    }
    return { detail: `${tables.length} tables found, all expected tables present` };
  } catch (err) {
    return {
      status: 'FAIL',
      detail: `cannot open: ${err.message}`,
      guidance: `Verify the file is a valid SQLite database: sqlite3 ${path.relative(ROOT, dbPath)} .tables`,
    };
  }
}

async function checkSettingsFiles() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  const sourceDir = path.resolve(ROOT, CONFIG.strapi3SourcePath);
  if (!existsSync(sourceDir)) {
    return {
      status: 'FAIL',
      detail: `${path.relative(ROOT, sourceDir)} not found`,
      guidance: `Place Strapi 3 source files at ${CONFIG.strapi3SourcePath}/{api,components,config}/`,
    };
  }
  const missing = [];
  for (const ct of EXPECTED_CONTENT_TYPES) {
    const p = path.join(sourceDir, 'api', ct, 'models', `${ct}.settings.json`);
    if (!existsSync(p)) missing.push(ct);
  }
  if (missing.length > 0) {
    return {
      status: 'FAIL',
      detail: `${missing.length} of ${EXPECTED_CONTENT_TYPES.length} types missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`,
      guidance: `Copy missing api/<type>/models/<type>.settings.json files to ${CONFIG.strapi3SourcePath}/api/`,
    };
  }
  return { detail: `${EXPECTED_CONTENT_TYPES.length}/${EXPECTED_CONTENT_TYPES.length} content type settings.json files present` };
}

async function checkComponentFiles() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  const sourceDir = path.resolve(ROOT, CONFIG.strapi3SourcePath, 'components');
  const missing = [];
  for (const [category, name] of EXPECTED_COMPONENTS) {
    const p = path.join(sourceDir, category, `${name}.json`);
    if (!existsSync(p)) missing.push(`${category}/${name}`);
  }
  if (missing.length > 0) {
    return {
      status: 'FAIL',
      detail: `${missing.length} of ${EXPECTED_COMPONENTS.length} components missing: ${missing.join(', ')}`,
      guidance: `Copy missing component .json files to ${CONFIG.strapi3SourcePath}/components/`,
    };
  }
  return { detail: `${EXPECTED_COMPONENTS.length}/${EXPECTED_COMPONENTS.length} components present` };
}

// ─────────────────────────────────────────────────────────────────────
// Strapi 3 GraphQL connectivity
// ─────────────────────────────────────────────────────────────────────

async function checkStrapi3Graphql() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  const url = CONFIG.strapi3.graphqlUrl;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return {
        status: 'FAIL',
        detail: `${url} → HTTP ${res.status}`,
        guidance: `Verify the URL or set STRAPI3_GRAPHQL_URL`,
      };
    }
    const json = await res.json();
    if (json.errors) {
      return {
        status: 'FAIL',
        detail: `GraphQL error: ${json.errors[0]?.message}`,
        guidance: `Check that the endpoint accepts introspection queries`,
      };
    }
    if (!json.data?.__schema?.queryType?.name) {
      return {
        status: 'FAIL',
        detail: 'introspection returned unexpected shape',
        guidance: `Verify ${url} is a Strapi 3 GraphQL endpoint`,
      };
    }
    return { detail: `${url} reachable, introspection OK` };
  } catch (err) {
    return {
      status: 'FAIL',
      detail: `${url} → ${err.message}`,
      guidance: `Check network connectivity. Set STRAPI3_GRAPHQL_URL or edit config.<env>.js`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Strapi 5 connectivity + auth
// ─────────────────────────────────────────────────────────────────────

async function checkStrapi5Reachable() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  if (SKIP_STRAPI5) return { status: 'SKIP', detail: 'skipped via --skip-strapi5' };
  const url = CONFIG.strapi5.apiUrl;
  try {
    const res = await fetch(`${url}/_health`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    // Strapi 5's /_health returns 204 when running. Some setups respond 200.
    if (res.status === 204 || res.status === 200) {
      return { detail: `${url} reachable (HTTP ${res.status})` };
    }
    // Fall back to root URL — admin panel
    const root = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    if (root.ok || root.status === 301 || root.status === 302) {
      return { status: 'WARN', detail: `${url} responds but /_health returned ${res.status}` };
    }
    return {
      status: 'FAIL',
      detail: `${url} → HTTP ${res.status}`,
      guidance: `Start Strapi 5: cd ${CONFIG.strapi5ProjectPath} && pnpm develop`,
    };
  } catch (err) {
    return {
      status: 'FAIL',
      detail: `${url} unreachable (${err.message})`,
      guidance: `Start Strapi 5: cd ${CONFIG.strapi5ProjectPath} && pnpm develop\n     ` +
        `Or set STRAPI5_API_URL to a different port (e.g., http://localhost:1339)`,
    };
  }
}

async function checkStrapi5Auth() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  if (SKIP_STRAPI5) return { status: 'SKIP', detail: 'skipped via --skip-strapi5' };
  const token = CONFIG.strapi5.token;
  if (!token) {
    return {
      status: 'FAIL',
      detail: 'STRAPI5_TOKEN is empty',
      guidance: `Generate a Full-Access token in Strapi 5 admin: Settings → API Tokens\n     ` +
        `Then: export STRAPI5_TOKEN="<token>"`,
    };
  }
  try {
    const res = await fetch(`${CONFIG.strapi5.apiUrl}/api/upload/files?pagination[pageSize]=1`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'FAIL',
        detail: `token rejected (HTTP ${res.status})`,
        guidance: `Token may be invalid or insufficient. Regenerate a Full-Access token in Strapi 5 admin.`,
      };
    }
    if (!res.ok) {
      return {
        status: 'WARN',
        detail: `unexpected HTTP ${res.status} from /api/upload/files`,
        guidance: `Token works but endpoint returned non-2xx. May be safe to proceed.`,
      };
    }
    return { detail: 'API token authenticated successfully' };
  } catch (err) {
    return {
      status: 'FAIL',
      detail: `auth check failed: ${err.message}`,
      guidance: `Check Strapi 5 connectivity and token`,
    };
  }
}

async function checkStrapi5Project() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  if (SKIP_STRAPI5) return { status: 'SKIP', detail: 'skipped via --skip-strapi5' };
  const projectPath = path.resolve(ROOT, CONFIG.strapi5ProjectPath);
  if (!existsSync(projectPath)) {
    return {
      status: 'WARN',
      detail: `${path.relative(ROOT, projectPath)} not found`,
      guidance: `Create a Strapi 5 install:\n     ` +
        `cd .. && npx create-strapi-app@latest icjia-public-strapi5 --quickstart --no-run\n     ` +
        `(Phase 1 needs this to copy generated schemas into src/api/)`,
    };
  }
  const pkgPath = path.join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      status: 'WARN',
      detail: `${path.relative(ROOT, projectPath)} has no package.json`,
      guidance: `Doesn't look like a Strapi 5 project. Verify STRAPI5_PROJECT_PATH.`,
    };
  }
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!deps['@strapi/strapi']) {
      return {
        status: 'WARN',
        detail: `package.json found but no @strapi/strapi dep`,
        guidance: `Verify ${path.relative(ROOT, projectPath)} is a Strapi 5 install`,
      };
    }
    const version = deps['@strapi/strapi'];
    return { detail: `Strapi 5 project found at ${path.relative(ROOT, projectPath)} (${version})` };
  } catch (err) {
    return {
      status: 'WARN',
      detail: `cannot parse package.json: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!JSON_OUTPUT) {
    console.log('');
    console.log(`${BOLD}ICJIA Public Website Migration — Preflight Check${RESET}`);
    console.log(DIM + 'Verifies your environment before any migration phase runs.' + RESET);
    console.log('');
  }

  printSection('Environment');
  await check('environment', 'Node version', checkNode);
  await check('environment', 'pnpm version', checkPnpm);
  await check('environment', 'node_modules + native bindings', checkNodeModules);

  printSection('Configuration');
  await check('config', 'Config file resolution', checkConfigLoad);
  await check('config', 'Required config fields populated', checkConfigFields);
  await check('config', 'Content-types manifest', checkManifest);

  printSection('Strapi 3 source data (in-repo snapshot)');
  await check('source', 'SQLite snapshot (data.db)', checkSqliteSnapshot);
  await check('source', 'Content-type .settings.json files', checkSettingsFiles);
  await check('source', 'Component .json files', checkComponentFiles);

  printSection('Strapi 3 remote (GraphQL endpoint)');
  await check('strapi3', 'GraphQL reachable + introspection', checkStrapi3Graphql);

  printSection(`Strapi 5 (${CONFIG?.strapi5?.apiUrl || 'not configured'})`);
  await check('strapi5', 'Server reachable', checkStrapi5Reachable);
  await check('strapi5', 'API token valid', checkStrapi5Auth);
  await check('strapi5', 'Strapi 5 project directory', checkStrapi5Project);

  // Summary
  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const warned = checks.filter((c) => c.status === 'WARN').length;
  const skipped = checks.filter((c) => c.status === 'SKIP').length;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      summary: { total: checks.length, passed, failed, warned, skipped },
      checks,
    }, null, 2));
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log('');
  console.log(`${BOLD}── Summary ──${RESET}`);
  console.log(`  ${GREEN}PASS:${RESET} ${passed}` +
    `  ${failed > 0 ? RED : DIM}FAIL:${RESET} ${failed}` +
    `  ${warned > 0 ? YELLOW : DIM}WARN:${RESET} ${warned}` +
    `  ${DIM}SKIP:${RESET} ${skipped}`);

  if (failed > 0) {
    console.log('');
    console.log(`${RED}${BOLD}Preflight FAILED.${RESET} Resolve the FAIL items below before running any migration phase.`);
    console.log('');
    for (const c of checks.filter((c) => c.status === 'FAIL')) {
      console.log(`${RED}✗${RESET} ${BOLD}${c.name}${RESET}`);
      console.log(`  ${c.detail}`);
      if (c.guidance) {
        console.log(`  ${CYAN}Fix:${RESET} ${c.guidance}`);
      }
      console.log('');
    }
    process.exit(1);
  }

  if (warned > 0) {
    console.log('');
    console.log(`${YELLOW}Warnings (non-blocking):${RESET}`);
    for (const c of checks.filter((c) => c.status === 'WARN')) {
      console.log(`${YELLOW}!${RESET} ${BOLD}${c.name}${RESET}: ${c.detail}`);
      if (c.guidance) {
        console.log(`  ${CYAN}Suggestion:${RESET} ${c.guidance}`);
      }
    }
  }

  console.log('');
  console.log(`${GREEN}${BOLD}All systems go.${RESET} Ready to migrate.`);
  console.log('');
  console.log('Next: Phase 1 (Schema Setup)');
  console.log(`  pnpm migrate:phase01`);
  console.log('');
  console.log(`Or run the full pipeline (phases 1–7):`);
  console.log(`  pnpm migrate:full`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
