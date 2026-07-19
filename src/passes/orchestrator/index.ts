/**
 * The combined Late Edition orchestrator. Chains all eight passes in the
 * spec's own stated real nightly order (0 -> 1 -> 2 -> 2.5 -> 3 -> 4 -> 4.5
 * -> 5) in one process, sharing one Run_ID generated here, rather than
 * requiring eight separate CLI invocations with a Run_ID copied by hand
 * between them.
 *
 * Deliberately does NOT restructure any individual pass's internal Sheets/
 * Attio reads to share fetched data in memory (e.g. Master_ID, Contacts) —
 * every pass already does its own fresh, independently-tested reads, and
 * touching that machinery on already-live-verified passes is real risk for
 * marginal efficiency gain. The one piece of real in-memory data sharing
 * this orchestrator DOES do is deliberate and specific: PASS 2's identity-
 * drift warnings feed directly into PASS 3's digest (see drift-notes.ts) —
 * the one genuine gap standalone operation couldn't close on its own.
 *
 * Fail-soft at the orchestrator level too: every individual pass already
 * returns an `aborted` report rather than throwing, but each stage here is
 * still wrapped defensively — an unexpected exception escaping a pass
 * (despite its own internal safeguards) must not take down the rest of the
 * night's run.
 *
 * Real inconsistency found while wiring this up: PASS 4's report has no
 * `aborted` field at all (every other pass does, including its sibling
 * PASS 4.5) — its fail-soft is purely per-contact, not per-run, and its own
 * existing CLI already posts the Slack addendum unconditionally rather than
 * gating on any run-level failure state. This orchestrator matches that
 * established behavior exactly for both PASS 4 and PASS 4.5 (always post
 * when live) rather than inventing new gating logic PASS 4's own CLI never
 * had. Worth reconciling someday, not fixed here — changing PASS 4's report
 * shape is real surgery on an already-live-verified pass.
 */

import { makeRunId } from '../../config/constants.js';
import type { AnthropicClient } from '../../lib/anthropic.js';
import type { AttioClient } from '../../lib/attio.js';
import { todayIn } from '../../lib/dates.js';
import type { Logger } from '../../lib/logger.js';
import type { SheetsClient } from '../../lib/sheets.js';
import type { SlackPoster } from '../../lib/slack.js';
import { runPass0 } from '../pass0/index.js';
import { runPass1 } from '../pass1/index.js';
import { runPass2 } from '../pass2/index.js';
import { runPass25 } from '../pass2_5/index.js';
import { runPass3 } from '../pass3/index.js';
import { runPass4 } from '../pass4/index.js';
import { buildSlackAddendum as buildPass4SlackAddendum } from '../pass4/report.js';
import { runPass45 } from '../pass4_5/index.js';
import { buildSlackAddendum as buildPass45SlackAddendum } from '../pass4_5/report.js';
import { runPass5 } from '../pass5/index.js';
import { extractDriftNotes } from './drift-notes.js';
import type { LateEditionOptions, LateEditionReport } from './types.js';

export interface LateEditionDeps {
  readonly sheets: SheetsClient;
  readonly attio: AttioClient;
  readonly anthropic: AnthropicClient;
  readonly slack: SlackPoster;
  readonly logger: Logger;
}

/** Wraps a single stage so an unexpected throw doesn't abort the rest of the night's run. */
async function runStage<T>(logger: Logger, label: string, fn: () => Promise<T>, onError: (message: string) => T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logger.warn(`${label} threw unexpectedly (should have been caught internally) — continuing: ${message}`);
    return onError(message);
  }
}

export async function runLateEdition(opts: LateEditionOptions, deps: LateEditionDeps): Promise<LateEditionReport> {
  const { sheets, attio, anthropic, slack, logger } = deps;
  const { dryRun, timezone, limit } = opts;
  const startedAt = new Date().toISOString();
  const runId = makeRunId();
  const today = todayIn(timezone);

  logger.info('='.repeat(100));
  logger.info(`LATE EDITION — ${runId} — ${dryRun ? 'DRY RUN' : 'LIVE RUN'}`);
  logger.info('='.repeat(100));

  logger.info('');
  logger.info('--- PASS 0 — Reply-Placeholder Reconciliation ---');
  const pass0 = await runPass0({ runId, dryRun, sheets, logger });

  logger.info('');
  logger.info('--- PASS 1 — Housekeeping ---');
  const pass1 = await runPass1({ runId, dryRun, sheets, logger });

  logger.info('');
  logger.info('--- PASS 2 — Enrichment ---');
  const pass2 = await runPass2({ runId, dryRun, sheets, attio, anthropic, logger, ...(limit !== undefined ? { limit } : {}) });

  logger.info('');
  logger.info('--- PASS 2.5 — Task Reconciliation ---');
  const pass25 = await runPass25({ runId, dryRun, sheets, anthropic, logger, today, ...(limit !== undefined ? { limit } : {}) });

  logger.info('');
  logger.info('--- PASS 3 — Slack Digest ---');
  const driftNotes = extractDriftNotes(pass2);
  const pass3 = await runStage(
    logger,
    'PASS 3',
    () => runPass3({ runId, dryRun, driftNotes }, { sheets, slack, logger, today }),
    (abortReason) => ({
      runId, dryRun, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      aborted: true, abortReason, rowCount: 0, surfacedCount: 0, filteredCount: 0, bodyKind: null,
      posted: false, digestBody: null, warnings: [],
    }),
  );

  logger.info('');
  logger.info('--- PASS 4 — Attio Cadence Engine ---');
  const pass4 = await runPass4({ runId, dryRun, timezone, attio, sheets, logger, today, ...(limit !== undefined ? { limit } : {}) });
  if (!dryRun) {
    await runStage(logger, 'PASS 4 Slack addendum', () => slack.post(buildPass4SlackAddendum(pass4)), () => undefined);
  }

  logger.info('');
  logger.info('--- PASS 4.5 — Pipeline Cache ---');
  const pass45 = await runPass45({ runId, dryRun, timezone, attio, sheets, logger, today, ...(limit !== undefined ? { limit } : {}) });
  if (!dryRun) {
    await runStage(logger, 'PASS 4.5 Slack addendum', () => slack.post(buildPass45SlackAddendum(pass45)), () => undefined);
  }

  logger.info('');
  logger.info('--- PASS 5 — Game Plan Generation ---');
  const pass5 = await runPass5({ runId, dryRun }, { sheets, attio, logger, today });

  const finishedAt = new Date().toISOString();
  logger.info('');
  logger.info('='.repeat(100));
  logger.info(`LATE EDITION — ${runId} — done`);
  logger.info('='.repeat(100));

  return { runId, dryRun, startedAt, finishedAt, pass0, pass1, pass2, pass25, pass3, pass4, pass45, pass5 };
}
