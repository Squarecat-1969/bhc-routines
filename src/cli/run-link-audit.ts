/**
 * Link audit — READ ONLY. Emits the work list for index reference lines that
 * carry no hyperlink. Writes nothing, to any document or any sheet.
 *
 *   npm run link-audit                 # full audit, ranges resolved by the route
 *   npm run link-audit -- --no-find    # skip the per-line find round-trip
 *   npm run link-audit -- --out FILE
 */

import 'dotenv/config';

import { writeFileSync } from 'node:fs';

import { DocsClient } from '../lib/docs.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { runLinkAudit } from '../passes/link-audit/index.js';
import { renderLinkAudit } from '../passes/link-audit/report.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipFind = argv.includes('--no-find');
  const outAt = argv.indexOf('--out');
  const outFile = outAt >= 0 ? argv[outAt + 1] : undefined;

  const env = loadEnv();
  const logger = createLogger();
  const docs = new DocsClient({
    token: env.BRAIN_API_TOKEN,
    url: env.DOCS_PROXY_URL,
    onRetry: ({ attempt, delayMs }) => logger.warn(`  docs retry ${attempt} in ${delayMs}ms`),
  });

  logger.info('LINK AUDIT — read only, nothing is written');
  logger.info('  building the locator -> heading URL map from the source tabs');
  const result = await runLinkAudit({ docs, logger, skipFind });

  const md = renderLinkAudit(result);
  if (outFile) {
    writeFileSync(outFile, md);
    logger.info(`\nwritten to ${outFile}`);
  } else {
    console.log(`\n${md}`);
  }

  const unresolved = result.rows.filter((r) => r.status !== 'resolved').length;
  logger.info(
    `\n${result.rows.length} unlinked line(s) · ${result.rows.length - unresolved} ready · ${unresolved} needing a human`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
