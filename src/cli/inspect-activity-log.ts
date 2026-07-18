/**
 * Read-only Activity_Log reconnaissance.
 *
 * PASS 0's spec references "col J", "col N", "col P" on Activity_Log as if the
 * layout is already known, but nowhere in routines/BHC_Late_Edition.md is
 * Activity_Log's column layout spelled out explicitly the way Thread_Staging's
 * and Brain_Complete's are. Guessing at letter positions here is exactly the
 * mistake class that caused the last_interaction_at bug (docs/pass4-notes.md #4)
 * — so before writing any PASS 0 matching logic, get the real header row and a
 * few real sample rows.
 *
 * Zero write risk: this issues exactly two Sheets reads and prints them. Never
 * writes anything, never touches any other tab.
 *
 *   npm run inspect:activity-log
 */

import 'dotenv/config';

import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { columnLetter } from '../passes/pass4/load.js';

async function main(): Promise<void> {
  const logger = createLogger();
  const env = loadEnv();
  const sheets = new SheetsClient({ token: env.BRAIN_API_TOKEN, url: env.SHEETS_PROXY_URL });

  logger.info('Activity_Log reconnaissance — read-only, no writes');

  const headerRows = await sheets.read('Activity_Log!A1:U1', 'FORMATTED_VALUE');
  const header = headerRows[0];
  if (!header) {
    logger.warn('Activity_Log!A1:U1 came back empty — is the range/tab name right?');
    return;
  }

  logger.info('--- header row (Activity_Log!A1:U1) ---');
  header.forEach((title, i) => {
    logger.info(`  ${columnLetter(i)}[${i}] ${String(title ?? '').trim() || '(blank)'}`);
  });

  logger.info('--- three sample data rows (Activity_Log!A2:U4) ---');
  const sampleRows = await sheets.read('Activity_Log!A2:U4', 'FORMATTED_VALUE');
  sampleRows.forEach((row, rowIdx) => {
    logger.info(`  row ${rowIdx + 2}:`);
    row.forEach((value, i) => {
      const v = String(value ?? '').trim();
      if (v !== '') logger.info(`    ${columnLetter(i)}[${i}] (${header[i] ?? '?'}): ${v.slice(0, 120)}`);
    });
  });
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
