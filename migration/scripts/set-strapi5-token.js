/**
 * @module set-strapi5-token
 * @description Interactive prompt that writes a fresh Strapi 5 API token into
 * config.js. Saves the friction of opening the file in an editor and
 * navigating to the right line.
 *
 * Usage:
 *   pnpm set-token             # prompts for the token
 *   pnpm set-token <token>     # accepts as positional arg
 *   STRAPI5_TOKEN=<token> pnpm set-token  # accepts via env var
 *
 * The script edits config.js by replacing the existing
 *   token: process.env.STRAPI5_TOKEN || '<old>',
 * with the new value. It refuses to write an empty/short token.
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

const CONFIG_JS = path.join(ROOT, 'config.js');

async function main() {
  if (!existsSync(CONFIG_JS)) {
    console.error(`${RED}ERROR:${RESET} ${CONFIG_JS} not found.`);
    console.error(`Run ${CYAN}cp config.dev.js config.js${RESET} first, or run ${CYAN}install-strapi5.sh${RESET}.`);
    process.exit(1);
  }

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
    console.log(`${YELLOW}No token entered — config.js not modified.${RESET}`);
    process.exit(0);
  }

  // Sanity checks: hex string, 64+ chars, no whitespace or quotes.
  if (/[\s'"]/.test(token)) {
    console.error(`${RED}ERROR:${RESET} token contains whitespace or quotes — refusing to write.`);
    process.exit(1);
  }
  if (token.length < 64) {
    console.error(`${RED}ERROR:${RESET} token is only ${token.length} chars (Strapi 5 tokens are typically ~256). Refusing to write.`);
    process.exit(1);
  }

  let content = await fs.readFile(CONFIG_JS, 'utf8');
  const before = content;
  content = content.replace(
    /(process\.env\.STRAPI5_TOKEN \|\| ')[^']*(')/g,
    `$1${token}$2`,
  );

  if (content === before) {
    console.error(`${RED}ERROR:${RESET} couldn't find the token line in ${CONFIG_JS}.`);
    console.error(`Expected: ${DIM}token: process.env.STRAPI5_TOKEN || '...'${RESET}`);
    process.exit(1);
  }

  await fs.writeFile(CONFIG_JS, content);
  console.log(`${GREEN}✓${RESET} Token written to ${CYAN}${path.relative(ROOT, CONFIG_JS)}${RESET}`);
  console.log('');
  console.log(`Run ${CYAN}pnpm preflight${RESET} to verify the new token is valid.`);
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
