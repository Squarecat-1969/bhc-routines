/**
 * PASS 2.6 runner — calendar-evidence reconciliation.
 *
 *   npm run pass2_6:dry    # reads Graph + Sheets, writes NOTHING
 *   npm run pass2_6:live   # writes Reconciliation_Queue + Pass26_Watermark
 *
 * Dry-run is the default; --live must be explicit. Mirrors run-reconciler.ts.
 *
 * --skip-queue-write exercises the watermark live while leaving
 * Reconciliation_Queue untouched. It exists because the queue write is gated
 * behind human review of a dry run, and proving watermark suppression needs a
 * real write.
 */
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { CalendarClient } from '../lib/calendar.js';
import { SheetsClient } from '../lib/sheets.js';
import { runPass26 } from '../passes/pass2_6/index.js';

interface Args {
  dryRun: boolean;
  jsonOut: string | undefined;
  runId: string | undefined;
  lookbackDays: number | undefined;
  skipQueueWrite: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, jsonOut: undefined, runId: undefined, lookbackDays: undefined, skipQueueWrite: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': args.dryRun = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '--skip-queue-write': args.skipQueueWrite = true; break;
      case '--json-out': args.jsonOut = argv[++i]; if (!args.jsonOut) throw new Error('--json-out needs a path'); break;
      case '--run-id': args.runId = argv[++i]; if (!args.runId) throw new Error('--run-id needs a value'); break;
      case '--lookback-days': {
        const v = argv[++i];
        if (!v) throw new Error('--lookback-days needs a number');
        args.lookbackDays = Number.parseInt(v, 10);
        if (!Number.isFinite(args.lookbackDays) || args.lookbackDays <= 0) throw new Error(`--lookback-days must be positive, got ${v}`);
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
  const runId = args.runId ?? `PASS26-${Date.now()}`;

  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN, url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });
  const calendar = new CalendarClient({
    token: env.BRAIN_API_TOKEN,
    url: env.SHEETS_PROXY_URL.replace(/\/sheets$/, '/calendar'),
    onRetry: ({ attempt, delayMs }) => logger.warn(`  calendar retry ${attempt} in ${delayMs}ms`),
  });

  const report = await runPass26({
    sheets, calendar, logger, dryRun: args.dryRun, runId,
    skipQueueWrite: args.skipQueueWrite,
    ...(args.lookbackDays !== undefined ? { lookbackDays: args.lookbackDays } : {}),
  });

  logger.info('');
  logger.info(`window          : ${report.windowStart.slice(0, 10)} → ${report.windowEnd.slice(0, 10)} (end exclusive)`);
  logger.info(`events fetched  : ${report.eventsFetched} · complete=${report.windowComplete}`);
  logger.info(`extraction      : path1=${report.extractionPaths.path1} path2=${report.extractionPaths.path2} path3=${report.extractionPaths.path3}`);
  logger.info(`filter survivors: ${report.filterSurvivors} · dropped ${JSON.stringify(report.filterDrops)}`);
  logger.info(`contacts resolved: ${report.participantsResolved}`);
  logger.info(`tasks           : ${report.openTaskCount} open · ${report.tasksEvaluated} evaluated · ${report.tasksSkippedByWatermark} skipped by watermark`);
  logger.info(`verdicts        : ${JSON.stringify(report.verdictCounts)}`);
  logger.info(`UNEVALUABLE     : ${report.unevaluableCount} (a COUNT — never individual review cards)`);
  logger.info(`enqueued        : ${report.enqueuedCount} CONFIRMED`);
  logger.info(`watermark rows  : ${report.watermarkRowsWritten}`);
  if (report.dryRun || report.wouldWrite.length > 0) {
    logger.info(`would-write: ${report.wouldWrite.length}`);
    for (const w of report.wouldWrite.slice(0, 25)) logger.info(`  ${w}`);
  }
  for (const w of report.warnings) logger.warn(w);

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }
  if (report.aborted) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
