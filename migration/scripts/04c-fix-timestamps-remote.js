/**
 * @module 04c-fix-timestamps-remote
 * @description Phase 4c: Restore original createdAt/updatedAt timestamps via SSH.
 *
 * This is the remote-friendly version of 04c-fix-timestamps.js. Instead of
 * requiring local SQLite access, it:
 * 1. SCPs the necessary data files and a self-contained SQLite script to the server
 * 2. Runs the script on the server via SSH
 * 3. Cleans up the temporary files
 *
 * This approach is needed when Strapi 5 runs on a remote server (the REST API
 * does not allow overriding createdAt/updatedAt — those are system-managed fields).
 *
 * @example
 *   node migration/scripts/04c-fix-timestamps-remote.js
 *
 * Prerequisites:
 * - Phase 4a-4b complete (all content loaded and relations linked)
 * - Strapi 5 STOPPED on the remote server (pm2 stop strapi5)
 * - SSH access to the server configured (ssh-agent or key-based auth)
 * - Transformed data and ID maps available locally
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

import { loadConfig } from '../lib/load-config.js';
import {
  requireEnv,
  assertSafePath,
  escapeShellArg,
} from '../lib/security.js';
const config = await loadConfig();

// ── Configuration ───────────────────────────────────────────────────

/**
 * SSH connection details. All four values are required; no production
 * defaults are baked in (a developer running locally without env vars
 * would otherwise hit a hardcoded prod target).
 *
 * @type {{ host: string, user: string, strapiDir: string, dbRelativePath: string }}
 */
const SSH = {
  host: assertSafePath(
    requireEnv('SSH_HOST', { hint: 'remote Strapi 5 host (e.g., v2.example.com)' }),
    'SSH_HOST',
  ),
  user: assertSafePath(
    requireEnv('SSH_USER', { hint: 'SSH login user on the remote (e.g., forge)' }),
    'SSH_USER',
  ),
  strapiDir: assertSafePath(
    process.env.SSH_STRAPI_DIR || config.strapi5ProjectPath || '',
    'SSH_STRAPI_DIR / strapi5ProjectPath',
  ),
  dbRelativePath: assertSafePath(
    process.env.SSH_DB_RELATIVE_PATH || '.tmp/data.db',
    'SSH_DB_RELATIVE_PATH',
  ),
};

// Remote temp dir is created on the remote with `mktemp -d` (random,
// mode 0700). Filled in by Step 1.
let REMOTE_TMP = null;

/**
 * Content types to process.
 * @type {Array<{ singular: string, plural: string, file: string }>}
 */
const CONTENT_TYPES = [
  { singular: 'article', plural: 'articles', file: 'articles.json' },
  { singular: 'dataset', plural: 'datasets', file: 'datasets.json' },
  { singular: 'app', plural: 'apps', file: 'apps.json' },
];

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Run a shell command synchronously, printing output in real time.
 *
 * @param {string} cmd - Command to execute
 * @param {Object} [opts] - Options for execSync
 * @returns {string} Command output
 */
function run(cmd, opts = {}) {
  console.log(`  ${CYAN}$ ${cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd}${RESET}`);
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

/**
 * Run a command via SSH on the remote server.
 *
 * The local shell sees `ssh user@host '<remote-command>'` — single-quoted
 * so we only have to worry about embedded single quotes (handled by
 * escapeShellArg). The remote shell then receives the raw command bytes.
 *
 * @param {string} cmd - Remote command to execute
 * @returns {string} Command output
 */
function ssh(cmd) {
  // Both user and host are validated by assertSafePath so they're safe to
  // interpolate without quoting; the remote command itself is single-quoted.
  return run(`ssh ${SSH.user}@${SSH.host} ${escapeShellArg(cmd)}`);
}

/**
 * SCP a local file to the remote server.
 *
 * @param {string} localPath - Absolute local file path
 * @param {string} remotePath - Absolute remote destination path
 */
function scp(localPath, remotePath) {
  // assertSafePath rejects spaces/quotes — but we still single-quote both
  // sides defensively so any future relaxation doesn't open a shell hole.
  run(
    `scp ${escapeShellArg(localPath)} ${SSH.user}@${SSH.host}:${escapeShellArg(remotePath)}`,
  );
}

// ── Remote Script Generator ─────────────────────────────────────────

/**
 * Generate a self-contained Node.js script that updates timestamps directly
 * in the SQLite database on the remote server. This script uses only the
 * built-in `better-sqlite3` package that Strapi 5 already has installed.
 *
 * @returns {string} JavaScript source code for the remote script
 */
function generateRemoteScript() {
  // Both STRAPI_DIR and DATA_DIR are validated as safe paths by assertSafePath
  // before reaching here, so JSON.stringify embedding into the script literal
  // is safe. We still use JSON.stringify (not raw concatenation) so a future
  // weakening of the path allowlist can't break out of the JS string context.
  return `#!/usr/bin/env node
/**
 * Remote timestamp restoration script.
 * Auto-generated — runs on the Strapi 5 server to update createdAt/updatedAt.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const STRAPI_DIR = ${JSON.stringify(SSH.strapiDir)};
const DB_PATH = path.join(STRAPI_DIR, ${JSON.stringify(SSH.dbRelativePath)});
const DATA_DIR = ${JSON.stringify(REMOTE_TMP)};

const CONTENT_TYPES = ${JSON.stringify(CONTENT_TYPES)};

// Allowlist for table/column names. Mirrors migration/lib/security.js
// assertSafeIdent so the SQL we build cannot be perturbed even if the
// schema has unexpected names.
function quoteIdent(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error('Refusing unsafe SQL identifier: ' + JSON.stringify(name));
  }
  return '"' + name + '"';
}

function main() {
  console.log('=== Remote Timestamp Restoration ===\\n');
  console.log('DB path:', DB_PATH);
  console.log('Data dir:', DATA_DIR);

  if (!fs.existsSync(DB_PATH)) {
    console.error('ERROR: Database not found at ' + DB_PATH);
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  try {
    const allTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);
    console.log('Tables:', allTables.join(', '), '\\n');

    let totalUpdated = 0;
    let totalSkipped = 0;

    for (const ct of CONTENT_TYPES) {
      // Find table
      let tableName = null;
      for (const candidate of [ct.singular, ct.plural]) {
        if (allTables.includes(candidate)) { tableName = candidate; break; }
      }
      if (!tableName) {
        for (const t of allTables) {
          if (t.toLowerCase() === ct.singular || t.toLowerCase() === ct.plural) {
            tableName = t; break;
          }
        }
      }
      if (!tableName) {
        console.log('WARNING: No table for ' + ct.singular + ' — skipping');
        continue;
      }

      // Get columns. tableName flows into PRAGMA via quoteIdent.
      const columns = db.prepare('PRAGMA table_info(' + quoteIdent(tableName) + ')').all().map(c => c.name);
      const docIdCol = columns.includes('document_id') ? 'document_id' : columns.includes('documentId') ? 'documentId' : null;
      const createdCol = columns.includes('created_at') ? 'created_at' : columns.includes('createdAt') ? 'createdAt' : null;
      const updatedCol = columns.includes('updated_at') ? 'updated_at' : columns.includes('updatedAt') ? 'updatedAt' : null;

      if (!docIdCol || !createdCol || !updatedCol) {
        console.log('ERROR: Missing columns in ' + tableName);
        continue;
      }

      // Load data
      const idMap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'maps', ct.file), 'utf8'));
      const transformed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'transformed', ct.file), 'utf8'));

      const stmt = db.prepare(
        'UPDATE ' + quoteIdent(tableName) +
        ' SET ' + quoteIdent(createdCol) + ' = ?, ' +
                  quoteIdent(updatedCol) + ' = ?' +
        ' WHERE ' + quoteIdent(docIdCol) + ' = ?'
      );

      let updated = 0;
      let skipped = 0;

      for (const rec of transformed) {
        const mapping = idMap[rec.legacyId];
        if (!mapping || !rec._originalCreatedAt || !rec._originalUpdatedAt) {
          skipped++;
          continue;
        }
        const result = stmt.run(rec._originalCreatedAt, rec._originalUpdatedAt, mapping.strapi5DocumentId);
        if (result.changes > 0) updated++;
        else skipped++;
      }

      console.log(tableName + ': ' + updated + ' updated, ' + skipped + ' skipped');
      totalUpdated += updated;
      totalSkipped += skipped;

      // Sample
      const sample = db.prepare('SELECT ' + quoteIdent(docIdCol) + ', ' + quoteIdent(createdCol) + ' FROM ' + quoteIdent(tableName) + ' LIMIT 3').all();
      for (const row of sample) {
        console.log('  ' + docIdCol + '=' + row[docIdCol] + ' -> ' + createdCol + '=' + row[createdCol]);
      }
    }

    // Set mainField to "title" for admin display
    console.log('\\nSetting content manager mainField to "title"...');
    const configKeys = [
      'plugin_content_manager_configuration_content_types::api::article.article',
      'plugin_content_manager_configuration_content_types::api::dataset.dataset',
      'plugin_content_manager_configuration_content_types::api::app.app',
    ];
    for (const key of configKeys) {
      try {
        const row = db.prepare('SELECT value FROM strapi_core_store_settings WHERE key = ?').get(key);
        if (row && row.value) {
          const cfg = JSON.parse(row.value);
          cfg.settings.mainField = 'title';
          cfg.settings.defaultSortBy = 'title';
          db.prepare('UPDATE strapi_core_store_settings SET value = ? WHERE key = ?').run(JSON.stringify(cfg), key);
          console.log('  ✓ ' + key.split('::').pop() + ': mainField → title');
        }
      } catch (e) {
        console.log('  ⚠ Could not update ' + key + ': ' + e.message);
      }
    }

    console.log('\\nDone: ' + totalUpdated + ' updated, ' + totalSkipped + ' skipped');
  } finally {
    db.close();
    console.log('Database closed.');
  }
}

main();
`;
}

// ── Main ────────────────────────────────────────────────────────────

/**
 * Main entry point: uploads data to the server, runs the timestamp fix,
 * then cleans up.
 */
async function main() {
  console.log(`${BOLD}=== Phase 4c: Restore Timestamps (Remote) ===${RESET}\n`);

  console.log('Configuration:');
  console.log(`  SSH host:        ${SSH.user}@${SSH.host}`);
  console.log(`  Strapi 5 dir:    ${SSH.strapiDir}`);
  console.log(`  DB path:         ${SSH.strapiDir}/${SSH.dbRelativePath}`);
  console.log('');

  console.log(`${YELLOW}${BOLD}IMPORTANT: Strapi 5 must be STOPPED on the server before proceeding.${RESET}`);
  console.log(`${YELLOW}Run: ssh ${SSH.user}@${SSH.host} "pm2 stop strapi5"${RESET}\n`);

  // Verify local data files exist
  const mapsDir = path.resolve(ROOT, config.paths.maps);
  const transformedDir = path.resolve(ROOT, config.paths.transformedData);

  for (const ct of CONTENT_TYPES) {
    await fs.access(path.join(mapsDir, ct.file));
    await fs.access(path.join(transformedDir, ct.file));
  }
  console.log(`  ${GREEN}✓${RESET} Local data files verified\n`);

  // Step 1: Create a random, mode-0700 remote temp directory via mktemp.
  // Avoids the predictable `/tmp/migration-timestamps-${Date.now()}` race
  // where another user on the box could pre-create the dir.
  console.log(`${BOLD}── Step 1: Create remote temp directory ──${RESET}\n`);
  REMOTE_TMP = ssh(`mktemp -d /tmp/migration-timestamps-XXXXXXXX`).trim();
  // Defensive sanity check on the mktemp output.
  assertSafePath(REMOTE_TMP, 'REMOTE_TMP');
  if (!REMOTE_TMP.startsWith('/tmp/migration-timestamps-')) {
    throw new Error(`Unexpected mktemp output: ${REMOTE_TMP}`);
  }
  ssh(`chmod 700 ${REMOTE_TMP} && mkdir -p ${REMOTE_TMP}/maps ${REMOTE_TMP}/transformed && chmod 700 ${REMOTE_TMP}/maps ${REMOTE_TMP}/transformed`);
  console.log(`  ${GREEN}✓${RESET} Created ${REMOTE_TMP} (mode 0700)\n`);

  let runFailed = false;
  try {
    // Step 2: SCP data files to server
    console.log(`${BOLD}── Step 2: Upload data files to server ──${RESET}\n`);
    for (const ct of CONTENT_TYPES) {
      scp(path.join(mapsDir, ct.file), `${REMOTE_TMP}/maps/${ct.file}`);
      console.log(`  ${GREEN}✓${RESET} maps/${ct.file}`);
      scp(path.join(transformedDir, ct.file), `${REMOTE_TMP}/transformed/${ct.file}`);
      console.log(`  ${GREEN}✓${RESET} transformed/${ct.file}`);
    }
    console.log('');

    // Step 3: Generate and upload the remote script
    console.log(`${BOLD}── Step 3: Upload timestamp script ──${RESET}\n`);
    const scriptContent = generateRemoteScript();
    const localScriptPath = path.join(ROOT, 'migration/data/.tmp-remote-timestamp-fix.cjs');
    await fs.writeFile(localScriptPath, scriptContent, { mode: 0o600 });
    scp(localScriptPath, `${REMOTE_TMP}/fix-timestamps.cjs`);
    await fs.unlink(localScriptPath);
    console.log(`  ${GREEN}✓${RESET} Script uploaded\n`);

    // Step 4: Run the script on the server
    console.log(`${BOLD}── Step 4: Run timestamp fix on server ──${RESET}\n`);
    try {
      const output = ssh(`cd ${SSH.strapiDir} && NODE_PATH=${SSH.strapiDir}/node_modules node ${REMOTE_TMP}/fix-timestamps.cjs`);
      console.log(output);
    } catch (err) {
      runFailed = true;
      console.error(`${RED}Remote script failed:${RESET}`);
      console.error(err.stderr || err.message);
      throw err;
    }
  } finally {
    // Step 5: Always clean up remote temp files, even on failure.
    // REMOTE_TMP is validated to start with /tmp/migration-timestamps- so
    // the rm -rf is bounded.
    console.log(`${BOLD}── Step 5: Clean up ──${RESET}\n`);
    try {
      ssh(`rm -rf ${REMOTE_TMP}`);
      console.log(`  ${GREEN}✓${RESET} Removed ${REMOTE_TMP}\n`);
    } catch (cleanupErr) {
      console.warn(
        `  ${YELLOW}⚠ Could not remove ${REMOTE_TMP} — clean up by hand: ` +
          `ssh ${SSH.user}@${SSH.host} 'rm -rf ${REMOTE_TMP}'${RESET}\n`,
      );
    }
  }
  if (runFailed) process.exit(1);

  // Step 6: Restart Strapi 5
  console.log(`${BOLD}── Step 6: Restart Strapi 5 ──${RESET}\n`);
  try {
    const pmOutput = ssh(`pm2 restart strapi5`);
    console.log(pmOutput);
    console.log(`  ${GREEN}✓${RESET} Strapi 5 restarted\n`);
  } catch {
    console.log(`  ${YELLOW}⚠ Could not restart Strapi 5 automatically.${RESET}`);
    console.log(`  ${YELLOW}Run: ssh ${SSH.user}@${SSH.host} "pm2 restart strapi5"${RESET}\n`);
  }

  console.log(`${GREEN}${BOLD}Phase 4c (remote timestamp restoration) complete.${RESET}`);
  console.log('Next: pnpm migrate:phase05 (or node migration/scripts/05-run-phase.js)');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
