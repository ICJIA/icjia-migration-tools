/**
 * @module security
 * @description Security helpers used across the migration tool.
 *
 * Centralizes the input-validation and escaping primitives used by
 * scripts that talk to remote shells, build SQL, or fetch URLs from
 * untrusted manifests. Added during the v0.10.0 red/blue audit.
 *
 * Conventions:
 *  - Validators throw on failure (loud refusal). Don't return false.
 *  - All allowlists use anchored, character-class regexes.
 *  - Helpers are pure — no I/O, no globals, no logging side effects.
 *
 * @example
 *   import { requireEnv, assertSafePath, assertSafeUrl, quoteIdent,
 *            escapeShellArg, isLikelySecret } from './security.js';
 */

/**
 * Read an env var or throw a clear error if missing/empty.
 * Use for any secret or destination credential.
 *
 * @param {string} name - environment variable name
 * @param {Object} [opts]
 * @param {string} [opts.hint] - extra guidance printed in the error
 * @returns {string}
 */
export function requireEnv(name, opts = {}) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    const hint = opts.hint ? `\n  Hint: ${opts.hint}` : '';
    throw new Error(
      `Required environment variable ${name} is not set.${hint}\n` +
        `  Set it before running, e.g.: export ${name}="..."`,
    );
  }
  return String(v);
}

/**
 * Validate that a string is a "safe" Unix-ish path/host fragment that can be
 * embedded into a shell command without escaping.
 *
 * Allowed: alphanumerics, `.` `_` `-` `/` `:` (for user@host) and `~` only.
 * Rejects spaces, quotes, backticks, `$`, `;`, `&`, `|`, `*`, `?`, `<`, `>`,
 * `(`, `)`, `{`, `}`, `\\`, newlines, and the like.
 *
 * @param {string} value
 * @param {string} fieldName - human-readable name for error messages
 * @returns {string} the same value (passes through)
 * @throws {Error} when the value contains unsafe characters
 */
export function assertSafePath(value, fieldName = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9._\-/:~@]+$/.test(value)) {
    throw new Error(
      `Refusing unsafe ${fieldName}: ${JSON.stringify(value)} ` +
        `(only A-Z, a-z, 0-9, and . _ - / : @ ~ are allowed)`,
    );
  }
  if (value.includes('..')) {
    throw new Error(
      `Refusing ${fieldName} with parent traversal: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Validate that a SQL identifier (table or column name) is safe to interpolate.
 * Mirrors the pattern in `sqlite-reader.quoteIdent()` so the rule is consistent.
 *
 * @param {string} name
 * @returns {string} the same name (passes through)
 */
export function assertSafeIdent(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`SQL identifier must be a non-empty string`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`Refusing unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Quote a SQL identifier for SQLite (after asserting it is safe).
 *
 * @param {string} name
 * @returns {string} double-quoted identifier
 */
export function quoteIdent(name) {
  assertSafeIdent(name);
  return `"${name}"`;
}

/**
 * Validate a URL fetched from a (possibly tainted) manifest.
 *
 * Accepts an absolute URL OR a relative `/path` and joins it onto `expectedBase`.
 * Throws if the resolved URL's hostname does not match the expected host.
 *
 * Defends against SSRF where a manifest entry contains an attacker-controlled
 * absolute URL like `http://169.254.169.254/...` or `http://localhost:6379/...`.
 *
 * @param {string} input - the value to validate
 * @param {string} expectedBase - the trusted base URL (e.g., config.strapi3.apiUrl)
 * @returns {URL} the parsed, validated absolute URL
 */
export function assertSafeUrl(input, expectedBase) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('URL must be a non-empty string');
  }
  const base = new URL(expectedBase);
  if (!/^https?:$/.test(base.protocol)) {
    throw new Error(
      `Expected base URL must use http or https: ${JSON.stringify(expectedBase)}`,
    );
  }
  // If the input has a scheme already, refuse — the manifest must give a path,
  // not an absolute URL the source can override.
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(input)) {
    throw new Error(
      `Refusing absolute URL in source manifest (must be a relative /path): ${JSON.stringify(input)}`,
    );
  }
  // Refuse protocol-relative URLs (`//evil.example/...`) — they would inherit
  // the base's protocol but jump to a new host.
  if (input.startsWith('//')) {
    throw new Error(
      `Refusing protocol-relative URL: ${JSON.stringify(input)}`,
    );
  }
  const resolved = new URL(input, base);
  if (resolved.hostname !== base.hostname) {
    throw new Error(
      `URL host ${JSON.stringify(resolved.hostname)} does not match expected ` +
        `${JSON.stringify(base.hostname)}: ${JSON.stringify(input)}`,
    );
  }
  if (resolved.protocol !== base.protocol) {
    throw new Error(
      `URL protocol ${JSON.stringify(resolved.protocol)} does not match expected ` +
        `${JSON.stringify(base.protocol)}: ${JSON.stringify(input)}`,
    );
  }
  return resolved;
}

/**
 * POSIX-shell single-quote a value for safe inclusion in a shell command line.
 * Single-quote everything (preserve all characters literally) and escape any
 * embedded single quotes.
 *
 * @param {string} value
 * @returns {string} a quoted shell token
 */
export function escapeShellArg(value) {
  if (value === undefined || value === null) {
    throw new Error('Cannot shell-escape undefined/null');
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Heuristic check: does this string look like a credential/secret that
 * should never be hardcoded in source?
 *
 *  - >= 32 chars
 *  - matches base64 (incl. URL-safe + padding) OR hex
 *
 * Used by load-config to warn when a committed file ships a secret-shaped
 * fallback. It will produce false positives on long random IDs — that's fine,
 * the warning prompts the developer to confirm.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isLikelySecret(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 32) return false;
  if (/^[A-Fa-f0-9]+$/.test(value)) return true; // hex
  if (/^[A-Za-z0-9+/_=\-]+$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)) {
    return true; // mixed-case base64-ish
  }
  return false;
}

/**
 * Test whether a base URL is safe to send a bearer token over without HTTPS.
 * HTTPS is always safe. Plaintext HTTP is only allowed for localhost/127/::1.
 *
 * @param {string} baseUrl
 * @returns {boolean} true if it's safe to send a token
 */
export function isHttpsOrLocalhost(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return (
    u.hostname === 'localhost' ||
    u.hostname === '127.0.0.1' ||
    u.hostname === '::1' ||
    u.hostname === '0.0.0.0'
  );
}
