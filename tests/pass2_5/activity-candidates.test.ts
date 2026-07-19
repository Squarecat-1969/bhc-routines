import { describe, expect, it } from 'vitest';

import { filterCandidatesForCluster } from '../../src/passes/pass2_5/activity-candidates.js';
import type { ActivityLogCandidate, TaskCluster } from '../../src/passes/pass2_5/types.js';

function cluster(overrides: Partial<TaskCluster> = {}): TaskCluster {
  return {
    clusterKey: 'k', contactId: 'BHC-1', contactName: 'Alice', description: 'Send the contract',
    earliestCreatedAt: '2026-07-01T00:00:00Z', latestDueDate: '2026-07-10',
    tasks: [{ taskId: 'T1', createdAt: '2026-07-01T00:00:00Z', contactId: 'BHC-1', linkedinUrl: '', contactName: 'Alice', taskType: '', description: 'Send the contract', dueDate: '2026-07-10', status: 'Open', priority: 'High', owner: 'Bobby', closedAt: '', relatedActivityId: 'ACT-ORIGIN', sheetRow: 2 }],
    ...overrides,
  };
}

function candidate(overrides: Partial<ActivityLogCandidate> = {}): ActivityLogCandidate {
  return {
    activityId: 'ACT-1', timestamp: '2026-07-05T00:00:00Z', contactId: 'BHC-1', contactName: 'Alice',
    channel: 'Email', direction: 'Inbound', subject: 'Re: contract', body: 'Signed and sent back',
    outcome: 'Positive', source: 'orbit_work_queue', sheetRow: 5,
    ...overrides,
  };
}

describe('filterCandidatesForCluster', () => {
  it('keeps a candidate matching the contact, after the cluster start, real interaction, not originating', () => {
    const result = filterCandidatesForCluster(cluster(), [candidate()]);
    expect(result).toHaveLength(1);
  });

  it('excludes a candidate for a different contact', () => {
    const result = filterCandidatesForCluster(cluster(), [candidate({ contactId: 'BHC-2', contactName: 'Bob' })]);
    expect(result).toHaveLength(0);
  });

  it('excludes an automated Mark_Sent source', () => {
    const result = filterCandidatesForCluster(cluster(), [candidate({ source: 'Mark_Sent (Daily_Action_Growth)' })]);
    expect(result).toHaveLength(0);
  });

  it('excludes an outreach-beat source', () => {
    const result = filterCandidatesForCluster(cluster(), [candidate({ source: 'HF_Outreach_Beat_2' })]);
    expect(result).toHaveLength(0);
  });

  it("excludes the originating interaction (matches a task's relatedActivityId)", () => {
    const result = filterCandidatesForCluster(cluster(), [candidate({ activityId: 'ACT-ORIGIN' })]);
    expect(result).toHaveLength(0);
  });

  it('excludes a candidate dated before the cluster was created', () => {
    const result = filterCandidatesForCluster(cluster(), [candidate({ timestamp: '2026-06-01T00:00:00Z' })]);
    expect(result).toHaveLength(0);
  });

  it('includes a candidate dated exactly on the cluster creation date', () => {
    const result = filterCandidatesForCluster(cluster({ earliestCreatedAt: '2026-07-05T00:00:00Z' }), [
      candidate({ timestamp: '2026-07-05T00:00:00Z' }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('matches by contact name when BHC_ID is blank', () => {
    const result = filterCandidatesForCluster(cluster({ contactId: '' }), [candidate({ contactId: '' })]);
    expect(result).toHaveLength(1);
  });
});
