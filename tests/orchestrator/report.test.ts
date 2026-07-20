import { describe, expect, it } from 'vitest';

import { renderReport } from '../../src/passes/orchestrator/report.js';
import type { LateEditionReport } from '../../src/passes/orchestrator/types.js';

function baseReport(overrides: Partial<LateEditionReport> = {}): LateEditionReport {
  return {
    runId: 'RUN-1', dryRun: true, startedAt: '2026-07-19T00:00:00.000Z', finishedAt: '2026-07-19T00:01:00.000Z',
    pass0: {
      runId: 'RUN-1', dryRun: true, startedAt: '', finishedAt: '', aborted: false, abortReason: null,
      placeholderCount: 0, exactMatches: [], inferredMatches: [], ambiguousCount: 0, noMatchCount: 0,
      stalePlaceholderCount: 0, warnings: [],
    },
    pass1: {
      runId: 'RUN-1', dryRun: true, startedAt: '', finishedAt: '', aborted: false, abortReason: null,
      brainCompletePriorCount: 0, brainCompleteResolvedCount: 0, brainCompleteSurvivorCount: 0,
      threadStagingTotalCount: 0, workingSet: [], warnings: [],
    },
    pass2: {
      runId: 'RUN-1', dryRun: true, startedAt: '', finishedAt: '', aborted: false, abortReason: null,
      workingSetCount: 0, processedCount: 0, writtenCount: 0, noiseCount: 0, enrichmentFailureCount: 0,
      actionableCount: 0, driftCount: 0, previews: [], warnings: [],
    } as LateEditionReport['pass2'],
    pass25: {
      runId: 'RUN-1', dryRun: true, startedAt: '', finishedAt: '', aborted: false, abortReason: null,
      openTaskCount: 0, clusterCount: 0, handledCount: 0, staleCount: 0, openCount: 0, enqueuedCount: 0,
      supersededCount: 0, results: [], warnings: [],
    } as LateEditionReport['pass25'],
    pass3: {
      runId: 'RUN-1', dryRun: true, startedAt: '', finishedAt: '', aborted: false, abortReason: null,
      rowCount: 0, surfacedCount: 0, filteredCount: 0, bodyKind: 'all_clear', posted: false, digestBody: null, warnings: [],
    },
    pass4: {
      runId: 'RUN-1', today: '2026-07-19' as never, timezone: 'UTC', dryRun: true, startedAt: '', finishedAt: '',
      pipelineEntryCount: 0, masterIdRowCount: 0, tierIndexSize: 0, tierHeaderTitle: '', rows: [], writes: [],
      counts: { eligible: 0, withheld: 0, written: 0, failed: 0, verifiedMismatch: 0, stalled: 0, unmappedToMasterId: 0, tierDefaulted: 0 },
      warnings: [],
    },
    pass45: {
      runId: 'RUN-1', today: '2026-07-19' as never, dryRun: true, startedAt: '', finishedAt: '',
      skippedTabAbsent: false, aborted: false, abortReason: null, targetCount: 0, rows: [], withheld: [],
      mismatchCount: 0, unresolvedCount: 0, pipelineCount: 0, liteCount: 0, nameConflictsEnqueued: [], warnings: [],
    } as LateEditionReport['pass45'],
    pass5: {
      runId: 'RUN-1', dryRun: true, startedAt: '', finishedAt: '', aborted: false, abortReason: null,
      openTaskCount: 0, brainCompleteRowCount: 0, pipelineEntryCount: 0, meetingsToReviewCount: 0,
      planItemCount: 0, overflowItemCount: 0, written: false, gamePlan: null, warnings: [],
    },
    ...overrides,
  };
}

describe('renderReport — warning aggregation', () => {
  it('omits the WARNINGS section entirely when no pass has any warnings', () => {
    const text = renderReport(baseReport());
    expect(text).not.toContain('WARNINGS');
  });

  it('surfaces warnings from every pass, prefixed by pass name — previously silently dropped from the summary', () => {
    const report = baseReport({
      pass2: { ...baseReport().pass2, warnings: ['T1: enrichment failed — timeout. Skipped.'] } as LateEditionReport['pass2'],
      pass25: { ...baseReport().pass25, warnings: ['BHC-1: reconciliation failed — timeout. Skipped.'] } as LateEditionReport['pass25'],
    });
    const text = renderReport(report);
    expect(text).toContain('WARNINGS (2):');
    expect(text).toContain('[PASS 2] T1: enrichment failed — timeout. Skipped.');
    expect(text).toContain('[PASS 2.5] BHC-1: reconciliation failed — timeout. Skipped.');
  });

  it('counts warnings correctly across multiple passes', () => {
    const report = baseReport({
      pass0: { ...baseReport().pass0, warnings: ['w1', 'w2'] },
      pass5: { ...baseReport().pass5, warnings: ['w3'] },
    });
    const text = renderReport(report);
    expect(text).toContain('WARNINGS (3):');
  });
});
