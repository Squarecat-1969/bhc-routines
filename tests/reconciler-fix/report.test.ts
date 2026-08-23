/**
 * Reconciler Fix Slack report - pure shaping, no credentials, no I/O.
 *
 * The load-bearing property is the four-way separation: fixed / attempted-and-
 * needs-a-human / held-by-design / never-in-scope. Collapsing any two of those
 * is exactly the ambiguity this report exists to remove, so each has its own
 * test rather than being spot-checked through one big golden string.
 */

import { describe, expect, it } from 'vitest';

import { ISSUE_META, type IssueCode } from '../../src/passes/reconciler/types.js';
import type { ReconcilerFixReport } from '../../src/passes/reconciler-fix/index.js';
import {
  FIX_CODES,
  buildFixSlackMessage,
  outOfScopeCodes,
  summarize,
  writeFailures,
} from '../../src/passes/reconciler-fix/report.js';

function emptyReport(over: Partial<ReconcilerFixReport> = {}): ReconcilerFixReport {
  return {
    fixRunId: 'RECON-FIX-1', dryRun: false, sourceRunId: 'RECON-9',
    startedAt: '2026-08-23T08:00:00.000Z', finishedAt: '2026-08-23T08:03:00.000Z',
    candidates: { S1: 0, A1: 0, A3: 0, S4: 0, I1: 0 },
    s1: { groups: [], counts: { groups: 0, orphansFlagged: 0, hardStops: 0, writeFailures: 0 } },
    a1: { rows: [], counts: { considered: 0, fixed: 0, needsManual: 0, attioWrites: 0 } },
    a3: { rows: [], counts: { considered: 0, repointed: 0, setGoogleOnly: 0, ambiguous: 0, lookupFailed: 0, writeFailed: 0, hardStops: 0 } },
    s4: { groups: [], counts: { groups: 0, repaired: 0, needsManual: 0, lookupFailed: 0, orphansCleared: 0, hardStops: 0 } },
    i1: { rows: [], counts: { considered: 0, fixed: 0, needsManual: 0, attioWrites: 0 } },
    excludedFromA1: [], excludedFromI1: [], outOfScope: {}, wouldWrite: [], warnings: [],
    ...over,
  } as ReconcilerFixReport;
}

describe('out-of-scope codes are derived from ISSUE_META, not hardcoded', () => {
  it('is exactly the HIGH/MEDIUM codes outside Fix\'s five', () => {
    expect([...outOfScopeCodes()].sort()).toEqual(['A5', 'G1', 'G3', 'S2', 'S3', 'S5']);
  });

  it('never includes a code Fix actually repairs', () => {
    for (const c of outOfScopeCodes()) expect(FIX_CODES).not.toContain(c);
  });

  it('never includes LOW or INFO severities', () => {
    for (const c of outOfScopeCodes()) {
      expect(['HIGH', 'MEDIUM']).toContain(ISSUE_META[c].severity);
    }
  });
});

describe('every category reconciles: considered === fixed + needsManual + noAction + failed', () => {
  // The invariant that makes the message readable at a glance. A3's
  // skipped_superseded, S4/S1's nothing_to_do and I1's already_correct are all
  // absent from their own `counts`, so each one is a chance to silently lose a
  // candidate between "considered" and the buckets displayed.
  const report = emptyReport({
    s1: {
      groups: [
        { bhcId: 'BHC-1', outcome: 'flagged', canonicalRow: 2, orphansFlagged: [3], writes: [], reason: '' },
        { bhcId: 'BHC-2', outcome: 'nothing_to_do', canonicalRow: 4, orphansFlagged: [], writes: [], reason: '' },
      ],
      counts: { groups: 2, orphansFlagged: 1, hardStops: 0, writeFailures: 0 },
    },
    a1: { rows: [], counts: { considered: 5, fixed: 3, needsManual: 2, attioWrites: 3 } },
    a3: {
      rows: [
        { bhcId: 'BHC-9', masterRow: 9, outcome: 'skipped_superseded', matchCount: 0, newRecordId: null, writes: [], reason: '' },
      ],
      counts: { considered: 6, repointed: 2, setGoogleOnly: 1, ambiguous: 1, lookupFailed: 0, writeFailed: 1, hardStops: 0 },
    },
    s4: {
      groups: [
        { attioRecordId: 'rec-x', outcome: 'nothing_to_do', canonicalBhcId: null, canonicalFromAttio: false, orphansCleared: [], writes: [], reason: '' },
      ],
      counts: { groups: 3, repaired: 1, needsManual: 1, lookupFailed: 0, orphansCleared: 2, hardStops: 0 },
    },
    i1: {
      rows: [
        { bhcId: 'BHC-4', field: 'Title', outcome: 'already_correct', attioWritten: false, notes: [], reason: '' },
      ],
      counts: { considered: 4, fixed: 2, needsManual: 1, attioWrites: 2 },
    },
  } as Partial<ReconcilerFixReport>);

  for (const s of summarize(report)) {
    it(`${s.code} reconciles`, () => {
      expect(s.fixed ?? 0).toBeGreaterThanOrEqual(0);
      expect((s.fixed ?? 0) + s.needsManual + s.noAction + s.failed).toBe(s.considered);
    });
  }

  it('S1 has no "fixed" number at all — it is flag-only, not a failed attempt', () => {
    const s1 = summarize(report).find((s) => s.code === 'S1')!;
    expect(s1.fixed).toBeNull();
    expect(buildFixSlackMessage(report)).toContain('S1 Duplicate BHC_ID: 2 group(s) · flag-only');
  });

  it("A3's write failures land on the failures segment, never in needs-manual", () => {
    const a3 = summarize(report).find((s) => s.code === 'A3')!;
    expect(a3.needsManual).toBe(1); // ambiguous only
    expect(a3.failed).toBe(1); // writeFailed
  });

  it('counts write-unit failures separately from the group buckets', () => {
    const r = emptyReport({
      s1: { groups: [], counts: { groups: 0, orphansFlagged: 0, hardStops: 2, writeFailures: 1 } },
      s4: { groups: [], counts: { groups: 0, repaired: 0, needsManual: 0, lookupFailed: 0, orphansCleared: 0, hardStops: 3 } },
    } as Partial<ReconcilerFixReport>);
    expect(writeFailures(r).total).toBe(6);
  });
});

describe('failures are attributed to the pass that produced them', () => {
  // A bare total means opening the JSON artifact just to learn WHERE to look.
  const threeWays = emptyReport({
    s1: { groups: [], counts: { groups: 0, orphansFlagged: 0, hardStops: 0, writeFailures: 1 } },
    a3: { rows: [], counts: { considered: 3, repointed: 2, setGoogleOnly: 0, ambiguous: 0, lookupFailed: 0, writeFailed: 1, hardStops: 0 } },
    s4: { groups: [], counts: { groups: 1, repaired: 1, needsManual: 0, lookupFailed: 0, orphansCleared: 0, hardStops: 1 } },
  } as Partial<ReconcilerFixReport>);

  it('names every contributing category when several fail at once', () => {
    expect(writeFailures(threeWays).byCategory).toEqual([
      { code: 'S1', n: 1 }, { code: 'A3', n: 1 }, { code: 'S4', n: 1 },
    ]);
    expect(buildFixSlackMessage(threeWays)).toContain('⚠ 3 write failure(s): 1 S1, 1 A3, 1 S4');
  });

  it('names the category even when only one contributes', () => {
    const only = emptyReport({
      s4: { groups: [], counts: { groups: 1, repaired: 1, needsManual: 0, lookupFailed: 0, orphansCleared: 0, hardStops: 2 } },
    } as Partial<ReconcilerFixReport>);
    expect(buildFixSlackMessage(only)).toContain('⚠ 2 write failure(s): 2 S4');
  });

  it('lists only categories that actually failed', () => {
    expect(writeFailures(emptyReport()).byCategory).toEqual([]);
    expect(buildFixSlackMessage(emptyReport({ warnings: ['w'] }))).not.toContain('write failure');
  });

  // A3 is the one category that appears in both views; the footer must not
  // silently drop it, or a footer reading clean would be wrong.
  it("includes A3's row-unit failures in the footer as well as on its own line", () => {
    const a3Only = emptyReport({
      a3: { rows: [], counts: { considered: 2, repointed: 1, setGoogleOnly: 0, ambiguous: 0, lookupFailed: 0, writeFailed: 0, hardStops: 1 } },
    } as Partial<ReconcilerFixReport>);
    const msg = buildFixSlackMessage(a3Only);
    expect(msg).toContain('1 failed'); // A3's own line
    expect(msg).toContain('⚠ 1 write failure(s): 1 A3'); // and attributed in the footer
  });
});

describe('held-by-design is never presented as a failure', () => {
  const report = emptyReport({
    excludedFromA1: ['BHC-1', 'BHC-2'],
    excludedFromI1: ['BHC-3'],
  });

  it('names the hold and its reason, separately for A1 and I1', () => {
    const msg = buildFixSlackMessage(report);
    expect(msg).toContain('Held by design');
    expect(msg).toContain('2 A1 candidate(s): pointer contested by an S4 group');
    expect(msg).toContain('1 I1 candidate(s): BHC_ID is S1-disputed');
  });

  it('does not fold held candidates into the needs-you headline', () => {
    // Held means "not attempted", so it must not inflate the number that
    // represents attempted-and-stopped.
    expect(buildFixSlackMessage(report)).toContain('🔸 0 still need you');
  });
});

describe('out-of-scope findings are labelled as never-attempted', () => {
  const report = emptyReport({
    outOfScope: { A5: 4, G1: 2, S3: 1 } as Partial<Record<IssueCode, number>>,
  });

  it('lists each code with its type and severity', () => {
    const msg = buildFixSlackMessage(report);
    expect(msg).toContain("Not in Fix's scope - always needs manual review");
    expect(msg).toContain('A5 Attio name mismatch (HIGH) ×4');
    expect(msg).toContain('G1 Google row mismatch (HIGH) ×2');
    expect(msg).toContain('S3 Location/pointer mismatch (MEDIUM) ×1');
  });

  it('keeps them out of the in-scope candidate total', () => {
    expect(buildFixSlackMessage(report)).toContain('0 candidate(s) in scope');
  });
});

describe('clean run', () => {
  it('collapses to a single line when there is nothing in or out of scope', () => {
    const msg = buildFixSlackMessage(emptyReport());
    expect(msg).toBe('✓ Reconciler Fix RECON-FIX-1 - source audit RECON-9 had no repairable findings. Nothing to do.');
  });

  it('does NOT collapse when something out of scope still needs a human', () => {
    const msg = buildFixSlackMessage(emptyReport({ outOfScope: { G1: 1 } }));
    expect(msg).not.toContain('Nothing to do');
    expect(msg).toContain('G1 Google row mismatch (HIGH) ×1');
  });

  it('states plainly when no source run was found', () => {
    expect(buildFixSlackMessage(emptyReport({ sourceRunId: null }))).toContain('(no source run found)');
  });
});
