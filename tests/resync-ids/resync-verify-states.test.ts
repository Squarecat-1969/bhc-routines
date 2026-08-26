import { describe, expect, it } from 'vitest';
import { runResyncIds } from '../../src/passes/resync-ids/index.js';
import { HttpError } from '../../src/lib/http.js';
import type { SheetsClient, SheetRow } from '../../src/lib/sheets.js';
import type { Logger } from '../../src/lib/logger.js';
import type { SlackPoster } from '../../src/lib/slack.js';

// ─── harness ─────────────────────────────────────────────────────────────────
// Two Master_ID rows whose Google_Row pointers are both stale by one, and a
// Contacts column that says what they should be. That is enough to produce
// exactly two corrections and nothing else.

const MASTER: SheetRow[] = [
  ['BHC-00001', 'Ada Lovelace',  'BOTH',   '9', '', ''],   // row 2 → should be 3
  ['BHC-00002', 'Alan Turing',   'GOOGLE', '9', '', ''],   // row 3 → should be 4
];
const CONTACTS: SheetRow[] = [['BHC-00001'], ['BHC-00002']]; // Contacts!A3:A → rows 3, 4

const quota = (kind: 'Read' | 'Write') =>
  new HttpError(429, `HTTP 429: Quota exceeded for quota metric '${kind} requests'`, 'https://x');

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const silentSlack: SlackPoster = { post: async () => {} };

interface FakeOpts {
  /** throw from batchUpdate — simulates the WRITE itself failing */
  failWrite?: boolean;
  /** throw from the post-write verification read — the 2026-08-20 case */
  failVerifyRead?: boolean;
  /** what the verification read reports back, when it succeeds */
  verifyValues?: SheetRow[];
  /**
   * Accept the write, report success, change NOTHING — the silent-no-op shape.
   * `verifyValues` supplies the unchanged column, so the read-back is what
   * catches it.
   */
  swallowWrites?: boolean;
  /** Sheets reports 0 cells written: an outright REFUSAL, not a lost response. */
  refuseWrite?: boolean;
  /** Response carries no totalUpdatedCells: unverifiable, NOT refused. */
  noCellsField?: boolean;
}

function fakeSheets(o: FakeOpts): { client: SheetsClient; batchUpdateCalls: number; readRanges: string[] } {
  const state = { batchUpdateCalls: 0, readRanges: [] as string[] };
  const client = {
    async read(range: string): Promise<SheetRow[]> {
      state.readRanges.push(range);
      if (range.startsWith('Master_ID!A')) return MASTER;
      if (range.startsWith('Contacts!A'))  return CONTACTS;
      if (range.startsWith('Master_ID!D')) {            // the verification read
        if (o.failVerifyRead) throw quota('Read');
        return o.verifyValues ?? [['3'], ['4']];
      }
      return [];
    },
    async update(): Promise<void> { throw new Error('update() must not be used — corrections go through batchUpdate'); },
    async batchUpdate(data: readonly { range: string; values: readonly SheetRow[] }[]) {
      state.batchUpdateCalls += 1;
      if (o.failWrite) throw quota('Write');
      if (o.noCellsField) return { totalUpdatedCells: 0, fieldsPresent: false, rangesRequested: data.length };
      if (o.refuseWrite) return { totalUpdatedCells: 0, fieldsPresent: true, rangesRequested: data.length };
      // swallowWrites still reports success — that is the whole point.
      return { totalUpdatedCells: data.length, fieldsPresent: true, rangesRequested: data.length };
    },
    async append() { throw new Error('append() not used by resync'); },
  } as unknown as SheetsClient;
  return { client, get batchUpdateCalls() { return state.batchUpdateCalls; }, get readRanges() { return state.readRanges; } };
}

const run = (o: FakeOpts) => {
  const f = fakeSheets(o);
  return runResyncIds({ sheets: f.client, logger: silentLogger, slack: silentSlack, dryRun: false, runId: 'R-TEST' })
    .then((report) => ({ report, fake: f }));
};

// ─── the regression this whole change exists for ─────────────────────────────

describe('a write that succeeded but could not be verified is NOT reported as a failed write', () => {
  it('reports VERIFY_INCONCLUSIVE with written:true when the read-back 429s', async () => {
    const { report } = await run({ failVerifyRead: true });

    expect(report.writes).toHaveLength(2);
    for (const w of report.writes) {
      expect(w.outcome).toBe('VERIFY_INCONCLUSIVE');
      expect(w.written).toBe(true);     // ← the whole point: the write DID go out
      expect(w.verified).toBe(false);   // ← but we cannot claim it landed
      expect(w.detail).toContain('read-back unavailable');
    }
  });

  it('is genuinely distinguishable from a write that never landed', async () => {
    const inconclusive = (await run({ failVerifyRead: true })).report.writes[0]!;
    const trulyFailed  = (await run({ failWrite: true })).report.writes[0]!;

    // The old shape made these two identical: written:false, verified:false.
    expect(inconclusive.outcome).not.toBe(trulyFailed.outcome);
    expect(inconclusive.written).toBe(true);
    expect(trulyFailed.written).toBe(false);
    expect(trulyFailed.outcome).toBe('WRITE_FAILED');
  });

  it('says "issued but could not be confirmed", never "did not land", for an unverified write', async () => {
    const { report } = await run({ failVerifyRead: true });
    const text = report.warnings.join(' | ');
    expect(text).toContain('could not be confirmed');
    expect(text).toContain('may well have landed');
    expect(text).not.toContain('did not land');
  });

  it('does say "did not land" when the write genuinely failed', async () => {
    const { report } = await run({ failWrite: true });
    expect(report.warnings.join(' | ')).toContain('did not land');
  });
});

describe('a write that lands but reads back wrong is its own state', () => {
  it('is MISMATCH, not VERIFY_INCONCLUSIVE', async () => {
    const { report } = await run({ verifyValues: [['999'], ['4']] });
    expect(report.writes[0]!.outcome).toBe('MISMATCH');
    expect(report.writes[0]!.written).toBe(true);
    expect(report.writes[0]!.verified).toBe(false);
    expect(report.writes[0]!.detail).toContain('read back as 999');
    expect(report.writes[1]!.outcome).toBe('VERIFIED');
  });
});

// ─── the rate-limit fix ──────────────────────────────────────────────────────

describe('corrections are batched, not one request per correction', () => {
  it('issues ONE batchUpdate for a whole batch and ONE verification read', async () => {
    const { report, fake } = await run({});
    expect(report.writes.every((w) => w.outcome === 'VERIFIED')).toBe(true);

    // 2 corrections → 1 batch, not 2 updates
    expect(fake.batchUpdateCalls).toBe(1);
    // reads: Master_ID!A2:F, Contacts!A3:A, then exactly one Master_ID!D2:D
    const verifyReads = fake.readRanges.filter((r) => r.startsWith('Master_ID!D'));
    expect(verifyReads).toHaveLength(1);
    expect(verifyReads[0]).toBe('Master_ID!D2:D');
  });

  it('never falls back to per-cell update()', async () => {
    // fakeSheets throws from update(); a clean run proves it is unused.
    await expect(run({})).resolves.toBeDefined();
  });
});

/**
 * THE SILENT NO-OP. A batchUpdate that is accepted, reports success, and
 * changes nothing.
 *
 * This is worse here than anywhere else in the repo. Resync IDs repairs
 * Master_ID — the identity bridge, and the only authority for which Contacts
 * row any later write touches. If a no-op is reported as a repair, the next
 * routine writes to the wrong person's row while the log says that row was
 * already corrected. A repair routine that cannot confirm its repairs removes
 * the suspicion that would have caught the problem.
 */
describe('a write that is accepted, reports success, and changes nothing', () => {
  it('confirms ZERO corrections and names every one that did not land', async () => {
    // The verification read returns the OLD values — the write never took.
    const fake = fakeSheets({ swallowWrites: true, verifyValues: [['99'], ['99']] });
    const report = await runResyncIds({
      sheets: fake.client, logger: silentLogger, slack: silentSlack,
      dryRun: false, runId: 'RESYNC-NOOP',
    });

    expect(report.writes).toHaveLength(2);
    expect(report.writes.every((w) => w.outcome === 'MISMATCH')).toBe(true);
    expect(report.writes.every((w) => w.verified === false)).toBe(true);

    // Named, not merely counted — an operator must be able to act on this.
    const warned = report.warnings.join('\n');
    expect(warned).toContain('did not land');
    for (const w of report.writes) {
      expect(warned).toContain(w.correction.bhcId);
      expect(warned).toContain(`Master_ID row ${w.correction.masterRow}`);
    }
  });

  it('the Slack post says ZERO confirmed, never the planned count', async () => {
    const fake = fakeSheets({ swallowWrites: true, verifyValues: [['99'], ['99']] });
    let posted = '';
    const report = await runResyncIds({
      sheets: fake.client, logger: silentLogger,
      slack: { post: async (t: string) => { posted = t; } },
      dryRun: false, runId: 'RESYNC-NOOP',
    });
    expect(report.plan.corrections.length).toBe(2); // 2 were PLANNED
    expect(posted).toContain('0 of 2 correction(s) CONFIRMED');
    expect(posted).toContain('did not land');
    expect(posted).toContain('Master_ID pointers are still wrong');
  });

  it('a REFUSED batch is WRITE_FAILED, not MISMATCH — the layers are different', async () => {
    // totalUpdatedCells: 0 means Sheets declined. Reporting that as "read back
    // wrong" would aim diagnosis at data drift instead of a refused write.
    const fake = fakeSheets({ refuseWrite: true, verifyValues: [['99'], ['99']] });
    const report = await runResyncIds({
      sheets: fake.client, logger: silentLogger, slack: silentSlack,
      dryRun: false, runId: 'RESYNC-REFUSED',
    });
    expect(report.writes.every((w) => w.outcome === 'WRITE_FAILED')).toBe(true);
    expect(report.writes.every((w) => w.written === false)).toBe(true);
    expect(report.warnings.join(' ')).toContain('did not land');
  });

  it('an unverifiable response is NOT treated as refused — the read-back decides', async () => {
    // No totalUpdatedCells field. Different fact from a 0: the write may well
    // have landed, so the read-back is what settles it.
    const fake = fakeSheets({ noCellsField: true, verifyValues: [['3'], ['4']] });
    const report = await runResyncIds({
      sheets: fake.client, logger: silentLogger, slack: silentSlack,
      dryRun: false, runId: 'RESYNC-UNVERIFIABLE',
    });
    expect(report.writes.every((w) => w.outcome === 'VERIFIED')).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it('a fully successful run reports every correction CONFIRMED', async () => {
    const fake = fakeSheets({ verifyValues: [['3'], ['4']] });
    let posted = '';
    const report = await runResyncIds({
      sheets: fake.client, logger: silentLogger,
      slack: { post: async (t: string) => { posted = t; } },
      dryRun: false, runId: 'RESYNC-OK',
    });
    expect(report.writes.every((w) => w.outcome === 'VERIFIED')).toBe(true);
    expect(posted).toContain('2 of 2 correction(s) CONFIRMED');
    expect(posted).not.toContain('did not land');
  });
});
