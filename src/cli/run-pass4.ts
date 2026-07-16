/**
 * PASS 4 entry point.
 *
 *   npm run pass4:dry            compute and print, write nothing
 *   npm run pass4:live           compute and write to Attio
 *   npm run pass4 -- --dry-run --limit 5 --dump-shapes
 *
 * Dry-run is the default: `--live` must be passed explicitly. There is no way to
 * write by omitting a flag.
 */

// Loads .env for local runs; a no-op in CI, where secrets are real env vars.
import 'dotenv/config';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { makeRunId } from '../config/constants.js';
import { AttioClient } from '../lib/attio.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runPass4 } from '../passes/pass4/index.js';
import { buildSlackAddendum, renderReport } from '../passes/pass4/report.js';
import { isCivilDate, type CivilDate } from '../lib/dates.js';

interface Args {
  dryRun: boolean;
  limit: number | undefined;
  jsonOut: string | undefined;
  dumpShapes: boolean;
  today: CivilDate | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, limit: undefined, jsonOut: undefined, dumpShapes: false, today: undefined };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--live':
        args.dryRun = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--dump-shapes':
        args.dumpShapes = true;
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
  const runId = makeRunId();

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

  // Print one raw Attio person record so slugs/shapes can be checked against the
  // live workspace before trusting any extractor. See docs/pass4-notes.md #4.
  if (args.dumpShapes) {
    const { ATTIO_PIPELINE_LIST } = await import('../config/constants.js');
    const entries = await attio.listEntries(ATTIO_PIPELINE_LIST);
    const first = entries[0];
    if (!first) {
      logger.error('Pipeline list returned no entries — nothing to dump.');
      return;
    }
    const record = await attio.getPersonRecord(first.recordId);
    logger.info('--- raw pipeline entry_values ---');
    console.log(JSON.stringify(first.entryValues, null, 2));
    logger.info('--- raw person values ---');
    console.log(JSON.stringify(record.values, null, 2));
    return;
  }

  const report = await runPass4({
    runId,
    dryRun: args.dryRun,
    timezone: env.RUN_TIMEZONE,
    attio,
    sheets,
    logger,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.today !== undefined ? { today: args.today } : {}),
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

  // A withheld contact is a healthy refusal, not a failure — don't fail the job
  // for it. Write failures and read-back mismatches are real breakage.
  if (report.counts.failed > 0 || report.counts.verifiedMismatch > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
