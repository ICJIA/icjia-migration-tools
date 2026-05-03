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
const SKIP_CHECKLIST = argv.has('--skip-checklist') || argv.has('--no-checklist');
const JSON_OUTPUT = argv.has('--json');

// Manifest-derived expectations (populated by loadManifest())
let EXPECTED_CONTENT_TYPES = [];
let EXPECTED_COMPONENTS = [];
let EXPECTED_SQLITE_TABLES = [];

async function loadManifest() {
  // Try to read the manifest at the canonical path before config is loaded
  const manifestPath = path.resolve(ROOT, 'migration/config/content-types.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    EXPECTED_CONTENT_TYPES = (m.contentTypes || []).map((c) => c.name);
    EXPECTED_COMPONENTS = (m.components || []).map((c) => [c.category, c.name]);
    const tables = new Set();
    for (const c of m.contentTypes || []) {
      if (c.sqlTable) tables.add(c.sqlTable);
    }
    tables.add('upload_file');
    EXPECTED_SQLITE_TABLES = [...tables];
    return m;
  } catch {
    return null;
  }
}

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
    // Query a Strapi-specific type (Tag is small, present, public).
    // Generic introspection would pass on any GraphQL server — querying a
    // known content type confirms it's actually the ICJIA Strapi 3 endpoint.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ tagsConnection { aggregate { count } } }',
      }),
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
        guidance: `Endpoint reachable but doesn't expose a 'tags' query — check that ${url} is the ICJIA Strapi 3 endpoint`,
      };
    }
    const count = json.data?.tagsConnection?.aggregate?.count;
    if (typeof count !== 'number') {
      return {
        status: 'FAIL',
        detail: 'unexpected response shape',
        guidance: `Verify ${url} is a Strapi 3 GraphQL endpoint with public Tag access`,
      };
    }
    return { detail: `${url} reachable, ${count} tags visible` };
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
    // Configured URL didn't respond. Before giving up, probe the port from
    // Strapi 5's .env — if Strapi is running THERE, the user just has a
    // port mismatch in config.js, and we can tell them exactly what to fix.
    const envProbe = await probeStrapi5OnEnvPort(url);
    if (envProbe?.actualPort && envProbe.actualPort !== envProbe.configPort) {
      return {
        status: 'FAIL',
        detail: `Strapi 5 is running on :${envProbe.actualPort} but config.js points to :${envProbe.configPort}`,
        guidance: `Fix the port mismatch:\n     ` +
          `(a) Edit config.js → strapi5.apiUrl + graphqlUrl to use port ${envProbe.actualPort}, OR\n     ` +
          `(b) Edit ${CONFIG.strapi5ProjectPath}/.env → PORT=${envProbe.configPort} and restart Strapi 5\n     ` +
          `(install-strapi5.sh syncs both automatically.)`,
      };
    }
    return {
      status: 'FAIL',
      detail: `${url} unreachable (${err.message})`,
      guidance: `Start Strapi 5: cd ${CONFIG.strapi5ProjectPath} && pnpm develop\n     ` +
        `Or check that nothing else is occupying that port.`,
    };
  }
}

// Probe Strapi 5's .env to find the port it WANTS to run on, then HEAD
// /_health on that port to see if a Strapi is actually there. Used by
// checkStrapi5Reachable's failure path to give a specific port-mismatch
// error rather than a generic "unreachable".
async function probeStrapi5OnEnvPort(configUrl) {
  try {
    const projectPath = path.resolve(ROOT, CONFIG.strapi5ProjectPath);
    const envPath = path.join(projectPath, '.env');
    if (!existsSync(envPath)) return null;

    const envContent = await fs.readFile(envPath, 'utf8');
    const m = envContent.match(/^\s*PORT\s*=\s*(\d+)/m);
    const envPort = m ? m[1] : '1337';

    const u = new URL(configUrl);
    const configPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (envPort === configPort) return null; // not a mismatch — original error stands

    // Try the .env port
    const probeUrl = `${u.protocol}//${u.hostname}:${envPort}/_health`;
    try {
      const res = await fetch(probeUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      if (res.status === 204 || res.status === 200) {
        return { actualPort: envPort, configPort };
      }
    } catch { /* not running on .env port either */ }
    return null;
  } catch {
    return null;
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
  // Use /api/upload/files since the upload plugin is core in Strapi 5 and
  // returns a deterministic shape. If it 404s (plugin disabled), fall back
  // to /api/users/me which is universally available with Full-Access tokens.
  const apiUrl = CONFIG.strapi5.apiUrl;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    let res = await fetch(`${apiUrl}/api/upload/files?pagination[pageSize]=1`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    // 404 likely means upload plugin is disabled — try a more universal endpoint
    if (res.status === 404) {
      res = await fetch(`${apiUrl}/api/users/me`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
    }

    if (res.status === 401 || res.status === 403) {
      return {
        status: 'FAIL',
        detail: `token rejected (HTTP ${res.status})`,
        guidance: `Token may be invalid or have insufficient permissions.\n     ` +
          `Regenerate a Full-Access token in Strapi 5 admin: Settings → API Tokens`,
      };
    }
    if (!res.ok) {
      return {
        status: 'WARN',
        detail: `auth probe returned HTTP ${res.status}`,
        guidance: `Token may work but probe endpoint isn't reachable. Migration phases may still succeed; watch for 401/403 in Phase 4.`,
      };
    }

    // Read access confirmed — now verify WRITE access. A Read-only token
    // would have passed the GET above but causes HTTP 405 "Method Not
    // Allowed" on POST during Phase 4, often after several minutes of work.
    // POST to /api/upload with no body returns 400 "Files are empty" if the
    // token has write permission (Strapi reached the upload handler), and
    // 405 if the token only has read permission.
    let writeRes;
    try {
      writeRes = await fetch(`${apiUrl}/api/upload`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      return {
        status: 'WARN',
        detail: `read OK; write probe network error: ${err.message}`,
        guidance: `Read works. Write may still succeed in Phase 4 — watch for 405.`,
      };
    }
    if (writeRes.status === 405) {
      return {
        status: 'FAIL',
        detail: `token is READ-ONLY (write probe returned HTTP 405)`,
        guidance: `Strapi 5 admin → Settings → Global Settings → API Tokens\n     ` +
          `Delete the existing token and create a new one with ${BOLD}Token type: Full access${RESET}.\n     ` +
          `Then re-run: pnpm set-token`,
      };
    }
    if (writeRes.status === 401 || writeRes.status === 403) {
      return {
        status: 'FAIL',
        detail: `write probe rejected (HTTP ${writeRes.status})`,
        guidance: `Token authenticates but lacks write permission. Recreate as Full Access.`,
      };
    }
    // 400 "Files are empty" is the expected success response (Strapi reached
    // the upload handler with no file in the body). Anything in 200-499
    // range that isn't an auth error means write access works.
    return { detail: 'API token has read + write access (Full Access)' };
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

async function checkStrapi5PortMatches() {
  if (!CONFIG) return { status: 'SKIP', detail: 'config not loaded' };
  if (SKIP_STRAPI5) return { status: 'SKIP', detail: 'skipped via --skip-strapi5' };

  // Extract the configured port from config.strapi5.apiUrl (e.g.,
  // http://localhost:1340 → 1340). If it's HTTPS / non-localhost we skip
  // — prod typically goes through nginx on 443, no .env port to match.
  let configPort = null;
  try {
    const u = new URL(CONFIG.strapi5.apiUrl);
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      return { status: 'SKIP', detail: 'remote Strapi 5 (no .env to compare)' };
    }
    configPort = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return { status: 'WARN', detail: `cannot parse strapi5.apiUrl: ${CONFIG.strapi5.apiUrl}` };
  }

  const projectPath = path.resolve(ROOT, CONFIG.strapi5ProjectPath);
  const envPath = path.join(projectPath, '.env');
  if (!existsSync(envPath)) {
    return { status: 'SKIP', detail: '.env not found in Strapi 5 project' };
  }

  let envPort = null;
  try {
    const content = await fs.readFile(envPath, 'utf8');
    const m = content.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (!m) {
      // No explicit PORT — Strapi 5 default is 1337. Compare to that.
      envPort = '1337';
    } else {
      envPort = m[1];
    }
  } catch (err) {
    return { status: 'WARN', detail: `cannot read .env: ${err.message}` };
  }

  if (envPort !== configPort) {
    return {
      status: 'FAIL',
      detail: `port mismatch — config.js says :${configPort}, Strapi 5 .env says :${envPort}`,
      guidance: `Either:\n     ` +
        `(a) Edit config.js → strapi5.apiUrl + graphqlUrl to use port ${envPort}, OR\n     ` +
        `(b) Edit ${path.relative(ROOT, envPath)} → PORT=${configPort} and restart Strapi 5\n     ` +
        `(install-strapi5.sh syncs both automatically — re-running it with --keep-migration-data is the safe option.)`,
    };
  }

  return { detail: `config.js and Strapi 5 .env both use port :${envPort}` };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

function printChecklist() {
  if (JSON_OUTPUT || SKIP_CHECKLIST) return;

  // Pull current Strapi 5 URL so the checklist reflects the actual configured port
  const s5Url = process.env.STRAPI5_API_URL || 'http://localhost:1338';
  const tokenSet = !!process.env.STRAPI5_TOKEN;

  const box = (s) => `${CYAN}│${RESET} ${s}`;
  const bar = `${CYAN}├──────────────────────────────────────────────────────────────────${RESET}`;
  const top = `${CYAN}┌──────────────────────────────────────────────────────────────────${RESET}`;
  const bot = `${CYAN}└──────────────────────────────────────────────────────────────────${RESET}`;

  console.log('');
  console.log(top);
  console.log(box(`${BOLD}Before you start — make sure you have:${RESET}`));
  console.log(bar);
  console.log(box(''));
  console.log(box(`  ${BOLD}1. Strapi 5 instance running${RESET}`));
  console.log(box(`     Configured URL: ${CYAN}${s5Url}${RESET}`));
  console.log(box(`     Override port via env: ${DIM}STRAPI5_API_URL=http://localhost:1339${RESET}`));
  console.log(box(`     ${BOLD}First-time install (JavaScript, not TypeScript):${RESET}`));
  console.log(box(`       ${DIM}cd /Volumes/satechi/webdev${RESET}`));
  console.log(box(`       ${DIM}npx create-strapi-app@latest icjia-public-strapi5 \\${RESET}`));
  console.log(box(`         ${DIM}--quickstart --no-run --skip-cloud --skip-db --javascript${RESET}`));
  console.log(box(`       ${DIM}cd icjia-public-strapi5${RESET}`));
  console.log(box(`       ${DIM}echo "PORT=1340" >> .env${RESET}`));
  console.log(box(`       ${DIM}pnpm add @strapi/plugin-graphql${RESET}      ${DIM}# required for Phase 1c verify${RESET}`));
  console.log(box(`       ${DIM}pnpm rebuild better-sqlite3 sharp${RESET}    ${YELLOW}# REQUIRED — pnpm blocks native scripts${RESET}`));
  console.log(box(`       ${DIM}pnpm develop${RESET}                          ${DIM}# launch${RESET}`));
  console.log(box(`     To restart later: ${DIM}cd ../icjia-public-strapi5 && pnpm develop${RESET}`));
  console.log(box(''));
  console.log(box(`  ${BOLD}2. Strapi 5 admin user created${RESET}`));
  console.log(box(`     Visit ${CYAN}${s5Url}/admin${RESET} — first-launch flow creates one`));
  console.log(box(''));
  console.log(box(`  ${BOLD}3. Strapi 5 API token (${BOLD}Full access${RESET}, not Read-only)${RESET}`));
  console.log(box(`     ${tokenSet ? GREEN + 'STRAPI5_TOKEN is set' + RESET : YELLOW + 'STRAPI5_TOKEN is NOT set' + RESET}`));
  console.log(box(`     ${s5Url}/admin → Settings → API Tokens → Create new API Token`));
  console.log(box(`     Token type: ${BOLD}Full access${RESET}, Duration: ${BOLD}Unlimited${RESET}`));
  console.log(box(`     ${YELLOW}!${RESET} Read-only tokens get HTTP 405 on POST — write phases will fail`));
  console.log(box(`     Then: ${DIM}export STRAPI5_TOKEN="<your-token>"${RESET}`));
  console.log(box(`     ${DIM}or paste it into config.js (gitignored)${RESET}`));
  console.log(box(''));
  console.log(box(`  ${BOLD}4. Strapi 3 source files in repo${RESET}`));
  console.log(box(`     Path: ${CYAN}docs/strapi-3-source/${RESET}`));
  console.log(box(`     Should contain: ${DIM}api/ components/ config/ data.db${RESET}`));
  console.log(box(`     ${DIM}(data.db is gitignored — each dev needs to obtain it separately)${RESET}`));
  console.log(box(''));
  console.log(box(`  ${BOLD}5. Network access to ${CYAN}agency.icjia-api.cloud${RESET}`));
  console.log(box(`     For Phase 2 GraphQL extraction + Phase 3 file downloads`));
  console.log(box(`     (~2,110 media files, total ~1–2 GB)`));
  console.log(box(''));
  console.log(box(`  ${BOLD}6. Config profile selected${RESET}`));
  console.log(box(`     ${DIM}cp config.dev.js config.js${RESET}   (local Strapi 5)`));
  console.log(box(`     ${DIM}cp config.prod.js config.js${RESET}  (production Strapi 5)`));
  console.log(box(`     Or: ${DIM}MIGRATION_ENV=dev pnpm preflight${RESET}`));
  console.log(box(''));
  console.log(box(`  ${BOLD}7. ~3 GB free disk space${RESET}`));
  console.log(box(`     Media files + JSON extracts + ID maps`));
  console.log(box(''));
  console.log(bot);
  console.log('');
  console.log(`${DIM}(Pass --skip-checklist to suppress this screen.)${RESET}`);
  console.log('');
}

async function main() {
  if (!JSON_OUTPUT) {
    console.log('');
    console.log(`${BOLD}ICJIA Public Website Migration — Preflight Check${RESET}`);
    console.log(DIM + 'Verifies your environment before any migration phase runs.' + RESET);
  }

  // Load manifest before any check needs it
  const manifest = await loadManifest();
  if (!manifest && !JSON_OUTPUT) {
    console.log('');
    console.log(`${YELLOW}Warning:${RESET} could not load migration/config/content-types.json — ` +
      `expected types/tables/components will not be validated against the manifest.`);
  }

  printChecklist();

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
  await check('strapi5', 'Port matches Strapi 5 .env', checkStrapi5PortMatches);

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
