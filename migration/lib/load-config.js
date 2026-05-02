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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

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
  return config;
}
