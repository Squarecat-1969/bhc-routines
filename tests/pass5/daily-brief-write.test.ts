import { describe, expect, it } from 'vitest';

import { SheetsClient } from '../../src/lib/sheets.js';
import { serializeGamePlan, writeDailyBrief } from '../../src/passes/pass5/daily-brief-write.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';
import type { GamePlan } from '../../src/passes/pass5/types.js';

const MINIMAL: FakeBackendConfig = { entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [] };

function gamePlan(overrides: Partial<GamePlan> = {}): GamePlan {
  return {
    brief: 'Inbox clear.',
    missionStatus: {
      tnb: { active: 0, stalled: 0, nextTouch: null },
      fte: { active: 0, stalled: 0, nextTouch: null, daysSinceTouch: null },
      fractional: { active: 0, stalled: 0, nextTouch: null },
    },
    counts: { emailsPending: 0, tasksOverdue: 0, pipelineTouches: 0, staleRelationships: 0, meetingsToReview: 0 },
    plan: [],
    generatedAt: '2026-07-19T00:00:00.000Z',
    runId: 'RUN-1',
    ...overrides,
  };
}

describe('serializeGamePlan', () => {
  it('produces a single JSON string, not a nested object', () => {
    const json = serializeGamePlan(gamePlan());
    expect(typeof json).toBe('string');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe('writeDailyBrief — size safety guard', () => {
  it('refuses to write and returns a clear reason when the JSON would exceed the safety margin', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      // A plan item's `draft` field padded far past any realistic size —
      // simulates a future scenario where the plan's natural bounds don't
      // hold, without needing 45,000 real characters of fixture data.
      const oversized = gamePlan({
        plan: [
          {
            type: 'reply', contact: 'Alice', bhcId: 'BHC-1', reason: 'x', channel: 'email', subject: '',
            draft: 'x'.repeat(46_000), replyRecipientsJson: '', replyMode: '', description: '', taskId: '',
            dueDate: '', attioRecordId: '', priority: 1,
          },
        ],
      });
      const result = await writeDailyBrief(sheets, '2026-07-19', oversized);
      expect(result.written).toBe(false);
      if (!result.written) {
        expect(result.reason).toContain('45000');
        expect(result.reason).toContain('50000');
      }
      expect(backend.sheetsWrites).toHaveLength(0); // never even attempted the write
    } finally {
      await backend.stop();
    }
  });

  it('writes normally when well under the safety margin', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      const result = await writeDailyBrief(sheets, '2026-07-19', gamePlan());
      expect(result.written).toBe(true);
      expect(backend.sheetsWrites).toHaveLength(1);
    } finally {
      await backend.stop();
    }
  });
});

describe('writeDailyBrief — the exact write shape', () => {
  it('appends exactly one row with exactly two columns when no row exists for today', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      await writeDailyBrief(sheets, '2026-07-19', gamePlan());
      const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Daily_Brief!A2:B');
      expect(append).toBeDefined();
      const values = (append!.body as { values: unknown[][] }).values;
      expect(values).toHaveLength(1); // exactly one row
      expect(values[0]).toHaveLength(2); // exactly two columns
      expect(values[0]![0]).toBe('2026-07-19'); // col A = run_date string
      expect(typeof values[0]![1]).toBe('string'); // col B = the whole plan as ONE string
    } finally {
      await backend.stop();
    }
  });

  it('never iterates game_plan keys into separate columns — col B is always exactly one JSON string', async () => {
    const backend = new FakeBackend(MINIMAL);
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      const plan = gamePlan({
        plan: [
          {
            type: 'reply', contact: 'Alice', bhcId: 'BHC-1', reason: 'x', channel: 'email', subject: '', draft: '',
            replyRecipientsJson: '', replyMode: '', description: '', taskId: '', dueDate: '', attioRecordId: '', priority: 1,
          },
        ],
      });
      await writeDailyBrief(sheets, '2026-07-19', plan);
      const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Daily_Brief!A2:B');
      const values = (append!.body as { values: unknown[][] }).values;
      expect(values[0]).toHaveLength(2); // still exactly 2, regardless of plan complexity
      const parsed = JSON.parse(values[0]![1] as string);
      expect(parsed.plan).toHaveLength(1); // the plan lives INSIDE the JSON string, not as extra columns
    } finally {
      await backend.stop();
    }
  });

  it('updates the existing row in place when one already exists for today, rather than appending a duplicate', async () => {
    const backend = new FakeBackend({ ...MINIMAL, dailyBriefDates: [['2026-07-18'], ['2026-07-19'], ['2026-07-17']] });
    const { sheetsUrl } = await backend.start();
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    try {
      await writeDailyBrief(sheets, '2026-07-19', gamePlan());
      const update = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Daily_Brief!A3:B3'); // row 3 = 2nd data row
      expect(update).toBeDefined();
      const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Daily_Brief!A2:B');
      expect(append).toBeUndefined();
    } finally {
      await backend.stop();
    }
  });
});
