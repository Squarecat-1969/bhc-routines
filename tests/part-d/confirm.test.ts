import { describe, expect, it } from 'vitest';
import {
  buildAcknowledgment, buildConfirmationMessage, buildCorrectionsMessage,
  buildNoRunIdMessage, buildNoValidItemActionsMessage, buildProceedMessage,
  buildMixedMessage, buildResolveMessage, buildUnrecognizedCommandMessage,
} from '../../src/part-d/confirm.js';
import type { AppliedRowResult, BranchResult } from '../../src/part-d/branch.js';
import type { QAResult } from '../../src/part-d/qa-readback.js';
import type { WriteRowResult } from '../../src/part-d/types.js';

const RUN_LABEL = 'LATE-EDITION-1784499863693';

function writeResult(overrides: Partial<WriteRowResult> = {}): WriteRowResult {
  const base = {
    ok: true, bhcId: 'BHC-1', activityId: 'ACT-1', writes: [], warnings: [],
    taskIds: [], googleWritten: false, attioWritten: false,
    activityLogWritten: true, identityGateWarnings: [] as readonly string[],
    secondaries: [] as readonly WriteRowResult['secondaries'][number][],
    ...overrides,
  };
  // A target that was WRITTEN was necessarily TARGETED. Defaulting one from
  // the other keeps a fixture from silently expressing an impossible state
  // (written but never named) unless a test deliberately asks for one.
  return {
    ...base,
    googleTargeted: overrides.googleTargeted ?? base.googleWritten,
    attioTargeted: overrides.attioTargeted ?? base.attioWritten,
  };
}

function qaResult(overrides: Partial<QAResult> = {}): QAResult {
  return {
    bhcId: 'BHC-1', brainCompleteRow: 5, vSet: true,
    primaryChecks: [], personalContextChecks: [], secondaryChecks: [], warnings: [],
    ...overrides,
  };
}

function resolvedRow(overrides: Partial<AppliedRowResult> = {}): AppliedRowResult {
  return {
    digestPosition: 1, bhcId: 'BHC-1', outcome: 'resolved',
    writeResult: writeResult(), qa: qaResult(), warnings: [],
    ...overrides,
  };
}

function branchResult(command: BranchResult['command'], applied: AppliedRowResult[], skippedLines: string[] = []): BranchResult {
  return { command, runId: RUN_LABEL, runSetSize: applied.length, applied, skippedLines };
}

describe('confirm.ts — trivial fixed-text messages', () => {
  it('builds each exactly as specced', () => {
    expect(buildAcknowledgment(RUN_LABEL)).toBe(`⚡ ${RUN_LABEL} — on it…`);
    expect(buildNoRunIdMessage()).toBe("Couldn't find a run id — ignoring.");
    expect(buildUnrecognizedCommandMessage()).toBe("Couldn't read a valid command — no action taken.");
    expect(buildNoValidItemActionsMessage()).toBe('No valid item actions found — nothing done.');
  });
});

describe('buildProceedMessage', () => {
  it('counts every applied row as a closed thread', () => {
    const result = branchResult('PROCEED', [
      { digestPosition: 1, bhcId: 'BHC-1', outcome: 'closed', warnings: [] },
      { digestPosition: null, bhcId: 'BHC-2', outcome: 'closed', warnings: [] },
    ]);
    expect(buildProceedMessage(RUN_LABEL, result)).toBe(`⏭️ ${RUN_LABEL} — acknowledged. No CRM writes. 2 thread(s) closed.`);
  });
});

describe('buildCorrectionsMessage', () => {
  it('counts only rows with outcome corrected, not skipped ones', () => {
    const result = branchResult('CORRECTIONS', [
      { digestPosition: 1, bhcId: 'BHC-1', outcome: 'corrected', warnings: [] },
      { digestPosition: 2, bhcId: 'BHC-2', outcome: 'corrected', warnings: [] },
      { digestPosition: 99, bhcId: null, outcome: 'skipped_invalid_position', warnings: ['x'] },
    ]);
    expect(buildCorrectionsMessage(RUN_LABEL, result)).toBe(`✏️ ${RUN_LABEL} — 2 thread(s) held for re-confirmation next cycle.`);
  });
});

describe('buildResolveMessage', () => {
  it('builds the full template with real counts', () => {
    const result = branchResult('RESOLVE', [
      resolvedRow({ writeResult: writeResult({ googleWritten: true, attioWritten: true, taskIds: ['t1'] }) }),
      resolvedRow({ digestPosition: 2, writeResult: writeResult({ googleWritten: true, secondaries: [{ bhcId: 'BHC-9', activityId: 'ACT-2', attioRecordId: null, ok: true, warnings: [] }] }) }),
    ]);
    const msg = buildResolveMessage(RUN_LABEL, result);
    expect(msg).toBe(`✅ ${RUN_LABEL} — done · 2 Google · 1 Attio · 3 activity entries · 1 tasks → https://aida.hougham.us/briefing/emails`);
  });

  it('replaces the whole message with "nothing to write" when every count is zero', () => {
    const result = branchResult('RESOLVE', [
      { digestPosition: 1, bhcId: 'BHC-1', outcome: 'skipped_no_target', warnings: [] },
    ]);
    expect(buildResolveMessage(RUN_LABEL, result)).toBe(`✅ ${RUN_LABEL} — done · nothing to write`);
  });

  it('appends the enriched-contacts count when personal context checks ran', () => {
    const result = branchResult('RESOLVE', [
      resolvedRow({ writeResult: writeResult({ googleWritten: true }), qa: qaResult({ personalContextChecks: [{ field: 'Google AI', ok: true }] }) }),
    ]);
    expect(buildResolveMessage(RUN_LABEL, result)).toContain('· 1 contact(s) enriched');
  });

  it('appends the QA-failure warning when a primary check failed', () => {
    const result = branchResult('RESOLVE', [
      resolvedRow({ writeResult: writeResult({ googleWritten: true }), qa: qaResult({ primaryChecks: [{ field: 'Google Contacts BZ:CG', ok: false, correctedOnRetry: true, detail: 'x' }] }) }),
    ]);
    expect(buildResolveMessage(RUN_LABEL, result)).toContain('· ⚠ 1 write(s) failed QA — check manually');
  });

  it('never double-counts activity entries — one per primary plus one per secondary', () => {
    const result = branchResult('RESOLVE', [
      resolvedRow({
        writeResult: writeResult({
          googleWritten: true,
          secondaries: [
            { bhcId: 'BHC-9', activityId: 'ACT-2', attioRecordId: null, ok: true, warnings: [] },
            { bhcId: 'BHC-10', activityId: 'ACT-3', attioRecordId: null, ok: true, warnings: [] },
          ],
        }),
      }),
    ]);
    expect(buildResolveMessage(RUN_LABEL, result)).toContain('3 activity entries'); // 1 primary + 2 secondaries
  });
});

describe('buildConfirmationMessage — dispatch', () => {
  it('routes to the right template for each command', () => {
    const proceed = branchResult('PROCEED', [{ digestPosition: 1, bhcId: 'BHC-1', outcome: 'closed', warnings: [] }]);
    expect(buildConfirmationMessage(RUN_LABEL, proceed)).toContain('acknowledged');

    const corrections = branchResult('CORRECTIONS', [{ digestPosition: 1, bhcId: 'BHC-1', outcome: 'corrected', warnings: [] }]);
    expect(buildConfirmationMessage(RUN_LABEL, corrections)).toContain('held for re-confirmation');

    const resolve = branchResult('RESOLVE', [resolvedRow()]);
    expect(buildConfirmationMessage(RUN_LABEL, resolve)).toContain('done ·');

    const mixed = branchResult('MIXED', [resolvedRow()]);
    expect(buildConfirmationMessage(RUN_LABEL, mixed)).toContain('accepted');
  });
});

// ─── Counting outcomes, not intent (the fabricated-seven defect) ──────────────
//
// countResolved incremented activityEntries by `1 + secondaries.length` on
// every resolved row, unconditionally, while google and attio were gated on
// real booleans. A run that wrote nothing rendered as
// "0 Google · 0 Attio · 7 activity entries" — two honest zeros either side of
// a number that described intent rather than outcome.

describe('countResolved — counts what happened, not what was attempted', () => {
  it('does not count an activity entry when the 4a append never landed', () => {
    const result = branchResult('RESOLVE', [
      resolvedRow({ writeResult: writeResult({ activityLogWritten: false }) }),
    ]);
    expect(buildResolveMessage(RUN_LABEL, result)).toContain('nothing to write');
  });

  it('counts secondaries by their own ok flag, not by array length', () => {
    // Each secondary's Activity_Log append is independently try/caught.
    const result = branchResult('RESOLVE', [
      resolvedRow({
        writeResult: writeResult({
          googleWritten: true,
          secondaries: [
            { bhcId: 'BHC-A', activityId: 'ACT-A', attioRecordId: null, ok: true, warnings: [] },
            { bhcId: 'BHC-B', activityId: null, attioRecordId: null, ok: false, warnings: ['append failed'] },
          ],
        }),
      }),
    ]);
    // primary + the one secondary that succeeded = 2, not 3.
    expect(buildResolveMessage(RUN_LABEL, result)).toContain('2 activity entries');
  });
});

describe('withheld rows are never rendered as a clean success', () => {
  it('flags a row whose targets were named but nothing reached a CRM', () => {
    const result = branchResult('RESOLVE', [
      resolvedRow({
        writeResult: writeResult({ googleTargeted: true, attioTargeted: true, googleWritten: false, attioWritten: false }),
      }),
    ]);
    expect(buildResolveMessage(RUN_LABEL, result)).toContain('⚠ 1 write(s) withheld by identity gate');
  });

  it('does NOT flag an FYI-only row that named no target at all', () => {
    // Nothing to write and nothing withheld are different facts; only one of
    // them means something went wrong.
    const result = branchResult('RESOLVE', [
      resolvedRow({ writeResult: writeResult({ googleTargeted: false, attioTargeted: false }) }),
    ]);
    expect(buildResolveMessage(RUN_LABEL, result)).not.toContain('withheld');
  });

  it('flags a PARTIAL write separately — not withheld, but the CRMs now disagree', () => {
    // Google took the write, Attio did not. Not silence, so not "withheld" —
    // but Google's BZ now says contacted while Attio's last_interaction_at is
    // stale, and PASS 4 computes cadence from Attio.
    const result = branchResult('RESOLVE', [
      resolvedRow({
        writeResult: writeResult({ googleTargeted: true, googleWritten: true, attioTargeted: true, attioWritten: false }),
      }),
    ]);
    const msg = buildResolveMessage(RUN_LABEL, result);
    expect(msg).toContain('⚠ 1 row(s) partially written — CRMs may be out of sync');
    expect(msg).not.toContain('withheld by identity gate');
  });

  it('flags partial writes on MIXED too', () => {
    const result = branchResult('MIXED', [
      resolvedRow({
        writeResult: writeResult({ googleTargeted: true, googleWritten: true, attioTargeted: true, attioWritten: false }),
      }),
    ]);
    expect(buildMixedMessage(RUN_LABEL, result)).toContain('⚠ 1 row(s) partially written');
  });

  it('flags withheld rows on MIXED too', () => {
    const result = branchResult('MIXED', [
      resolvedRow({ writeResult: writeResult({ googleTargeted: true, googleWritten: false }) }),
    ]);
    expect(buildMixedMessage(RUN_LABEL, result)).toContain('⚠ 1 write(s) withheld by identity gate');
  });
});


// ─── The four states, pinned explicitly ──────────────────────────────────────
//
// googleOk and attioOk are independent checks against the same bhcId, so all
// four combinations are reachable and they mean different things. Only two of
// them are problems, and they are different problems.

describe('the four write states', () => {
  const state = (o: Partial<WriteRowResult>) =>
    buildResolveMessage(RUN_LABEL, branchResult('RESOLVE', [resolvedRow({ writeResult: writeResult(o) })]));

  it('1. no target named — nothing to write, and that is not a fault', () => {
    const msg = state({ googleTargeted: false, attioTargeted: false });
    expect(msg).not.toContain('withheld');
    expect(msg).not.toContain('partially written');
  });

  it('2. every named target landed — clean', () => {
    const msg = state({ googleTargeted: true, googleWritten: true, attioTargeted: true, attioWritten: true });
    expect(msg).not.toContain('withheld');
    expect(msg).not.toContain('partially written');
    expect(msg).toContain('1 Google · 1 Attio');
  });

  it('3. one landed, one withheld — PARTIAL', () => {
    const msg = state({ googleTargeted: true, googleWritten: true, attioTargeted: true, attioWritten: false });
    expect(msg).toContain('partially written');
    expect(msg).not.toContain('withheld by identity gate');
  });

  it('4. every named target withheld — WITHHELD', () => {
    const msg = state({ googleTargeted: true, googleWritten: false, attioTargeted: true, attioWritten: false });
    expect(msg).toContain('withheld by identity gate');
    expect(msg).not.toContain('partially written');
  });

  it('a single named target that was withheld is WITHHELD, not partial', () => {
    const msg = state({ googleTargeted: true, googleWritten: false, attioTargeted: false });
    expect(msg).toContain('withheld by identity gate');
    expect(msg).not.toContain('partially written');
  });
});
