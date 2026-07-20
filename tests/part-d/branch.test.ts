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
    entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [], brainComplete, ...config,
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
