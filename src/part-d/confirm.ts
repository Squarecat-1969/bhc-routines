/**
 * Part D STEP 0 ("Post to #aida: ⚡ {RUN_LABEL} — on it…") and STEP 6
 * ("Confirm to Slack"). All of Part D's Slack message text lives in this
 * one file — including the STEP 1 stop-condition messages ("Couldn't find
 * a run id", "Couldn't read a valid command") — deliberately, so there's
 * one place to look for exactly what Bobby sees, rather than message text
 * scattered across parse-command.ts/branch.ts/index.ts. Those other
 * modules return structured data; this one is the only place that turns
 * structured data into words.
 *
 * RESOLVE template, spec exact: "✅ {RUN_LABEL} — done · {g} Google · {a}
 * Attio · {n} activity entries · {t} tasks → .../briefing/emails" with three
 * conditional appends (personal context enriched count, QA-failure count)
 * and one full-replacement case ("If all FYI-only: ... nothing to write").
 *
 * MIXED template is this session's own addition (not in the original
 * spec) — same shape and spirit as RESOLVE's, adapted for a mixed batch:
 * "✅ {RUN_LABEL} — done · {a} accepted (...) · {c} corrected · {d} dismissed"
 * plus the same two conditional appends, plus a third for skipped lines.
 */

import type { BranchResult } from './branch.js';

const BRIEFING_URL = 'https://aida.hougham.us/briefing/emails';

export function buildAcknowledgment(runLabel: string): string {
  return `⚡ ${runLabel} — on it…`;
}

export function buildNoRunIdMessage(): string {
  return "Couldn't find a run id — ignoring.";
}

export function buildUnrecognizedCommandMessage(): string {
  return "Couldn't read a valid command — no action taken.";
}

export function buildNoValidItemActionsMessage(): string {
  return 'No valid item actions found — nothing done.';
}

interface ResolveCounts {
  google: number;
  attio: number;
  activityEntries: number;
  tasks: number;
  enrichedContacts: number;
  failedQAWrites: number;
}

function countResolved(applied: BranchResult['applied']): ResolveCounts {
  const counts: ResolveCounts = { google: 0, attio: 0, activityEntries: 0, tasks: 0, enrichedContacts: 0, failedQAWrites: 0 };
  for (const row of applied) {
    if (row.outcome !== 'resolved' || !row.writeResult) continue;
    if (row.writeResult.googleWritten) counts.google += 1;
    if (row.writeResult.attioWritten) counts.attio += 1;
    counts.activityEntries += 1 + row.writeResult.secondaries.length; // primary + each secondary gets its own Activity_Log row
    counts.tasks += row.writeResult.taskIds.length;
    if (row.qa && row.qa.personalContextChecks.length > 0) counts.enrichedContacts += 1;
    if (row.qa) counts.failedQAWrites += row.qa.primaryChecks.filter((c) => !c.ok).length;
  }
  return counts;
}

export function buildProceedMessage(runLabel: string, result: BranchResult): string {
  return `⏭️ ${runLabel} — acknowledged. No CRM writes. ${result.applied.length} thread(s) closed.`;
}

export function buildCorrectionsMessage(runLabel: string, result: BranchResult): string {
  const held = result.applied.filter((a) => a.outcome === 'corrected').length;
  return `✏️ ${runLabel} — ${held} thread(s) held for re-confirmation next cycle.`;
}

export function buildResolveMessage(runLabel: string, result: BranchResult): string {
  const c = countResolved(result.applied);

  if (c.google === 0 && c.attio === 0 && c.activityEntries === 0 && c.tasks === 0) {
    return `✅ ${runLabel} — done · nothing to write`;
  }

  let msg = `✅ ${runLabel} — done · ${c.google} Google · ${c.attio} Attio · ${c.activityEntries} activity entries · ${c.tasks} tasks → ${BRIEFING_URL}`;
  if (c.enrichedContacts > 0) msg += ` · ${c.enrichedContacts} contact(s) enriched`;
  if (c.failedQAWrites > 0) msg += ` · ⚠ ${c.failedQAWrites} write(s) failed QA — check manually`;
  return msg;
}

export function buildMixedMessage(runLabel: string, result: BranchResult): string {
  const c = countResolved(result.applied);
  const accepted = result.applied.filter((a) => a.outcome === 'resolved').length;
  const corrected = result.applied.filter((a) => a.outcome === 'corrected').length;
  const dismissed = result.applied.filter((a) => a.outcome === 'dismissed').length;
  const skippedPositions = result.applied.filter((a) => a.outcome === 'skipped_invalid_position').length;
  const totalSkipped = skippedPositions + result.skippedLines.length;

  let msg = `✅ ${runLabel} — done · ${accepted} accepted (${c.google} Google · ${c.attio} Attio · ${c.activityEntries} activity entries · ${c.tasks} tasks) · ${corrected} corrected · ${dismissed} dismissed`;
  if (c.failedQAWrites > 0) msg += ` · ⚠ ${c.failedQAWrites} write(s) failed QA — check manually`;
  if (totalSkipped > 0) msg += ` · ⚠ ${totalSkipped} line(s) skipped — see above`;
  return msg;
}

/** Dispatches to the right template for the command that actually ran — the one place index.ts needs to call after branch.ts returns. Switches on result.command directly (already narrowed to the four actionable kinds) rather than taking a separate ParsedCommand['kind'] parameter, which would also include NO_RUN_ID/UNRECOGNIZED — kinds that never reach branch.ts and so are never a real case here. */
export function buildConfirmationMessage(runLabel: string, result: BranchResult): string {
  switch (result.command) {
    case 'PROCEED': return buildProceedMessage(runLabel, result);
    case 'CORRECTIONS': return buildCorrectionsMessage(runLabel, result);
    case 'RESOLVE': return buildResolveMessage(runLabel, result);
    case 'MIXED': return buildMixedMessage(runLabel, result);
    default: {
      const _exhaustive: never = result.command;
      throw new Error(`buildConfirmationMessage called with an unhandled command kind: ${String(_exhaustive)}`);
    }
  }
}
