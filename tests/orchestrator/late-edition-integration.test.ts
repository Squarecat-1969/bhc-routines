import { describe, expect, it } from 'vitest';

import { AnthropicClient } from '../../src/lib/anthropic.js';
import { AttioClient } from '../../src/lib/attio.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { SlackPoster } from '../../src/lib/slack.js';
import { runLateEdition } from '../../src/passes/orchestrator/index.js';
import { FakeAnthropicBackend } from '../helpers/fake-anthropic.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

const CONTACTS_HEADER = [
  'Contact_ID', 'B', 'C', 'D', 'E', 'Primary_Email', 'G', 'H', 'I', 'J', 'K', 'L',
  'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Relationship_Tier',
  'Z', 'AA', 'AB', 'Effective_Segment', 'AD', 'AE', 'AF', 'AG', 'AH', 'Personal_Notes',
  'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT', 'Topics_of_Interest', 'Conversation_Trigger',
];

function contactRow(id: string, email: string): unknown[] {
  const row = new Array<unknown>(49).fill('');
  row[0] = id;
  row[5] = email;
  row[24] = 'Strategic';
  return row;
}

function rawEmailsJson(senderEmail: string, body: string): string {
  return JSON.stringify([
    {
      record_id: 'r1', email_msg_id: 'm1', received_at: '2026-07-19T12:00:00.000Z', source_mailbox: 'gmail',
      direction: 'Inbound', sender_name: 'Alice', sender_email: senderEmail, recipient_name: '', recipient_email: '',
      cc_list: '', subject: 'Hello', body, thread_id: 'T1',
    },
  ]);
}

function threadStagingRow(rawEmails: string): unknown[] {
  const row = new Array<unknown>(23).fill('');
  row[0] = 'T1';
  row[2] = 'Alice Nguyen';
  row[4] = 'Inbound';
  row[5] = 'Hello';
  row[7] = '2026-07-19T12:00:00.000Z';
  row[9] = rawEmails;
  row[14] = 'Open';
  row[21] = 'ACTIVE';
  return row;
}

const VALID_ENRICHMENT = {
  running_summary: 'Alice followed up on the project.',
  key_commitments: '',
  personal_details_flag: false,
  company_intel: '',
  pipeline_signals: '',
  brain_notes: '',
  action_required: 'FYI_ONLY',
  outcome: 'Neutral',
  response_draft: '',
  tasks: [],
  ready_to_archive: false,
  personal_notes_extract: '',
  topics_of_interest_extract: '',
  conversation_trigger_extract: '',
};

const MINIMAL: FakeBackendConfig = {
  entries: [], people: {}, masterId: [], contactsHeader: CONTACTS_HEADER, contacts: [],
};

function mockSlack(): SlackPoster & { posts: string[] } {
  const posts: string[] = [];
  return { posts, async post(text: string) { posts.push(text); } };
}

async function run(sheetsConfig: Partial<FakeBackendConfig>, dryRun: boolean) {
  const sheetsBackend = new FakeBackend({ ...MINIMAL, ...sheetsConfig });
  const { sheetsUrl, attioBase } = await sheetsBackend.start();
  const anthropicBackend = new FakeAnthropicBackend({ responseText: JSON.stringify(VALID_ENRICHMENT) });
  const { baseUrl: anthropicBase } = await anthropicBackend.start();

  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
  const anthropic = new AnthropicClient({ apiKey: 'test', baseUrl: anthropicBase });
  const slack = mockSlack();

  try {
    const report = await runLateEdition({ dryRun, timezone: 'UTC' }, { sheets, attio, anthropic, slack, logger: silentLogger });
    return { report, sheetsBackend, anthropicBackend, slack };
  } finally {
    await sheetsBackend.stop();
    await anthropicBackend.stop();
  }
}

describe('runLateEdition — chains all eight passes', () => {
  it('runs every pass and shares one Run_ID across all eight reports', async () => {
    const { report } = await run({}, true);
    const runId = report.runId;
    expect(report.pass0.runId).toBe(runId);
    expect(report.pass1.runId).toBe(runId);
    expect(report.pass2.runId).toBe(runId);
    expect(report.pass25.runId).toBe(runId);
    expect(report.pass3.runId).toBe(runId);
    expect(report.pass4.runId).toBe(runId);
    expect(report.pass45.runId).toBe(runId);
    expect(report.pass5.runId).toBe(runId);
  });

  it('completes cleanly against a fully empty dataset (nothing aborts unexpectedly)', async () => {
    const { report } = await run({}, true);
    expect(report.pass0.aborted).toBe(false);
    expect(report.pass1.aborted).toBe(false);
    expect(report.pass2.aborted).toBe(false);
    expect(report.pass25.aborted).toBe(false);
    expect(report.pass3.aborted).toBe(false);
    expect(report.pass45.aborted).toBe(false);
    expect(report.pass5.aborted).toBe(false);
  });

  it('processes a real thread through PASS 2 and surfaces it in PASS 3s digest', async () => {
    // Deliberately --live: PASS 2 gates its actual sheets.append() behind
    // !dryRun (confirmed while debugging this test — dry-run correctly
    // writes nothing at all, even though it still counts writtenCount for
    // reporting). Proving real cross-pass data flow needs a real write.
    const { report } = await run(
      {
        masterId: [['BHC-1', 'Alice Nguyen', 'BOTH', 3, 'rec-alice', '']],
        contacts: [contactRow('BHC-1', 'alice@x.com')],
        people: { 'rec-alice': { bhcContactId: 'BHC-1' } }, // matches Master_ID — no drift here, that's the next test
        threadStaging: [threadStagingRow(rawEmailsJson('alice@x.com', 'Following up on the project'))],
      },
      false,
    );
    expect(report.pass2.writtenCount).toBe(1);
    expect(report.pass2.driftCount).toBe(0);
    expect(report.pass3.bodyKind).not.toBe('failure');
    if (report.pass3.digestBody) {
      expect(report.pass3.digestBody).toContain('Alice Nguyen');
    }
  });

  it("flows PASS 2's identity-drift warning into PASS 3's digest — the specific standalone gap this orchestrator closes", async () => {
    const { report } = await run(
      {
        masterId: [['BHC-1', 'Alice Nguyen', 'BOTH', 3, 'rec-alice', '']],
        contacts: [contactRow('BHC-1', 'alice@x.com')],
        people: { 'rec-alice': { bhcContactId: 'BHC-WRONG' } }, // Attio's own record disagrees with Master_ID
        threadStaging: [threadStagingRow(rawEmailsJson('alice@x.com', 'Following up on the project'))],
      },
      false,
    );
    expect(report.pass2.driftCount).toBe(1);
    // The whole point: PASS 3, chained in-process, actually sees this —
    // standalone it never could (see docs/pass3-notes.md).
    expect(report.pass3.digestBody).toContain('Drift');
  });

  it('posts the PASS 4 and PASS 4.5 Slack addenda when live', async () => {
    const { slack } = await run({}, false);
    expect(slack.posts.length).toBeGreaterThanOrEqual(2);
  });

  it('never posts anything to Slack in dry-run', async () => {
    const { slack } = await run({}, true);
    expect(slack.posts).toHaveLength(0);
  });
});
