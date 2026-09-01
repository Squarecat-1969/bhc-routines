/**
 * PASS 2.6 end to end, against fakes built from the real response shape.
 *
 * The privileged-content sweep is the load-bearing test in this file: it drives
 * the whole pass with bodies carrying a sentinel and asserts the sentinel
 * reaches NO written value, NO log line and NO field of the report. Everything
 * else here is recoverable by a later fix; that is not.
 */

import { describe, expect, it } from 'vitest';

import { runPass26, type Logger } from '../../src/passes/pass2_6/index.js';
import { ITEM_TYPE_CALENDAR, EVIDENCE_SOURCE_CALENDAR, QUEUE_COLUMNS } from '../../src/passes/pass2_6/queue-write.js';
import { WATERMARK_COLUMNS } from '../../src/passes/pass2_6/watermark.js';
import { ALL_FIXTURES, NATIVE_EVENT, PRIVILEGED_MARKER, SUBJECT_ONLY_EVENT } from './fixtures.js';
import type { RawCalendarEvent } from '../../src/lib/calendar.js';

const CONTACTS_HEADER = [['Contact_ID', 'First_Name', 'Last_Name', 'Title', 'Company', 'Primary_Email']];
const CONTACTS_DATA = [
  ['BHC-00001', 'Sarah', 'Holmes', 'Counsel', 'HMLG', 'sholmes@hmlglaw.com'],
  ['BHC-00002', 'Brian', 'Johnson', 'Owner', 'DERU', 'brian@deru.example'],
  ['BHC-00003', 'Nick', 'Lamb', 'Broker', 'INSNW', 'nicklamb@insnw.com'],
];

/** Tasks_Open A–M. Status col I = 'Open'. */
function taskRow(o: { id: string; bhcId: string; name: string; desc: string; createdAt: string }): unknown[] {
  const r = new Array<unknown>(13).fill('');
  r[0] = o.id; r[1] = o.createdAt; r[2] = o.bhcId; r[4] = o.name;
  r[6] = o.desc; r[8] = 'Open';
  return r;
}

interface FakeOpts {
  events?: readonly RawCalendarEvent[];
  complete?: boolean;
  tasks?: unknown[][];
  watermark?: unknown[][];
  watermarkHeader?: boolean;
  appendZeroRows?: boolean;
  batchZeroCells?: boolean;
}

/**
 * A fake Attio directory. ⚠ ATTIO IS THE PRIMARY PATH now, so the fake must
 * actually resolve — a fake returning nothing would let every test pass while
 * proving only that unresolved participants produce no verdict.
 */
const ATTIO_PEOPLE: Record<string, { recordId: string; bhcId: string | null; name: string }> = {
  'sholmes@hmlglaw.com': { recordId: 'rec-sarah', bhcId: 'BHC-00001', name: 'Sarah Holmes' },
  'nicklamb@insnw.com': { recordId: 'rec-nick', bhcId: null, name: 'Nick Lamb' }, // NN#15 violation
  'service@greenwoodheating.com': { recordId: 'rec-gw', bhcId: 'BHC-00009', name: 'Greenwood' },
};

function fakes(o: FakeOpts) {
  const appends: { range: string; values: unknown[][] }[] = [];
  const batches: { range: string; values: readonly unknown[][] }[] = [];
  const logLines: string[] = [];
  const sheets = {
    async read(range: string) {
      if (range.startsWith('Contacts!A1') || /Contacts!.*1$/.test(range)) return CONTACTS_HEADER;
      if (range.startsWith('Contacts!')) return CONTACTS_DATA;
      if (range.startsWith('Tasks_Open')) return o.tasks ?? [];
      if (range.startsWith('Master_ID')) return [['BHC-00003', 'Nick Lamb', 'ATTIO', '', 'rec-nick', '']];
      if (range.startsWith('Pass26_Watermark!A1')) return o.watermarkHeader === false ? [] : [[...WATERMARK_COLUMNS]];
      if (range.startsWith('Pass26_Watermark')) return o.watermark ?? [];
      return [];
    },
    async append(range: string, values: unknown[][]) {
      appends.push({ range, values });
      const landed = o.appendZeroRows ? 0 : values.length;
      return { updatedRows: landed, updatesBlockPresent: true, updatedRowsFieldPresent: true };
    },
    async batchUpdate(data: { range: string; values: readonly unknown[][] }[]) {
      batches.push(...data);
      return { totalUpdatedCells: o.batchZeroCells ? 0 : data.length, fieldsPresent: true, rangesRequested: data.length };
    },
    async update() { throw new Error('single-cell update should not be used'); },
  };
  const calendar = {
    async listEvents() {
      return {
        events: o.events ?? [], eventCount: (o.events ?? []).length,
        complete: o.complete !== false, partialReason: o.complete === false ? 'page cap hit' : null,
        subjectlessCount: 0, pagesFetched: 1, preReadMs: 10,
      };
    },
  };
  const attio = {
    async searchPeopleByEmail(email: string) {
      const p = ATTIO_PEOPLE[email.toLowerCase()];
      if (!p) return [];
      const values: Record<string, unknown> = { name: [{ value: p.name }] };
      if (p.bhcId) values['bhc_contact_id'] = [{ value: p.bhcId }];
      return [{ recordId: p.recordId, values }];
    },
  };
  const logger: Logger = { info: (m) => logLines.push(m), warn: (m) => logLines.push(m) };
  return { sheets, calendar, attio, logger, appends, batches, logLines };
}

const NOW = new Date('2026-08-15T12:00:00Z');

async function run(o: FakeOpts, extra: Partial<Parameters<typeof runPass26>[0]> = {}) {
  const f = fakes(o);
  const report = await runPass26({
    sheets: f.sheets as never, calendar: f.calendar as never, attio: f.attio as never, logger: f.logger,
    dryRun: false, runId: 'PASS26-TEST', now: NOW, lookbackDays: 30, ...extra,
  });
  return { report, ...f };
}

describe('⚠ THE PRIVILEGED BODY REACHES NOTHING — the one unrecoverable rule', () => {
  const everyPath: FakeOpts = {
    events: ALL_FIXTURES,
    tasks: [
      taskRow({ id: 'TASK-1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call with Sarah', createdAt: '2026-08-01T00:00:00Z' }),
      taskRow({ id: 'TASK-2', bhcId: 'BHC-00002', name: 'Brian Johnson', desc: 'Discuss the DERU brief with Brian', createdAt: '2026-08-01T00:00:00Z' }),
      taskRow({ id: 'TASK-3', bhcId: 'BHC-00003', name: 'Nick Lamb', desc: 'Book time with Nick', createdAt: '2026-08-01T00:00:00Z' }),
    ],
  };

  it('no body content reaches any WRITTEN value', async () => {
    const { appends, batches } = await run(everyPath);
    const written = JSON.stringify({ appends, batches });
    expect(written).not.toContain(PRIVILEGED_MARKER);
    expect(written).not.toContain('attorney-client');
    expect(written).not.toContain('143,297');
    expect(written).not.toContain('Zoom web conference');
  });

  it('no body content reaches any LOG LINE — not on success, not truncated', async () => {
    const { logLines } = await run(everyPath);
    const logged = logLines.join('\n');
    expect(logged).not.toContain(PRIVILEGED_MARKER);
    expect(logged).not.toContain('attorney-client');
  });

  it('no body content reaches the REPORT, which becomes a CI artifact', async () => {
    const { report } = await run(everyPath);
    expect(JSON.stringify(report)).not.toContain(PRIVILEGED_MARKER);
    expect(JSON.stringify(report)).not.toContain('attorney-client');
  });

  it('holds on the ERROR path too — a stack trace must not carry privileged prose', async () => {
    const f = fakes(everyPath);
    const exploding = { ...f.sheets, async read() { throw new Error(`boom while reading ${PRIVILEGED_MARKER}`); } };
    const report = await runPass26({
      sheets: exploding as never, calendar: f.calendar as never, attio: f.attio as never, logger: f.logger,
      dryRun: false, runId: 'PASS26-TEST', now: NOW,
    });
    // The pass aborts fail-soft. What matters is that OUR code never put a body
    // into the message — this asserts the abort path carries only what the
    // thrower supplied, and that no event body was appended to it.
    expect(report.aborted).toBe(true);
    expect(JSON.stringify({ appends: f.appends, batches: f.batches })).not.toContain(PRIVILEGED_MARKER);
  });

  it('evidence quotes carry SUBJECT AND DATE only', async () => {
    const { report } = await run(everyPath);
    for (const r of report.results) {
      if (r.evidenceQuote === '') continue;
      expect(r.evidenceQuote).toMatch(/^".*" on \d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('a partial window is an UNKNOWN window — the run skips', () => {
  it('does not evaluate anything and writes nothing when complete is false', async () => {
    const { report, appends, batches } = await run({ events: ALL_FIXTURES, complete: false, tasks: [taskRow({ id: 'T', bhcId: 'BHC-00001', name: 'S', desc: 'Schedule', createdAt: '2026-08-01T00:00:00Z' })] });
    expect(report.windowComplete).toBe(false);
    expect(report.tasksEvaluated).toBe(0);
    expect(appends).toHaveLength(0);
    expect(batches).toHaveLength(0);
    expect(report.warnings.join(' ')).toContain('UNKNOWN window');
  });

  it('treats an ABSENT complete flag as not-complete, never as known-empty', async () => {
    const f = fakes({});
    const calendar = { async listEvents() { return { events: [], eventCount: 0, complete: undefined as never, partialReason: null, subjectlessCount: 0, pagesFetched: 1, preReadMs: 1 }; } };
    const report = await runPass26({ sheets: f.sheets as never, calendar: calendar as never, attio: f.attio as never, logger: f.logger, dryRun: false, runId: 'X', now: NOW });
    expect(report.windowComplete).toBe(false);
  });
});

describe('verdicts', () => {
  const withTask = (desc: string, createdAt: string, bhcId = 'BHC-00001') => ({
    events: [NATIVE_EVENT],
    tasks: [taskRow({ id: 'TASK-1', bhcId, name: 'Sarah Holmes', desc, createdAt })],
  });

  it('a scheduling task with a matching meeting is HIGH confidence — the booking IS the completion', async () => {
    const { report } = await run(withTask('Schedule a call with Sarah Holmes', '2026-08-01T00:00:00Z'));
    expect(report.results[0]!.verdict).toBe('LIKELY_HANDLED_EVIDENCE');
    expect(report.results[0]!.taskKind).toBe('scheduling');
    expect(report.results[0]!.confidence).toBe('high');
  });

  it('a discussion task with the same meeting is MEDIUM — a scheduled meeting is not a held meeting', async () => {
    const { report } = await run(withTask('Discuss the transition agreement with Sarah Holmes', '2026-08-01T00:00:00Z'));
    expect(report.results[0]!.taskKind).toBe('discussion');
    expect(report.results[0]!.confidence).toBe('medium');
    expect(report.results[0]!.brainReasoning).toContain('not a held meeting');
  });

  it('NO_EVIDENCE when the window covers the task and nothing matched', async () => {
    // BHC-00003 (Nick Lamb) has no event in this fixture set.
    const { report } = await run(withTask('Schedule a call with Nick', '2026-08-01T00:00:00Z', 'BHC-00003'));
    expect(report.results[0]!.verdict).toBe('NO_EVIDENCE');
  });

  it('UNEVALUABLE when the task predates the window — not stale, just unlooked-at', async () => {
    const { report } = await run(withTask('Schedule a call with Nick', '2026-01-01T00:00:00Z', 'BHC-00003'));
    expect(report.results[0]!.verdict).toBe('UNEVALUABLE');
    expect(report.results[0]!.brainReasoning).toContain('predates the calendar window');
  });

  it('⚠ UNEVALUABLE is a COUNT and never a review card', async () => {
    const { report, appends } = await run(withTask('Schedule a call with Nick', '2026-01-01T00:00:00Z', 'BHC-00003'));
    expect(report.unevaluableCount).toBe(1);
    // No queue row for it — twelve unanswerable cards is the Reconciler's
    // twenty findings again.
    expect(appends).toHaveLength(0);
  });

  it('resolves a contact from the SUBJECT alone — the case that justifies the source', async () => {
    const { report } = await run({
      events: [SUBJECT_ONLY_EVENT],
      tasks: [taskRow({ id: 'TASK-9', bhcId: 'BHC-00002', name: 'Brian Johnson', desc: 'Schedule lunch with Brian Johnson', createdAt: '2026-08-01T00:00:00Z' })],
    });
    expect(report.results[0]!.verdict).toBe('LIKELY_HANDLED_EVIDENCE');
    expect(report.results[0]!.evidenceQuote).toContain('Lunch w Brian Johnson');
  });
});

describe('the written row shape', () => {
  it('uses the NEW Item_Type and Evidence_Source on every row, and blanks col O', async () => {
    const { appends } = await run({
      events: [NATIVE_EVENT],
      tasks: [taskRow({ id: 'TASK-1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
    });
    expect(appends).toHaveLength(1);
    for (const row of appends[0]!.values) {
      expect(row).toHaveLength(QUEUE_COLUMNS.length); // 15, A–O
      expect(row[2]).toBe(ITEM_TYPE_CALENDAR);
      expect(row[9]).toBe(EVIDENCE_SOURCE_CALENDAR);
      expect(row[13]).toBe(''); // N Status — awaiting review
      expect(row[14]).toBe(''); // O Placeholder_Activity_ID — PASS 0's field
    }
  });
});

describe('the watermark', () => {
  const oneTask = {
    events: [NATIVE_EVENT],
    tasks: [taskRow({ id: 'TASK-1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
  };

  it('suppresses a task whose watermark already covers the latest event', async () => {
    const wmRow = ['TASK-1', 'sheet', 'BHC-00001', '2026-08-14T00:00:00Z', '2026-08-04T17:00:00.000Z', 'NO_EVIDENCE', '1', ''];
    const { report } = await run({ ...oneTask, watermark: [wmRow] });
    expect(report.tasksEvaluated).toBe(0);
    expect(report.tasksSkippedByWatermark).toBe(1);
  });

  it('re-evaluates when a NEWER event appears for that contact', async () => {
    const wmRow = ['TASK-1', 'sheet', 'BHC-00001', '2026-08-02T00:00:00Z', '2026-08-01T00:00:00.000Z', 'NO_EVIDENCE', '1', ''];
    const { report } = await run({ ...oneTask, watermark: [wmRow] });
    expect(report.tasksEvaluated).toBe(1);
  });

  it('writes the header when the tab has none — the tab exists, the header does not', async () => {
    const { batches, report } = await run({ ...oneTask, watermarkHeader: false });
    expect(batches[0]!.range).toContain('Pass26_Watermark!A1');
    expect(batches[0]!.values[0]).toEqual([...WATERMARK_COLUMNS]);
    expect(report.warnings.join(' ')).toContain('no header row');
  });

  it('⚠ does NOT advance the watermark when the queue write was not confirmed', async () => {
    // Stamping over an unconfirmed write would suppress re-evaluation of a task
    // whose proposal never reached Bobby — pass2's PROCESSED-over-lost-row shape.
    const { report, batches } = await run({ ...oneTask, appendZeroRows: true });
    expect(report.enqueuedCount).toBe(0);
    expect(batches).toHaveLength(0);
    expect(report.warnings.join(' ')).toContain('watermark NOT advanced');
  });

  it('counts CONFIRMED queue writes, never intended', async () => {
    const { report } = await run({ ...oneTask, appendZeroRows: true });
    expect(report.enqueuedCount).toBe(0);
    expect(report.warnings.join(' ')).toContain('did NOT land');
  });
});

describe('dry run writes nothing', () => {
  it('issues no append and no batchUpdate, but computes both', async () => {
    const { report, appends, batches } = await run({
      events: [NATIVE_EVENT],
      tasks: [taskRow({ id: 'TASK-1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
    }, { dryRun: true });
    expect(appends).toHaveLength(0);
    expect(batches).toHaveLength(0);
    expect(report.wouldWrite.some((w) => w.startsWith('APPEND'))).toBe(true);
    expect(report.wouldWrite.some((w) => w.startsWith('WATERMARK'))).toBe(true);
  });

  it('--skip-queue-write exercises the watermark live without touching the queue', async () => {
    const { appends, batches } = await run({
      events: [NATIVE_EVENT],
      tasks: [taskRow({ id: 'TASK-1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
    }, { skipQueueWrite: true });
    expect(appends).toHaveLength(0);
    expect(batches.length).toBeGreaterThan(0);
  });
});

/**
 * ⚠ ATTIO IS THE PRIMARY DIRECTORY, Contacts the edge case.
 *
 * Google Contacts is the LINKEDIN REACH ENGINE — ~400 rows, all
 * LinkedIn-sourced, 132 with an email. Attio holds 2506 people. Ordering
 * Contacts first resolves almost nothing and reads as a broken matcher rather
 * than a directory pointed at the wrong CRM.
 */
describe('identity resolution — Attio first, Contacts as the edge case', () => {
  const eventWith = (addr: string, id = 'ev-x'): RawCalendarEvent => ({
    id, subject: 'External sync',
    body: { contentType: 'html', content: '' }, bodyPreview: '',
    start: { dateTime: '2026-08-10T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-08-10T16:00:00.0000000', timeZone: 'UTC' },
    attendees: [{ emailAddress: { name: 'X', address: addr } }],
    organizer: { emailAddress: { address: 'bobbyhougham@gmail.com' } },
    isCancelled: false, type: 'singleInstance', seriesMasterId: null, showAs: 'busy', sensitivity: 'normal',
  });

  it('resolves ONE HOP via Attio — bhc_contact_id is on the record, no Master_ID needed', async () => {
    const { report } = await run({
      events: [eventWith('sholmes@hmlglaw.com')],
      tasks: [taskRow({ id: 'T1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
    });
    expect(report.resolutionByPath.attio).toBe(1);
    expect(report.resolutionByPath.attio_via_masterid).toBe(0);
    expect(report.resolutionByPath.contacts).toBe(0);
    expect(report.results[0]!.verdict).toBe('LIKELY_HANDLED_EVIDENCE');
  });

  it('falls back to Master_ID only when the Attio record lacks bhc_contact_id — and COUNTS it', async () => {
    // Non-negotiable #15 says every Attio person should carry one before
    // leaving PASS 1. 251 of 2506 do not, so this is a real finding, not a
    // theoretical branch.
    const { report } = await run({
      events: [eventWith('nicklamb@insnw.com')],
      tasks: [taskRow({ id: 'T1', bhcId: 'BHC-00003', name: 'Nick Lamb', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
    });
    expect(report.resolutionByPath.attio_via_masterid).toBe(1);
    expect(report.resolutionByPath.attio).toBe(0);
    expect(report.attioRecordsMissingBhcId).toBe(1);
    expect(report.warnings.join(' ')).toContain('Non-negotiable #15');
  });

  it('falls back to Contacts for a LinkedIn contact Attio does not hold — rare, but real', async () => {
    const { report } = await run({
      events: [eventWith('brian@deru.example')],
      tasks: [taskRow({ id: 'T1', bhcId: 'BHC-00002', name: 'Brian Johnson', desc: 'Schedule lunch', createdAt: '2026-08-01T00:00:00Z' })],
    });
    expect(report.resolutionByPath.contacts).toBe(1);
    expect(report.resolutionByPath.attio).toBe(0);
    expect(report.results[0]!.verdict).toBe('LIKELY_HANDLED_EVIDENCE');
  });

  it('counts an address neither directory holds as unresolved — and produces NO verdict from it', async () => {
    const { report } = await run({
      events: [eventWith('stranger@nowhere.example')],
      tasks: [taskRow({ id: 'T1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
    });
    expect(report.resolutionByPath.unresolved).toBe(1);
    // Never mint, never guess — the task simply gets no calendar evidence.
    expect(report.results[0]!.verdict).toBe('NO_EVIDENCE');
  });

  it('reports the paths SEPARATELY and never as one total', async () => {
    const { report } = await run({
      events: [eventWith('sholmes@hmlglaw.com', 'a'), eventWith('brian@deru.example', 'b'), eventWith('nicklamb@insnw.com', 'c')],
      tasks: [taskRow({ id: 'T1', bhcId: 'BHC-00001', name: 'Sarah Holmes', desc: 'Schedule a call', createdAt: '2026-08-01T00:00:00Z' })],
    });
    // "3 resolved" would hide which CRM is carrying the pass.
    expect(report.resolutionByPath).toEqual({ attio: 1, attio_via_masterid: 1, contacts: 1, unresolved: 0 });
  });

  it('queries Attio once per DISTINCT address, not once per event', async () => {
    const f = fakes({
      events: [eventWith('sholmes@hmlglaw.com', 'a'), eventWith('sholmes@hmlglaw.com', 'b'), eventWith('sholmes@hmlglaw.com', 'c')],
      tasks: [],
    });
    let calls = 0;
    const counting = { async searchPeopleByEmail(e: string) { calls++; return f.attio.searchPeopleByEmail(e); } };
    await runPass26({
      sheets: f.sheets as never, calendar: f.calendar as never, attio: counting as never,
      logger: f.logger, dryRun: true, runId: 'X', now: NOW, lookbackDays: 30,
    });
    expect(calls).toBe(1);
  });
});
