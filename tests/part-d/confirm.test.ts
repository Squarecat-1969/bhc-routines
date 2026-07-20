import { describe, expect, it } from 'vitest';
import {
  buildAcknowledgment, buildConfirmationMessage, buildCorrectionsMessage,
  buildNoRunIdMessage, buildNoValidItemActionsMessage, buildProceedMessage,
  buildResolveMessage, buildUnrecognizedCommandMessage,
} from '../../src/part-d/confirm.js';
import type { AppliedRowResult, BranchResult } from '../../src/part-d/branch.js';
import type { QAResult } from '../../src/part-d/qa-readback.js';
import type { WriteRowResult } from '../../src/part-d/types.js';

const RUN_LABEL = 'LATE-EDITION-1784499863693';

function writeResult(overrides: Partial<WriteRowResult> = {}): WriteRowResult {
  return {
    ok: true, bhcId: 'BHC-1', activityId: 'ACT-1', writes: [], warnings: [],
    taskIds: [], googleWritten: false, attioWritten: false, secondaries: [],
    ...overrides,
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
