/**
 * Zoom DISCOVERY runner.
 *
 *   npm run zoom-discovery:dry    # reads Fathom + Sheets, writes NOTHING
 *   npm run zoom-discovery:live   # appends Zoom_Staging, backfills toplines, posts Slack
 *
 * Dry-run is the default; --live must be explicit. Mirrors run-reconciler.ts.
 */
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { FathomClient } from '../lib/fathom.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { buildSlackMessage, runZoomDiscovery } from '../passes/zoom-discovery.js';

interface Args {
  dryRun: boolean;
  jsonOut: string | undefined;
  runId: string | undefined;
  limit: number | undefined;
  lookbackHours: number | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, jsonOut: undefined, runId: undefined, limit: undefined, lookbackHours: undefined };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': args.dryRun = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json-out': args.jsonOut = argv[++i]; if (!args.jsonOut) throw new Error('--json-out needs a path'); break;
      case '--run-id': args.runId = argv[++i]; if (!args.runId) throw new Error('--run-id needs a value'); break;
      case '--limit': {
        const v = argv[++i];
        if (!v) throw new Error('--limit needs a number');
        args.limit = Number.parseInt(v, 10);
        if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error(`--limit must be a positive number, got ${v}`);
        break;
      }
      case '--lookback-hours': {
        const v = argv[++i];
        if (!v) throw new Error('--lookback-hours needs a number');
        args.lookbackHours = Number.parseInt(v, 10);
        if (!Number.isFinite(args.lookbackHours) || args.lookbackHours <= 0) throw new Error(`--lookback-hours must be a positive number, got ${v}`);
        break;
      }
      default: break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const logger = createLogger();
  const runId = args.runId ?? `ZOOM-DISC-${Date.now()}`;

  // FATHOM_API_KEY is optional in the shared env schema so every OTHER routine
  // still loads without it; this is the one routine that genuinely needs it, so
  // it fails here, loudly, rather than at the first request.
  if (!env.FATHOM_API_KEY) {
    throw new Error('FATHOM_API_KEY is required for Zoom DISCOVERY. Set it in .env locally and as a repository Actions secret.');
  }

  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN, url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });
  const fathom = new FathomClient({
    apiKey: env.FATHOM_API_KEY,
    ...(env.FATHOM_API_BASE ? { baseUrl: env.FATHOM_API_BASE } : {}),
    onRetry: ({ attempt, delayMs }) => logger.warn(`  fathom retry ${attempt} in ${delayMs}ms (rate limit or transient)`),
  });
  const slack =
    !args.dryRun && env.ZAPIER_SLACK_HOOK_URL
      ? createSlackPoster({ hookUrl: env.ZAPIER_SLACK_HOOK_URL })
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no ZAPIER_SLACK_HOOK_URL'}). Would post:`);
          console.log(text);
        });

  const report = await runZoomDiscovery({
    sheets, fathom, logger, dryRun: args.dryRun, runId,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.lookbackHours !== undefined ? { lookbackHours: args.lookbackHours } : {}),
  });

  logger.info('');
  logger.info(`existing rows   : ${report.existingRows}`);
  logger.info(`fetched         : ${report.fetched}`);
  logger.info(`appended        : ${report.appended.length}${report.appendedWithoutTopline.length > 0 ? ` (${report.appendedWithoutTopline.length} without a topline)` : ''}`);
  logger.info(`skipped dupe    : ${report.skippedDuplicate}`);
  logger.info(`skipped by age  : ${report.skippedOlderThanCutoff}`);
  logger.info(`backfilled      : ${report.backfilled.length} of ${report.backfillCandidates} candidate(s)`);
  if (report.dryRun) {
    logger.info(`would-write: ${report.wouldWrite.length}`);
    for (const w of report.wouldWrite.slice(0, 20)) logger.info(`  ${w}`);
  }

  // Only when something was actually written. A sweep announcing "nothing
  // found" 48 times a day is worse than silence.
  const message = buildSlackMessage(report);
  if (message === null) {
    logger.info('No rows added or backfilled - Slack deliberately silent.');
  } else if (args.dryRun) {
    logger.info('DRY RUN - Slack suppressed. Would post:');
    logger.info(message);
  } else {
    await slack.post(message);
  }

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
