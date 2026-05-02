/**
 * @module fix-tables
 * @description Fix malformed markdown tables in Strapi 5 articles.
 *
 * Scans all articles for markdown tables with formatting issues:
 * - Missing trailing pipes on rows
 * - Inconsistent leading pipes/spacing
 * - Wrong separator column count
 * - Tabs mixed with spaces
 * - Inconsistent cell padding
 *
 * Modes:
 *   --dry-run   Identify broken tables, show before/after, validate (default)
 *   --fix       Apply fixes via PUT to Strapi 5 REST API
 *
 * @example
 *   node migration/scripts/fix-tables.js --dry-run
 *   node migration/scripts/fix-tables.js --fix
 */

import MarkdownIt from 'markdown-it';
import { loadConfig } from '../lib/load-config.js';
import { RestClient } from '../lib/rest-client.js';

const md = new MarkdownIt();

const config = await loadConfig();

const DRY_RUN = !process.argv.includes('--fix');
const VERBOSE = process.argv.includes('--verbose');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const client = new RestClient(config.strapi5.apiUrl, {
  token: config.strapi5.token,
  timeoutMs: config.settings?.requestTimeoutMs || 30000,
});

// ── Table detection & parsing ────────────────────────────────────────

/**
 * Find all markdown table regions in a text.
 * A table region starts with a line containing `|` and includes
 * the separator row (containing `---`).
 *
 * Returns array of { start, end, lines } where start/end are line indices.
 */
function findTableRegions(markdown) {
  const lines = markdown.split('\n');
  const regions = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for potential table start: a line with pipes
    if (line.includes('|') && !isHorizontalRule(line)) {
      // Scan ahead to find separator row (must be within first 3 lines of table)
      let sepIdx = -1;
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        if (isSeparatorRow(lines[j])) {
          sepIdx = j;
          break;
        }
      }

      if (sepIdx >= 0) {
        // Found a table. Now find where it ends.
        let end = sepIdx + 1;
        while (end < lines.length) {
          const tl = lines[end].trim();
          // Table continues if line has pipes or is empty (blank line within table)
          if (tl.startsWith('|') || (tl.includes('|') && !isNoteOrParagraph(tl))) {
            end++;
          } else {
            break;
          }
        }

        // Check if the line immediately after the table is non-empty (needs blank line)
        const nextLine = end < lines.length ? lines[end].trim() : '';
        const needsBlank = nextLine.length > 0 && !nextLine.startsWith('|');

        regions.push({
          start: i,
          end: end, // exclusive
          lines: lines.slice(i, end),
          sepIdx: sepIdx - i, // relative index of separator within region
          _needsTrailingBlankLine: needsBlank,
        });

        i = end;
        continue;
      }
    }
    i++;
  }

  return regions;
}

function isHorizontalRule(line) {
  const trimmed = line.trim();
  return /^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed) || /^_{3,}$/.test(trimmed);
}

function isSeparatorRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('---') && !trimmed.includes('--')) return false;
  // Must have pipes and dashes, cells like :---, ---:, :---:, ---
  const cells = splitRow(trimmed);
  if (cells.length === 0) return false;
  const sepCells = cells.filter(c => /^\s*:?-{2,}:?\s*$/.test(c));
  // At least half the cells should be separator-like
  return sepCells.length > 0 && sepCells.length >= cells.length * 0.5;
}

function isNoteOrParagraph(line) {
  // Lines that start with *Note or regular text (not table rows)
  const trimmed = line.trim();
  if (trimmed.startsWith('*Note') || trimmed.startsWith('Note.') || trimmed.startsWith('Note:')) return true;
  // If it doesn't start with | it's probably not a table row
  if (!trimmed.startsWith('|')) return true;
  return false;
}

/**
 * Split a table row into cells (content between pipes).
 * Handles leading/trailing pipes and trims whitespace.
 */
function splitRow(line) {
  // Normalize tabs to spaces
  let normalized = line.replace(/\t/g, ' ');
  normalized = normalized.trim();

  // Remove leading pipe
  if (normalized.startsWith('|')) normalized = normalized.substring(1);
  // Remove trailing pipe
  if (normalized.endsWith('|')) normalized = normalized.slice(0, -1);

  if (normalized.trim() === '') return [];

  return normalized.split('|').map(c => c.trim());
}

// ── Table analysis & fixing ──────────────────────────────────────────

/**
 * Analyze a table region for formatting issues.
 */
function analyzeTable(region) {
  const issues = [];
  const { lines, sepIdx } = region;

  // Determine column count from header row (line before separator)
  const headerIdx = sepIdx > 0 ? sepIdx - 1 : 0;
  const headerCells = splitRow(lines[headerIdx]);
  const sepCells = splitRow(lines[sepIdx]);

  // The true column count: use the header row
  const colCount = headerCells.length;

  if (colCount === 0) {
    issues.push('Could not determine column count from header');
    return { issues, colCount: 0 };
  }

  // Check separator column count matches
  if (sepCells.length !== colCount) {
    issues.push(`Separator has ${sepCells.length} columns but header has ${colCount}`);
  }

  // Check each data row
  for (let i = 0; i < lines.length; i++) {
    if (i === headerIdx || i === sepIdx) continue;
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cells = splitRow(line);

    // Missing trailing pipe
    if (!trimmed.endsWith('|')) {
      issues.push(`Row ${i + 1}: missing trailing pipe`);
    }

    // Missing leading pipe
    if (!trimmed.startsWith('|')) {
      issues.push(`Row ${i + 1}: missing leading pipe`);
    }

    // Wrong column count
    if (cells.length !== colCount && cells.length > 0) {
      issues.push(`Row ${i + 1}: has ${cells.length} columns, expected ${colCount}`);
    }

    // Tabs in content
    if (line.includes('\t')) {
      issues.push(`Row ${i + 1}: contains tabs`);
    }
  }

  // Check: missing blank line after table (will cause next content to be swallowed)
  if (region._needsTrailingBlankLine) {
    issues.push('No blank line after table — following text will be rendered as a table row');
  }

  return { issues, colCount };
}

/**
 * Reformat a table region into a proper markdown table.
 * - Normalizes column count based on header
 * - Adds consistent leading/trailing pipes
 * - Normalizes whitespace
 * - Pads cells for alignment
 */
function reformatTable(region) {
  const { lines, sepIdx } = region;
  const headerIdx = sepIdx > 0 ? sepIdx - 1 : 0;

  // Parse all rows into cell arrays
  const headerCells = splitRow(lines[headerIdx]);
  const colCount = headerCells.length;

  if (colCount === 0) return null;

  // Parse separator to preserve alignment hints
  const sepCells = splitRow(lines[sepIdx]);
  const alignments = [];
  for (let c = 0; c < colCount; c++) {
    const sep = (sepCells[c] || '---').trim();
    if (sep.startsWith(':') && sep.endsWith(':')) {
      alignments.push('center');
    } else if (sep.endsWith(':')) {
      alignments.push('right');
    } else {
      alignments.push('left');
    }
  }

  // Collect all data rows (everything except header and separator)
  const dataRows = [];

  // Include any rows before header (unusual but handle it)
  for (let i = 0; i < headerIdx; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && trimmed.includes('|')) {
      dataRows.push(splitRow(lines[i]));
    }
  }

  for (let i = sepIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const cells = splitRow(lines[i]);
    if (cells.length > 0) {
      dataRows.push(cells);
    }
  }

  // Normalize all rows to correct column count
  const allRows = [headerCells, ...dataRows];
  for (const row of allRows) {
    while (row.length < colCount) row.push('');
    if (row.length > colCount) row.length = colCount;
  }

  // Calculate max width per column
  const colWidths = new Array(colCount).fill(3); // minimum 3 for ---
  for (const row of allRows) {
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(colWidths[c], (row[c] || '').length);
    }
  }

  // Build formatted rows
  function formatRow(cells) {
    const parts = cells.map((cell, c) => {
      const width = colWidths[c];
      const padded = (cell || '').padEnd(width);
      return ` ${padded} `;
    });
    return '|' + parts.join('|') + '|';
  }

  function formatSep() {
    const parts = alignments.map((align, c) => {
      const width = colWidths[c];
      let dash = '-'.repeat(width);
      if (align === 'left') return ` :${dash.slice(1)} `;
      if (align === 'right') return ` ${dash.slice(1)}: `;
      if (align === 'center') return ` :${dash.slice(2)}: `;
      return ` ${dash} `;
    });
    return '|' + parts.join('|') + '|';
  }

  const formatted = [];
  formatted.push(formatRow(allRows[0])); // header
  formatted.push(formatSep()); // separator
  for (let i = 1; i < allRows.length; i++) {
    formatted.push(formatRow(allRows[i]));
  }

  return formatted.join('\n');
}

// ── Markdown table spec validation ───────────────────────────────────

/**
 * Validate a formatted table by rendering it through markdown-it.
 *
 * Checks:
 * 1. markdown-it produces a <table> element (proves it parsed as a table)
 * 2. The rendered table has the expected number of header columns
 * 3. Every <tr> in <tbody> has the same column count as <thead>
 * 4. The total row count matches (header + data rows)
 *
 * Returns an array of validation errors (empty = valid).
 */
function validateTable(tableStr) {
  const errors = [];
  const lines = tableStr.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    errors.push('Table must have at least a header and separator row');
    return errors;
  }

  // Structural checks first
  const headerCells = splitRow(lines[0]);
  const colCount = headerCells.length;
  const expectedDataRows = lines.length - 2; // minus header and separator

  // Render through markdown-it
  const html = md.render(tableStr);

  // Check 1: Did it produce a <table>?
  if (!html.includes('<table>')) {
    errors.push('markdown-it did NOT render this as a <table> — it will not display as a table');
    return errors;
  }

  // Check 2: Count <th> cells in <thead> (exclude <thead> tag itself)
  const thMatches = html.match(/<th[\s>]/g);
  const renderedCols = thMatches ? thMatches.length : 0;
  if (renderedCols !== colCount) {
    errors.push(`Render: <thead> has ${renderedCols} columns, expected ${colCount}`);
  }

  // Check 3: Count <tr> rows in <tbody>
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (tbodyMatch) {
    const tbodyRows = (tbodyMatch[1].match(/<tr>/g) || []).length;
    if (tbodyRows !== expectedDataRows) {
      errors.push(`Render: <tbody> has ${tbodyRows} rows, expected ${expectedDataRows}`);
    }

    // Check 4: Each row has correct number of <td> cells
    const rowHtmls = tbodyMatch[1].split('<tr>').filter(r => r.trim());
    for (let i = 0; i < rowHtmls.length; i++) {
      const tdCount = (rowHtmls[i].match(/<td[\s>]/g) || []).length;
      if (tdCount !== colCount) {
        errors.push(`Render: data row ${i + 1} has ${tdCount} cells, expected ${colCount}`);
      }
    }
  } else if (expectedDataRows > 0) {
    errors.push(`Render: no <tbody> found, expected ${expectedDataRows} data rows`);
  }

  return errors;
}

// ── Main ─────────────────────────────────────────────────────────────

async function fetchAllArticles() {
  const pageSize = 100;
  let page = 1;
  let all = [];
  let hasMore = true;

  console.log(`${CYAN}Fetching articles from ${config.strapi5.apiUrl}...${RESET}`);

  while (hasMore) {
    const json = await client.get('/api/articles', {
      'pagination[pageSize]': pageSize,
      'pagination[page]': page,
      'fields[0]': 'title',
      'fields[1]': 'markdown',
      'fields[2]': 'documentId',
    });

    const records = json.data || [];
    all = all.concat(records);

    const pagination = json.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(`${GREEN}Fetched ${all.length} articles${RESET}\n`);
  return all;
}

async function main() {
  console.log(`\n${BOLD}Markdown Table Fixer${RESET}`);
  console.log(`Mode: ${DRY_RUN ? `${YELLOW}DRY RUN${RESET} (use --fix to apply changes)` : `${RED}LIVE FIX${RESET}`}\n`);

  const articles = await fetchAllArticles();

  let totalTablesFound = 0;
  let totalIssuesFound = 0;
  let articlesWithIssues = 0;
  let fixedCount = 0;
  const summary = [];

  for (const article of articles) {
    if (!article.markdown) continue;

    const regions = findTableRegions(article.markdown);
    if (regions.length === 0) continue;

    totalTablesFound += regions.length;

    const articleIssues = [];
    const fixes = [];

    for (let t = 0; t < regions.length; t++) {
      const region = regions[t];
      const { issues, colCount } = analyzeTable(region);

      if (issues.length === 0) continue;

      totalIssuesFound += issues.length;
      articleIssues.push({ tableIndex: t, issues, region, colCount });

      // Attempt to reformat
      const reformatted = reformatTable(region);
      if (reformatted) {
        const validationErrors = validateTable(reformatted);
        fixes.push({
          tableIndex: t,
          original: region.lines.join('\n'),
          reformatted,
          validationErrors,
          region,
        });
      }
    }

    if (articleIssues.length === 0) continue;

    articlesWithIssues++;

    console.log(`${'─'.repeat(80)}`);
    console.log(`${BOLD}${article.title}${RESET}`);
    console.log(`${DIM}documentId: ${article.documentId}${RESET}`);
    console.log(`Tables found: ${regions.length}, with issues: ${articleIssues.length}\n`);

    for (const fix of fixes) {
      console.log(`  ${CYAN}Table ${fix.tableIndex + 1}:${RESET}`);

      // Show issues
      const { issues } = articleIssues.find(a => a.tableIndex === fix.tableIndex);
      for (const issue of issues.slice(0, 5)) {
        console.log(`    ${YELLOW}! ${issue}${RESET}`);
      }
      if (issues.length > 5) {
        console.log(`    ${DIM}... and ${issues.length - 5} more issues${RESET}`);
      }

      // Show before/after
      console.log(`\n  ${RED}BEFORE:${RESET}`);
      for (const line of fix.original.split('\n').slice(0, 8)) {
        console.log(`    ${DIM}${line}${RESET}`);
      }
      if (fix.original.split('\n').length > 8) {
        console.log(`    ${DIM}... (${fix.original.split('\n').length} rows total)${RESET}`);
      }

      console.log(`\n  ${GREEN}AFTER:${RESET}`);
      for (const line of fix.reformatted.split('\n').slice(0, 8)) {
        console.log(`    ${line}`);
      }
      if (fix.reformatted.split('\n').length > 8) {
        console.log(`    ${DIM}... (${fix.reformatted.split('\n').length} rows total)${RESET}`);
      }

      // Validation
      if (fix.validationErrors.length === 0) {
        console.log(`\n  ${GREEN}VALIDATION: PASS${RESET} - Table meets markdown spec`);
      } else {
        console.log(`\n  ${RED}VALIDATION: FAIL${RESET}`);
        for (const err of fix.validationErrors) {
          console.log(`    ${RED}✗ ${err}${RESET}`);
        }
      }
      console.log();
    }

    // Apply fixes if not dry run
    if (!DRY_RUN) {
      const allValid = fixes.every(f => f.validationErrors.length === 0);
      if (!allValid) {
        console.log(`  ${RED}SKIPPING - validation errors found${RESET}\n`);
        summary.push({ title: article.title, status: 'skipped', reason: 'validation errors' });
        continue;
      }

      // Build the new markdown by replacing table regions
      let newMarkdown = article.markdown;
      // Process fixes in reverse order so indices don't shift
      const sortedFixes = [...fixes].sort((a, b) => b.region.start - a.region.start);

      const mdLines = newMarkdown.split('\n');
      for (const fix of sortedFixes) {
        const { start, end } = fix.region;
        const reformattedLines = fix.reformatted.split('\n');
        // Add blank line after table if next line is non-empty non-table text
        if (fix.region._needsTrailingBlankLine) {
          reformattedLines.push('');
        }
        mdLines.splice(start, end - start, ...reformattedLines);
      }
      newMarkdown = mdLines.join('\n');

      try {
        await client.put(`/api/articles/${article.documentId}`, {
          markdown: newMarkdown,
        });
        fixedCount++;
        console.log(`  ${GREEN}UPDATED via REST API${RESET}\n`);
        summary.push({ title: article.title, status: 'fixed' });

        // Respect rate limiting
        const delay = config.settings?.requestDelayMs || 100;
        await new Promise(r => setTimeout(r, delay));
      } catch (err) {
        console.log(`  ${RED}ERROR: ${err.message}${RESET}\n`);
        summary.push({ title: article.title, status: 'error', reason: err.message });
      }
    } else {
      summary.push({
        title: article.title,
        tables: fixes.length,
        allValid: fixes.every(f => f.validationErrors.length === 0),
      });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`${'═'.repeat(80)}`);
  console.log(`${BOLD}Summary${RESET}\n`);
  console.log(`  Total articles scanned:     ${articles.length}`);
  console.log(`  Articles with tables:        ${articles.filter(a => a.markdown && findTableRegions(a.markdown).length > 0).length}`);
  console.log(`  Tables found:                ${totalTablesFound}`);
  console.log(`  Articles with issues:        ${articlesWithIssues}`);
  console.log(`  Total formatting issues:     ${totalIssuesFound}`);

  if (!DRY_RUN) {
    console.log(`  Articles fixed:              ${fixedCount}`);
    const skipped = summary.filter(s => s.status === 'skipped').length;
    const errors = summary.filter(s => s.status === 'error').length;
    if (skipped) console.log(`  ${YELLOW}Articles skipped:          ${skipped}${RESET}`);
    if (errors) console.log(`  ${RED}Articles with errors:      ${errors}${RESET}`);
  } else {
    const valid = summary.filter(s => s.allValid).length;
    const invalid = summary.filter(s => !s.allValid).length;
    console.log(`\n  ${GREEN}Ready to fix (valid):      ${valid}${RESET}`);
    if (invalid) console.log(`  ${RED}Need review (invalid):     ${invalid}${RESET}`);
    console.log(`\n  ${DIM}Run with --fix to apply changes${RESET}`);
  }
  console.log();
}

main().catch(err => {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  process.exit(1);
});
