/**
 * COUNT CONFIRMED, NOT INTENDED — the four remaining counters, plus
 * writeDailyBrief's boolean.
 *
 * Part D's counts.tasks counted Attio task IDs rather than sheet rows, so five
 * weeks of appends landing in a read-only FILTER view printed as a healthy
 * "N tasks". The number was true about something, which is why nobody saw it.
 * These are the same shape in four other passes: a counter incremented beside a
 * discarded append result measures intent.
 *
 * Every case here uses the shared fake's existing knobs — `appendZeroRowsFor`
 * (Sheets refused) and `appendNoUpdatedRowsFieldFor` (unverifiable, a different
 * fact) — rather than new ones, because a fake that under-specifies a response
 * shape silently disarms every guard built on it. That happened twice: `{}` for
 * batchUpdate for four days, and the same gap for append before 2026-08-14.
 */

import { describe, expect, it } from 'vitest';

import { writeDailyBrief } from '../src/passes/pass5/daily-brief-write.js';
import { SheetsClient } from '../src/lib/sheets.js';
import { FakeBackend, type FakeBackendConfig } from './helpers/fake-backend.js';
import type { GamePlan } from '../src/passes/pass5/types.js';

const MINIMAL: FakeBackendConfig = {
  entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [],
};

function gamePlan(): GamePlan {
  return {
    date: '2026-07-19', missionStatus: 'x', counts: { replies: 0, tasks: 0, meetings: 0, proposals: 0 },
    items: [], generatedAt: '2026-07-19T00:00:00.000Z',
  } as unknown as GamePlan;
}

async function withSheets<T>(config: Partial<FakeBackendConfig>, fn: (s: SheetsClient) => Promise<T>): Promise<T> {
  const backend = new FakeBackend({ ...MINIMAL, ...config });
  const { sheetsUrl } = await backend.start();
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  try {
    return await fn(sheets);
  } finally {
    await backend.stop();
  }
}

describe('writeDailyBrief reports the outcome, not the attempt', () => {
  it('APPEND path: a refused write reports written:false with a reason', async () => {
    const r = await withSheets({ appendZeroRowsFor: 'Daily_Brief' }, (s) =>
      writeDailyBrief(s, '2026-07-19', gamePlan()),
    );
    expect(r.written).toBe(false);
    expect(r.written === false && r.reason).toContain('0 written');
    expect(r.written === false && r.reason).toContain('did NOT land');
  });

  it('APPEND path: an unverifiable response is reported as NOT a refusal', async () => {
    const r = await withSheets({ appendNoUpdatedRowsFieldFor: 'Daily_Brief' }, (s) =>
      writeDailyBrief(s, '2026-07-19', gamePlan()),
    );
    expect(r.written).toBe(false);
    expect(r.written === false && r.reason).toContain('UNVERIFIABLE');
    expect(r.written === false && r.reason).toContain('NOT a refusal');
  });

  it('UPDATE path: a refused in-place write also reports written:false', async () => {
    // The existing-row path goes through batchUpdate specifically so it can be
    // confirmed too — confirming only the append path would make `written` mean
    // different things depending on whether today's row already existed.
    const r = await withSheets(
      { dailyBriefDates: [['2026-07-19']], batchUpdateZeroCellsFor: 'Daily_Brief' },
      (s) => writeDailyBrief(s, '2026-07-19', gamePlan()),
    );
    expect(r.written).toBe(false);
    expect(r.written === false && r.reason).toContain('Daily_Brief!A2:B2');
  });

  it('a confirmed write on either path still reports written:true', async () => {
    const appended = await withSheets({}, (s) => writeDailyBrief(s, '2026-07-19', gamePlan()));
    expect(appended.written).toBe(true);
    const updated = await withSheets({ dailyBriefDates: [['2026-07-19']] }, (s) =>
      writeDailyBrief(s, '2026-07-19', gamePlan()),
    );
    expect(updated.written).toBe(true);
  });
});
