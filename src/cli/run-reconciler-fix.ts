/**
 * Reconciler Fix runner.
 *
 *   npm run reconciler-fix:dry    # reads everything, issues NOTHING
 *   npm run reconciler-fix:live   # writes Master_ID + Attio
 *
 * Dry-run is the default; --live must be explicit. Mirrors run-reconciler.ts.
 */
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { AttioClient } from '../lib/attio.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runReconcilerFix } from '../passes/reconciler-fix/index.js';

interface Args { dryRun: boolean; jsonOut: string | undefined; fixRunId: string | undefined }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, jsonOut: undefined, fixRunId: undefined };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': args.dryRun = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json-out': args.jsonOut = argv[++i]; if (!args.jsonOut) throw new Error('--json-out needs a path'); break;
      case '--run-id': args.fixRunId = argv[++i]; if (!args.fixRunId) throw new Error('--run-id needs a value'); break;
      default: break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const logger = createLogger();
  const fixRunId = args.fixRunId ?? `RECON-FIX-${Date.now()}`;

  const sheets = new SheetsClient({
    token: env.BRAIN_API_TOKEN, url: env.SHEETS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`),
  });
  const attio = new AttioClient({
    apiKey: env.ATTIO_API_KEY, baseUrl: env.ATTIO_API_BASE,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  attio retry ${attempt} in ${delayMs}ms`),
  });

  // Same ternary, same env var, same #aida identity as run-reconciler.ts.
  // Deliberately not a second Slack pathway - one poster module, one hook.
  const slack =
    !args.dryRun && env.ZAPIER_SLACK_HOOK_URL
      ? createSlackPoster({ hookUrl: env.ZAPIER_SLACK_HOOK_URL })
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no ZAPIER_SLACK_HOOK_URL'}). Would post:`);
          console.log(text);
        });

  const report = await runReconcilerFix({ sheets, attio, logger, dryRun: args.dryRun, fixRunId, slack });

  logger.info('');
  logger.info(`candidates : ${JSON.stringify(report.candidates)}`);
  logger.info(`S1 ${JSON.stringify(report.s1.counts)}`);
  logger.info(`A1 ${JSON.stringify(report.a1.counts)}`);
  logger.info(`A3 ${JSON.stringify(report.a3.counts)}`);
  logger.info(`S4 ${JSON.stringify(report.s4.counts)}`);
  logger.info(`I1 ${JSON.stringify(report.i1.counts)}`);
  if (report.dryRun) {
    logger.info(`would-write: ${report.wouldWrite.length}`);
    for (const w of report.wouldWrite.slice(0, 20)) logger.info(`  ${w}`);
  }
  for (const w of report.warnings) logger.warn(w);

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
