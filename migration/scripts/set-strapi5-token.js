/**
 * @module set-strapi5-token
 * @description Interactive prompt that writes a fresh Strapi 5 API token into
 * the project's `.env` file. Saves the friction of opening the file in an
 * editor and finding the right line.
 *
 * Usage:
 *   pnpm set-token             # prompts for the token
 *   pnpm set-token <token>     # accepts as positional arg
 *   STRAPI5_TOKEN=<token> pnpm set-token  # accepts via env var
 *
 * Behavior:
 *   - Upserts a `STRAPI5_TOKEN=<value>` line in the project-root `.env`.
 *   - If `.env` doesn't exist, creates it (mode 0600).
 *   - If the line already exists, replaces in place (preserves order /
 *     surrounding lines / comments).
 *   - If the line doesn't exist, appends it.
 *   - Refuses to write a short or whitespace-containing token.
 *
 * `.env` is gitignored. The token never lands in any committed config file.
 * The migration loader (migration/lib/load-config.js) auto-reads `.env` at
 * startup, so subsequent scripts see the token via process.env.STRAPI5_TOKEN.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const ENV_PATH = path.join(ROOT, '.env');

async function main() {
  let token = process.env.STRAPI5_TOKEN || process.argv[2] || '';

  if (!token) {
    console.log(`${BOLD}── Set Strapi 5 API token ──${RESET}`);
    console.log(`Paste the token (Full-access, generated in the Strapi 5 admin):`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    token = await new Promise((resolve) => {
      rl.question('  token: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!token) {
    console.log(`${YELLOW}No token entered — .env not modified.${RESET}`);
    process.exit(0);
  }

  // Sanity checks: hex string, 64+ chars, no whitespace or quotes.
  if (/[\s'"]/.test(token)) {
    console.error(`${RED}ERROR:${RESET} token contains whitespace or quotes — refusing to write.`);
    process.exit(1);
  }
  if (token.length < 64) {
    console.error(
      `${RED}ERROR:${RESET} token is only ${token.length} chars (Strapi 5 tokens are typically ~256). Refusing to write.`,
    );
    process.exit(1);
  }

  await upsertEnvVar(ENV_PATH, 'STRAPI5_TOKEN', token);

  console.log(`${GREEN}✓${RESET} Token written to ${CYAN}${path.relative(ROOT, ENV_PATH)}${RESET} ${DIM}(mode 0600)${RESET}`);
  console.log('');
  console.log(`Run ${CYAN}pnpm preflight${RESET} to verify the new token is valid.`);
}

/**
 * Set or replace a single KEY=value line in a `.env` file. Preserves the rest
 * of the file. Creates the file (mode 0600) if it doesn't exist.
 *
 * @param {string} envPath - absolute path to the .env file
 * @param {string} key - env var name (must match /^[A-Za-z_][A-Za-z0-9_]*$/)
 * @param {string} value - the value to store; written unquoted (Strapi tokens
 *                        are alphanumeric/hex, no special chars)
 */
async function upsertEnvVar(envPath, key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid env var name: ${key}`);
  }
  if (/\r|\n/.test(value)) {
    throw new Error(`Refusing to write a value containing a newline`);
  }
  const newLine = `${key}=${value}`;

  if (!existsSync(envPath)) {
    const banner = [
      `# Migration tool secrets — gitignored, owner-only (mode 0600).`,
      `# Loaded automatically by migration/lib/load-config.js. Shell-set env vars`,
      `# always win over values here, so \`export ${key}=...\` in a calling shell`,
      `# still overrides this file.`,
      `#`,
      `# See .env.example for the full list of recognized keys.`,
      ``,
      newLine,
      ``,
    ].join('\n');
    await fs.writeFile(envPath, banner, { mode: 0o600 });
    return;
  }

  const text = await fs.readFile(envPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const updated = lines.map((line) => {
    if (replaced) return line;
    if (re.test(line)) {
      replaced = true;
      return newLine;
    }
    return line;
  });
  if (!replaced) {
    // Append before any trailing blank lines so the file stays tidy.
    while (updated.length && updated[updated.length - 1] === '') updated.pop();
    updated.push(newLine, '');
  }
  await fs.writeFile(envPath, updated.join('\n'), { mode: 0o600 });
  // Re-assert mode in case the file existed with looser perms before
  await fs.chmod(envPath, 0o600);
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
