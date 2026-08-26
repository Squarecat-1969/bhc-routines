/**
 * Zoom DISCOVERY — parsers and pass behaviour.
 *
 * The parsers are pure string functions and carry the whole weight of the fix:
 * if Meeting Purpose extraction fails, column G goes blank and triage is back
 * to where it started. Both escaping variants are fixtures here, because the
 * list endpoint returns escaped hashes (`\#\#`) and the per-recording endpoint
 * returns clean markdown with the purpose wrapped in a link — one parser has
 * to survive both.
 */

import { describe, expect, it } from 'vitest';

import { parseRetryAfter } from '../src/lib/http.js';
import type { FathomMeeting } from '../src/lib/fathom.js';
import {
  BACKFILL_CAP,
  DERIVED_SUFFIX,
  buildSlackMessage,
  extractMeetingPurpose,
  extractNextStepsOwners,
  meetingDate,
  meetingDuration,
  participantsFor,
  runZoomDiscovery,
  toStagingRow,
  trimToWordBoundary,
  urlKey,
  type ZoomDiscoveryReport,
} from '../src/passes/zoom-discovery.js';

// ── Fixtures: the two real shapes ─────────────────────────────────────────

/** `/meetings` with include_summary=true — hashes arrive escaped. */
const ESCAPED_LIST_SUMMARY = `\\#\\# Meeting Purpose
Alex and Sam reviewed the Q3 renewal terms for Northwind and agreed the revised discount schedule before it goes to legal.

\\#\\# Key Takeaways
- Northwind wants a 3-year term
- Legal review is the long pole

\\#\\# Topics
\\#\\#\\# Pricing
Discussed the tiering.

\\#\\# Next Steps
- \\*\\*Alex\\*\\*: send the revised schedule to legal by Friday
- \\*\\*Sam\\*\\*: confirm the renewal date with Northwind
- \\*\\*Alex\\*\\*: book the follow-up`;

/** `/recordings/:id/summary` — clean markdown, purpose heading is a link. */
const CLEAN_RECORDING_SUMMARY = `## [Meeting Purpose](https://fathom.video/calls/12345)
Impromptu call with **Riverton Capital** about their onboarding timeline and the data migration blocker.

## Key Takeaways
- Migration is blocked on their IT

## Next Steps
- [**Dana**](https://fathom.video/calls/12345?t=120): chase Riverton IT for the export
- **Priya**: draft the migration runbook`;

describe('Meeting Purpose extraction survives both escaping variants', () => {
  it('parses the escaped list-endpoint shape', () => {
    expect(extractMeetingPurpose(ESCAPED_LIST_SUMMARY)).toBe(
      'Alex and Sam reviewed the Q3 renewal terms for Northwind and agreed the revised discount schedule before it goes to legal.',
    );
  });

  it('parses the clean per-recording shape and unwraps the linked heading', () => {
    const out = extractMeetingPurpose(CLEAN_RECORDING_SUMMARY);
    expect(out).toBe(
      'Impromptu call with Riverton Capital about their onboarding timeline and the data migration blocker.',
    );
    // Link syntax stripped, URL discarded, label kept.
    expect(out).not.toContain('fathom.video');
    expect(out).not.toContain('**');
  });

  it('stops at the next heading and never bleeds Key Takeaways in', () => {
    expect(extractMeetingPurpose(ESCAPED_LIST_SUMMARY)).not.toContain('Northwind wants a 3-year term');
    expect(extractMeetingPurpose(CLEAN_RECORDING_SUMMARY)).not.toContain('Migration is blocked');
  });

  it('returns null rather than inventing a topline when the section is absent', () => {
    expect(extractMeetingPurpose('## Key Takeaways\n- something')).toBeNull();
    expect(extractMeetingPurpose('')).toBeNull();
    expect(extractMeetingPurpose(null)).toBeNull();
    expect(extractMeetingPurpose(undefined)).toBeNull();
  });

  it('returns null for a present but empty Meeting Purpose section', () => {
    expect(extractMeetingPurpose('## Meeting Purpose\n\n## Key Takeaways\n- x')).toBeNull();
  });

  it('handles the body riding on the heading line', () => {
    expect(extractMeetingPurpose('## Meeting Purpose: quick sync on the invoice\n\n## Topics')).toBe(
      'quick sync on the invoice',
    );
  });
});

describe('200-char word-boundary trim', () => {
  it('leaves short text untouched', () => {
    expect(trimToWordBoundary('short enough', 200)).toBe('short enough');
  });

  it('never exceeds the cap and never cuts mid-word', () => {
    const long = `${'alpha bravo charlie delta echo foxtrot '.repeat(20)}end`;
    const out = trimToWordBoundary(long, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    // Every word in the output is a whole word from the input.
    for (const w of out.split(' ')) expect(long).toContain(w);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('hard-cuts a single word longer than the cap rather than returning nothing', () => {
    const out = trimToWordBoundary('x'.repeat(300), 200);
    expect(out).toHaveLength(200);
  });

  it('strips a dangling separator left at the cut', () => {
    expect(trimToWordBoundary('one two, three four', 9)).toBe('one two');
  });

  it('applies the cap through extractMeetingPurpose', () => {
    const body = 'word '.repeat(120).trim();
    const out = extractMeetingPurpose(`## Meeting Purpose\n${body}`)!;
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe('Next-Steps owner regex', () => {
  it('picks bolded owners from the escaped variant, deduped in order', () => {
    expect(extractNextStepsOwners(ESCAPED_LIST_SUMMARY)).toEqual(['Alex', 'Sam']);
  });

  it('picks owners from the clean variant, including a linked bullet', () => {
    expect(extractNextStepsOwners(CLEAN_RECORDING_SUMMARY)).toEqual(['Dana', 'Priya']);
  });

  it('ignores capitalised product and vendor names in prose', () => {
    // The rejected design — scanning for capitalised words — would return
    // Northwind and Riverton Capital here. Only bulleted owners count.
    expect(extractNextStepsOwners(ESCAPED_LIST_SUMMARY)).not.toContain('Northwind');
    expect(extractNextStepsOwners(CLEAN_RECORDING_SUMMARY)).not.toContain('Riverton');
  });

  it("matches §5.2's literal bracket form as well as the linked form", () => {
    // The spec regex's optional `[` implies `- [**Name**:` occurs in live data;
    // `- [**Name**](url):` is the same thing with the link actually closed.
    expect(extractNextStepsOwners('- [**Alex**: do the thing')).toEqual(['Alex']);
    expect(extractNextStepsOwners('- **Alex**: do the thing')).toEqual(['Alex']);
    expect(extractNextStepsOwners('- [**Alex**](https://x/y): do the thing')).toEqual(['Alex']);
  });

  it('ignores a bold word that is not at a bullet start or has no colon', () => {
    expect(extractNextStepsOwners('**Alex** did the thing')).toEqual([]);
    expect(extractNextStepsOwners('- **Alex** send it')).toEqual([]);
  });

  it('returns [] for no summary', () => {
    expect(extractNextStepsOwners(null)).toEqual([]);
  });
});

describe('column E fallback ladder', () => {
  it('Tier 1: real invitees win, comma-joined, with NO suffix', () => {
    const m: FathomMeeting = { calendar_invitees: [{ name: 'Ada Lovelace' }, { name: 'Bo Geddes' }] };
    expect(participantsFor(m, ESCAPED_LIST_SUMMARY)).toBe('Ada Lovelace, Bo Geddes');
    expect(participantsFor(m, ESCAPED_LIST_SUMMARY)).not.toContain(DERIVED_SUFFIX);
  });

  it('Tier 1 falls back to email when an invitee has no name', () => {
    const m: FathomMeeting = { calendar_invitees: [{ email: 'ada@example.com' }] };
    expect(participantsFor(m, null)).toBe('ada@example.com');
  });

  it('Tier 2: no invitees -> summary owners, ALWAYS with the provenance suffix', () => {
    const m: FathomMeeting = { calendar_invitees: [] };
    expect(participantsFor(m, ESCAPED_LIST_SUMMARY)).toBe(`Alex, Sam ${DERIVED_SUFFIX}`);
  });

  it('Tier 3: neither -> blank, never a guess', () => {
    expect(participantsFor({ calendar_invitees: [] }, null)).toBe('');
    expect(participantsFor({}, '## Meeting Purpose\nno next steps here')).toBe('');
  });
});

describe('dedupe keys', () => {
  it('matches the two live URL formats on their trailing token', () => {
    // A naive whole-URL comparison fails on every meeting; recording_id is
    // primary and this is only the secondary net.
    expect(urlKey('https://fathom.video/calls/12345')).toBe('12345');
    expect(urlKey('https://fathom.video/share/abc-token/')).toBe('abc-token');
    expect(urlKey('https://fathom.video/calls/12345?t=30')).toBe('12345');
  });

  it('is blank for a blank url', () => {
    expect(urlKey('')).toBe('');
    expect(urlKey('   ')).toBe('');
  });
});

describe('row shaping', () => {
  it('writes exactly 14 columns A-N with status NEW and no added columns', () => {
    const row = toStagingRow({
      recordingId: 'r1', title: 'T', date: '2026-08-23', duration: '30 min',
      participants: 'A', url: 'u', topline: 'top', runId: 'ZOOM-DISC-1',
    });
    expect(row).toHaveLength(14);
    expect(row[7]).toBe('NEW');
    expect(row[13]).toBe('ZOOM-DISC-1');
    expect(row.slice(8, 13)).toEqual(['', '', '', '', '']);
  });

  it('derives date and duration, and blanks them rather than guessing', () => {
    const m: FathomMeeting = {
      recording_start_time: '2026-08-23T14:00:00Z', recording_end_time: '2026-08-23T14:45:00Z',
    };
    expect(meetingDate(m)).toBe('2026-08-23');
    expect(meetingDuration(m)).toBe('45 min');
    expect(meetingDate({})).toBe('');
    expect(meetingDuration({ recording_start_time: '2026-08-23T14:00:00Z' })).toBe('');
  });
});

describe('Retry-After honouring (lib/http.ts)', () => {
  it('reads delay-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-08-23T12:00:00Z');
    expect(parseRetryAfter('Sun, 23 Aug 2026 12:00:45 GMT', now)).toBe(45_000);
  });

  it('treats a past date as retry-now, not a negative delay', () => {
    const now = Date.parse('2026-08-23T12:00:00Z');
    expect(parseRetryAfter('Sun, 23 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('clamps a pathological value so a sweep never parks for an hour', () => {
    expect(parseRetryAfter('99999')).toBe(120_000);
  });

  it('is undefined for absent or unparseable headers, falling back to the fixed floor', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

// ── Pass behaviour, against fakes ─────────────────────────────────────────

const silent = { info: () => {}, warn: () => {} };

function fakeSheets(rows: unknown[][]) {
  const appends: { range: string; values: unknown[][] }[] = [];
  const batches: { range: string; values: readonly unknown[][] }[] = [];
  return {
    appends, batches,
    client: {
      async read() { return rows; },
      async append(range: string, values: unknown[][]) {
        appends.push({ range, values });
        return { updatedRows: values.length, updatesBlockPresent: true, updatedRowsFieldPresent: true };
      },
      async batchUpdate(data: { range: string; values: readonly unknown[][] }[]) { batches.push(...data); },
      async update() { throw new Error('single-cell update should not be used - batchUpdate keeps quota per-request'); },
    },
  };
}

function fakeFathom(meetings: FathomMeeting[], summaries: Record<string, string> = {}) {
  const summaryCalls: string[] = [];
  return {
    summaryCalls,
    client: {
      async listMeetings() { return meetings; },
      async getSummary(id: string) { summaryCalls.push(id); return summaries[id] ?? null; },
    },
  };
}

const NOW = new Date('2026-08-23T12:00:00Z');

describe('discovery: dedupe and append', () => {
  it('skips a meeting whose recording_id is already staged', async () => {
    const sheets = fakeSheets([['rec-1', 'Old', '2026-08-23', '', '', 'https://fathom.video/calls/1', 'top', 'NEW', '', '', '', '', '', 'R']]);
    const fathom = fakeFathom([
      { recording_id: 'rec-1', title: 'Dupe', recording_start_time: '2026-08-23T11:00:00Z' },
      { recording_id: 'rec-2', title: 'Fresh', recording_start_time: '2026-08-23T11:00:00Z' },
    ]);
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(r.skippedDuplicate).toBe(1);
    expect(r.appended).toEqual(['rec-2']);
    expect(sheets.appends[0]!.values).toHaveLength(1);
  });

  it('skips meetings older than the lookback window', async () => {
    const fathom = fakeFathom([{ recording_id: 'old', recording_start_time: '2026-08-20T00:00:00Z' }]);
    const r = await runZoomDiscovery({
      sheets: fakeSheets([]).client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(r.skippedOlderThanCutoff).toBe(1);
    expect(r.appended).toEqual([]);
  });

  it('an overlapping second run appends nothing new', async () => {
    const meetings: FathomMeeting[] = [{ recording_id: 'rec-9', recording_start_time: '2026-08-23T11:00:00Z' }];
    const first = fakeSheets([]);
    await runZoomDiscovery({ sheets: first.client as never, fathom: fakeFathom(meetings).client as never, logger: silent, dryRun: false, runId: 'R1', now: NOW });
    const staged = first.appends[0]!.values;
    const second = fakeSheets(staged);
    const r2 = await runZoomDiscovery({ sheets: second.client as never, fathom: fakeFathom(meetings).client as never, logger: silent, dryRun: false, runId: 'R2', now: NOW });
    expect(r2.appended).toEqual([]);
    expect(second.appends).toHaveLength(0);
  });

  it('stages a row with a blank topline rather than skipping the meeting', async () => {
    const sheets = fakeSheets([]);
    const fathom = fakeFathom([{ recording_id: 'rec-3', title: 'No summary yet', recording_start_time: '2026-08-23T11:00:00Z' }]);
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(r.appended).toEqual(['rec-3']);
    expect(r.appendedWithoutTopline).toEqual(['rec-3']);
    expect(sheets.appends[0]!.values[0]![6]).toBe('');
  });

  it('fills column G at capture time when the summary rode along', async () => {
    const sheets = fakeSheets([]);
    const fathom = fakeFathom([{
      recording_id: 'rec-4', title: 'Impromptu Zoom Meeting',
      recording_start_time: '2026-08-23T11:00:00Z',
      default_summary: { markdown_formatted: ESCAPED_LIST_SUMMARY },
    }]);
    await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    const row = sheets.appends[0]!.values[0]!;
    expect(row[6]).toContain('Q3 renewal terms');
    expect(row[4]).toBe(`Alex, Sam ${DERIVED_SUFFIX}`); // no invitees -> Tier 2
    // No per-meeting summary call: the list call already carried it.
    expect(fathom.summaryCalls).toEqual([]);
  });
});

describe('backfill: blanks only, capped', () => {
  const rowNew = (id: string, topline = '', participants = '', status = 'NEW') =>
    [id, 'T', '2026-08-23', '', participants, `https://fathom.video/calls/${id}`, topline, status, '', '', '', '', '', 'R'];

  it('fills a blank G on a NEW row and never touches a populated one', async () => {
    const sheets = fakeSheets([rowNew('a'), rowNew('b', 'already has a topline')]);
    const fathom = fakeFathom([], { a: CLEAN_RECORDING_SUMMARY, b: CLEAN_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(r.backfilled.map((b) => b.recordingId)).toEqual(['a']);
    expect(fathom.summaryCalls).toEqual(['a']); // 'b' never even fetched
    expect(sheets.batches.some((x) => x.range === 'Zoom_Staging!G2')).toBe(true);
    expect(sheets.batches.some((x) => x.range.startsWith('Zoom_Staging!G3'))).toBe(false);
  });

  it('never overwrites a non-empty column E', async () => {
    const sheets = fakeSheets([rowNew('a', '', 'Real Invitee')]);
    const fathom = fakeFathom([], { a: CLEAN_RECORDING_SUMMARY });
    await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(sheets.batches.some((x) => x.range.startsWith('Zoom_Staging!E'))).toBe(false);
    expect(sheets.batches.some((x) => x.range.startsWith('Zoom_Staging!G'))).toBe(true);
  });

  it('ignores rows already triaged past NEW', async () => {
    const sheets = fakeSheets([rowNew('a', '', '', 'PROCESS'), rowNew('b', '', '', 'DONE')]);
    const fathom = fakeFathom([], { a: CLEAN_RECORDING_SUMMARY, b: CLEAN_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(r.backfillCandidates).toBe(0);
    expect(fathom.summaryCalls).toEqual([]);
  });

  it(`caps at ${BACKFILL_CAP} rows per run, because the heavy budget degrades to 5/60s`, async () => {
    const many = Array.from({ length: 25 }, (_, i) => rowNew(`m${i}`));
    const summaries = Object.fromEntries(many.map((_, i) => [`m${i}`, CLEAN_RECORDING_SUMMARY]));
    const sheets = fakeSheets(many);
    const fathom = fakeFathom([], summaries);
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(r.backfillCandidates).toBe(25);
    expect(r.backfilled).toHaveLength(BACKFILL_CAP);
    expect(fathom.summaryCalls).toHaveLength(BACKFILL_CAP);
  });

  it('leaves the row alone when the summary is not ready yet', async () => {
    const sheets = fakeSheets([rowNew('a')]);
    const fathom = fakeFathom([], {}); // getSummary returns null
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(r.backfilled).toEqual([]);
    expect(sheets.batches).toHaveLength(0);
  });
});

describe('dry run writes nothing', () => {
  it('issues no append and no batchUpdate, but computes both', async () => {
    const sheets = fakeSheets([['a', 'T', '2026-08-23', '', '', 'https://fathom.video/calls/a', '', 'NEW', '', '', '', '', '', 'R']]);
    const fathom = fakeFathom(
      [{ recording_id: 'new-1', recording_start_time: '2026-08-23T11:00:00Z', default_summary: { markdown_formatted: ESCAPED_LIST_SUMMARY } }],
      { a: CLEAN_RECORDING_SUMMARY },
    );
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: true, runId: 'ZOOM-DISC-T', now: NOW,
    });
    expect(sheets.appends).toHaveLength(0);
    expect(sheets.batches).toHaveLength(0);
    expect(r.wouldWrite.length).toBeGreaterThan(0);
    expect(r.wouldWrite.some((w) => w.startsWith('APPEND'))).toBe(true);
    expect(r.wouldWrite.some((w) => w.startsWith('SHEETS Zoom_Staging!G'))).toBe(true);
  });
});

describe('Slack stays silent on a no-op run', () => {
  const base: ZoomDiscoveryReport = {
    runId: 'ZOOM-DISC-1', dryRun: false, startedAt: '', finishedAt: '', lookbackHours: 24,
    existingRows: 0, observedStatuses: {}, fetched: 0, skippedOlderThanCutoff: 0, skippedDuplicate: 0,
    appended: [], appendedWithoutTopline: [], backfillCandidates: 0, backfilled: [], wouldWrite: [], warnings: [],
  };

  it('returns null when nothing was added or backfilled', () => {
    expect(buildSlackMessage(base)).toBeNull();
    // Even with warnings — a warning alone is not something written.
    expect(buildSlackMessage({ ...base, warnings: ['w'], fetched: 12 })).toBeNull();
  });

  it('posts when rows were appended', () => {
    const msg = buildSlackMessage({ ...base, appended: ['r1', 'r2'] })!;
    expect(msg).toContain('2 new meeting(s) staged as NEW');
  });

  it('posts when only a backfill happened, and names what is still pending', () => {
    const msg = buildSlackMessage({ ...base, backfillCandidates: 14, backfilled: [{ recordingId: 'a', row: 2, what: 'G' }] })!;
    expect(msg).toContain('1 existing row(s) backfilled');
    expect(msg).toContain('13 still pending');
  });
});
