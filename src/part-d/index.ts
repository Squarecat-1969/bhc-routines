/**
 * Part D orchestrator. Ties together every piece built for this pass:
 * parseCommand (STEP 1) -> loadRunSet (STEP 2) -> applyX from branch.ts
 * (STEP 3/4/4-MIXED, which themselves call writeRow/qaVerifyAndClose) ->
 * buildConfirmationMessage (STEP 6).
 *
 * STEP 0/1/2 ordering, resolved: the spec lists STEP 0 ("Post: ⚡
 * {RUN_LABEL} — on it…") before STEP 1 (parse) and STEP 2 (load the run
 * set) — but runtime order here is parse, then load, then acknowledge,
 * deliberately out of the spec's own numbering, for two compounding
 * reasons. First: STEP 0's template needs RUN_LABEL, which doesn't exist
 * until STEP 1 succeeds — NO_RUN_ID and UNRECOGNIZED never get an
 * acknowledgment, only their own specific stop message. Second, more
 * important: STEP 2's "if empty: stop silently, no Slack post at all"
 * only means something if nothing has been posted yet. Acknowledging
 * right after STEP 1 (as first implemented) and THEN discovering the run
 * set is empty would leave an "⚡ on it…" sitting in #aida with no
 * follow-up ever coming — Slack messages can't be un-sent. That specific
 * bug was caught by a failing test (the empty-run-set case expecting zero
 * posts), not reasoned out in advance — fixed by confirming there's real,
 * non-empty work before saying anything at all, rather than trying to
 * retract an already-sent acknowledgment.
 *
 * KNOWN LIMITATION, stated plainly rather than silently shipped: dry-run
 * here is OUTER-LEVEL only. write-row.ts, qa-readback.ts, and branch.ts
 * have no internal dry-run gating at all — every sheets.update/append and
 * attio.updatePersonRecord/createTask call in those three modules executes
 * unconditionally the moment they're called. This orchestrator's dryRun
 * flag works by never calling into branch.ts at all when true — it parses
 * the command and loads the run set (both read-only), then reports what
 * WOULD run without exercising any of the actual write logic. That's a
 * meaningfully weaker dry-run than every other pass in this repo has
 * (PASS 4/4.5/Late Edition's own passes all thread dryRun through their
 * full logic path, gating only the final write call) — this was a real,
 * deliberate scope decision, not an oversight, given retrofitting full
 * dry-run support through three already-built, already-tested modules is
 * substantial additional work. Flagged to Bobby explicitly; worth
 * revisiting before this is trusted the same way --dry-run is trusted
 * elsewhere in this repo.
 */

import type { AttioClient } from '../lib/attio.js';
import { loadMasterId } from '../passes/pass4/load.js';
import type { Logger } from '../lib/logger.js';
import type { SheetsClient } from '../lib/sheets.js';
import type { SlackPoster } from '../lib/slack.js';
import { applyCorrections, applyMixed, applyProceed, applyResolve, type BranchResult } from './branch.js';
import {
  buildAcknowledgment, buildConfirmationMessage, buildNoRunIdMessage,
  buildNoValidItemActionsMessage, buildUnrecognizedCommandMessage,
} from './confirm.js';
import { loadRunSet } from './load-run-set.js';
import { parseCommand } from './parse-command.js';
import type { PartDOptions, PartDReport, StopReason } from './types.js';

export interface RunPartDDeps {
  readonly sheets: SheetsClient;
  readonly attio: AttioClient;
  readonly slack: SlackPoster;
  readonly logger: Logger;
}

function emptyReport(partial: {
  runId: string | null; dryRun: boolean; startedAt: string; aborted?: boolean; abortReason?: string | null;
  command?: PartDReport['command']; stopReason?: StopReason | null; runSetSize?: number;
  posted?: boolean; confirmationMessage?: string | null;
}): PartDReport {
  return {
    runId: partial.runId,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    command: partial.command ?? null,
    stopReason: partial.stopReason ?? null,
    runSetSize: partial.runSetSize ?? 0,
    posted: partial.posted ?? false,
    confirmationMessage: partial.confirmationMessage ?? null,
  };
}

/**
 * Never throws in the normal sense — matches every other pass's fail-soft
 * posture, with ONE deliberate difference: per spec ("If Sheets proxy
 * unreachable or 401/5xx: STOP immediately, post ⚠ ... Sheets proxy error.
 * Nothing written."), a genuine crash here DOES post to Slack (when live),
 * unlike every read-and-stage pass elsewhere in this repo, which stays
 * silent on an aborted run. Part D is triggered by a person expecting a
 * result — silence on a crash would leave Bobby waiting for a confirmation
 * that's never coming, worse than a visible failure.
 */
export async function runPartD(opts: PartDOptions, deps: RunPartDDeps): Promise<PartDReport> {
  const startedAt = new Date().toISOString();
  try {
    return await runPartDInner(opts, deps, startedAt);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    deps.logger.warn(`Part D aborted: ${message}`);
    if (!opts.dryRun) {
      try {
        await deps.slack.post(`⚠ Part D halted: ${message.slice(0, 300)}. Nothing written.`);
      } catch {
        /* best-effort — a failed alert shouldn't mask the original error */
      }
    }
    return emptyReport({ runId: null, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function runPartDInner(opts: PartDOptions, deps: RunPartDDeps, startedAt: string): Promise<PartDReport> {
  const { sheets, attio, slack, logger } = deps;
  const { commandText, dryRun } = opts;

  logger.info('Part D — resolve handler');
  logger.info(`  mode : ${dryRun ? 'DRY RUN (outer-level only — see module doc comment)' : 'LIVE'}`);

  // STEP 1 — parse
  const parsed = parseCommand(commandText);
  if (parsed.kind === 'NO_RUN_ID') {
    logger.info('STEP 1 — no run id found in command_text, stopping');
    if (!dryRun) await slack.post(buildNoRunIdMessage());
    return emptyReport({ runId: null, dryRun, startedAt, stopReason: 'no_run_id', posted: !dryRun, confirmationMessage: buildNoRunIdMessage() });
  }
  if (parsed.kind === 'UNRECOGNIZED') {
    logger.info('STEP 1 — unrecognized command, stopping');
    if (!dryRun) await slack.post(buildUnrecognizedCommandMessage());
    return emptyReport({ runId: null, dryRun, startedAt, stopReason: 'unrecognized_command', posted: !dryRun, confirmationMessage: buildUnrecognizedCommandMessage() });
  }

  const runLabel = parsed.runId;
  logger.info(`STEP 1 — parsed command=${parsed.kind} runId=${runLabel}`);

  // STEP 2 — load the run set. Deliberately BEFORE STEP 0's acknowledgment,
  // even though the spec numbers them the other way — "stop silently" on
  // an empty run set only means something if nothing has been posted yet.
  // Acknowledging first, then discovering the run set is empty, would
  // leave an "⚡ on it…" sitting in #aida with no follow-up ever coming —
  // a real bug caught by a failing test (this exact scenario), not
  // reasoned out in advance. Fixed by confirming there's real work before
  // saying anything at all, not by trying to un-send a Slack message.
  const runSet = await loadRunSet(sheets, runLabel);
  logger.info(`STEP 2 — run set size=${runSet.rows.length} digest positions=${runSet.byDigestPosition.size}`);
  if (runSet.rows.length === 0) {
    // Per spec: stop SILENTLY. No Slack post at all — a prior run already
    // confirmed this digest, this is not a failure or something to flag.
    logger.info('STEP 2 — empty run set, stopping silently (no Slack post)');
    return emptyReport({ runId: runLabel, dryRun, startedAt, command: parsed.kind, stopReason: 'empty_run_set', runSetSize: 0 });
  }

  // STEP 0 — acknowledge, now that we know there's a real, non-empty run
  // set to work with (see the comment above STEP 2 for why this order).
  if (!dryRun) await slack.post(buildAcknowledgment(runLabel));

  // MIXED-specific stop condition, from this session's own spec addition:
  // an empty (or entirely malformed) item-action list means there's
  // nothing to do, even though the run set itself is non-empty.
  if (parsed.kind === 'MIXED' && parsed.itemActions.length === 0) {
    logger.info('STEP 3 (MIXED) — no valid item actions, stopping');
    if (!dryRun) await slack.post(buildNoValidItemActionsMessage());
    return emptyReport({
      runId: runLabel, dryRun, startedAt, command: 'MIXED', stopReason: 'no_valid_item_actions',
      posted: !dryRun, confirmationMessage: buildNoValidItemActionsMessage(),
    });
  }

  if (dryRun) {
    // Outer-level dry-run — see module doc comment. Reports what's staged
    // without calling into branch.ts (and therefore write-row.ts/
    // qa-readback.ts) at all, so nothing gets written.
    logger.info(`DRY RUN — would run ${parsed.kind} against ${runSet.rows.length} row(s); no writes attempted, no Slack post sent.`);
    return emptyReport({ runId: runLabel, dryRun, startedAt, command: parsed.kind, runSetSize: runSet.rows.length });
  }

  // STEP 3 (+ 4/4-MIXED/5, inside branch.ts) — actually do the work
  const masterId = await loadMasterId(sheets);
  let result: BranchResult;
  if (parsed.kind === 'PROCEED') {
    result = await applyProceed(sheets, runSet);
  } else if (parsed.kind === 'CORRECTIONS') {
    result = await applyCorrections(sheets, runSet, parsed.corrections);
  } else if (parsed.kind === 'RESOLVE') {
    result = await applyResolve(sheets, attio, masterId, runSet);
  } else {
    result = await applyMixed(sheets, attio, masterId, runSet, parsed.itemActions, parsed.skipped);
  }

  // STEP 6 — confirm
  const confirmationMessage = buildConfirmationMessage(runLabel, result);
  await slack.post(confirmationMessage);
  logger.info(`STEP 6 — posted confirmation: ${confirmationMessage}`);

  return emptyReport({
    runId: runLabel, dryRun, startedAt, command: parsed.kind,
    runSetSize: runSet.rows.length, posted: true, confirmationMessage,
  });
}
