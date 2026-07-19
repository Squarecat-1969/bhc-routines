import { describe, expect, it } from 'vitest';

import { extractDriftNotes } from '../../src/passes/orchestrator/drift-notes.js';
import type { Pass2Report } from '../../src/passes/pass2/index.js';

function pass2Report(warnings: readonly string[]): Pass2Report {
  return {
    runId: 'RUN-1', dryRun: true, startedAt: '', finishedAt: '', aborted: false, abortReason: null,
    workingSetCount: 0, processedCount: 0, writtenCount: 0, noiseCount: 0, enrichmentFailureCount: 0,
    actionableCount: 0, driftCount: 0, previews: [], warnings,
  };
}

describe('extractDriftNotes', () => {
  it('pulls only the identity-drift warnings out of a Pass2Report', () => {
    const notes = extractDriftNotes(
      pass2Report([
        'T1: identity drift on primary — Attio bhc_contact_id mismatch. CRM writes withheld for the drifted side.',
        'T2: enrichment failed — timeout. Skipped.',
        'T3: identity drift on primary — Google Contacts col A mismatch. CRM writes withheld for the drifted side.',
      ]),
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('Attio bhc_contact_id mismatch');
    expect(notes[1]).toContain('Google Contacts col A mismatch');
  });

  it('returns an empty array when there are no drift warnings', () => {
    const notes = extractDriftNotes(pass2Report(['T1: enrichment failed — timeout. Skipped.']));
    expect(notes).toHaveLength(0);
  });

  it('returns an empty array for a report with no warnings at all', () => {
    expect(extractDriftNotes(pass2Report([]))).toHaveLength(0);
  });
});
