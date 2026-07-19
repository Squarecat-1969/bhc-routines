import { describe, expect, it } from 'vitest';

import { SheetsClient } from '../../src/lib/sheets.js';
import { silentLogger } from '../../src/lib/logger.js';
import { runPass3 } from '../../src/passes/pass3/index.js';
import type { SlackPoster } from '../../src/lib/slack.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

function brainRow(threadId: string, runId: string, slackMessage = '', actionRequired = 'NO_ACTION'): unknown[] {
  const row = new Array<unknown>(30).fill('');
  row[0] = threadId;
  row[22] = actionRequired;
  row[26] = slackMessage;
  row[27] = runId;
  return row;
}

const MINIMAL: FakeBackendConfig = { entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [] };

function mockSlack(): SlackPoster & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    async post(text: string) {
      posts.push(text);
    },
  };
}

async function run(config: Partial<FakeBackendConfig>, runId: string, dryRun: boolean, slack: SlackPoster) {
  const backend = new FakeBackend({ ...MINIMAL, ...config });
  const { sheetsUrl } = await backend.start();
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  try {
    return await runPass3({ runId, dryRun }, { sheets, slack, logger: silentLogger, today: '2026-07-19' as never });
  } finally {
    await backend.stop();
  }
}

describe('PASS 3 orchestration — a normal digest with surfaced items', () => {
  it('posts once with a valid body', async () => {
    const slack = mockSlack();
    const report = await run(
      { brainComplete: [brainRow('T1', 'RUN-A', '[1] Alice — Hello\nREPLY_NEEDED | summary', 'REPLY_NEEDED')] },
      'RUN-A',
      false,
      slack,
    );
    expect(report.bodyKind).toBe('valid');
    expect(report.posted).toBe(true);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toContain('Alice — Hello');
  });

  it('dry-run does not post at all', async () => {
    const slack = mockSlack();
    const report = await run(
      { brainComplete: [brainRow('T1', 'RUN-A', '[1] x', 'REPLY_NEEDED')] },
      'RUN-A',
      true,
      slack,
    );
    expect(report.posted).toBe(false);
    expect(slack.posts).toHaveLength(0);
  });
});

describe('PASS 3 orchestration — all-clear night', () => {
  it('posts the all-clear message, not a failure', async () => {
    const slack = mockSlack();
    const report = await run({ brainComplete: [brainRow('T1', 'RUN-A')] }, 'RUN-A', false, slack);
    expect(report.bodyKind).toBe('all_clear');
    expect(report.posted).toBe(true);
    expect(slack.posts[0]).toContain('Nothing needs your attention');
  });
});

describe('PASS 3 orchestration — Slack post failure', () => {
  it('retries once, then posts a failure alert instead of silently losing the digest', async () => {
    let calls = 0;
    const slack: SlackPoster = {
      async post(_text: string) {
        calls += 1;
        if (calls === 1) throw new Error('simulated Slack outage');
        // second call (the failure-alert post) succeeds
      },
    };
    const report = await run({ brainComplete: [brainRow('T1', 'RUN-A', '[1] x', 'REPLY_NEEDED')] }, 'RUN-A', false, slack);
    expect(calls).toBe(2);
    expect(report.warnings.some((w) => w.includes('Slack post failed'))).toBe(true);
  });
});

describe('PASS 3 orchestration — only digests the specified run', () => {
  it('ignores Brain_Complete rows from other runs entirely', async () => {
    const slack = mockSlack();
    const report = await run(
      {
        brainComplete: [
          brainRow('T1', 'RUN-A', '[1] x', 'REPLY_NEEDED'),
          brainRow('T2', 'RUN-OLD', '[1] should not appear', 'REPLY_NEEDED'),
        ],
      },
      'RUN-A',
      false,
      slack,
    );
    expect(report.rowCount).toBe(1);
    expect(slack.posts[0]).not.toContain('should not appear');
  });
});

describe('PASS 3 orchestration — drift notes', () => {
  it('warns that standalone runs cannot surface drift when none is passed', async () => {
    const slack = mockSlack();
    const report = await run({ brainComplete: [brainRow('T1', 'RUN-A')] }, 'RUN-A', false, slack);
    expect(report.warnings.some((w) => w.includes('drift alerts require chaining'))).toBe(true);
  });
});

describe('PASS 3 orchestration — fail-soft', () => {
  it('never throws — a Sheets failure is caught and reported as aborted', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await backend.start();
    await backend.stop();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const report = await runPass3({ runId: 'RUN-A', dryRun: true }, { sheets, slack: mockSlack(), logger: silentLogger });
    expect(report.aborted).toBe(true);
  });
});
