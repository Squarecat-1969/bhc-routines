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

/**
 * VERBATIM from a real response — get_meeting_summary(174479646).
 *
 * The previous fixture here was hand-constructed from the spec's prose rather
 * than taken from a live response, which is exactly why the old regex passed
 * its tests and scored zero matches in production. Note where the colon sits:
 * INSIDE the bold, with the whole bullet as a link label.
 *
 * Note too that Topics carries the same bulleted-bold-prefix shape for
 * non-people labels (Method, Black, Feasibility, Rationale). Those are the
 * false positives an unscoped regex would write into a participants field.
 */
const REAL_RECORDING_SUMMARY = `## [Meeting Purpose](https://fathom.video/calls/174479646)
Review VFX approach for shoe colorways and discuss technical limitations.

## Key Takeaways
- [**Method:** Map new color textures onto the source footage.](https://fathom.video/calls/174479646?t=45)
- [**Feasibility:** High.](https://fathom.video/calls/174479646?t=90)

## Topics
### Colorway Approach
- [**Black:** Has a tight light-to-shadow gradation.](https://fathom.video/calls/174479646?t=120)
- [**White:** Needs a wider dynamic range.](https://fathom.video/calls/174479646?t=140)
- [**Rationale:** The source shoe's material break determines the mask.](https://fathom.video/calls/174479646?t=160)

## Next Steps
- [**Andrew:** Present the two options (VFX-only vs. Full CGI) with costs.](https://fathom.video/calls/174479646?t=200)
- [**Bobby:** Call Andrew back to continue the discussion.](https://fathom.video/calls/174479646?t=220)`;

/** Kept for the link-wrapped-heading case; not used for owner extraction. */
const CLEAN_RECORDING_SUMMARY = REAL_RECORDING_SUMMARY;

describe('Meeting Purpose extraction survives both escaping variants', () => {
  it('parses the escaped list-endpoint shape', () => {
    expect(extractMeetingPurpose(ESCAPED_LIST_SUMMARY)).toBe(
      'Alex and Sam reviewed the Q3 renewal terms for Northwind and agreed the revised discount schedule before it goes to legal.',
    );
  });

  it('parses the clean per-recording shape and unwraps the linked heading', () => {
    const out = extractMeetingPurpose(REAL_RECORDING_SUMMARY);
    expect(out).toBe('Review VFX approach for shoe colorways and discuss technical limitations.');
    // Link syntax stripped, URL discarded, label kept.
    expect(out).not.toContain('fathom.video');
    expect(out).not.toContain('**');
  });

  it('stops at the next heading and never bleeds Key Takeaways in', () => {
    expect(extractMeetingPurpose(ESCAPED_LIST_SUMMARY)).not.toContain('Northwind wants a 3-year term');
    expect(extractMeetingPurpose(REAL_RECORDING_SUMMARY)).not.toContain('Method');
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

  it('matches the REAL shape, where the colon sits inside the bold', () => {
    // The spec's `**Name**:` pattern cannot match this at all — the name class
    // excludes ':', so it never reaches the closing `**`. Zero live matches.
    expect(extractNextStepsOwners(REAL_RECORDING_SUMMARY)).toEqual(['Andrew', 'Bobby']);
  });

  it('accepts the colon outside the bold too, in every documented form', () => {
    expect(extractNextStepsOwners('## Next Steps\n- **Alex**: do it')).toEqual(['Alex']);
    expect(extractNextStepsOwners('## Next Steps\n- [**Alex**: do it')).toEqual(['Alex']);
    expect(extractNextStepsOwners('## Next Steps\n- [**Alex**](https://x/y): do it')).toEqual(['Alex']);
    expect(extractNextStepsOwners('## Next Steps\n- [**Alex:** do it](https://x/y)')).toEqual(['Alex']);
  });

  // THE POINT OF FIX 2. Fixing the regex without scoping makes the over-
  // matching §5.3 rejects strictly worse, not better.
  it('returns ONLY Next Steps owners when Topics carries the same bullet shape', () => {
    expect(extractNextStepsOwners(REAL_RECORDING_SUMMARY)).toEqual(['Andrew', 'Bobby']);
    for (const label of ['Method', 'Black', 'White', 'Feasibility', 'Rationale']) {
      expect(extractNextStepsOwners(REAL_RECORDING_SUMMARY)).not.toContain(label);
    }
  });

  it('never falls back to the whole summary when there is no Next Steps section', () => {
    const noNextSteps = `## Meeting Purpose\nx\n\n## Topics\n- [**Method:** map it](u)\n- [**Result:** good](u)`;
    expect(extractNextStepsOwners(noNextSteps)).toEqual([]);
  });

  it('matches the Next Steps heading case-insensitively', () => {
    expect(extractNextStepsOwners('## NEXT STEPS\n- [**Andrew:** go](u)')).toEqual(['Andrew']);
    expect(extractNextStepsOwners('## next steps\n- [**Andrew:** go](u)')).toEqual(['Andrew']);
  });

  it('stops at the heading after Next Steps', () => {
    const trailing = `## Next Steps\n- [**Andrew:** go](u)\n\n## Appendix\n- [**Notes:** stuff](u)`;
    expect(extractNextStepsOwners(trailing)).toEqual(['Andrew']);
  });

  it('ignores a bold word that is not at a bullet start or has no colon', () => {
    expect(extractNextStepsOwners('## Next Steps\n**Alex** did the thing')).toEqual([]);
    expect(extractNextStepsOwners('## Next Steps\n- **Alex** send it')).toEqual([]);
  });

  it('returns [] for no summary', () => {
    expect(extractNextStepsOwners(null)).toEqual([]);
  });
});

describe('the account owner renders as "you" (Tier 2 only)', () => {
  it('maps Bobby to "you" while keeping his position in the list', () => {
    expect(participantsFor({ calendar_invitees: [] }, REAL_RECORDING_SUMMARY)).toBe(
      `Andrew, you ${DERIVED_SUFFIX}`,
    );
  });

  it('is case-insensitive', () => {
    expect(participantsFor({}, '## Next Steps\n- [**BOBBY:** do it](u)')).toBe(`you ${DERIVED_SUFFIX}`);
  });

  it('NEVER rewrites Tier 1 calendar_invitees — those are verified data', () => {
    const m: FathomMeeting = { calendar_invitees: [{ name: 'Bobby Hougham' }, { name: 'Andrew Reid' }] };
    expect(participantsFor(m, REAL_RECORDING_SUMMARY)).toBe('Bobby Hougham, Andrew Reid');
  });

  it('keeps a 1:1 with only Bobby distinguishable from an empty list', () => {
    expect(participantsFor({}, '## Next Steps\n- [**Bobby:** follow up](u)')).toBe(`you ${DERIVED_SUFFIX}`);
    expect(participantsFor({}, '## Next Steps\n- nothing bolded')).toBe('');
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

/**
 * A fake that behaves like a sheet: batchUpdate actually mutates the rows, and
 * read returns what is currently there. Without that, a read-back test proves
 * nothing.
 *
 * `swallowWrites` reproduces the live bug exactly — batchUpdate accepts the
 * request, reports success, and changes nothing.
 */
function fakeSheets(rows: unknown[][], opts: { swallowWrites?: boolean; reportZeroCells?: boolean; noCellsField?: boolean } = {}) {
  const state = rows.map((r) => [...r]);
  const appends: { range: string; values: unknown[][] }[] = [];
  const batches: { range: string; values: readonly unknown[][] }[] = [];
  const COL_LETTER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, N: 13 };
  return {
    appends, batches, state,
    client: {
      async read() { return state.map((r) => [...r]); },
      async append(range: string, values: unknown[][]) {
        appends.push({ range, values });
        for (const v of values) state.push([...v]);
        return { updatedRows: values.length, updatesBlockPresent: true, updatedRowsFieldPresent: true };
      },
      async batchUpdate(data: { range: string; values: readonly unknown[][] }[]) {
        batches.push(...data);
        if (!opts.swallowWrites) {
          for (const d of data) {
            const m = /Zoom_Staging!([A-Z])(\d+)/.exec(d.range);
            if (!m) continue;
            const rowIdx = Number(m[2]) - 2;
            const colIdx = COL_LETTER[m[1]!]!;
            if (state[rowIdx]) state[rowIdx]![colIdx] = d.values[0]?.[0];
          }
        }
        if (opts.noCellsField) return { totalUpdatedCells: 0, fieldsPresent: false, rangesRequested: data.length };
        return {
          totalUpdatedCells: opts.reportZeroCells ? 0 : data.length,
          fieldsPresent: true,
          rangesRequested: data.length,
        };
      },
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

  it('fills a blank G and never writes G on a row that already has one', async () => {
    // Row 'b' is fully populated — G AND E — so it is genuinely not a
    // candidate. Populating only G would leave it a candidate for E, which is
    // the whole point of deciding the two columns independently.
    const sheets = fakeSheets([rowNew('a'), rowNew('b', 'already has a topline', 'Real Invitee')]);
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

describe('candidate selection: G and E are decided independently', () => {
  // The gap this closes: gating the whole candidate on a blank G meant a row
  // whose G was filled by an earlier sweep could never have its E revisited,
  // even though the fixed extractor produces owners for it.
  const row = (id: string, g: string, e: string, status = 'NEW') =>
    [id, 'T', '2026-08-23', '', e, `https://fathom.video/calls/${id}`, g, status, '', '', '', '', '', 'R'];

  it('IS a candidate when G is filled and E is blank', async () => {
    const sheets = fakeSheets([row('a', 'already has a topline', '')]);
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfillCandidates).toBe(1);
    expect(r.backfilled).toEqual([{ recordingId: 'a', row: 2, what: 'E' }]);
    // G untouched — fill-blanks-only still holds per column.
    expect(sheets.state[0]![6]).toBe('already has a topline');
    expect(sheets.state[0]![4]).toBe(`Andrew, you ${DERIVED_SUFFIX}`);
    expect(sheets.batches.some((b) => b.range.startsWith('Zoom_Staging!G'))).toBe(false);
  });

  it('is NOT a candidate when both G and E are filled', async () => {
    const sheets = fakeSheets([row('a', 'topline', 'Real Person')]);
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfillCandidates).toBe(0);
    expect(fathom.summaryCalls).toEqual([]); // no heavy request at all
    expect(sheets.batches).toHaveLength(0);
  });

  it('IS a candidate when G is blank and E is filled, and writes only G', async () => {
    const sheets = fakeSheets([row('a', '', 'Real Invitee')]);
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfilled).toEqual([{ recordingId: 'a', row: 2, what: 'G' }]);
    expect(sheets.state[0]![4]).toBe('Real Invitee'); // never overwritten
  });

  it('writes both when both are blank', async () => {
    const sheets = fakeSheets([row('a', '', '')]);
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfilled).toEqual([{ recordingId: 'a', row: 2, what: 'G+E' }]);
  });

  it('orders rows needing BOTH cells before rows needing one', async () => {
    // Only one slot, so the ordering decides which row gets it.
    const sheets = fakeSheets([row('needs-e', 'has topline', ''), row('needs-both', '', '')]);
    const fathom = fakeFathom([], { 'needs-e': REAL_RECORDING_SUMMARY, 'needs-both': REAL_RECORDING_SUMMARY });
    await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(fathom.summaryCalls[0]).toBe('needs-both');
  });

  it('a Tier 3 row stays a candidate rather than being marked off — the accepted cost', async () => {
    // No invitees, no Next-Steps owners: E is legitimately blank and will be
    // re-fetched each sweep until triaged. Deliberate: no marker column.
    const sheets = fakeSheets([row('a', 'has topline', '')]);
    const fathom = fakeFathom([], { a: '## Meeting Purpose\nx\n\n## Next Steps\n- nothing bolded' });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfillCandidates).toBe(1);
    expect(r.backfillPlanned).toBe(0); // nothing extractable, nothing written
    expect(sheets.batches).toHaveLength(0);
  });

  it('ignores rows past pre-triage even when E is blank', async () => {
    const sheets = fakeSheets([row('a', 'topline', '', 'PASS'), row('b', 'topline', '', 'DONE')]);
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY, b: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfillCandidates).toBe(0);
  });
});

describe('backfill writes are verified by reading them back', () => {
  const rowNew = (id: string) =>
    [id, 'T', '2026-08-23', '', '', `https://fathom.video/calls/${id}`, '', 'NEW', '', '', '', '', '', 'R'];

  it('reports a row as backfilled ONLY after the read-back confirms it', async () => {
    const sheets = fakeSheets([rowNew('a')]);
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfillPlanned).toBe(1);
    expect(r.backfilled).toHaveLength(1);
    expect(r.warnings).toEqual([]);
    expect(sheets.state[0]![6]).toBe('Review VFX approach for shoe colorways and discuss technical limitations.');
  });

  // THE LIVE BUG: the write is accepted, reported as fine, and lands nothing.
  it('catches a silently-swallowed write and reports ZERO backfilled', async () => {
    const sheets = fakeSheets([rowNew('a'), rowNew('b')], { swallowWrites: true });
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY, b: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.backfillPlanned).toBe(2);
    expect(r.backfilled).toEqual([]); // outcome, not intent
    const w = r.warnings.join('\n');
    expect(w).toContain('BACKFILL WRITE NOT CONFIRMED for 2 of 2');
    expect(w).toContain('STILL BLANK'); // names the specific rows
    expect(w).toContain('row 2');
    expect(w).toContain('row 3');
  });

  it('warns when Google reports 0 cells written', async () => {
    const sheets = fakeSheets([rowNew('a')], { swallowWrites: true, reportZeroCells: true });
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    // Two cells, not one: this row gets both G (topline) and E (owners).
    expect(r.warnings.join('\n')).toContain('reported 0 of 2 cell(s) written');
  });

  it('treats a response with no totalUpdatedCells as unverifiable, not as success', async () => {
    const sheets = fakeSheets([rowNew('a')], { noCellsField: true });
    const fathom = fakeFathom([], { a: REAL_RECORDING_SUMMARY });
    const r = await runZoomDiscovery({
      sheets: sheets.client as never, fathom: fathom.client as never, logger: silent,
      dryRun: false, runId: 'T', now: NOW,
    });
    expect(r.warnings.join('\n')).toContain('UNVERIFIABLE');
    // The read-back still confirms it, because the cells really did change.
    expect(r.backfilled).toHaveLength(1);
  });

  it('Slack breaks silence when writes were attempted and none confirmed', () => {
    const msg = buildSlackMessage({
      runId: 'T', dryRun: false, startedAt: '', finishedAt: '', lookbackHours: 24,
      existingRows: 0, observedStatuses: {}, fetched: 0, skippedOlderThanCutoff: 0, skippedDuplicate: 0,
      appended: [], appendedWithoutTopline: [], backfillCandidates: 10, backfillPlanned: 10, backfilled: [],
      wouldWrite: [], warnings: ['x'],
    });
    expect(msg).not.toBeNull();
    expect(msg!).toContain('10 backfill write(s) NOT confirmed');
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
    appended: [], appendedWithoutTopline: [], backfillCandidates: 0, backfillPlanned: 0, backfilled: [],
    wouldWrite: [], warnings: [],
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
