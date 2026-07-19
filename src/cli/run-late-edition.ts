/**
 * The combined Late Edition entry point — runs all eight passes in the
 * spec's own stated order (0 -> 1 -> 2 -> 2.5 -> 3 -> 4 -> 4.5 -> 5) with
 * one shared Run_ID, instead of eight separate commands with a Run_ID
 * copied by hand between them.
 *
 *   npm run late-edition:dry     full night, writes nothing, still calls
 *                                 the real Anthropic API (PASS 2, 2.5) —
 *                                 real cost, zero Sheets/Attio/Slack risk
 *   npm run late-edition:live    the real thing — writes Sheets, patches
 *                                 Attio, posts to #aida
 *   npm run late-edition -- --dry-run --limit 5
 *
 * This has NEVER been run end-to-end before — every individual pass has
 * been live-verified on its own, but never chained. Start with --dry-run
 * and a small --limit, same discipline as every pass's own first live run.
 */

import 'dotenv/config';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AnthropicClient } from '../lib/anthropic.js';
import { AttioClient } from '../lib/attio.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runLateEdition } from '../passes/orchestrator/index.js';
import { renderReport } from '../passes/orchestrator/report.js';

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
    throw new Error('ANTHROPIC_BHC_ROUTINES_API is required — PASS 2 and PASS 2.5 both need it, even in dry-run.');
  }

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
  const anthropic = new AnthropicClient({
    apiKey: env.ANTHROPIC_BHC_ROUTINES_API,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  anthropic retry ${attempt} in ${delayMs}ms`),
  });
  const slack =
    !args.dryRun && env.SLACK_WEBHOOK_URL
      ? createSlackPoster(env.SLACK_WEBHOOK_URL)
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no SLACK_WEBHOOK_URL'}). Would post:`);
          logger.info(text);
        });

  const report = await runLateEdition(
    { dryRun: args.dryRun, timezone: env.RUN_TIMEZONE, ...(args.limit !== undefined ? { limit: args.limit } : {}) },
    { sheets, attio, anthropic, slack, logger },
  );

  console.log(renderReport(report));

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
