/**
 * PASS 2.5 entry point.
 *
 *   npm run pass2_5:dry     compute and print, write nothing (still calls the LLM)
 *   npm run pass2_5:live    writes to Reconciliation_Queue
 *   npm run pass2_5 -- --dry-run --limit 5
 */

import 'dotenv/config';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { AnthropicClient } from '../lib/anthropic.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { runPass25 } from '../passes/pass2_5/index.js';
import { renderReport } from '../passes/pass2_5/report.js';

interface Args {
  dryRun: boolean;
  limit: number | undefined;
  jsonOut: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, limit: undefined, jsonOut: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--live':
        args.dryRun = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--limit': {
        const v = Number.parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(v) || v <= 0) throw new Error('--limit needs a positive integer');
        args.limit = v;
        break;
      }
      case '--json-out':
        args.jsonOut = argv[++i];
        if (!args.jsonOut) throw new Error('--json-out needs a path');
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger();
  const env = loadEnv();

  if (!env.ANTHROPIC_BHC_ROUTINES_API) {
    throw new Error('ANTHROPIC_BHC_ROUTINES_API is required for PASS 2.5 (the reconciliation call needs it even in dry-run).');
  }

  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });
  const anthropic = new AnthropicClient({
    apiKey: env.ANTHROPIC_BHC_ROUTINES_API,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  anthropic retry ${attempt} in ${delayMs}ms`),
  });

  const report = await runPass25({
    dryRun: args.dryRun,
    sheets,
    anthropic,
    logger,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });

  console.log(renderReport(report));

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }

  if (report.aborted) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
