/**
 * Part D CLI entry point.
 *
 *   npm run part-d -- --command-text "PROCEED LATE-EDITION-123" --dry-run
 *   npm run part-d -- --command-text-file /tmp/command.txt --live
 *
 * Two ways to supply command_text, not one, deliberately: CORRECTIONS and
 * MIXED payloads are multi-line ({n}: {note} / {n}:ACTION per line), and
 * passing multi-line content through a shell as a single --flag value is a
 * real, avoidable source of quoting bugs. --command-text-file sidesteps
 * that entirely — the GitHub Actions workflow (not yet built) writes the
 * workflow_dispatch input to a temp file first and points here, rather
 * than trying to thread a multi-line string through shell argument
 * parsing. --command-text stays available for the simple single-line
 * case (PROCEED/RESOLVE, or manual ad-hoc testing) where a file is
 * needless ceremony.
 */

import 'dotenv/config';

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AttioClient } from '../lib/attio.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runPartD } from '../part-d/index.js';

interface Args {
  dryRun: boolean;
  commandText: string | undefined;
  commandTextFile: string | undefined;
  jsonOut: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, commandText: undefined, commandTextFile: undefined, jsonOut: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--live':
        args.dryRun = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--command-text':
        args.commandText = argv[++i];
        if (args.commandText === undefined) throw new Error('--command-text needs a value');
        break;
      case '--command-text-file':
        args.commandTextFile = argv[++i];
        if (!args.commandTextFile) throw new Error('--command-text-file needs a path');
        break;
      case '--json-out':
        args.jsonOut = argv[++i];
        if (!args.jsonOut) throw new Error('--json-out needs a path');
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.commandText && !args.commandTextFile) {
    throw new Error('Provide either --command-text or --command-text-file');
  }
  if (args.commandText && args.commandTextFile) {
    throw new Error('Provide only one of --command-text or --command-text-file, not both');
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger();
  const env = loadEnv();

  const commandText = args.commandTextFile ? readFileSync(args.commandTextFile, 'utf8') : args.commandText!;

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
  const slack =
    !args.dryRun && env.SLACK_WEBHOOK_URL
      ? createSlackPoster(env.SLACK_WEBHOOK_URL)
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no SLACK_WEBHOOK_URL'}). Would post:`);
          logger.info(text);
        });

  const report = await runPartD({ commandText, dryRun: args.dryRun }, { sheets, attio, slack, logger });

  console.log(JSON.stringify(report, null, 2));

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }

  if (report.aborted) process.exitCode = 1;
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
