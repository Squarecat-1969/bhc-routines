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
import { failedWriteCount, inconclusiveWriteCount, resyncExitCode } from '../passes/resync-ids/resync.js';

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

  // Fail the job ONLY on a KNOWN problem. Reconciler chains off this job's
  // conclusion, so anything that exits non-zero silently cancels the audit —
  // which makes the exit code a decision about what deserves to stop it.
  // See resyncExitCode for why uncertainty specifically does not.
  const failed = failedWriteCount(report.writes);
  const unsure = inconclusiveWriteCount(report.writes);

  if (failed > 0) {
    logger.warn(`${failed} correction(s) did not land — exiting non-zero`);
  }
  if (unsure > 0) {
    // Reported either way, and deliberately NOT fatal. Reconciler independently
    // re-derives Master_ID from Attio and Contacts, so an unconfirmed write is
    // exactly the case its audit resolves — blocking the cascade would only
    // delay the answer.
    logger.warn(
      `${unsure} correction(s) were issued but could not be confirmed — not failing the run. ` +
        `They may well have landed; re-run to confirm rather than assuming data loss. ` +
        `Reconciler runs next and will verify Master_ID independently either way.`,
    );
  }
  if (failed === 0 && unsure === 0 && report.warnings.length > 0) {
    logger.warn(`${report.warnings.length} advisory warning(s); every issued write verified — exiting 0`);
  }

  process.exitCode = resyncExitCode(report.writes);
}

main().catch((e) => { console.error(e); process.exit(1); });
