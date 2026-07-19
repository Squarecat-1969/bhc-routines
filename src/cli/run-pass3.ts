/**
 * PASS 3 entry point.
 *
 *   npm run pass3 -- --run-id LATE-EDITION-... --dry-run
 *   npm run pass3 -- --run-id LATE-EDITION-... --live
 *
 * Unlike every other pass, PASS 3 does not generate its own run_id — it
 * re-reads a SPECIFIC prior run's Brain_Complete output, so --run-id is
 * required. Find it in a PASS 2 run's log line ("run_id : LATE-EDITION-...")
 * or in Brain_Complete's Run_ID column (AB).
 */

import 'dotenv/config';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runPass3 } from '../passes/pass3/index.js';
import { renderReport } from '../passes/pass3/report.js';

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
      '--run-id is required — PASS 3 digests a specific prior run, it does not generate its own. ' +
        'Find it in that run\'s log ("run_id : LATE-EDITION-...") or Brain_Complete column AB.',
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

  const slack =
    !args.dryRun && env.SLACK_WEBHOOK_URL
      ? createSlackPoster(env.SLACK_WEBHOOK_URL)
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no SLACK_WEBHOOK_URL'}). Would post:`);
          logger.info(text);
        });

  const report = await runPass3({ runId: args.runId, dryRun: args.dryRun }, { sheets, slack, logger });

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
