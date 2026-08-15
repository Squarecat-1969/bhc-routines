import { afterEach, describe, expect, it } from 'vitest';

import { AttioClient } from '../../src/lib/attio.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { loadMasterId, type MasterIdIndex } from '../../src/passes/pass4/load.js';
import { loadRunSet } from '../../src/part-d/load-run-set.js';
import { applyCorrections, applyMixed, applyProceed, applyResolve } from '../../src/part-d/branch.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

let backend: FakeBackend;

async function setup(brainComplete: unknown[][], config: Partial<FakeBackendConfig> = {}): Promise<{
  sheets: SheetsClient; attio: AttioClient; masterId: MasterIdIndex; backend: FakeBackend;
}> {
  backend = new FakeBackend({
    // See the sentinel note in tests/pass2/resolve.test.ts — loadMasterId
    // refuses a 0-entry index. A row that matches nothing still lets the
    // identity gate withhold exactly as these tests expect.
    entries: [], people: {}, masterId: [['BHC-09999', 'Fixture Sentinel', 'BOTH', 3, 'rec-fixture-sentinel', 'fixture row — a production Master_ID is never empty']], contactsHeader: [], contacts: [], brainComplete, ...config,
  });
  const { attioBase, sheetsUrl } = await backend.start();
  const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  const masterId = await loadMasterId(sheets);
  return { sheets, attio, masterId, backend };
}

afterEach(async () => {
  await backend?.stop();
});

/** Builds a 30-element Brain_Complete row (A-AD), matching the real column positions. */
function row(opts: {
  bhcId?: string; runId?: string; actionRequired?: string;
  writeTargetsJson?: string; subject?: string;
}): unknown[] {
  const r = new Array<unknown>(30).fill('');
  r[1] = opts.bhcId ?? 'BHC-1';
  r[2] = 'Alice';
  r[4] = 'Inbound';
  r[5] = opts.subject ?? 'Re: contract';
  r[10] = 'summary';
  r[21] = ''; // V blank
  r[22] = opts.actionRequired ?? 'REPLY_NEEDED'; // W
  r[24] = '[]'; // Y
  r[25] = opts.writeTargetsJson ?? ''; // Z
  r[27] = opts.runId ?? 'LATE-EDITION-1'; // AB
  return r;
}

describe('applyProceed', () => {
  it('closes every row in the run set, including NO_ACTION rows, with no writes', async () => {
    const { sheets } = await setup([
      row({ bhcId: 'BHC-1', actionRequired: 'REPLY_NEEDED' }),
      row({ bhcId: 'BHC-2', actionRequired: 'NO_ACTION' }),
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyProceed(sheets, runSet);

    expect(result.applied).toHaveLength(2);
    expect(result.applied.every((a) => a.outcome === 'closed')).toBe(true);
    const vWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!V'));
    expect(vWrites).toHaveLength(2);
    // No Activity_Log or Contacts writes at all — PROCEED never touches the CRM
    expect(backend.sheetsWrites.some((w) => (w.body as { range?: string }).range?.startsWith('Activity_Log'))).toBe(false);
  });
});

describe('applyCorrections', () => {
  it('appends CORRECTION: {note} to col U, leaves V blank', async () => {
    const { sheets } = await setup([row({ bhcId: 'BHC-1' })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyCorrections(sheets, runSet, [{ n: 1, note: 'wrong contact' }]);

    expect(result.applied[0]!.outcome).toBe('corrected');
    const uWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!U'));
    expect(uWrite).toBeDefined();
    expect((uWrite!.body as { values: unknown[][] }).values[0]![0]).toBe('CORRECTION: wrong contact');
    const vWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!V'));
    expect(vWrite).toBeUndefined(); // V left blank
  });

  it('appends AFTER existing Brain_Notes content rather than overwriting it', async () => {
    const seedRow = row({ bhcId: 'BHC-1' });
    seedRow[20] = 'Existing brain notes about this thread.'; // U
    const { sheets } = await setup([seedRow]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    await applyCorrections(sheets, runSet, [{ n: 1, note: 'wrong contact' }]);

    const uWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!U'));
    expect((uWrite!.body as { values: unknown[][] }).values[0]![0]).toBe(
      'Existing brain notes about this thread.\nCORRECTION: wrong contact',
    );
  });

  it('flags an invalid digest position rather than throwing or silently ignoring it', async () => {
    const { sheets } = await setup([row({ bhcId: 'BHC-1' })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyCorrections(sheets, runSet, [{ n: 99, note: 'does not exist' }]);

    expect(result.applied[0]!.outcome).toBe('skipped_invalid_position');
    expect(result.applied[0]!.warnings[0]).toContain('position 99');
  });
});

describe('applyResolve', () => {
  it('resolves a row with real writeTargets via writeRow + QA, and skips a row with none', async () => {
    const wt = JSON.stringify({ primary: { bhc_id: 'BHC-1' }, secondary: [] });
    const { sheets, attio, masterId } = await setup(
      [row({ bhcId: 'BHC-1', writeTargetsJson: wt }), row({ bhcId: 'BHC-2', writeTargetsJson: '' })],
      { masterId: [['BHC-1', 'Alice', 'BOTH', '', '', ''], ['BHC-2', 'Bob', 'BOTH', '', '', '']] },
    );
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyResolve(sheets, attio, masterId, runSet);

    expect(result.applied).toHaveLength(2);
    expect(result.applied[0]!.outcome).toBe('resolved');
    expect(result.applied[0]!.qa).toBeDefined();
    expect(result.applied[1]!.outcome).toBe('skipped_no_target');

    const vWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!V'));
    expect(vWrites).toHaveLength(2); // both rows end up closed one way or another
  });

  // ── The durable WITHHELD marker ─────────────────────────────────────────
  // Part D produced the correct diagnosis four times a night for a month and
  // discarded it every time, so reconstructing the affected set meant reading
  // Slack history. A marker on the row makes the set queryable from the sheet.
  it('records a WITHHELD marker in col U when the identity gate holds every write', async () => {
    const wt = JSON.stringify({
      primary: { bhc_id: 'BHC-MISSING', google: { google_row: 371, fields: {} } },
      secondary: [],
    });
    // Master_ID deliberately does NOT contain BHC-MISSING — the gate withholds.
    const { sheets, attio, masterId } = await setup([row({ bhcId: '', writeTargetsJson: wt })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyResolve(sheets, attio, masterId, runSet);

    expect(result.applied[0]!.writeResult!.googleWritten).toBe(false);

    const uWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!U'));
    expect(uWrites).toHaveLength(1);
    const written = String(((uWrites[0]!.body as { values: unknown[][] }).values)[0]![0]);
    expect(written).toMatch(/^WITHHELD \d{4}-\d{2}-\d{2}: /);
    expect(written).toContain('withholding Google write');

    // Still closed — leaving V blank to enable retry would duplicate the
    // Activity_Log and Contact_History rows that DID land.
    const vWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!V'));
    expect(vWrites).toHaveLength(1);
  });

  it('records a PARTIAL marker when one CRM took the write and another did not', async () => {
    // Google_Row 3 matches Master_ID; the Attio record_id does not. One
    // independent check passes, the other withholds — pointer drift on one
    // side only, and the two CRMs end the run disagreeing.
    const wt = JSON.stringify({
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 3, fields: {} },
        attio: { record_id: 'rec-WRONG', fields: { last_meeting_summary: 'x' } },
      },
      secondary: [],
    });
    const { sheets, attio, masterId } = await setup(
      [row({ bhcId: '', writeTargetsJson: wt })],
      { masterId: [['BHC-1', 'Alice', 'BOTH', 3, 'rec-RIGHT', '']] },
    );
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyResolve(sheets, attio, masterId, runSet);

    expect(result.applied[0]!.writeResult!.googleWritten).toBe(true);
    expect(result.applied[0]!.writeResult!.attioWritten).toBe(false);

    const uWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!U'));
    expect(uWrites).toHaveLength(1);
    const written = String(((uWrites[0]!.body as { values: unknown[][] }).values)[0]![0]);
    expect(written).toMatch(/^PARTIAL \d{4}-\d{2}-\d{2}: /);
    // The pointer-drift branch of the gate, not the missing-entry branch —
    // Master_ID HAS BHC-1, its Attio_Record_ID just isn't the staged one.
    expect(written).toContain("Master_ID's Attio_Record_ID for BHC-1");
    expect(written).toContain('Withholding Attio write');
  });

  it('writes no WITHHELD marker when the gate lets the write through', async () => {
    const wt = JSON.stringify({
      primary: { bhc_id: 'BHC-1', google: { google_row: 3, fields: {} } },
      secondary: [],
    });
    const { sheets, attio, masterId } = await setup(
      [row({ bhcId: '', writeTargetsJson: wt })],
      { masterId: [['BHC-1', 'Alice', 'BOTH', 3, 'rec-1', '']] },
    );
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyResolve(sheets, attio, masterId, runSet);

    // THE FIX, end to end: col B is blank, identity came from
    // Write_Targets_JSON, the gate passed, and a real Google write happened.
    // Before the fallback this was googleWritten=false on every live row.
    expect(runSet.rows[0]!.bhcIdFromWriteTargets).toBe(true);
    expect(result.applied[0]!.writeResult!.googleWritten).toBe(true);

    const uWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!U'));
    expect(uWrites).toHaveLength(0);
  });
});

describe('applyMixed', () => {
  it('handles ACCEPT, CORRECT, and DISMISS in one command, leaves untouched rows alone', async () => {
    const wt = JSON.stringify({ primary: { bhc_id: 'BHC-1' }, secondary: [] });
    const { sheets, attio, masterId } = await setup(
      [
        row({ bhcId: 'BHC-1', writeTargetsJson: wt }), // position 1 — ACCEPT
        row({ bhcId: 'BHC-2' }), // position 2 — CORRECT
        row({ bhcId: 'BHC-3' }), // position 3 — DISMISS
        row({ bhcId: 'BHC-4' }), // position 4 — not mentioned, stays untouched
      ],
      { masterId: [['BHC-1', 'Alice', 'BOTH', '', '', '']] },
    );
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyMixed(sheets, attio, masterId, runSet, [
      { n: 1, action: 'ACCEPT' },
      { n: 2, action: 'CORRECT', note: 'wrong company' },
      { n: 3, action: 'DISMISS' },
    ], []);

    expect(result.applied).toHaveLength(3); // position 4 never appears at all
    expect(result.applied.find((a) => a.digestPosition === 1)!.outcome).toBe('resolved');
    expect(result.applied.find((a) => a.digestPosition === 2)!.outcome).toBe('corrected');
    expect(result.applied.find((a) => a.digestPosition === 3)!.outcome).toBe('dismissed');

    // Position 4 (BHC-4) never got any Brain_Complete write at all
    const vWrites = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range?.startsWith('Brain_Complete!V'));
    expect(vWrites).toHaveLength(2); // position 1 (via QA) + position 3 (DISMISS) — not position 4
  });

  it('processes in ascending digest-position order regardless of submission order', async () => {
    const { sheets, attio, masterId } = await setup([
      row({ bhcId: 'BHC-1' }), row({ bhcId: 'BHC-2' }), row({ bhcId: 'BHC-3' }),
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyMixed(sheets, attio, masterId, runSet, [
      { n: 3, action: 'DISMISS' },
      { n: 1, action: 'DISMISS' },
      { n: 2, action: 'DISMISS' },
    ], []);
    expect(result.applied.map((a) => a.digestPosition)).toEqual([1, 2, 3]);
  });

  it('flags an invalid position and carries through skippedLines from parse-command.ts', async () => {
    const { sheets, attio, masterId } = await setup([row({ bhcId: 'BHC-1' })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    const result = await applyMixed(sheets, attio, masterId, runSet, [{ n: 99, action: 'DISMISS' }], ['garbage line']);
    expect(result.applied[0]!.outcome).toBe('skipped_invalid_position');
    expect(result.skippedLines).toEqual(['garbage line']);
  });
});
