/**
 * PASS 4.5 entry point.
 *
 *   npm run pass4_5:dry            compute and print, write nothing
 *   npm run pass4_5:live           compute and write to Pipeline_Cache / Name_Conflicts
 *   npm run pass4_5 -- --dry-run --limit 50
 *   npm run pass4_5 -- --dry-run --batch-size 25 --pause-ms 1000   (fetch tuning, see docs/pass4_5-notes.md #1)
 *
 * Dry-run is the default: `--live` must be passed explicitly. There is no way to
 * write by omitting a flag. --limit/--batch-size/--pause-ms are dev/testing
 * conveniences, not in the spec.
 */

// Loads .env for local runs; a no-op in CI, where secrets are real env vars.
import 'dotenv/config';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { AttioClient } from '../lib/attio.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runPass45 } from '../passes/pass4_5/index.js';
import { buildSlackAddendum, renderReport } from '../passes/pass4_5/report.js';
import { isCivilDate, type CivilDate } from '../lib/dates.js';

interface Args {
  dryRun: boolean;
  limit: number | undefined;
  jsonOut: string | undefined;
  today: CivilDate | undefined;
  batchSize: number | undefined;
  pauseMs: number | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: true,
    limit: undefined,
    jsonOut: undefined,
    today: undefined,
    batchSize: undefined,
    pauseMs: undefined,
  };

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
      case '--today': {
        const v = argv[++i] ?? '';
        if (!isCivilDate(v)) throw new Error('--today needs YYYY-MM-DD');
        args.today = v;
        break;
      }
      case '--batch-size': {
        const v = Number.parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(v) || v <= 0) throw new Error('--batch-size needs a positive integer');
        args.batchSize = v;
        break;
      }
      case '--pause-ms': {
        const v = Number.parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(v) || v < 0) throw new Error('--pause-ms needs a non-negative integer');
        args.pauseMs = v;
        break;
      }
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

  const attio = new AttioClient({
    apiKey: env.ATTIO_API_KEY,
    baseUrl: env.ATTIO_API_BASE,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  attio retry ${attempt} in ${delayMs}ms`),
  });
  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });

  const report = await runPass45({
    dryRun: args.dryRun,
    // PASS 4.5 uses UTC per its own spec (datetime.now(timezone.utc).date()) —
    // independent of PASS 4's RUN_TIMEZONE, which is now also UTC (decided
    // 2026-07-17 to match this exact convention). Not read from env.RUN_TIMEZONE
    // on purpose: 4.5's TODAY was never ambiguous the way PASS 4's was.
    timezone: 'UTC',
    attio,
    sheets,
    logger,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.today !== undefined ? { today: args.today } : {}),
    ...(args.batchSize !== undefined ? { fetchBatchSize: args.batchSize } : {}),
    ...(args.pauseMs !== undefined ? { fetchPauseMs: args.pauseMs } : {}),
  });

  console.log(renderReport(report));

  const addendum = buildSlackAddendum(report);
  const slack =
    !args.dryRun && env.SLACK_WEBHOOK_URL
      ? createSlackPoster(env.SLACK_WEBHOOK_URL)
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no SLACK_WEBHOOK_URL'}). Would post:`);
          console.log(text);
        });
  await slack.post(addendum);

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }

  // An abort or a tab-absent skip is a real problem worth a non-zero exit;
  // withheld/unresolved rows are healthy refusals, same as PASS 4.
  if (report.aborted || report.skippedTabAbsent) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
