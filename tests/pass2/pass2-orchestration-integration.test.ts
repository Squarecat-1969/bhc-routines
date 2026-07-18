import { describe, expect, it } from 'vitest';

import { AnthropicClient } from '../../src/lib/anthropic.js';
import { AttioClient } from '../../src/lib/attio.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import { runPass2 } from '../../src/passes/pass2/index.js';
import { FakeAnthropicBackend } from '../helpers/fake-anthropic.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

const CONTACTS_HEADER = [
  'Contact_ID', 'B', 'C', 'D', 'E', 'Primary_Email', 'G', 'H', 'I', 'J', 'K', 'L',
  'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Relationship_Tier',
  'Z', 'AA', 'AB', 'Effective_Segment', 'AD', 'AE', 'AF', 'AG', 'AH', 'Personal_Notes',
  'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT', 'Topics_of_Interest', 'Conversation_Trigger',
];
const ID_COL = 0;
const EMAIL_COL = 5;
const PERSONAL_NOTES_COL = 35;
const TOPICS_COL = 47;
const TRIGGER_COL = 48;

function contactRow(opts: { id: string; email: string }): unknown[] {
  const row = new Array<unknown>(49).fill('');
  row[ID_COL] = opts.id;
  row[EMAIL_COL] = opts.email;
  row[PERSONAL_NOTES_COL] = '';
  row[TOPICS_COL] = '';
  row[TRIGGER_COL] = '';
  return row;
}

function rawEmailsJson(opts: { msgId: string; senderEmail: string; body: string; subject?: string; direction?: string }): string {
  return JSON.stringify([
    {
      record_id: 'r1',
      email_msg_id: opts.msgId,
      received_at: '2026-07-18T12:00:00.000Z',
      source_mailbox: 'gmail',
      direction: opts.direction ?? 'Inbound',
      sender_name: 'Alice',
      sender_email: opts.senderEmail,
      recipient_name: '',
      recipient_email: '',
      cc_list: '',
      subject: opts.subject ?? 'Hello',
      body: opts.body,
      thread_id: 'T1',
    },
  ]);
}

function threadStagingRow(opts: {
  threadId: string;
  contactName?: string;
  direction?: string;
  subject?: string;
  rawEmails: string;
  status?: string;
}): unknown[] {
  const row = new Array<unknown>(23).fill('');
  row[0] = opts.threadId;
  row[2] = opts.contactName ?? 'Alice Nguyen';
  row[4] = opts.direction ?? 'Inbound';
  row[5] = opts.subject ?? 'Hello';
  row[7] = '2026-07-18T12:00:00.000Z';
  row[9] = opts.rawEmails;
  row[14] = 'Open';
  row[21] = opts.status ?? 'ACTIVE';
  return row;
}

const VALID_ENRICHMENT = {
  running_summary: 'Alice followed up about the project.',
  key_commitments: 'Bobby to send the deck by Friday.',
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

const MINIMAL_SHEETS: FakeBackendConfig = {
  entries: [],
  people: {},
  masterId: [['BHC-00001', 'Alice Nguyen', 'BOTH', 3, 'rec-alice', '']],
  contactsHeader: CONTACTS_HEADER,
  contacts: [contactRow({ id: 'BHC-00001', email: 'alice@x.com' })],
  threadStaging: [],
};

async function run(
  sheetsConfig: Partial<FakeBackendConfig>,
  anthropicResponseText: string,
  dryRun: boolean,
  limit?: number,
) {
  const sheetsBackend = new FakeBackend({ ...MINIMAL_SHEETS, ...sheetsConfig });
  const { attioBase, sheetsUrl } = await sheetsBackend.start();
  const anthropicBackend = new FakeAnthropicBackend({ responseText: anthropicResponseText });
  const { baseUrl: anthropicBase } = await anthropicBackend.start();

  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
  const anthropic = new AnthropicClient({ apiKey: 'test', baseUrl: anthropicBase });

  try {
    const report = await runPass2({ dryRun, sheets, attio, anthropic, logger: silentLogger, ...(limit !== undefined ? { limit } : {}) });
    return { report, sheetsBackend, anthropicBackend };
  } finally {
    await sheetsBackend.stop();
    await anthropicBackend.stop();
  }
}

describe('PASS 2 orchestration — noise paths skip the LLM entirely', () => {
  it('a test/placeholder thread never calls Anthropic', async () => {
    const { report, anthropicBackend } = await run(
      { threadStaging: [threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'lorem ipsum dolor sit amet' }) })] },
      JSON.stringify(VALID_ENRICHMENT),
      false,
    );
    expect(report.noiseCount).toBe(1);
    expect(anthropicBackend.requests).toHaveLength(0);
  });

  it('an automated-sender thread never calls Anthropic', async () => {
    const { report, anthropicBackend } = await run(
      { threadStaging: [threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'no-reply@service.com', body: 'Your receipt' }) })] },
      JSON.stringify(VALID_ENRICHMENT),
      false,
    );
    expect(report.noiseCount).toBe(1);
    expect(anthropicBackend.requests).toHaveLength(0);
  });
});

describe('PASS 2 orchestration — a real relationship thread', () => {
  it('resolves the contact, calls Anthropic, and writes a full Brain_Complete row', async () => {
    const { report, sheetsBackend, anthropicBackend } = await run(
      {
        threadStaging: [
          threadStagingRow({
            threadId: 'T1',
            rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'Following up on the project timeline' }),
          }),
        ],
      },
      JSON.stringify(VALID_ENRICHMENT),
      false,
    );

    expect(report.writtenCount).toBe(1);
    expect(report.noiseCount).toBe(0);
    expect(anthropicBackend.requests).toHaveLength(1);

    const brainWrite = sheetsBackend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Brain_Complete!A1');
    expect(brainWrite).toBeDefined();
    const row = (brainWrite!.body as { values: unknown[][] }).values[0]!;
    expect(row[10]).toBe('Alice followed up about the project.'); // K Running_Summary
    expect(row[22]).toBe('ACTION_ITEM'); // W Action_Required

    const statusWrite = sheetsBackend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Thread_Staging!V2:W2');
    expect(statusWrite).toBeDefined();
    expect((statusWrite!.body as { values: unknown[][] }).values[0]).toEqual(['PROCESSED', report.runId]);
  });

  it('includes a content preview for an actionable thread — real content, reviewable without going --live', async () => {
    const { report } = await run(
      {
        threadStaging: [
          threadStagingRow({
            threadId: 'T1',
            rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'Following up on the project timeline' }),
          }),
        ],
      },
      JSON.stringify(VALID_ENRICHMENT),
      true,
    );
    expect(report.previews).toHaveLength(1);
    const preview = report.previews[0]!;
    expect(preview.isNoise).toBe(false);
    expect(preview.contactName).toBe('Alice Nguyen');
    expect(preview.actionRequired).toBe('ACTION_ITEM');
    expect(preview.runningSummary).toBe('Alice followed up about the project.');
    expect(preview.keyCommitments).toBe('Bobby to send the deck by Friday.');
    expect(preview.responseDraft).toBeNull(); // only populated for REPLY_NEEDED
  });

  it('includes response_draft in the preview only for REPLY_NEEDED', async () => {
    const replyNeeded = { ...VALID_ENRICHMENT, action_required: 'REPLY_NEEDED', response_draft: 'Hey Alice—Bobby' };
    const { report } = await run(
      {
        threadStaging: [
          threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'Question?' }) }),
        ],
      },
      JSON.stringify(replyNeeded),
      true,
    );
    expect(report.previews[0]!.responseDraft).toBe('Hey Alice—Bobby');
  });

  it('includes a preview for a noise-filtered thread, with the tag and no LLM content', async () => {
    const { report } = await run(
      { threadStaging: [threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'no-reply@service.com', body: 'Your receipt' }) })] },
      JSON.stringify(VALID_ENRICHMENT),
      true,
    );
    expect(report.previews).toHaveLength(1);
    const preview = report.previews[0]!;
    expect(preview.isNoise).toBe(true);
    expect(preview.noiseTag).toBe('noise:automated');
    expect(preview.runningSummary).toBeNull();
  });

  it('produces a Write_Targets_JSON with the resolved BHC_ID', async () => {
    const { sheetsBackend } = await run(
      {
        threadStaging: [
          threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'Following up' }) }),
        ],
      },
      JSON.stringify(VALID_ENRICHMENT),
      false,
    );
    const brainWrite = sheetsBackend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Brain_Complete!A1');
    const row = (brainWrite!.body as { values: unknown[][] }).values[0]!;
    const writeTargets = JSON.parse(row[25] as string); // Z
    expect(writeTargets.primary.bhc_id).toBe('BHC-00001');
  });
});

describe('PASS 2 orchestration — dry-run', () => {
  it('still calls Anthropic (real cost) but writes nothing to Sheets', async () => {
    const { report, sheetsBackend, anthropicBackend } = await run(
      {
        threadStaging: [
          threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'Following up' }) }),
        ],
      },
      JSON.stringify(VALID_ENRICHMENT),
      true,
    );
    expect(report.writtenCount).toBe(1); // computed, just not written
    expect(anthropicBackend.requests).toHaveLength(1);
    expect(sheetsBackend.sheetsWrites).toHaveLength(0);
  });
});

describe('PASS 2 orchestration — enrichment failure leaves the thread unprocessed', () => {
  it('does not write Brain_Complete or mark PROCESSED when Anthropic returns malformed JSON', async () => {
    const { report, sheetsBackend } = await run(
      {
        threadStaging: [
          threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'Following up' }) }),
        ],
      },
      'not valid json',
      false,
    );
    expect(report.enrichmentFailureCount).toBe(1);
    expect(report.writtenCount).toBe(0);
    expect(sheetsBackend.sheetsWrites).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('enrichment failed'))).toBe(true);
  });
});

describe('PASS 2 orchestration — identity drift', () => {
  it('flags drift and withholds the drifted CRM side, but still writes the Brain_Complete row', async () => {
    // Master_ID says rec-alice; Attio record's own bhc_contact_id disagrees -> Attio-side drift.
    const { report, sheetsBackend } = await run(
      {
        people: { 'rec-alice': { bhcContactId: 'BHC-WRONG' } },
        threadStaging: [
          threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'Following up' }) }),
        ],
      },
      JSON.stringify(VALID_ENRICHMENT),
      false,
    );
    expect(report.driftCount).toBe(1);
    expect(report.warnings.some((w) => w.includes('identity drift'))).toBe(true);
    expect(report.writtenCount).toBe(1); // still written — drift withholds only the drifted CRM side

    const brainWrite = sheetsBackend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Brain_Complete!A1');
    const row = (brainWrite!.body as { values: unknown[][] }).values[0]!;
    const writeTargets = JSON.parse(row[25] as string);
    expect(writeTargets.primary.attio).toBeUndefined(); // Attio side withheld
    expect(writeTargets.primary.google).toBeDefined(); // Google side still written
  });
});

describe('PASS 2 orchestration — --limit', () => {
  it('caps the number of threads processed', async () => {
    const { report } = await run(
      {
        threadStaging: [
          threadStagingRow({ threadId: 'T1', rawEmails: rawEmailsJson({ msgId: 'm1', senderEmail: 'alice@x.com', body: 'One' }) }),
          threadStagingRow({ threadId: 'T2', rawEmails: rawEmailsJson({ msgId: 'm2', senderEmail: 'alice@x.com', body: 'Two' }) }),
        ],
      },
      JSON.stringify(VALID_ENRICHMENT),
      true,
      1,
    );
    expect(report.workingSetCount).toBe(1);
  });
});

describe('PASS 2 orchestration — fail-soft', () => {
  it('never throws — a Sheets failure is caught and reported as aborted', async () => {
    const sheetsBackend = new FakeBackend(MINIMAL_SHEETS);
    const { sheetsUrl, attioBase } = await sheetsBackend.start();
    await sheetsBackend.stop();
    const anthropicBackend = new FakeAnthropicBackend({ responseText: JSON.stringify(VALID_ENRICHMENT) });
    const { baseUrl: anthropicBase } = await anthropicBackend.start();

    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
    const anthropic = new AnthropicClient({ apiKey: 'test', baseUrl: anthropicBase });

    try {
      const report = await runPass2({ dryRun: true, sheets, attio, anthropic, logger: silentLogger });
      expect(report.aborted).toBe(true);
      expect(report.abortReason).toBeTruthy();
    } finally {
      await anthropicBackend.stop();
    }
  }, 15_000);
});
