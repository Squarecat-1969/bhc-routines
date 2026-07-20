import { afterEach, describe, expect, it } from 'vitest';

import { AttioClient } from '../../src/lib/attio.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { SlackPoster } from '../../src/lib/slack.js';
import { runPartD } from '../../src/part-d/index.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

let backend: FakeBackend;

function fakeSlack(): SlackPoster & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    async post(text: string) {
      posts.push(text);
    },
  };
}

async function setup(brainComplete: unknown[][], config: Partial<FakeBackendConfig> = {}): Promise<{
  sheets: SheetsClient; attio: AttioClient; slack: ReturnType<typeof fakeSlack>; backend: FakeBackend;
}> {
  backend = new FakeBackend({
    entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [], brainComplete, ...config,
  });
  const { attioBase, sheetsUrl } = await backend.start();
  const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  return { sheets, attio, slack: fakeSlack(), backend };
}

afterEach(async () => {
  await backend?.stop();
});

function row(opts: { bhcId?: string; runId?: string; actionRequired?: string; writeTargetsJson?: string }): unknown[] {
  const r = new Array<unknown>(30).fill('');
  r[1] = opts.bhcId ?? 'BHC-1';
  r[2] = 'Alice';
  r[4] = 'Inbound';
  r[5] = 'Re: contract';
  r[10] = 'summary';
  r[21] = '';
  r[22] = opts.actionRequired ?? 'REPLY_NEEDED';
  r[24] = '[]';
  r[25] = opts.writeTargetsJson ?? '';
  r[27] = opts.runId ?? 'LATE-EDITION-1';
  return r;
}

describe('runPartD — stop conditions', () => {
  it('posts the no-run-id message and does not touch Brain_Complete at all', async () => {
    const { sheets, attio, slack } = await setup([row({})]);
    const report = await runPartD({ commandText: 'RESOLVE', dryRun: false }, { sheets, attio, slack, logger: silentLogger });

    expect(report.stopReason).toBe('no_run_id');
    expect(slack.posts).toEqual(["Couldn't find a run id — ignoring."]);
    expect(backend.requests.some((r) => r.path === '/sheets')).toBe(false); // never even read Brain_Complete
  });

  it('posts the unrecognized-command message', async () => {
    const { sheets, attio, slack } = await setup([row({})]);
    const report = await runPartD({ commandText: 'DELETE LATE-EDITION-1', dryRun: false }, { sheets, attio, slack, logger: silentLogger });
    expect(report.stopReason).toBe('unrecognized_command');
    expect(slack.posts).toEqual(["Couldn't read a valid command — no action taken."]);
  });

  it('stops SILENTLY on an empty run set — no Slack post at all, per spec', async () => {
    const { sheets, attio, slack } = await setup([row({ runId: 'LATE-EDITION-999' })]); // different run id
    const report = await runPartD({ commandText: 'RESOLVE LATE-EDITION-1', dryRun: false }, { sheets, attio, slack, logger: silentLogger });
    expect(report.stopReason).toBe('empty_run_set');
    expect(slack.posts).toEqual([]); // truly nothing — not even the acknowledgment
  });

  it('posts the no-valid-item-actions message for a MIXED command with nothing parseable', async () => {
    const { sheets, attio, slack } = await setup([row({})]);
    const report = await runPartD({ commandText: 'MIXED LATE-EDITION-1\ngarbage line', dryRun: false }, { sheets, attio, slack, logger: silentLogger });
    expect(report.stopReason).toBe('no_valid_item_actions');
    // Acknowledgment DOES post here — we have a valid run id and a valid command, just nothing actionable within it
    expect(slack.posts).toEqual(['⚡ LATE-EDITION-1 — on it…', 'No valid item actions found — nothing done.']);
  });
});

describe('runPartD — dry run (outer-level only, see index.ts module doc comment)', () => {
  it('parses and loads the run set but never calls into branch.ts — no writes, no Slack post', async () => {
    const { sheets, attio, slack } = await setup([row({ bhcId: 'BHC-1' })]);
    const report = await runPartD({ commandText: 'PROCEED LATE-EDITION-1', dryRun: true }, { sheets, attio, slack, logger: silentLogger });

    expect(report.dryRun).toBe(true);
    expect(report.command).toBe('PROCEED');
    expect(report.runSetSize).toBe(1);
    expect(report.posted).toBe(false);
    expect(slack.posts).toEqual([]); // nothing posted at all in dry-run, not even the acknowledgment
    const vWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!V'));
    expect(vWrites).toHaveLength(0); // confirmed nothing was written
  });
});

describe('runPartD — end to end, live', () => {
  it('PROCEED: acknowledges, closes every row, posts the confirmation', async () => {
    const { sheets, attio, slack } = await setup([row({ bhcId: 'BHC-1' }), row({ bhcId: 'BHC-2' })]);
    const report = await runPartD({ commandText: 'PROCEED LATE-EDITION-1', dryRun: false }, { sheets, attio, slack, logger: silentLogger });

    expect(report.posted).toBe(true);
    expect(slack.posts).toHaveLength(2); // acknowledgment + confirmation
    expect(slack.posts[0]).toBe('⚡ LATE-EDITION-1 — on it…');
    expect(slack.posts[1]).toContain('2 thread(s) closed');
    const vWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!V'));
    expect(vWrites).toHaveLength(2);
  });

  it('RESOLVE: runs the real write path and posts a confirmation with real counts', async () => {
    const wt = JSON.stringify({ primary: { bhc_id: 'BHC-1' }, secondary: [] });
    const { sheets, attio, slack } = await setup(
      [row({ bhcId: 'BHC-1', writeTargetsJson: wt })],
      { masterId: [['BHC-1', 'Alice', 'BOTH', '', '', '']] },
    );
    const report = await runPartD({ commandText: 'RESOLVE LATE-EDITION-1', dryRun: false }, { sheets, attio, slack, logger: silentLogger });

    expect(report.posted).toBe(true);
    expect(slack.posts[1]).toContain('done ·');
    const activityAppend = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    expect(activityAppend).toBeDefined(); // a real write happened, not just a report
  });
});

describe('runPartD — a genuine crash posts an alert and aborts, unlike other passes\' silent fail-soft', () => {
  it('posts a halt alert when Master_ID is genuinely unreachable', async () => {
    const wt = JSON.stringify({ primary: { bhc_id: 'BHC-1', attio: { record_id: 'rec-x', fields: { last_meeting_summary: 'x' } } }, secondary: [] });
    const { sheets, attio, slack } = await setup(
      [row({ bhcId: 'BHC-1', writeTargetsJson: wt })],
      { masterIdFailWith: 500 },
    );
    const report = await runPartD({ commandText: 'RESOLVE LATE-EDITION-1', dryRun: false }, { sheets, attio, slack, logger: silentLogger });

    expect(report.aborted).toBe(true);
    expect(slack.posts.some((p) => p.includes('halted'))).toBe(true);
  });
});
