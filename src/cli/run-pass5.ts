/**
 * PASS 5 entry point.
 *
 *   npm run pass5 -- --run-id LATE-EDITION-... --dry-run
 *   npm run pass5 -- --run-id LATE-EDITION-... --live
 *
 * Like PASS 3, --run-id is required — PASS 5 digests a specific prior run's
 * Brain_Complete output alongside a fresh (read-only) Attio pipeline sweep.
 */

import 'dotenv/config';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AttioClient } from '../lib/attio.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { runPass5 } from '../passes/pass5/index.js';
import { renderReport } from '../passes/pass5/report.js';

interface Args {
  runId: string;
  dryRun: boolean;
  jsonOut: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let runId: string | undefined;
  let dryRun = true;
  let jsonOut: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--live':
        dryRun = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--run-id':
        runId = argv[++i];
        if (!runId) throw new Error('--run-id needs a value');
        break;
      case '--json-out':
        jsonOut = argv[++i];
        if (!jsonOut) throw new Error('--json-out needs a path');
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!runId) {
    throw new Error(
      "--run-id is required — PASS 5 digests a specific prior run's Brain_Complete rows, it does not generate its own.",
    );
  }

  return { runId, dryRun, jsonOut };
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
  const attio = new AttioClient({
    apiKey: env.ATTIO_API_KEY,
    baseUrl: env.ATTIO_API_BASE,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  attio retry ${attempt} in ${delayMs}ms`),
  });

  const report = await runPass5({ runId: args.runId, dryRun: args.dryRun }, { sheets, attio, logger });

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
