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
const config = await loadConfig();

// ── Configuration ───────────────────────────────────────────────────

/**
 * SSH connection details. Override via environment variables if needed.
 * @type {{ host: string, user: string, strapiDir: string, dbRelativePath: string }}
 */
const SSH = {
  host: process.env.SSH_HOST || '137.184.64.249',
  user: process.env.SSH_USER || 'forge',
  strapiDir: config.strapi5ProjectPath || '/home/forge/v2.hub.icjia-api.cloud/v2hub',
  dbRelativePath: '.tmp/data.db',
};

const REMOTE_TMP = `/tmp/migration-timestamps-${Date.now()}`;

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
 * @param {string} cmd - Remote command to execute
 * @returns {string} Command output
 */
function ssh(cmd) {
  return run(`ssh ${SSH.user}@${SSH.host} "${cmd.replace(/"/g, '\\"')}"`);
}

/**
 * SCP a local file to the remote server.
 *
 * @param {string} localPath - Absolute local file path
 * @param {string} remotePath - Absolute remote destination path
 */
function scp(localPath, remotePath) {
  run(`scp "${localPath}" ${SSH.user}@${SSH.host}:${remotePath}`);
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
  return `#!/usr/bin/env node
/**
 * Remote timestamp restoration script.
 * Auto-generated — runs on the Strapi 5 server to update createdAt/updatedAt.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const STRAPI_DIR = '${SSH.strapiDir}';
const DB_PATH = path.join(STRAPI_DIR, '${SSH.dbRelativePath}');
const DATA_DIR = '${REMOTE_TMP}';

const CONTENT_TYPES = ${JSON.stringify(CONTENT_TYPES)};

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

      // Get columns
      const columns = db.prepare('PRAGMA table_info(' + tableName + ')').all().map(c => c.name);
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
        'UPDATE ' + tableName + ' SET ' + createdCol + ' = ?, ' + updatedCol + ' = ? WHERE ' + docIdCol + ' = ?'
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
      const sample = db.prepare('SELECT ' + docIdCol + ', ' + createdCol + ' FROM ' + tableName + ' LIMIT 3').all();
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
  console.log(`  Remote temp dir: ${REMOTE_TMP}`);
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

  // Step 1: Create remote temp directory structure
  console.log(`${BOLD}── Step 1: Create remote temp directory ──${RESET}\n`);
  ssh(`mkdir -p ${REMOTE_TMP}/maps ${REMOTE_TMP}/transformed`);
  console.log(`  ${GREEN}✓${RESET} Created ${REMOTE_TMP}\n`);

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
  await fs.writeFile(localScriptPath, scriptContent);
  scp(localScriptPath, `${REMOTE_TMP}/fix-timestamps.cjs`);
  await fs.unlink(localScriptPath);
  console.log(`  ${GREEN}✓${RESET} Script uploaded\n`);

  // Step 4: Run the script on the server
  console.log(`${BOLD}── Step 4: Run timestamp fix on server ──${RESET}\n`);
  try {
    const output = ssh(`cd ${SSH.strapiDir} && NODE_PATH=${SSH.strapiDir}/node_modules node ${REMOTE_TMP}/fix-timestamps.cjs`);
    console.log(output);
  } catch (err) {
    console.error(`${RED}Remote script failed:${RESET}`);
    console.error(err.stderr || err.message);
    console.log(`\n${YELLOW}You can retry by running:${RESET}`);
    console.log(`  ssh ${SSH.user}@${SSH.host} "cd ${SSH.strapiDir} && NODE_PATH=${SSH.strapiDir}/node_modules node ${REMOTE_TMP}/fix-timestamps.cjs"`);
    process.exit(1);
  }

  // Step 5: Clean up remote temp files
  console.log(`${BOLD}── Step 5: Clean up ──${RESET}\n`);
  ssh(`rm -rf ${REMOTE_TMP}`);
  console.log(`  ${GREEN}✓${RESET} Removed ${REMOTE_TMP}\n`);

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
