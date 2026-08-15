import { describe, expect, it } from 'vitest';

import { SheetsClient } from '../../src/lib/sheets.js';
import { loadRunSet } from '../../src/part-d/load-run-set.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

async function setup(brainComplete: unknown[][]): Promise<{ sheets: SheetsClient; backend: FakeBackend }> {
  const config: FakeBackendConfig = {
    entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [], brainComplete,
  };
  const backend = new FakeBackend(config);
  const { sheetsUrl } = await backend.start();
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  return { sheets, backend };
}

/** Builds a 30-element Brain_Complete row (A-AD), matching brain-complete-row.ts's real column positions. */
function row(opts: {
  bhcId?: string;
  contactName?: string;
  direction?: string;
  subject?: string;
  runningSummary?: string;
  blankFlag?: string; // V
  actionRequired?: string; // W
  tasksJson?: string; // Y
  writeTargetsJson?: string; // Z
  runId?: string; // AB
}): unknown[] {
  const r = new Array<unknown>(30).fill('');
  r[1] = opts.bhcId ?? 'BHC-1'; // B
  r[2] = opts.contactName ?? 'Alice'; // C
  r[4] = opts.direction ?? 'Inbound'; // E
  r[5] = opts.subject ?? 'Re: contract'; // F
  r[10] = opts.runningSummary ?? 'summary'; // K
  r[21] = opts.blankFlag ?? ''; // V
  r[22] = opts.actionRequired ?? 'REPLY_NEEDED'; // W
  r[24] = opts.tasksJson ?? '[]'; // Y
  r[25] = opts.writeTargetsJson ?? ''; // Z
  r[27] = opts.runId ?? 'LATE-EDITION-1'; // AB
  return r;
}

describe('loadRunSet', () => {
  it('selects only rows matching runId with a blank col V', async () => {
    const { sheets } = await setup([
      row({ bhcId: 'BHC-1', runId: 'LATE-EDITION-1', blankFlag: '' }), // matches
      row({ bhcId: 'BHC-2', runId: 'LATE-EDITION-2', blankFlag: '' }), // wrong run
      row({ bhcId: 'BHC-3', runId: 'LATE-EDITION-1', blankFlag: 'TRUE' }), // already resolved
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows).toHaveLength(1);
    expect(runSet.rows[0]!.bhcId).toBe('BHC-1');
  });

  it('returns an empty run set (never throws) when nothing matches — "stop silently" per spec', async () => {
    const { sheets } = await setup([row({ runId: 'LATE-EDITION-999' })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows).toHaveLength(0);
    expect(runSet.byDigestPosition.size).toBe(0);
  });

  it('assigns sequential digest positions in sheet order, skipping NO_ACTION rows', async () => {
    const { sheets } = await setup([
      row({ bhcId: 'BHC-1', actionRequired: 'REPLY_NEEDED' }), // position 1
      row({ bhcId: 'BHC-2', actionRequired: 'NO_ACTION' }), // no position
      row({ bhcId: 'BHC-3', actionRequired: 'ACTION_ITEM' }), // position 2
      row({ bhcId: 'BHC-4', actionRequired: 'FYI_ONLY' }), // position 3
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows).toHaveLength(4); // NO_ACTION row is still in the run set...
    expect(runSet.rows.map((r) => r.digestPosition)).toEqual([1, null, 2, 3]); // ...just never numbered
    expect(runSet.byDigestPosition.size).toBe(3);
    expect(runSet.byDigestPosition.get(1)!.bhcId).toBe('BHC-1');
    expect(runSet.byDigestPosition.get(2)!.bhcId).toBe('BHC-3');
    expect(runSet.byDigestPosition.get(3)!.bhcId).toBe('BHC-4');
  });

  it('records the correct physical sheet row (data starts at row 2)', async () => {
    const { sheets } = await setup([
      row({ bhcId: 'BHC-1' }),
      row({ bhcId: 'BHC-2' }),
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.sheetRow).toBe(2);
    expect(runSet.rows[1]!.sheetRow).toBe(3);
  });
});

describe('loadRunSet — Write_Targets_JSON parsing (col Z)', () => {
  it('parses a well-formed WriteTargets blob', async () => {
    const wt = JSON.stringify({ primary: { bhc_id: 'BHC-1', google: { google_row: 10, fields: { BZ: 'x', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } } }, secondary: [] });
    const { sheets } = await setup([row({ writeTargetsJson: wt })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.writeTargets).not.toBeNull();
    expect(runSet.rows[0]!.writeTargets!.primary.bhc_id).toBe('BHC-1');
  });

  it('treats blank col Z as null, matching STEP 4\'s "empty Write_Targets" case', async () => {
    const { sheets } = await setup([row({ writeTargetsJson: '' })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.writeTargets).toBeNull();
  });

  it('treats "{}" as null, per spec\'s own "col Z is non-empty and not {}"', async () => {
    const { sheets } = await setup([row({ writeTargetsJson: '{}' })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.writeTargets).toBeNull();
  });

  it('treats malformed JSON as null rather than throwing', async () => {
    const { sheets } = await setup([row({ writeTargetsJson: '{not valid json' })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.writeTargets).toBeNull();
  });

  it('treats a shape missing primary.bhc_id as null — malformed enough to refuse, not just any parseable JSON', async () => {
    const { sheets } = await setup([row({ writeTargetsJson: JSON.stringify({ primary: {}, secondary: [] }) })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.writeTargets).toBeNull();
  });
});

describe('loadRunSet — Tasks_JSON parsing (col Y)', () => {
  it('parses a well-formed task array', async () => {
    const tasks = JSON.stringify([{ description: 'Follow up', due_date: '2026-07-25', priority: 'High' }]);
    const { sheets } = await setup([row({ tasksJson: tasks })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.tasks).toHaveLength(1);
    expect(runSet.rows[0]!.tasks[0]!.description).toBe('Follow up');
  });

  it('returns an empty array (never throws) for blank, "[]", or malformed Tasks_JSON', async () => {
    for (const val of ['', '[]', 'not json at all', '{}']) {
      const { sheets } = await setup([row({ tasksJson: val })]);
      const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
      expect(runSet.rows[0]!.tasks).toEqual([]);
    }
  });

  it('filters out malformed individual entries rather than rejecting the whole array', async () => {
    const tasks = JSON.stringify([
      { description: 'Good task', due_date: '2026-07-25', priority: 'High' },
      { due_date: '2026-07-26' }, // missing description — malformed
      'not an object',
    ]);
    const { sheets } = await setup([row({ tasksJson: tasks })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    expect(runSet.rows[0]!.tasks).toHaveLength(1);
    expect(runSet.rows[0]!.tasks[0]!.description).toBe('Good task');
  });
});

// ─── Identity fallback (the 2026-08-15 silent-withhold defect) ────────────────
//
// Col B is blank on every live Brain_Complete row — Zap C does no identity
// resolution and PASS 2 passed the blank through. Every row therefore reached
// the identity gate with an empty key, masterId.byBhcId.get('') returned
// undefined, and Part D withheld 100% of primary CRM writes while reporting
// success. The real identity was in Write_Targets_JSON the whole time.

describe('loadRunSet — identity fallback to Write_Targets_JSON', () => {
  const targets = (bhcId: string) =>
    JSON.stringify({ primary: { bhc_id: bhcId, google: { google_row: 371, fields: {} } } });

  it('falls back to Write_Targets_JSON primary.bhc_id when col B is blank', async () => {
    const { sheets, backend } = await setup([row({ bhcId: '', writeTargetsJson: targets('BHC-02395') })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    await backend.stop();

    expect(runSet.rows[0]!.bhcId).toBe('BHC-02395');
    expect(runSet.rows[0]!.bhcIdFromWriteTargets).toBe(true);
    expect(runSet.rowsUsingWriteTargetIdentity).toBe(1);
  });

  it('PREFERS col B when it is populated — the fallback never overrides it', async () => {
    // So the moment PASS 2 starts writing col B, it silently becomes the
    // primary path again with no further change here.
    const { sheets, backend } = await setup([row({ bhcId: 'BHC-FROM-COL-B', writeTargetsJson: targets('BHC-FROM-JSON') })]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    await backend.stop();

    expect(runSet.rows[0]!.bhcId).toBe('BHC-FROM-COL-B');
    expect(runSet.rows[0]!.bhcIdFromWriteTargets).toBe(false);
    expect(runSet.rowsUsingWriteTargetIdentity).toBe(0);
  });

  it('cannot introduce a blank identity — a row with no usable targets keeps writeTargets null', async () => {
    // parseWriteTargets' shape guard already returns null without a
    // primary.bhc_id, so the fallback has nothing to hand over and the row
    // takes the existing skipped_no_target path instead.
    const { sheets, backend } = await setup([
      row({ bhcId: '', writeTargetsJson: JSON.stringify({ primary: { google: { google_row: 5, fields: {} } } }) }),
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    await backend.stop();

    expect(runSet.rows[0]!.writeTargets).toBeNull();
    expect(runSet.rows[0]!.bhcId).toBe('');
    expect(runSet.rows[0]!.bhcIdFromWriteTargets).toBe(false);
  });

  it('counts every row that took the fallback, so a run-wide fallback is visible', async () => {
    const { sheets, backend } = await setup([
      row({ bhcId: '', writeTargetsJson: targets('BHC-1') }),
      row({ bhcId: '', writeTargetsJson: targets('BHC-2') }),
      row({ bhcId: 'BHC-3', writeTargetsJson: targets('BHC-3') }),
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    await backend.stop();

    expect(runSet.rows).toHaveLength(3);
    expect(runSet.rowsUsingWriteTargetIdentity).toBe(2);
  });
});


describe('loadRunSet — totalRowsRead', () => {
  it('reports what the read returned, before any run-id filtering', async () => {
    const { sheets, backend } = await setup([
      row({ runId: 'LATE-EDITION-1' }),
      row({ runId: 'LATE-EDITION-OTHER' }),
      row({ runId: 'LATE-EDITION-OTHER' }),
    ]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    await backend.stop();

    expect(runSet.rows).toHaveLength(1);   // matched this run
    expect(runSet.totalRowsRead).toBe(3);  // but the read itself was healthy
  });

  it('reports 0 when the read returned nothing — the caller uses this to refuse a silent stop', async () => {
    const { sheets, backend } = await setup([]);
    const runSet = await loadRunSet(sheets, 'LATE-EDITION-1');
    await backend.stop();

    expect(runSet.rows).toHaveLength(0);
    expect(runSet.totalRowsRead).toBe(0);
  });
});
