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

import fs from 'fs';
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

// Auto-load `.env` from the project root if present. The intended use is to
// keep secrets (STRAPI5_TOKEN, etc.) out of the JS config files entirely,
// so the auditLoadedConfig() walk never finds a secret-shaped literal.
//
// Precedence: shell-set env vars always win over `.env` values, so an
// `export STRAPI5_TOKEN=...` in the calling shell still overrides .env
// (handy for one-off CI runs). Disable by setting MIGRATION_DISABLE_DOTENV=1.
if (process.env.MIGRATION_DISABLE_DOTENV !== '1') {
  loadDotenv(path.join(ROOT, '.env'));
}

/**
 * Minimal `.env` parser. Reads `KEY=value` lines from the given path and
 * merges them into `process.env`, but never overrides values already set
 * in the parent shell.
 *
 * Supports:
 *   KEY=value
 *   KEY="quoted value"
 *   KEY='single-quoted'
 *   # comments and blank lines (ignored)
 *
 * Does not support: variable expansion (`${OTHER}`), multi-line values,
 * `export` prefixes (just KEY=value, the standard dotenv shape).
 */
function loadDotenv(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // file missing = fine
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // shell wins
    let value = m[2];
    // Strip surrounding quotes if matched
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
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
 * Read the JS source of `source` (the file the loader picked up — config.js,
 * config.dev.js, etc.) and warn if any string literal in it looks like a
 * hardcoded secret. Scanning the SOURCE rather than the resolved config means
 * tokens loaded from `.env` or `process.env.*` produce no warning, but a
 * literal `'3df98a55…'` in the JS file still does.
 *
 * The check is intentionally heuristic — false positives prompt a developer
 * conversation, which is the desired outcome.
 *
 * Set MIGRATION_SUPPRESS_SECRET_WARNINGS=1 to silence (e.g., for CI runs).
 */
function auditLoadedConfig(config, source) {
  if (process.env.MIGRATION_SUPPRESS_SECRET_WARNINGS === '1') return;
  const sourcePath = path.join(ROOT, source);
  let text;
  try {
    text = fs.readFileSync(sourcePath, 'utf8');
  } catch {
    return; // can't read source = nothing to check
  }
  const findings = scanSourceForSecretLiterals(text);
  if (findings.length === 0) return;
  console.warn(
    `${YELLOW}SECURITY WARNING: ${source} contains ${findings.length} ` +
      `secret-shaped string literal${findings.length === 1 ? '' : 's'}.${RESET}`,
  );
  for (const f of findings) {
    console.warn(`${YELLOW}  - line ${f.line}: ${f.preview}${RESET}`);
  }
  console.warn(
    `${YELLOW}  Move the value into .env (auto-loaded; gitignored) and replace\n` +
      `  the literal with an empty string fallback:\n` +
      `      token: process.env.STRAPI5_TOKEN || '',\n` +
      `  Then write the secret with: pnpm set-token  (or: edit .env directly).${RESET}`,
  );
  console.warn(`${YELLOW}  Suppress with: export MIGRATION_SUPPRESS_SECRET_WARNINGS=1${RESET}`);
}

/**
 * Lex a JS source file for string literals (single, double, or backtick
 * quoted) and return any whose contents match isLikelySecret().
 *
 * We intentionally skip values inside comments by stripping line and block
 * comments first — keeps the example-token comments in headers from
 * triggering warnings.
 */
function scanSourceForSecretLiterals(text) {
  // Strip block and line comments (best-effort; doesn't account for strings
  // containing /* or //, but that's OK for our config files which are simple).
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const findings = [];
  // Match string literals: '...', "...", `...` (no escaped quote handling
  // needed — Strapi tokens are alphanumerics so they never contain quotes).
  const re = /(['"`])([^'"`]{16,})\1/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const value = m[2];
    if (!isLikelySecret(value)) continue;
    // Find line number in the original (un-stripped) text by searching for
    // this exact literal. Approximation is fine — config files are small.
    const idx = text.indexOf(value);
    const line = idx === -1 ? 0 : text.slice(0, idx).split('\n').length;
    findings.push({
      line,
      preview: `${value.slice(0, 8)}…${value.slice(-4)} (${value.length} chars)`,
    });
  }
  return findings;
}
