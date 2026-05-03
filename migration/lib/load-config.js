/**
 * @module load-config
 * @description Loads the migration configuration with environment profile support.
 *
 * Resolution order:
 * 1. `config.js` (if exists) — the gitignored working config
 * 2. `config.{MIGRATION_ENV}.js` (if MIGRATION_ENV is set) — e.g., config.dev.js or config.prod.js
 * 3. `config.example.js` — fallback defaults
 *
 * @example
 *   import { loadConfig } from '../lib/load-config.js';
 *   const config = await loadConfig();
 *
 * @example
 *   MIGRATION_ENV=prod node migration/scripts/02-extract.js
 *
 * @returns {Promise<Object>} The resolved configuration object
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { isLikelySecret } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Restrict default file/dir permissions to the running user only.
// migration/data/ holds id maps, manifests, raw extracted records — all
// sensitive enough that group/other access is undesirable. Override with
// MIGRATION_DISABLE_UMASK=1 if a workflow needs the default 0022 umask.
if (process.env.MIGRATION_DISABLE_UMASK !== '1') {
  process.umask(0o077);
}

const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

/**
 * Load the migration configuration, trying multiple sources in order.
 *
 * @returns {Promise<Object>} The configuration object
 */
export async function loadConfig() {
  // 1. Try config.js (gitignored, user-customized)
  try {
    const config = (await import(path.join(ROOT, 'config.js'))).default;
    auditLoadedConfig(config, 'config.js');
    return config;
  } catch {
    // Not found — continue
  }

  // 2. Try MIGRATION_ENV profile (e.g., config.dev.js, config.prod.js)
  const env = process.env.MIGRATION_ENV;
  if (env) {
    try {
      const config = (await import(path.join(ROOT, `config.${env}.js`))).default;
      console.log(`${CYAN}Using config.${env}.js (MIGRATION_ENV=${env})${RESET}`);
      auditLoadedConfig(config, `config.${env}.js`);
      return config;
    } catch {
      console.warn(`${YELLOW}WARNING: MIGRATION_ENV=${env} but config.${env}.js not found${RESET}`);
    }
  }

  // 3. Fall back to config.example.js
  console.warn(`${YELLOW}config.js not found — using config.example.js defaults${RESET}`);
  console.warn(`${YELLOW}Tip: cp config.dev.js config.js  (for local dev)${RESET}`);
  console.warn(`${YELLOW}     cp config.prod.js config.js (for production)${RESET}`);
  const config = (await import(path.join(ROOT, 'config.example.js'))).default;
  auditLoadedConfig(config, 'config.example.js');
  return config;
}

/**
 * Walk the loaded config and warn if any token-shaped value is sitting in a
 * file rather than coming from `process.env.<NAME>`. We can't tell that
 * statically (the value is already resolved by the time we see it), but we
 * can flag the *shape* of the resolved value so a developer knows their token
 * is on disk.
 *
 * Set MIGRATION_SUPPRESS_SECRET_WARNINGS=1 to silence (e.g., for CI test runs).
 */
function auditLoadedConfig(config, source) {
  if (process.env.MIGRATION_SUPPRESS_SECRET_WARNINGS === '1') return;
  const findings = [];
  walk(config, [], findings);
  if (findings.length === 0) return;
  console.warn(
    `${YELLOW}SECURITY WARNING: ${source} contains ${findings.length} ` +
      `secret-shaped value${findings.length === 1 ? '' : 's'} in plaintext on disk.${RESET}`,
  );
  for (const f of findings) {
    console.warn(`${YELLOW}  - ${f.path}: ${f.preview}${RESET}`);
  }
  console.warn(
    `${YELLOW}  Move secrets to environment variables (e.g., STRAPI5_TOKEN=...)\n` +
      `  and use \`process.env.STRAPI5_TOKEN || ''\` in the config file.${RESET}`,
  );
  console.warn(`${YELLOW}  Suppress with: export MIGRATION_SUPPRESS_SECRET_WARNINGS=1${RESET}`);
}

function walk(obj, trail, out) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (isLikelySecret(obj)) {
      out.push({
        path: trail.join('.') || '(root)',
        preview: `${obj.slice(0, 8)}…${obj.slice(-4)} (${obj.length} chars)`,
      });
    }
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    walk(v, [...trail, k], out);
  }
}
