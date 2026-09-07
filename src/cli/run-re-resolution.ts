/**
 * Identity re-resolution entry point.
 *
 *   npm run re-resolve:dry     classify and report, writes nothing
 *   npm run re-resolve -- --live
 *
 * Dry-run is the default; `--live` must be explicit.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { AttioClient } from '../lib/attio.js';
import { createLogger } from '../lib/logger.js';
import { SheetsClient } from '../lib/sheets.js';
import { runReresolution } from '../passes/re-resolution/index.js';
import { renderReport } from '../passes/re-resolution/report.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dryRun = true, jsonOut: string | undefined, maxAttempts: number | undefined, ignoreGate = false;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      // Recovery/diagnostic only — costs a full sweep of Attio lookups.
      case '--ignore-gate': ignoreGate = true; break;
      case '--max-attempts': {
        const v = Number.parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(v) || v < 0) throw new Error('--max-attempts needs a non-negative integer');
        maxAttempts = v; break;
      }
      case '--json-out':
        jsonOut = argv[++i];
        if (!jsonOut) throw new Error('--json-out needs a path');
        break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  const logger = createLogger();
  const env = loadEnv();
  const sheets = new SheetsClient({ token: env.BRAIN_API_TOKEN, url: env.SHEETS_PROXY_URL, onRetry: ({ attempt, delayMs }) => logger.warn(`  sheets retry ${attempt} in ${delayMs}ms`) });
  const attio = new AttioClient({ apiKey: env.ATTIO_API_KEY, baseUrl: env.ATTIO_API_BASE, onRetry: ({ attempt, delayMs }) => logger.warn(`  attio retry ${attempt} in ${delayMs}ms`) });

  const report = await runReresolution({
    dryRun, sheets, attio, logger, ignoreGate,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  });
  console.log(renderReport(report));

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
  }
  if (report.aborted || (!report.dryRun && report.writesConfirmed !== report.writesAttempted)) process.exitCode = 1;
}

main().catch((e: unknown) => {
  createLogger(process.stderr).error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
