/**
 * Contacts Triage entry point.
 *
 *   npm run contacts-triage:dry     enumerate, exclude, score, report — writes nothing
 *   npm run contacts-triage:live    the same, then writes the two staging tabs
 *   npm run contacts-triage -- --dry-run --limit 25 --no-llm
 *
 * Dry-run is the default; `--live` must be passed explicitly. There is no way
 * to write by omitting a flag.
 *
 * A dry run still makes real Anthropic calls for in-band contacts — same
 * convention as PASS 2 (`pass2:dry` "writes nothing to Sheets, but DOES call
 * the real Anthropic API"). Pass `--no-llm` for a free run that shows only the
 * deterministic distribution, which is the number the thresholds get tuned
 * against anyway.
 *
 * Scoring reads Attio's computed connection signals, which arrive with the
 * enumeration walk — there is no per-contact fetch and no email endpoint. See
 * docs/contacts-triage-notes.md #15 for why the message-metadata path is
 * permanently closed.
 */

// Loads .env for local runs; a no-op in CI, where secrets are real env vars.
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { AnthropicClient } from '../lib/anthropic.js';
import { AttioClient } from '../lib/attio.js';
import { isCivilDate, type CivilDate } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { createNoopSlackPoster, createSlackPoster } from '../lib/slack.js';
import { runContactsTriage } from '../passes/contacts-triage/index.js';
import { buildSlackMessage, renderReport } from '../passes/contacts-triage/report.js';

interface Args {
  dryRun: boolean;
  noLlm: boolean;
  limit: number | undefined;
  maxLlmCalls: number | undefined;
  jsonOut: string | undefined;
  today: CivilDate | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: true,
    noLlm: false,
    limit: undefined,
    maxLlmCalls: undefined,
    jsonOut: undefined,
    today: undefined,
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
      case '--no-llm':
        args.noLlm = true;
        break;
      // STEP 4 is already on by default (PASS 2's convention: a dry run writes
      // nothing to Sheets but DOES call the real Anthropic API). `--llm` is
      // accepted so spending calls can be stated explicitly at the call site
      // rather than relied on as a default.
      case '--llm':
        args.noLlm = false;
        break;
      case '--limit': {
        const v = Number.parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(v) || v <= 0) throw new Error('--limit needs a positive integer');
        args.limit = v;
        break;
      }
      case '--max-llm-calls': {
        const v = Number.parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(v) || v < 0) throw new Error('--max-llm-calls needs a non-negative integer');
        args.maxLlmCalls = v;
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

  if (!args.noLlm && !env.ANTHROPIC_BHC_ROUTINES_API) {
    throw new Error('ANTHROPIC_BHC_ROUTINES_API is required for STEP 4. Pass --no-llm to score deterministically only.');
  }
  const anthropic =
    args.noLlm || !env.ANTHROPIC_BHC_ROUTINES_API
      ? undefined
      : new AnthropicClient({
          apiKey: env.ANTHROPIC_BHC_ROUTINES_API,
          onRetry: ({ attempt, delayMs }) => logger.warn(`  anthropic retry ${attempt} in ${delayMs}ms`),
        });

  const report = await runContactsTriage({
    dryRun: args.dryRun,
    attio,
    sheets,
    logger,
    ...(anthropic ? { anthropic } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.maxLlmCalls !== undefined ? { maxLlmCalls: args.maxLlmCalls } : {}),
    ...(args.today !== undefined ? { today: args.today } : {}),
  });

  console.log(renderReport(report));

  const slack =
    !args.dryRun && env.ZAPIER_SLACK_HOOK_URL
      ? createSlackPoster({ hookUrl: env.ZAPIER_SLACK_HOOK_URL })
      : createNoopSlackPoster((text) => {
          logger.info(`Slack post skipped (${args.dryRun ? 'dry run' : 'no ZAPIER_SLACK_HOOK_URL'}). Would post:`);
          console.log(text);
        });
  await slack.post(buildSlackMessage(report));

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }

  // An abort or a failed read-back is a real problem. Excluded contacts and
  // LLM fallbacks are healthy outcomes, not failures.
  if (report.aborted || report.readBackVerified === false) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
