/**
 * Index maintenance entry point.
 *
 *   npm run index:dry                       read everything, plan, write nothing
 *   npm run index -- --dry-run --source september --no-llm
 *   npm run index -- --live --source september
 *
 * Dry-run is the default; `--live` must be passed explicitly.
 *
 * ⚠ `--source` EXISTS BECAUSE THE FIRST LIVE RUN IS NOT A CATCH-UP. The
 * September tab is the smallest and newest source; indexing it alone and
 * verifying byte-exactly is what earns the right to touch the older backlog.
 */

import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { AnthropicClient } from '../lib/anthropic.js';
import { DocsClient } from '../lib/docs.js';
import { createLogger } from '../lib/logger.js';
import { SOURCE_ALIASES, SOURCE_TABS } from '../passes/index-maintenance/constants.js';
import { runIndexMaintenance } from '../passes/index-maintenance/index.js';
import { renderReport } from '../passes/index-maintenance/report.js';

interface Args {
  dryRun: boolean;
  noLlm: boolean;
  sources: string[];
  maxLlmCalls: number | undefined;
  jsonOut: string | undefined;
  ignoreWatermark: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: true, noLlm: false, sources: [], maxLlmCalls: undefined, jsonOut: undefined, ignoreWatermark: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--live': args.dryRun = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '--no-llm': args.noLlm = true; break;
      // ⚠ RECOVERY ONLY — re-judges indexed entries at full LLM cost.
      case '--ignore-watermark': args.ignoreWatermark = true; break;
      case '--llm': args.noLlm = false; break;
      case '--source': {
        const raw = argv[++i] ?? '';
        const label = SOURCE_ALIASES[raw] ?? raw;
        if (!SOURCE_TABS.some((s) => s.label === label)) {
          throw new Error(
            `Unknown --source "${raw}". Aliases: ${Object.keys(SOURCE_ALIASES).join(', ')}. ` +
              `Labels: ${SOURCE_TABS.map((s) => s.label).join(' | ')}`,
          );
        }
        args.sources.push(label);
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

  const docs = new DocsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.DOCS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  docs retry ${attempt} in ${delayMs}ms`),
  });

  if (!args.noLlm && !env.ANTHROPIC_BHC_ROUTINES_API) {
    throw new Error('ANTHROPIC_BHC_ROUTINES_API is required for term assignment. Pass --no-llm to plan nothing.');
  }
  const anthropic =
    args.noLlm || !env.ANTHROPIC_BHC_ROUTINES_API
      ? undefined
      : new AnthropicClient({
          apiKey: env.ANTHROPIC_BHC_ROUTINES_API,
          onRetry: ({ attempt, delayMs }) => logger.warn(`  anthropic retry ${attempt} in ${delayMs}ms`),
        });

  const report = await runIndexMaintenance({
    dryRun: args.dryRun,
    docs,
    logger,
    ...(anthropic ? { anthropic } : {}),
    ...(args.sources.length > 0 ? { sourceLabels: args.sources } : {}),
    ...(args.maxLlmCalls !== undefined ? { maxLlmCalls: args.maxLlmCalls } : {}),
    ...(args.ignoreWatermark ? { ignoreWatermark: true } : {}),
  });

  console.log(renderReport(report));

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`Report written to ${args.jsonOut}`);
  }

  if (report.aborted || (!report.dryRun && report.writesConfirmed !== report.writesAttempted)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  createLogger(process.stderr).error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
