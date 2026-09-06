/**
 * Documents QC entry point. READ-ONLY — there is no --live flag because there
 * is nothing to gate: this pass cannot write.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadEnv } from '../config/env.js';
import { DocsClient } from '../lib/docs.js';
import { createLogger } from '../lib/logger.js';
import { runDocsQc } from '../passes/docs-qc/index.js';
import { renderQcReport } from '../passes/docs-qc/report.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json-out') {
      jsonOut = argv[++i];
      if (!jsonOut) throw new Error('--json-out needs a path');
    } else {
      throw new Error(`Unknown argument: ${argv[i]}. This pass is read-only and takes only --json-out.`);
    }
  }

  const logger = createLogger();
  const env = loadEnv();
  const docs = new DocsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.DOCS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  docs retry ${attempt} in ${delayMs}ms`),
  });

  const report = await runDocsQc({ docs, logger });
  console.log(renderQcReport(report));

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
  }

  // A fired FINDING is the point of the run, not a crash — the job stays green
  // so a weekly report is read rather than treated as a broken build. Only an
  // abort fails.
  if (report.aborted) process.exitCode = 1;
}

main().catch((e: unknown) => {
  createLogger(process.stderr).error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
