import { describe, expect, it } from 'vitest';

import { computeReplyMode, computeReplyRecipients } from '../../src/passes/pass2/reply-recipients.js';
import { buildSlackBlock } from '../../src/passes/pass2/slack-block.js';
import { filterWorkingSet, parseThreadStagingFullRows } from '../../src/passes/pass2/thread-staging-row.js';
import { buildBrainCompleteRow } from '../../src/passes/pass2/brain-complete-row.js';
import type { BrainCompleteRowInput } from '../../src/passes/pass2/brain-complete-row.js';
import type { ThreadStagingFullRow } from '../../src/passes/pass2/types.js';
import type { EnrichmentResponse } from '../../src/passes/pass2/enrich-schema.js';

describe('computeReplyRecipients / computeReplyMode', () => {
  it('puts the primary in "to" and secondaries in "cc"', () => {
    const r = computeReplyRecipients('alice@x.com', ['bob@x.com', 'carol@x.com']);
    expect(r.to).toEqual(['alice@x.com']);
    expect(r.cc).toEqual(['bob@x.com', 'carol@x.com']);
  });

  it('is "individual" with no secondaries, "group" with any', () => {
    expect(computeReplyMode([])).toBe('individual');
    expect(computeReplyMode(['bob@x.com'])).toBe('group');
    expect(computeReplyMode(['bob@x.com', 'carol@x.com'])).toBe('group');
  });
});

describe('buildSlackBlock', () => {
  it('formats the standard block', () => {
    const block = buildSlackBlock({
      index: 1, contactName: 'Alice Nguyen', subject: 'Re: catching up',
      actionRequired: 'FYI_ONLY', oneLineSummary: 'Caught up on the project.', responseDraft: '',
    });
    expect(block).toBe('[1] Alice Nguyen — Re: catching up\nFYI_ONLY | Caught up on the project.');
  });

  it('shows "⚠ unresolved" for a null contact name', () => {
    const block = buildSlackBlock({
      index: 2, contactName: null, subject: 'Hello', actionRequired: 'ACTION_ITEM', oneLineSummary: 'summary', responseDraft: '',
    });
    expect(block).toContain('⚠ unresolved');
  });

  it('appends the Draft line only for REPLY_NEEDED with a non-empty draft', () => {
    const block = buildSlackBlock({
      index: 3, contactName: 'Bob', subject: 'Question', actionRequired: 'REPLY_NEEDED',
      oneLineSummary: 'Bob asked about pricing.', responseDraft: 'Hey Bob, happy to walk through it—Bobby',
    });
    expect(block).toContain('Draft: "Hey Bob, happy to walk through it—Bobby"');
  });

  it('does not append a Draft line for non-REPLY_NEEDED even if responseDraft is somehow set', () => {
    const block = buildSlackBlock({
      index: 4, contactName: 'Bob', subject: 'Q', actionRequired: 'ACTION_ITEM',
      oneLineSummary: 'summary', responseDraft: 'should not appear',
    });
    expect(block).not.toContain('Draft:');
  });
});

function rawRow(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const row = new Array<unknown>(23).fill('');
  row[0] = overrides.threadId ?? 'T1';
  row[4] = overrides.direction ?? 'Inbound';
  row[5] = overrides.subject ?? 'Hello';
  row[21] = overrides.rowStatus ?? 'ACTIVE';
  row[22] = overrides.runId ?? 'RUN-1';
  return row;
}

describe('parseThreadStagingFullRows / filterWorkingSet', () => {
  it('parses all 23 columns with correct sheetRow', () => {
    const rows = parseThreadStagingFullRows([rawRow({ threadId: 'T1' }), rawRow({ threadId: 'T2' })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.threadId).toBe('T1');
    expect(rows[0]!.sheetRow).toBe(2);
    expect(rows[1]!.sheetRow).toBe(3);
  });

  it('filterWorkingSet excludes PROCESSED rows', () => {
    const rows = parseThreadStagingFullRows([
      rawRow({ threadId: 'T1', rowStatus: 'PENDING' }),
      rawRow({ threadId: 'T2', rowStatus: 'PROCESSED' }),
    ]);
    const workingSet = filterWorkingSet(rows);
    expect(workingSet.map((r) => r.threadId)).toEqual(['T1']);
  });
});

function fullSourceRow(overrides: Partial<ThreadStagingFullRow> = {}): ThreadStagingFullRow {
  return {
    threadId: 'T1', bhcId: '', contactName: 'Alice Nguyen', sourceMailbox: 'gmail', direction: 'Inbound',
    subject: 'Re: catching up', firstEmailDate: '', lastEmailDate: '', emailCount: '1', rawEmailsJson: '[]',
    runningSummary: '', keyCommitments: '', personalDetailsFlag: '', companyIntel: '', threadStatus: 'Open',
    readyToArchive: '', parentThreadId: '', contactHistoryRowId: '', crmLastSynced: '', pipelineSignals: '',
    brainNotes: '', rowStatus: 'ACTIVE', runId: '', sheetRow: 2,
    ...overrides,
  };
}

const ENRICHED: EnrichmentResponse = {
  running_summary: 'Caught up on the project.',
  key_commitments: 'Alice to send the deck by Friday.',
  personal_details_flag: false,
  company_intel: '',
  pipeline_signals: '',
  brain_notes: '',
  action_required: 'ACTION_ITEM',
  outcome: 'Neutral',
  response_draft: '',
  tasks: [],
  ready_to_archive: false,
  personal_notes_extract: '',
  topics_of_interest_extract: '',
  conversation_trigger_extract: '',
};

function brainInput(overrides: Partial<BrainCompleteRowInput> = {}): BrainCompleteRowInput {
  return {
    source: fullSourceRow(),
    content: { kind: 'enriched', enrichment: ENRICHED },
    writeTargets: null,
    primaryEmail: null,
    secondaryEmails: [],
    contactNameForSlack: 'Alice Nguyen',
    slackIndex: 1,
    runId: 'RUN-1',
    ...overrides,
  };
}

describe('buildBrainCompleteRow', () => {
  it('produces exactly 30 columns (A-AD)', () => {
    const row = buildBrainCompleteRow(brainInput());
    expect(row.values).toHaveLength(30);
  });

  it('carries A-J and Q-S through unchanged from the source row', () => {
    const source = fullSourceRow({ threadId: 'T-abc', contactName: 'Bob', subject: 'Hi', parentThreadId: 'PARENT-1' });
    const row = buildBrainCompleteRow(brainInput({ source }));
    expect(row.values[0]).toBe('T-abc'); // A Thread_ID
    expect(row.values[2]).toBe('Bob'); // C Contact_Name
    expect(row.values[5]).toBe('Hi'); // F Subject
    expect(row.values[16]).toBe('PARENT-1'); // Q Parent_Thread_ID
  });

  it('overrides K/L/M/N/T/U with enrichment content', () => {
    const row = buildBrainCompleteRow(brainInput());
    expect(row.values[10]).toBe('Caught up on the project.'); // K Running_Summary
    expect(row.values[11]).toBe('Alice to send the deck by Friday.'); // L Key_Commitments
  });

  it('leaves col V (Brain_Complete flag) blank', () => {
    const row = buildBrainCompleteRow(brainInput());
    expect(row.values[21]).toBe('');
  });

  it('writes Action_Required to col W', () => {
    const row = buildBrainCompleteRow(brainInput());
    expect(row.values[22]).toBe('ACTION_ITEM');
  });

  it('produces a Slack block for an actionable row', () => {
    const row = buildBrainCompleteRow(brainInput());
    expect(row.slackBlock).not.toBeNull();
    expect(row.values[26]).toBe(row.slackBlock); // AA
  });

  it('produces NO Slack block for a NO_ACTION row (noise)', () => {
    const row = buildBrainCompleteRow(brainInput({ content: { kind: 'noise', tag: 'noise:test' } }));
    expect(row.slackBlock).toBeNull();
    expect(row.values[26]).toBe(''); // AA blank
    expect(row.values[22]).toBe('NO_ACTION'); // W
  });

  it('tags Brain_Notes with the noise reason for a filtered row', () => {
    const row = buildBrainCompleteRow(brainInput({ content: { kind: 'noise', tag: 'noise:automated' } }));
    expect(row.values[20]).toContain('noise:automated'); // U Brain_Notes
  });

  it('populates Reply_Recipients_JSON/Reply_Mode only for REPLY_NEEDED with a resolved primary', () => {
    const replyNeeded: EnrichmentResponse = { ...ENRICHED, action_required: 'REPLY_NEEDED', response_draft: 'Hey!—Bobby' };
    const row = buildBrainCompleteRow(
      brainInput({
        content: { kind: 'enriched', enrichment: replyNeeded },
        primaryEmail: 'alice@x.com',
        secondaryEmails: ['bob@x.com'],
      }),
    );
    const recipients = JSON.parse(row.values[28] as string); // AC
    expect(recipients).toEqual({ to: ['alice@x.com'], cc: ['bob@x.com'] });
    expect(row.values[29]).toBe('group'); // AD
  });

  it('leaves Reply_Recipients_JSON/Reply_Mode blank when REPLY_NEEDED but primary is unresolved', () => {
    const replyNeeded: EnrichmentResponse = { ...ENRICHED, action_required: 'REPLY_NEEDED', response_draft: 'Hey!—Bobby' };
    const row = buildBrainCompleteRow(
      brainInput({ content: { kind: 'enriched', enrichment: replyNeeded }, primaryEmail: null }),
    );
    expect(row.values[28]).toBe('');
    expect(row.values[29]).toBe('');
  });

  it('serializes Write_Targets_JSON when provided, blank string when null', () => {
    const withTargets = buildBrainCompleteRow(brainInput({ writeTargets: { primary: { bhc_id: 'BHC-1' }, secondary: [] } }));
    expect(JSON.parse(withTargets.values[25] as string)).toEqual({ primary: { bhc_id: 'BHC-1' }, secondary: [] });

    const withoutTargets = buildBrainCompleteRow(brainInput({ writeTargets: null }));
    expect(withoutTargets.values[25]).toBe('');
  });
});
