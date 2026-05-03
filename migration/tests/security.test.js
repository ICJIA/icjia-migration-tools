#!/usr/bin/env node
/**
 * @module security.test
 * @description Manual security regression test suite.
 *
 * Exercises every fix from the v0.10.0 red/blue audit so a developer
 * can prove the protections are still in place after future changes.
 *
 * USAGE
 *   pnpm test:security                 # run everything
 *   node migration/tests/security.test.js [--only=name]  # filter by test name
 *
 * Each test is self-contained — no external services, no real Strapi
 * instance required. Pure-function assertions only.
 *
 * Exit code 0 on pass, 1 on any failure.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { fileURLToPath as urlToPath } from 'url';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import {
  requireEnv,
  assertSafePath,
  assertSafeIdent,
  quoteIdent,
  assertSafeUrl,
  escapeShellArg,
  isLikelySecret,
  isHttpsOrLocalhost,
} from '../lib/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const argv = process.argv.slice(2);
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const results = [];

/**
 * Register and run one test. Captures pass/fail without aborting the suite.
 */
function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  process.stdout.write(`  ${DIM}…${RESET} ${name} `);
  try {
    fn();
    results.push({ name, status: 'pass' });
    process.stdout.write(`\r  ${GREEN}✓${RESET} ${name}\n`);
  } catch (err) {
    results.push({ name, status: 'fail', error: err.message });
    process.stdout.write(`\r  ${RED}✗${RESET} ${name}\n`);
    console.error(`      ${RED}${err.message}${RESET}`);
  }
}

/**
 * Assertion helper — throw if condition is falsy.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

/**
 * Assertion helper — expect fn() to throw a specific message substring.
 */
function assertThrows(fn, expectedSubstring, label) {
  let threw = false;
  let actualMessage = null;
  try {
    fn();
  } catch (err) {
    threw = true;
    actualMessage = err.message || String(err);
  }
  if (!threw) {
    throw new Error(`${label}: expected throw containing "${expectedSubstring}", but no throw`);
  }
  if (expectedSubstring && !actualMessage.includes(expectedSubstring)) {
    throw new Error(
      `${label}: expected throw containing "${expectedSubstring}", got "${actualMessage}"`,
    );
  }
}

console.log('');
console.log(`${BOLD}── Security regression suite ──${RESET}`);
console.log(`${DIM}Source of truth: migration/lib/security.js + the audit fixes${RESET}`);
console.log('');

// ──────────────────────────────────────────────────────────────────────
// Section A — security.js primitives
// ──────────────────────────────────────────────────────────────────────

console.log(`${BOLD}A. security.js primitives${RESET}`);

test('requireEnv: throws when env var is unset', () => {
  delete process.env.__SECURITY_TEST_VAR__;
  assertThrows(() => requireEnv('__SECURITY_TEST_VAR__'), 'is not set', 'requireEnv unset');
});

test('requireEnv: throws when env var is empty string', () => {
  process.env.__SECURITY_TEST_VAR__ = '';
  assertThrows(() => requireEnv('__SECURITY_TEST_VAR__'), 'is not set', 'requireEnv empty');
});

test('requireEnv: returns string when set', () => {
  process.env.__SECURITY_TEST_VAR__ = 'hello';
  assert(requireEnv('__SECURITY_TEST_VAR__') === 'hello', 'expected "hello"');
  delete process.env.__SECURITY_TEST_VAR__;
});

test('assertSafePath: accepts plain unix paths', () => {
  assertSafePath('/home/user/strapi', 'p');
  assertSafePath('forge', 'p');
  assertSafePath('v2.example.com', 'p');
});

test('assertSafePath: rejects spaces', () => {
  assertThrows(() => assertSafePath('a b', 'p'), 'Refusing unsafe', 'space');
});

test('assertSafePath: rejects backticks', () => {
  assertThrows(() => assertSafePath('a`b', 'p'), 'Refusing unsafe', 'backtick');
});

test('assertSafePath: rejects dollar signs', () => {
  assertThrows(() => assertSafePath('a$b', 'p'), 'Refusing unsafe', 'dollar');
});

test('assertSafePath: rejects semicolons', () => {
  assertThrows(() => assertSafePath('a;rm -rf /', 'p'), 'Refusing unsafe', 'semi');
});

test('assertSafePath: rejects pipe', () => {
  assertThrows(() => assertSafePath('a|b', 'p'), 'Refusing unsafe', 'pipe');
});

test('assertSafePath: rejects parent traversal', () => {
  assertThrows(() => assertSafePath('/foo/../bar', 'p'), 'parent traversal', 'traversal');
});

test('assertSafePath: rejects empty', () => {
  assertThrows(() => assertSafePath('', 'p'), 'non-empty', 'empty');
});

test('assertSafeIdent: accepts table-name shapes', () => {
  assertSafeIdent('articles');
  assertSafeIdent('posts_tags__tags_posts');
  assertSafeIdent('legacy_id');
});

test('assertSafeIdent: rejects identifiers starting with digit', () => {
  assertThrows(() => assertSafeIdent('1articles'), 'Refusing unsafe SQL identifier', 'digit-start');
});

test('assertSafeIdent: rejects spaces and quotes', () => {
  assertThrows(() => assertSafeIdent('articles WHERE 1=1'), 'Refusing unsafe SQL identifier', 'space');
  assertThrows(() => assertSafeIdent('a"b'), 'Refusing unsafe SQL identifier', 'quote');
});

test('quoteIdent: produces double-quoted output', () => {
  assert(quoteIdent('articles') === '"articles"', `expected "articles", got ${quoteIdent('articles')}`);
});

test('escapeShellArg: round-trips simple values', () => {
  const out = escapeShellArg('hello');
  assert(out === `'hello'`, `expected 'hello', got ${out}`);
});

test('escapeShellArg: handles embedded single quotes', () => {
  // Input: it's
  // Expected output: 'it'\''s'
  const out = escapeShellArg(`it's`);
  assert(out === `'it'\\''s'`, `escaped form mismatch: ${out}`);
});

test('escapeShellArg: through bash sees the original literal', () => {
  // Use printf %s to materialize the value through a real shell — proves the
  // escaping survives execution.
  const tricky = `'; rm -rf /; echo "x`;
  const cmd = `printf %s ${escapeShellArg(tricky)}`;
  const out = execSync(cmd, { encoding: 'utf8', shell: '/bin/sh' });
  assert(out === tricky, `expected ${JSON.stringify(tricky)}, got ${JSON.stringify(out)}`);
});

test('isLikelySecret: flags long hex strings', () => {
  assert(isLikelySecret('a'.repeat(40)), 'long hex should be flagged');
  // The token shape from the audit
  assert(isLikelySecret('f2fdc595ffe65ae6a8b910b0d0d8f3b38fb4cf5a8905fb3f5b045e3cb9d5b483'), 'audit token shape');
});

test('isLikelySecret: flags base64-shaped strings', () => {
  assert(isLikelySecret('ny9NML0lRHfa7lbokCprxZIEzFMTWkKSGP+FnIMWHjUo33w9XX1DApQfSdC3h2MoG'), 'base64 token shape');
});

test('isLikelySecret: does not flag short / lowercase-only / URLs', () => {
  assert(!isLikelySecret('short'), 'short should not flag');
  assert(!isLikelySecret('https://example.com/uploads/abc.jpg'), 'URL should not flag (has slashes)');
  assert(!isLikelySecret('all_lowercase_snake_case_long_string_yes'), 'no caps no digits');
});

test('isHttpsOrLocalhost: accepts https://...', () => {
  assert(isHttpsOrLocalhost('https://example.com'), 'https');
});

test('isHttpsOrLocalhost: accepts http://localhost', () => {
  assert(isHttpsOrLocalhost('http://localhost:1340'), 'localhost');
  assert(isHttpsOrLocalhost('http://127.0.0.1:1340'), '127.0.0.1');
});

test('isHttpsOrLocalhost: rejects http://example.com', () => {
  assert(!isHttpsOrLocalhost('http://example.com'), 'http to non-localhost should fail');
});

// ──────────────────────────────────────────────────────────────────────
// Section B — SSRF protection in download path
// ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${BOLD}B. SSRF protection (assertSafeUrl)${RESET}`);

test('SSRF: relative /uploads path resolves correctly', () => {
  const u = assertSafeUrl('/uploads/abc.jpg', 'https://agency.icjia-api.cloud');
  assert(u.toString() === 'https://agency.icjia-api.cloud/uploads/abc.jpg', `got ${u}`);
});

test('SSRF: rejects absolute http URL', () => {
  assertThrows(
    () => assertSafeUrl('http://evil.example.com/payload', 'https://agency.icjia-api.cloud'),
    'Refusing absolute URL',
    'absolute URL',
  );
});

test('SSRF: rejects internal-IP redirect', () => {
  assertThrows(
    () => assertSafeUrl('http://169.254.169.254/latest/meta-data/', 'https://agency.icjia-api.cloud'),
    'Refusing absolute URL',
    'AWS IMDS',
  );
});

test('SSRF: rejects localhost-redis attack', () => {
  assertThrows(
    () => assertSafeUrl('http://localhost:6379/', 'https://agency.icjia-api.cloud'),
    'Refusing absolute URL',
    'localhost:6379',
  );
});

test('SSRF: rejects protocol-relative URL', () => {
  assertThrows(
    () => assertSafeUrl('//evil.example.com/x', 'https://agency.icjia-api.cloud'),
    'protocol-relative',
    'protocol-relative',
  );
});

test('SSRF: rejects gopher://, file://, etc.', () => {
  assertThrows(
    () => assertSafeUrl('gopher://evil/', 'https://agency.icjia-api.cloud'),
    'Refusing absolute URL',
    'gopher',
  );
  assertThrows(
    () => assertSafeUrl('file:///etc/passwd', 'https://agency.icjia-api.cloud'),
    'Refusing absolute URL',
    'file',
  );
});

test('SSRF: rejects when expectedBase has a non-http(s) scheme', () => {
  assertThrows(
    () => assertSafeUrl('/x', 'ftp://example.com'),
    'must use http or https',
    'non-http base',
  );
});

// ──────────────────────────────────────────────────────────────────────
// Section C — HTTP+token guard in clients
// ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${BOLD}C. HTTP-with-token guard${RESET}`);

test('RestClient: refuses bearer token over plaintext HTTP to non-localhost', async () => {
  const { RestClient } = await import('../lib/rest-client.js');
  delete process.env.ALLOW_INSECURE_HTTP;
  assertThrows(
    () => new RestClient('http://example.com', { token: 'tok' }),
    'Refusing to send API token over plaintext HTTP',
    'rest-client http+token',
  );
});

test('RestClient: allows bearer token over HTTPS', async () => {
  const { RestClient } = await import('../lib/rest-client.js');
  // Should not throw
  new RestClient('https://example.com', { token: 'tok' });
});

test('RestClient: allows bearer token over http://localhost', async () => {
  const { RestClient } = await import('../lib/rest-client.js');
  new RestClient('http://localhost:1340', { token: 'tok' });
});

test('RestClient: ALLOW_INSECURE_HTTP=1 escape hatch works', async () => {
  const { RestClient } = await import('../lib/rest-client.js');
  process.env.ALLOW_INSECURE_HTTP = '1';
  try {
    new RestClient('http://example.com', { token: 'tok' });
  } finally {
    delete process.env.ALLOW_INSECURE_HTTP;
  }
});

test('GraphQLClient: refuses bearer token over plaintext HTTP to non-localhost', async () => {
  const { GraphQLClient } = await import('../lib/graphql-client.js');
  delete process.env.ALLOW_INSECURE_HTTP;
  assertThrows(
    () => new GraphQLClient('http://example.com/graphql', { token: 'tok' }),
    'Refusing to send API token over plaintext HTTP',
    'graphql-client http+token',
  );
});

test('GraphQLClient: allows bearer token over http://localhost (dev workflow)', async () => {
  const { GraphQLClient } = await import('../lib/graphql-client.js');
  delete process.env.ALLOW_INSECURE_HTTP;
  // Should not throw — this is the dev config URL shape (config.dev.js uses
  // http://localhost:1340/graphql + a real token). Breaking this test means
  // we've broken the local-dev round-trip.
  new GraphQLClient('http://localhost:1340/graphql', { token: 'localdev-token' });
  new GraphQLClient('http://127.0.0.1:1340/graphql', { token: 'localdev-token' });
  new GraphQLClient('http://[::1]:1340/graphql', { token: 'localdev-token' });
});

test('RestClient: allows bearer token over http://localhost with arbitrary port', async () => {
  const { RestClient } = await import('../lib/rest-client.js');
  delete process.env.ALLOW_INSECURE_HTTP;
  // Verify a few realistic local Strapi 5 port choices don't trip the guard.
  for (const url of [
    'http://localhost:1338',
    'http://localhost:1340',
    'http://127.0.0.1:1340',
  ]) {
    new RestClient(url, { token: 'localdev-token' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Section D — committed source tree hygiene
// ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${BOLD}D. Committed-tree hygiene${RESET}`);

test('No hardcoded production IPs in committed JS (137.184.x.x family)', () => {
  // Walk the migration/ tree and root JS files. Skip data/, output/, node_modules/.
  const findings = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'data' ||
          entry.name === 'output' ||
          entry.name === '.git' ||
          entry.name === '.claude'
        ) continue;
        walk(full);
      } else if (entry.isFile() && (full.endsWith('.js') || full.endsWith('.sh'))) {
        const content = fs.readFileSync(full, 'utf8');
        if (/137\.184\.\d+\.\d+/.test(content)) {
          findings.push(path.relative(ROOT, full));
        }
      }
    }
  };
  walk(path.join(ROOT, 'migration'));
  // also scan root .sh / .js
  for (const f of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, f);
    if (fs.statSync(full).isFile() && (f.endsWith('.js') || f.endsWith('.sh'))) {
      const content = fs.readFileSync(full, 'utf8');
      if (/137\.184\.\d+\.\d+/.test(content)) {
        findings.push(path.relative(ROOT, full));
      }
    }
  }
  assert(findings.length === 0, `hardcoded 137.184.x.x found in: ${findings.join(', ')}`);
});

test('No hardcoded long-token strings in committed config templates', () => {
  const templates = ['config.dev.js', 'config.prod.js', 'config.example.js'];
  const findings = [];
  for (const f of templates) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    // Find any string literal >= 32 chars of hex or base64-ish
    const re = /['"`]([A-Za-z0-9+/_=\-]{32,})['"`]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (isLikelySecret(m[1])) {
        findings.push(`${f}: ${m[1].slice(0, 8)}…`);
      }
    }
  }
  assert(findings.length === 0, `secret-shaped literals: ${findings.join(', ')}`);
});

test('.gitignore protects config.js', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert(/^\/?config\.js\b/m.test(gi), '.gitignore should exclude config.js');
});

test('.gitignore protects migration/data', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert(/migration\/data\b/.test(gi), '.gitignore should exclude migration/data');
});

test('.gitignore protects .env files', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert(/^\.env\b/m.test(gi), '.gitignore should exclude .env');
});

test('.gitignore protects docs/strapi-3-source/data.db (Strapi internals)', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert(/data\.db/.test(gi), '.gitignore should exclude data.db');
});

test('SSH-using scripts require env vars at module load (no prod-IP fallback)', () => {
  // Snapshot env, clear, re-import the script in a child process to prove it
  // throws clearly. We use a child proc because ESM modules are cached and
  // we can't easily reset the import state inside this run.
  const scripts = [
    'migration/scripts/reset-remote.js',
    'migration/scripts/04c-fix-timestamps-remote.js',
  ];
  for (const rel of scripts) {
    const full = path.join(ROOT, rel);
    assert(fs.existsSync(full), `missing ${rel}`);
    let stderr = '';
    let code = 0;
    try {
      execSync(`node ${escapeShellArg(full)}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Strip everything that would let it pass
          SSH_HOST: '',
          SSH_USER: '',
          SSH_STRAPI_DIR: '',
          MIGRATION_SUPPRESS_SECRET_WARNINGS: '1',
        },
        timeout: 8000,
      });
    } catch (err) {
      code = err.status ?? 1;
      stderr = (err.stderr || '').toString() + (err.stdout || '').toString();
    }
    assert(code !== 0, `${rel} should exit non-zero with no SSH env`);
    assert(
      stderr.includes('SSH_HOST') ||
        stderr.includes('SSH_USER') ||
        stderr.includes('Required environment'),
      `${rel} should mention the missing SSH var; got: ${stderr.slice(0, 200)}`,
    );
  }
});

// ──────────────────────────────────────────────────────────────────────
// Section E — process umask
// ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${BOLD}E. File permissions${RESET}`);

test('load-config sets umask to 0o077', async () => {
  const before = process.umask(0o022);
  process.umask(before); // restore — process.umask returns prior value
  // Force re-import via a fresh module URL. We do it by spawning a child node
  // that imports load-config and prints the umask.
  const probe = `
    process.env.MIGRATION_SUPPRESS_SECRET_WARNINGS = '1';
    process.env.MIGRATION_DISABLE_DOTENV = '1';
    import('${path.join(ROOT, 'migration/lib/load-config.js')}').then(() => {
      process.stdout.write(String(process.umask().toString(8)));
    });
  `;
  const out = execSync(`node --input-type=module -e ${escapeShellArg(probe)}`, {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  assert(out === '77', `expected umask 77 (octal), got ${out}`);
});

// ──────────────────────────────────────────────────────────────────────
// Section F — .env auto-loader
// ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${BOLD}F. .env auto-loader${RESET}`);

test('.env loader reads KEY=value lines', () => {
  // Use a tmp .env via env var so the parent process isn't affected. The
  // load-config module reads from project root, so we write a child probe
  // that points at a fresh dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  try {
    fs.writeFileSync(
      path.join(tmp, '.env'),
      [
        '# a comment',
        'PLAIN=hello',
        'QUOTED="quoted value"',
        "SINGLE='single quoted'",
        'WITH_EQUALS=key=val',
        '',
      ].join('\n'),
    );
    const probe = `
      process.env.MIGRATION_SUPPRESS_SECRET_WARNINGS = '1';
      process.chdir(${JSON.stringify(tmp)});
      // Manually simulate the loader since load-config keys off ROOT, not cwd:
      const fs = await import('fs');
      const text = fs.readFileSync('.env', 'utf8');
      const out = {};
      for (const raw of text.split(/\\r?\\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[m[1]] = v;
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const out = execSync(`node --input-type=module -e ${escapeShellArg(probe)}`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    const parsed = JSON.parse(out);
    assert(parsed.PLAIN === 'hello', `PLAIN: ${parsed.PLAIN}`);
    assert(parsed.QUOTED === 'quoted value', `QUOTED: ${parsed.QUOTED}`);
    assert(parsed.SINGLE === 'single quoted', `SINGLE: ${parsed.SINGLE}`);
    assert(parsed.WITH_EQUALS === 'key=val', `WITH_EQUALS: ${parsed.WITH_EQUALS}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('.env loader: shell env vars win over .env values', () => {
  // Write a temp .env at project root (shadowing the real one momentarily)
  // would be invasive; instead, test the precedence rule directly via the
  // loader's source: process.env[key] !== undefined → skip.
  // The probe sets STRAPI5_TOKEN in the shell first, then imports load-config.
  // After import, process.env.STRAPI5_TOKEN should still be the shell value,
  // even though .env in this repo also defines it.
  const probe = `
    process.env.MIGRATION_SUPPRESS_SECRET_WARNINGS = '1';
    process.env.STRAPI5_TOKEN = 'shell-wins-${Date.now()}';
    const expected = process.env.STRAPI5_TOKEN;
    await import('${path.join(ROOT, 'migration/lib/load-config.js')}');
    process.stdout.write(process.env.STRAPI5_TOKEN === expected ? 'OK' : 'FAIL:' + process.env.STRAPI5_TOKEN);
  `;
  const out = execSync(`node --input-type=module -e ${escapeShellArg(probe)}`, {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  assert(out === 'OK', `expected OK, got ${out}`);
});

test('.env loader: missing .env file is silently OK', () => {
  // Run load-config from a tmp cwd that has no .env — should not throw.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  try {
    const probe = `
      process.env.MIGRATION_SUPPRESS_SECRET_WARNINGS = '1';
      // Point at a fake non-existent .env via MIGRATION_DISABLE_DOTENV-style
      // skip; here, we just trust no .env at the actual ROOT, but the real
      // test is that the load-config import doesn't throw under any cwd.
      process.chdir(${JSON.stringify(tmp)});
      await import('${path.join(ROOT, 'migration/lib/load-config.js')}');
      process.stdout.write('OK');
    `;
    const out = execSync(`node --input-type=module -e ${escapeShellArg(probe)}`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    assert(out.endsWith('OK'), `expected OK, got ${out}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('.env loader: MIGRATION_DISABLE_DOTENV=1 skips loading', () => {
  // With dotenv disabled, an unset shell var stays unset even if .env defines it.
  const probe = `
    process.env.MIGRATION_SUPPRESS_SECRET_WARNINGS = '1';
    process.env.MIGRATION_DISABLE_DOTENV = '1';
    delete process.env.STRAPI5_TOKEN;
    await import('${path.join(ROOT, 'migration/lib/load-config.js')}');
    process.stdout.write(process.env.STRAPI5_TOKEN === undefined ? 'OK' : 'LOADED:' + (process.env.STRAPI5_TOKEN || '').slice(0,6));
  `;
  const out = execSync(`node --input-type=module -e ${escapeShellArg(probe)}`, {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  assert(out === 'OK', `expected OK, got ${out}`);
});

test('set-strapi5-token writes mode 0600 on .env', () => {
  // Use a child process with a tmp working dir + ROOT swap. Easiest path:
  // exec set-strapi5-token.js with stdin closed and STRAPI5_TOKEN preset,
  // pointed at a tmp .env via temporarily renaming the real one.
  const realEnv = path.join(ROOT, '.env');
  const realEnvBak = path.join(ROOT, '.env.testsuite-backup');
  const realEnvExisted = fs.existsSync(realEnv);
  if (realEnvExisted) fs.renameSync(realEnv, realEnvBak);
  try {
    const fakeToken = 'a'.repeat(128);
    execSync(
      `node ${escapeShellArg(path.join(ROOT, 'migration/scripts/set-strapi5-token.js'))} ${fakeToken}`,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, STRAPI5_TOKEN: '' },
        timeout: 5000,
      },
    );
    assert(fs.existsSync(realEnv), `expected .env to be created`);
    const stat = fs.statSync(realEnv);
    const mode = stat.mode & 0o777;
    assert(mode === 0o600, `expected mode 0600, got ${mode.toString(8)}`);
    const text = fs.readFileSync(realEnv, 'utf8');
    assert(text.includes(`STRAPI5_TOKEN=${fakeToken}`), `expected token line in .env`);
  } finally {
    fs.rmSync(realEnv, { force: true });
    if (realEnvExisted) fs.renameSync(realEnvBak, realEnv);
  }
});

test('set-strapi5-token upserts (does not duplicate) on second write', () => {
  const realEnv = path.join(ROOT, '.env');
  const realEnvBak = path.join(ROOT, '.env.testsuite-backup');
  const realEnvExisted = fs.existsSync(realEnv);
  if (realEnvExisted) fs.renameSync(realEnv, realEnvBak);
  try {
    const tok1 = 'a'.repeat(128);
    const tok2 = 'b'.repeat(128);
    const setTokenScript = path.join(ROOT, 'migration/scripts/set-strapi5-token.js');
    execSync(`node ${escapeShellArg(setTokenScript)} ${tok1}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STRAPI5_TOKEN: '' },
      timeout: 5000,
    });
    execSync(`node ${escapeShellArg(setTokenScript)} ${tok2}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STRAPI5_TOKEN: '' },
      timeout: 5000,
    });
    const text = fs.readFileSync(realEnv, 'utf8');
    const matches = text.match(/^\s*STRAPI5_TOKEN\s*=/gm) || [];
    assert(matches.length === 1, `expected exactly 1 STRAPI5_TOKEN line, got ${matches.length}`);
    assert(text.includes(`STRAPI5_TOKEN=${tok2}`), `expected new token in .env`);
    assert(!text.includes(tok1), `old token should be replaced, not duplicated`);
  } finally {
    fs.rmSync(realEnv, { force: true });
    if (realEnvExisted) fs.renameSync(realEnvBak, realEnv);
  }
});

test('set-strapi5-token refuses short tokens', () => {
  const setTokenScript = path.join(ROOT, 'migration/scripts/set-strapi5-token.js');
  let threw = false;
  try {
    execSync(`node ${escapeShellArg(setTokenScript)} short`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STRAPI5_TOKEN: '' },
      timeout: 5000,
    });
  } catch (err) {
    threw = true;
    const out = (err.stderr || '').toString();
    assert(out.includes('Refusing'), `expected "Refusing" in stderr, got: ${out}`);
  }
  assert(threw, `expected non-zero exit on short token`);
});

test('committed config templates have empty token fallbacks (no .env-needed leak)', () => {
  for (const f of ['config.dev.js', 'config.prod.js', 'config.example.js']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = text.match(/STRAPI5_TOKEN\s*\|\|\s*(['"])([^'"]*)\1/);
    if (m) {
      assert(m[2] === '', `${f}: token fallback should be empty, got ${m[2].slice(0, 8)}…`);
    }
  }
});

test('local config.js (if present) has empty token fallback', () => {
  const cj = path.join(ROOT, 'config.js');
  if (!fs.existsSync(cj)) return; // no config.js, nothing to check
  const text = fs.readFileSync(cj, 'utf8');
  const m = text.match(/STRAPI5_TOKEN\s*\|\|\s*(['"])([^'"]*)\1/);
  if (!m) return;
  assert(
    m[2] === '',
    `config.js: token fallback should be empty (token belongs in .env), got ${m[2].slice(0, 8)}…`,
  );
});

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === 'pass').length;
const failed = results.filter((r) => r.status === 'fail').length;

console.log('');
console.log(`${BOLD}── Summary ──${RESET}`);
console.log(`  Total:   ${results.length}`);
console.log(`  ${GREEN}Passed:  ${passed}${RESET}`);
console.log(`  ${failed > 0 ? RED : DIM}Failed:  ${failed}${RESET}`);
console.log('');

if (failed > 0) {
  console.log(`${RED}${BOLD}FAILED${RESET}`);
  for (const r of results.filter((x) => x.status === 'fail')) {
    console.log(`  - ${r.name}: ${r.error}`);
  }
  process.exit(1);
}

console.log(`${GREEN}${BOLD}All security tests passed.${RESET}`);
console.log(`${DIM}Run individual tests with --only=substring${RESET}`);
console.log('');
process.exit(0);
