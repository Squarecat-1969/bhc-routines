/**
 * Resync IDs runner.
 *
 *   npm run resync-ids:dry    # compute + report, writes nothing
 *   npm run resync-ids:live   # writes Master_ID col D corrections
 *
 * Dry-run is the default; --live must be explicit, same contract as every
 * other routine in this repo.
 */
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runResyncIds } from '../passes/resync-ids/index.js';

interface Args {
  dryRun: boolean;
  jsonOut: string | undefined;
  runId: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, jsonOut: undefined, runId: undefined };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': args.dryRun = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json-out':
        args.jsonOut = argv[++i];
        if (!args.jsonOut) throw new Error('--json-out needs a path');
        break;
      case '--run-id':
        args.runId = argv[++i];
        if (!args.runId) throw new Error('--run-id needs a value');
        break;
      default: break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const logger = createLogger();
  const runId = args.runId ?? `RESYNC-${Date.now()}`;

  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });

  const slack =
    !args.dryRun && env.ZAPIER_SLACK_HOOK_URL
      ? createSlackPoster({ hookUrl: env.ZAPIER_SLACK_HOOK_URL })
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no ZAPIER_SLACK_HOOK_URL'}). Would post:`);
          console.log(text);
        });

  const report = await runResyncIds({ sheets, logger, slack, dryRun: args.dryRun, runId });

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }

  if (report.warnings.length > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
