/**
 * PASS 0 entry point.
 *
 *   npm run pass0:dry            compute and print, write nothing
 *   npm run pass0:live           closes exact-match placeholders, enqueues inferred matches
 *
 * Dry-run is the default: `--live` must be passed explicitly.
 */

import 'dotenv/config';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { runPass0 } from '../passes/pass0/index.js';
import { renderReport } from '../passes/pass0/report.js';

interface Args {
  dryRun: boolean;
  jsonOut: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, jsonOut: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--live':
        args.dryRun = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
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

  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });

  const report = await runPass0({ dryRun: args.dryRun, sheets, logger });

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
