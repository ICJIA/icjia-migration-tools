/**
 * @module set-strapi5-url
 * @description Interactive script to update the Strapi 5 API URL and token
 * across all config files in one step.
 *
 * Prompts for the Strapi 5 URL (e.g., https://v2.hub.icjia-api.cloud)
 * and optionally the API token, then updates config.js automatically.
 *
 * @example
 *   pnpm set-strapi5
 *   # or: node migration/scripts/set-strapi5-url.js
 */

import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Prompt the user for input.
 * @param {string} question
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
function prompt(question, defaultValue) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function main() {
  console.log('');
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║         Configure Strapi 5 Connection                   ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  // Check if config.js exists
  const configPath = path.join(ROOT, 'config.js');
  let configExists = false;
  try {
    await fs.access(configPath);
    configExists = true;
  } catch { /* doesn't exist */ }

  if (!configExists) {
    console.log(`${YELLOW}config.js not found. Creating from config.dev.js...${RESET}`);
    await fs.copyFile(path.join(ROOT, 'config.dev.js'), configPath);
    console.log(`${GREEN}✓ config.js created${RESET}\n`);
  }

  // Read current config
  const configSource = await fs.readFile(configPath, 'utf8');

  // Extract current values for defaults
  const currentUrl = configSource.match(/apiUrl:\s*['"]([^'"]+)['"]/)?.[1] || 'http://localhost:1338';
  const currentGql = configSource.match(/graphqlUrl:\s*['"]([^'"]+)['"]/)?.[1] || '';

  console.log(`Current Strapi 5 URL: ${CYAN}${currentUrl}${RESET}\n`);

  // Prompt for new URL — always default to localhost:1338 (the standard dev setup)
  const defaultUrl = 'http://localhost:1338';
  const newUrl = await prompt('Strapi 5 API URL', defaultUrl);

  // Derive GraphQL URL
  const newGql = newUrl.replace(/\/$/, '') + '/graphql';

  // Prompt for token
  console.log('');
  const newToken = await prompt('Strapi 5 API Token (paste full token, or press Enter to keep current)', '');

  // Prompt for DB path (only relevant for local)
  let newDbPath = '';
  if (newUrl.includes('localhost') || newUrl.includes('127.0.0.1')) {
    console.log('');
    newDbPath = await prompt('Strapi 5 SQLite DB path (for timestamp fix)', '../strapi5-researchhub/.tmp/data.db');
  }

  // Update config.js
  let updated = configSource;

  // Update strapi5 block
  // Replace apiUrl
  updated = updated.replace(
    /(strapi5:\s*\{[^}]*apiUrl:\s*)(process\.env\.\w+\s*\|\|\s*)?['"][^'"]*['"]/s,
    `$1'${newUrl}'`
  );

  // Replace graphqlUrl
  updated = updated.replace(
    /(strapi5:\s*\{[^}]*graphqlUrl:\s*)(process\.env\.\w+\s*\|\|\s*)?['"][^'"]*['"]/s,
    `$1'${newGql}'`
  );

  // Replace token if provided
  if (newToken) {
    updated = updated.replace(
      /(strapi5:\s*\{[^}]*token:\s*)(process\.env\.\w+\s*\|\|\s*)?['"][^'"]*['"]/s,
      `$1'${newToken}'`
    );
  }

  // Replace dbPath if provided
  if (newDbPath) {
    updated = updated.replace(
      /(strapi5:\s*\{[^}]*dbPath:\s*)(process\.env\.\w+\s*\|\|\s*)?['"][^'"]*['"]/s,
      `$1'${newDbPath}'`
    );
  }

  await fs.writeFile(configPath, updated);

  // Verify by loading the config
  console.log('');
  console.log(`${GREEN}✓ config.js updated${RESET}`);
  console.log('');
  console.log('New Strapi 5 settings:');
  console.log(`  API URL:     ${CYAN}${newUrl}${RESET}`);
  console.log(`  GraphQL URL: ${CYAN}${newGql}${RESET}`);
  console.log(`  Token:       ${newToken ? `${GREEN}(set, ${newToken.length} chars)${RESET}` : `${YELLOW}(unchanged)${RESET}`}`);
  if (newDbPath) {
    console.log(`  DB path:     ${CYAN}${newDbPath}${RESET}`);
  }

  // Test connectivity
  console.log('\nTesting connection...');
  try {
    const res = await fetch(newUrl, { signal: AbortSignal.timeout(10000) });
    if (res.ok || res.status === 403 || res.status === 401) {
      console.log(`  ${GREEN}✓ Strapi 5 is reachable at ${newUrl} (HTTP ${res.status})${RESET}`);
    } else {
      console.log(`  ${YELLOW}⚠ Got HTTP ${res.status} from ${newUrl}${RESET}`);
    }
  } catch (err) {
    console.log(`  ${RED}✗ Cannot reach ${newUrl}: ${err.message}${RESET}`);
    console.log(`  ${YELLOW}Check the URL and try again. The config has been saved — you can edit config.js manually.${RESET}`);
  }

  console.log(`\n${GREEN}Done.${RESET} All migration scripts will now use the new Strapi 5 URL.\n`);

  // Offer to start Phase 1
  const startPhase1 = await prompt('Start Phase 1 (Schema Setup)? [Y/n]', 'y');
  if (startPhase1 === '' || startPhase1.toLowerCase() === 'y' || startPhase1.toLowerCase() === 'yes') {
    console.log('');
    const { spawn } = await import('child_process');
    const child = spawn('node', ['migration/scripts/01-run-phase.js'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => process.exit(code ?? 0));
  }
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
  process.exit(1);
});
