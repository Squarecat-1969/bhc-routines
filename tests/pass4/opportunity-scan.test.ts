import { describe, expect, it } from 'vitest';

import type { AttioPersonRecord } from '../../src/lib/attio.js';
import type { MasterIdIndex } from '../../src/passes/pass4/load.js';
import {
  buildEvidence,
  looksSynthetic,
  makeProposalId,
  scanForOpportunities,
  toSheetRow,
} from '../../src/passes/pass4/opportunity-scan.js';

/** Minimal Attio value shape — a list of {value} objects, as the API returns. */
function v(value: unknown): unknown[] {
  return [{ value }];
}

function person(opts: {
  recordId: string;
  name?: string | null;
  bhcId?: string | null;
  company?: string;
  outcome?: string;
  subject?: string;
  summary?: string;
  url?: string;
}): AttioPersonRecord {
  const values: Record<string, unknown> = {};
  if (opts.name !== null) values['name'] = [{ full_name: opts.name ?? 'Real Person' }];
  if (opts.bhcId !== null) values['bhc_contact_id'] = v(opts.bhcId ?? 'BHC-00001');
  values['company_name'] = v(opts.company ?? 'Acme');
  values['last_interaction_outcome'] = v(opts.outcome ?? 'Opportunity Emerging');
  if (opts.subject) values['last_interaction_subject'] = v(opts.subject);
  if (opts.summary) values['last_meeting_summary'] = v(opts.summary);
  values['last_interaction_url'] = v(opts.url ?? 'https://fathom.video/calls/698349985');
  return { recordId: opts.recordId, values };
}

function master(ids: readonly string[]): MasterIdIndex {
  const byBhcId = new Map(
    ids.map((id) => [id, { bhcId: id, fullName: `Name ${id}`, location: 'BOTH', googleRow: 10, attioRecordId: `rec-${id}`, masterRow: 5 }]),
  );
  return { byBhcId, byAttioRecordId: new Map(), rowCount: ids.length, duplicateAttioRecordIds: [] } as unknown as MasterIdIndex;
}

const BASE = {
  pipelineRecordIds: new Set<string>(),
  existingProposalRecordIds: new Set<string>(),
  runId: 'RUN-1',
  detectedAt: '2026-08-17T00:00:00.000Z',
};

describe('scanForOpportunities — the four exclusion rules', () => {
  it('proposes a real, unlisted, unproposed contact', () => {
    const r = scanForOpportunities({
      ...BASE,
      people: [person({ recordId: 'rec-a', bhcId: 'BHC-1' })],
      master: master(['BHC-1']),
    });
    expect(r.counts.proposed).toBe(1);
    expect(r.proposals[0]!.status).toBe('PENDING');
    expect(r.proposals[0]!.proposedTrack).toBe('TNB');
    expect(r.proposals[0]!.runId).toBe('RUN-1');
  });

  it('(a) excludes anyone already on the pipeline list', () => {
    const r = scanForOpportunities({
      ...BASE,
      people: [person({ recordId: 'rec-a', bhcId: 'BHC-1' })],
      master: master(['BHC-1']),
      pipelineRecordIds: new Set(['rec-a']),
    });
    expect(r.counts.proposed).toBe(0);
    expect(r.counts.excludedOnPipeline).toBe(1);
    expect(r.exclusions[0]!.rule).toBe('already_on_pipeline');
  });

  it('(b) excludes a bhc_contact_id with no Master_ID row', () => {
    const r = scanForOpportunities({
      ...BASE,
      people: [person({ recordId: 'rec-a', bhcId: 'BHC-GHOST' })],
      master: master(['BHC-1']),
    });
    expect(r.counts.excludedNoMasterId).toBe(1);
    expect(r.exclusions[0]!.detail).toContain('BHC-GHOST');
  });

  it('(b) excludes a record carrying no bhc_contact_id at all', () => {
    const r = scanForOpportunities({
      ...BASE,
      people: [person({ recordId: 'rec-a', bhcId: null })],
      master: master(['BHC-1']),
    });
    expect(r.counts.excludedNoMasterId).toBe(1);
    expect(r.exclusions[0]!.detail).toContain('no bhc_contact_id');
  });

  it('(b2) excludes the synthetic seed that PASSES the Master_ID check', () => {
    // The real David Park case: BHC-02379 has a genuine Master_ID row, so rule
    // (b) lets it through. Only the sentinel Fathom id catches it.
    const r = scanForOpportunities({
      ...BASE,
      people: [person({ recordId: 'rec-park', bhcId: 'BHC-02379', url: 'https://fathom.video/calls/999999999' })],
      master: master(['BHC-02379']),
    });
    expect(r.counts.excludedNoMasterId).toBe(0); // proves (b) did NOT catch it
    expect(r.counts.excludedSynthetic).toBe(1);
    expect(r.counts.proposed).toBe(0);
    expect(r.exclusions[0]!.detail).toContain('999999999');
  });

  it('(c) never re-proposes a record that already has a row, in ANY status', () => {
    const r = scanForOpportunities({
      ...BASE,
      people: [person({ recordId: 'rec-a', bhcId: 'BHC-1' })],
      master: master(['BHC-1']),
      existingProposalRecordIds: new Set(['rec-a']),
    });
    expect(r.counts.excludedAlreadyProposed).toBe(1);
    expect(r.counts.proposed).toBe(0);
  });

  it('counts every rule independently across a mixed batch', () => {
    const r = scanForOpportunities({
      ...BASE,
      people: [
        person({ recordId: 'rec-ok', bhcId: 'BHC-1' }),
        person({ recordId: 'rec-listed', bhcId: 'BHC-2' }),
        person({ recordId: 'rec-ghost', bhcId: 'BHC-NOPE' }),
        person({ recordId: 'rec-fake', bhcId: 'BHC-3', url: 'https://fathom.video/calls/999999999' }),
        person({ recordId: 'rec-dupe', bhcId: 'BHC-4' }),
      ],
      master: master(['BHC-1', 'BHC-2', 'BHC-3', 'BHC-4']),
      pipelineRecordIds: new Set(['rec-listed']),
      existingProposalRecordIds: new Set(['rec-dupe']),
    });
    expect(r.counts).toMatchObject({
      candidates: 5, excludedOnPipeline: 1, excludedNoMasterId: 1,
      excludedSynthetic: 1, excludedAlreadyProposed: 1, proposed: 1,
    });
    expect(r.proposals[0]!.attioRecordId).toBe('rec-ok');
  });
});

describe('looksSynthetic — narrow on purpose', () => {
  it('flags a repeated-digit sentinel call id', () => {
    expect(looksSynthetic(person({ recordId: 'r', url: 'https://fathom.video/calls/999999999' })).synthetic).toBe(true);
  });

  it('does NOT flag ordinary Fathom ids, including ones containing 9s', () => {
    for (const id of ['698349985', '664423062', '999123456', '199999999']) {
      expect(looksSynthetic(person({ recordId: 'r', url: `https://fathom.video/calls/${id}` })).synthetic).toBe(false);
    }
  });

  it('does NOT flag on a "test" subject — prose keywords catch real meetings too', () => {
    const p = person({ recordId: 'r', subject: 'A/B test review with the team', url: 'https://fathom.video/calls/698349985' });
    expect(looksSynthetic(p).synthetic).toBe(false);
  });

  it('does not flag a record with no interaction url at all', () => {
    const p: AttioPersonRecord = { recordId: 'r', values: {} };
    expect(looksSynthetic(p).synthetic).toBe(false);
  });
});

describe('evidence + row shape', () => {
  it('carries the real outcome text AND summary content, not just a label', () => {
    const e = buildEvidence(person({
      recordId: 'r', outcome: 'Opportunity Emerging',
      subject: 'URSA animation review', summary: 'Runtime extended, UI simplified, ship scheduled.',
    }));
    expect(e).toContain('Opportunity Emerging');
    expect(e).toContain('URSA animation review');
    expect(e).toContain('Runtime extended');
  });

  it('truncates a very long summary with an ellipsis rather than unbounded text', () => {
    const e = buildEvidence(person({ recordId: 'r', summary: 'x'.repeat(2000) }));
    expect(e.length).toBeLessThan(600);
    expect(e).toContain('…');
  });

  it('falls back to the Master_ID name when Attio has no name', () => {
    const r = scanForOpportunities({
      ...BASE,
      people: [person({ recordId: 'rec-a', bhcId: 'BHC-1', name: null })],
      master: master(['BHC-1']),
    });
    expect(r.proposals[0]!.contactName).toBe('Name BHC-1');
  });

  it('produces a stable, deterministic proposal id — a re-run cannot mint a second one', () => {
    expect(makeProposalId('b7d10177-db88-4908-b5bc-983401b0f6a0')).toBe('PROP-b7d10177');
    expect(makeProposalId('b7d10177-db88-4908-b5bc-983401b0f6a0')).toBe(makeProposalId('b7d10177-db88-4908-b5bc-983401b0f6a0'));
  });

  it('emits exactly 12 columns, A-L, in the tab header order', () => {
    const row = toSheetRow({
      proposalId: 'PROP-1', attioRecordId: 'rec-1', bhcId: 'BHC-1', contactName: 'A',
      companyName: 'C', evidence: 'E', proposedTrack: 'TNB', detectedAt: 'D', runId: 'R', status: 'PENDING',
    });
    expect(row).toHaveLength(12);
    expect(row[9]).toBe('PENDING');
    expect(row[10]).toBe(''); // Resolved_At — bhc-aida fills this
    expect(row[11]).toBe(''); // Reject_Reason
  });
});
