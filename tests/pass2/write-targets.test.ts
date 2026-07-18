import { describe, expect, it } from 'vitest';

import { buildWriteTargets } from '../../src/passes/pass2/write-targets.js';
import type { PrimaryTargetInput, SecondaryTargetInput } from '../../src/passes/pass2/write-targets.js';
import type { DriftCheckResult, ResolvedContact } from '../../src/passes/pass2/types.js';

const CLEAN_DRIFT: DriftCheckResult = { clean: true, tags: [], notes: [] };

function resolved(overrides: Partial<ResolvedContact> = {}): ResolvedContact {
  return {
    email: 'alice@x.com', source: 'CONTACTS', bhcId: 'BHC-1', googleRow: 10, attioRecordId: 'rec-1', location: 'BOTH',
    ...overrides,
  };
}

const BASE_INTERACTION = {
  date: '2026-07-18', channel: 'Email' as const, direction: 'Inbound' as const,
  subject: 'Re: catching up', summary: 'Caught up on the project.', outcome: 'Positive' as const,
  keyCommitments: 'Alice to send updated deck by Friday.',
};

function primaryInput(overrides: Partial<PrimaryTargetInput> = {}): PrimaryTargetInput {
  return { resolved: resolved(), drift: CLEAN_DRIFT, interaction: BASE_INTERACTION, personalContext: null, ...overrides };
}

describe('buildWriteTargets', () => {
  it('returns null (omit entirely) when the primary BHC_ID is unresolved', () => {
    const input = primaryInput({ resolved: resolved({ bhcId: null }) });
    expect(buildWriteTargets(input)).toBeNull();
  });

  it('includes both google and attio blocks for a clean BOTH-location contact', () => {
    const result = buildWriteTargets(primaryInput());
    expect(result?.primary.google).toBeDefined();
    expect(result?.primary.attio).toBeDefined();
    expect(result?.primary.google?.fields.CD).toBe('Re: catching up');
    expect(result?.primary.attio?.fields.last_meeting_summary).toBe('Caught up on the project.');
  });

  it('omits the google block for an ATTIO-only contact', () => {
    const result = buildWriteTargets(primaryInput({ resolved: resolved({ location: 'ATTIO', googleRow: null }) }));
    expect(result?.primary.google).toBeUndefined();
    expect(result?.primary.attio).toBeDefined();
  });

  it('omits the attio block for a GOOGLE-only contact', () => {
    const result = buildWriteTargets(primaryInput({ resolved: resolved({ location: 'GOOGLE', attioRecordId: null }) }));
    expect(result?.primary.attio).toBeUndefined();
    expect(result?.primary.google).toBeDefined();
  });

  it('withholds only the google block on drift:google-row-mismatch, still writes attio', () => {
    const drift: DriftCheckResult = { clean: false, tags: ['drift:google-row-mismatch'], notes: ['mismatch'] };
    const result = buildWriteTargets(primaryInput({ drift }));
    expect(result?.primary.google).toBeUndefined();
    expect(result?.primary.attio).toBeDefined();
  });

  it('withholds only the attio block on drift:attio-id-mismatch, still writes google', () => {
    const drift: DriftCheckResult = { clean: false, tags: ['drift:attio-id-mismatch'], notes: ['mismatch'] };
    const result = buildWriteTargets(primaryInput({ drift }));
    expect(result?.primary.attio).toBeUndefined();
    expect(result?.primary.google).toBeDefined();
  });

  it('includes personal_context when at least one extract field is non-empty', () => {
    const result = buildWriteTargets(
      primaryInput({ personalContext: { personalNotesExtract: 'New baby!', topicsOfInterestExtract: '', conversationTriggerExtract: '' } }),
    );
    expect(result?.primary.personal_context).toBeDefined();
    expect(result?.primary.personal_context?.personal_notes_extract).toBe('New baby!');
  });

  it('omits personal_context entirely when all three fields are empty strings', () => {
    const result = buildWriteTargets(
      primaryInput({ personalContext: { personalNotesExtract: '', topicsOfInterestExtract: '', conversationTriggerExtract: '' } }),
    );
    expect(result?.primary.personal_context).toBeUndefined();
  });

  it('omits personal_context when null (personal_details_flag was false)', () => {
    const result = buildWriteTargets(primaryInput({ personalContext: null }));
    expect(result?.primary.personal_context).toBeUndefined();
  });

  it('includes a resolved secondary with its own attio block', () => {
    const secondaries: SecondaryTargetInput[] = [
      { resolved: resolved({ bhcId: 'BHC-2', attioRecordId: 'rec-2', location: 'ATTIO' }), drift: CLEAN_DRIFT, roleNote: 'CC\'d, colleague' },
    ];
    const result = buildWriteTargets(primaryInput(), secondaries);
    expect(result?.secondary).toHaveLength(1);
    expect(result?.secondary[0]?.bhc_id).toBe('BHC-2');
    expect(result?.secondary[0]?.attio?.fields.last_meeting_summary).toBe("CC'd, colleague");
  });

  it('excludes an unresolved secondary from the output array entirely', () => {
    const secondaries: SecondaryTargetInput[] = [
      { resolved: resolved({ bhcId: null }), drift: CLEAN_DRIFT, roleNote: 'unknown cc' },
    ];
    const result = buildWriteTargets(primaryInput(), secondaries);
    expect(result?.secondary).toHaveLength(0);
  });

  it('a TypeScript-level guarantee: secondaries never carry a personal_context field', () => {
    const secondaries: SecondaryTargetInput[] = [
      { resolved: resolved({ bhcId: 'BHC-2' }), drift: CLEAN_DRIFT, roleNote: 'note' },
    ];
    const result = buildWriteTargets(primaryInput(), secondaries);
    expect(result?.secondary[0]).not.toHaveProperty('personal_context');
  });
});
