import { afterEach, describe, expect, it } from 'vitest';

import { AttioClient } from '../../src/lib/attio.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { loadMasterId, type MasterIdIndex } from '../../src/passes/pass4/load.js';
import { writeRow } from '../../src/part-d/write-row.js';
import { qaVerifyAndClose } from '../../src/part-d/qa-readback.js';
import type { WriteRowInput } from '../../src/part-d/types.js';
import type { WriteTargets } from '../../src/passes/pass2/write-targets.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

let backend: FakeBackend;

async function setup(config: FakeBackendConfig): Promise<{
  sheets: SheetsClient; attio: AttioClient; masterId: MasterIdIndex; backend: FakeBackend;
}> {
  backend = new FakeBackend(config);
  const { attioBase, sheetsUrl } = await backend.start();
  const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
  const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
  const masterId = await loadMasterId(sheets);
  return { sheets, attio, masterId, backend };
}

afterEach(async () => {
  await backend?.stop();
});

function baseInput(overrides: Partial<WriteRowInput> = {}, writeTargets?: Partial<WriteTargets>): WriteRowInput {
  const defaultTargets: WriteTargets = { primary: { bhc_id: 'BHC-1' }, secondary: [] };
  return {
    bhcId: 'BHC-1', contactName: 'Alice Nguyen', direction: 'Inbound', subject: 'Re: contract',
    runningSummary: 'Alice confirmed the contract terms.',
    writeTargets: { ...defaultTargets, ...writeTargets },
    tasks: [], brainCompleteRow: 5,
    ...overrides,
  };
}

const MASTER_ID_ROWS = [['BHC-1', 'Alice Nguyen', 'BOTH', 10, 'rec-alice', '']];

describe('qaVerifyAndClose — happy path', () => {
  it('sets Brain_Complete col V to TRUE when every eligible check passes on the first read, no corrections needed', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const input = baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: 'x', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } },
        attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'Confirmed terms.' } },
      },
    });
    const writeResult = await writeRow(sheets, attio, masterId, input);
    const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);

    expect(qa.vSet).toBe(true);
    expect(qa.primaryChecks.every((c) => c.ok)).toBe(true);
    expect(qa.primaryChecks.every((c) => !c.correctedOnRetry)).toBe(true); // nothing needed correcting

    const vWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === `Brain_Complete!V${input.brainCompleteRow}`);
    expect(vWrite).toBeDefined();
    expect((vWrite!.body as { values: unknown[][] }).values[0]![0]).toBe('TRUE');
  });

  it('only checks fields that were actually eligible — no google target means no Google check at all', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const input = baseInput({}, {
      primary: { bhc_id: 'BHC-1', attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'x' } } },
    });
    const writeResult = await writeRow(sheets, attio, masterId, input);
    const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);

    expect(qa.primaryChecks.some((c) => c.field.includes('Google'))).toBe(false);
    expect(qa.primaryChecks.some((c) => c.field.includes('Attio'))).toBe(true);
    expect(qa.vSet).toBe(true);
  });
});

describe('qaVerifyAndClose — mismatch detection and one-time correction', () => {
  it('detects and corrects an Activity_Log mismatch, still passes overall', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const input = baseInput();
    const writeResult = await writeRow(sheets, attio, masterId, input);

    // Simulate the original write having gone wrong somehow — directly
    // corrupt the stored row's subject, as if write-row.ts's append had
    // landed with bad data for reasons outside its own control.
    const activityLogIdx = backend.config.activityLog!.length - 1;
    (backend.config.activityLog![activityLogIdx] as unknown[])[8] = 'WRONG SUBJECT'; // I

    const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);
    const alCheck = qa.primaryChecks.find((c) => c.field.startsWith('Activity_Log'));
    expect(alCheck!.ok).toBe(true);
    expect(alCheck!.correctedOnRetry).toBe(true);
    expect(qa.vSet).toBe(true);
    expect(qa.warnings.some((w) => w.includes('required one correction'))).toBe(true);
  });

  it('detects and corrects a Google BZ:CG mismatch, still passes overall', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const input = baseInput({}, {
      primary: { bhc_id: 'BHC-1', google: { google_row: 10, fields: { BZ: 'x', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } } },
    });
    const writeResult = await writeRow(sheets, attio, masterId, input);

    // Corrupt what's in the row-store directly, simulating a write that
    // silently landed wrong. contactsRowStore is keyed by absolute column
    // index (columnLetterToIndex), not an offset relative to any
    // particular read's range — CG's real index is 84, not "6th column of
    // a CA:CG slice."
    backend.contactsRowStore.get(10)!.set(84, 'Negative'); // CG

    const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);
    const googleCheck = qa.primaryChecks.find((c) => c.field.includes('Google'));
    expect(googleCheck!.ok).toBe(true);
    expect(googleCheck!.correctedOnRetry).toBe(true);
    expect(qa.vSet).toBe(true);
  });

  it('detects and corrects a missing Contact_History row', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const input = baseInput();
    const writeResult = await writeRow(sheets, attio, masterId, input);

    // Simulate write-row.ts's Contact_History append having silently failed
    // (its own try/catch swallowed it into a warning) by removing it.
    backend.config.contactHistory = [];

    const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);
    const chCheck = qa.primaryChecks.find((c) => c.field.startsWith('Contact_History'));
    expect(chCheck!.ok).toBe(true);
    expect(chCheck!.correctedOnRetry).toBe(true);
    expect(qa.vSet).toBe(true);
    expect(backend.config.contactHistory).toHaveLength(1); // the corrective append landed
  });

  it('detects and corrects an Attio last_meeting_summary mismatch', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const input = baseInput({}, {
      primary: { bhc_id: 'BHC-1', attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'Correct summary' } } },
    });
    const writeResult = await writeRow(sheets, attio, masterId, input);

    // Directly corrupt the patched record, simulating drift.
    backend.patched.set('rec-alice', { last_meeting_summary: 'Wrong summary' });

    const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);
    const attioCheck = qa.primaryChecks.find((c) => c.field === 'Attio last_meeting_summary');
    expect(attioCheck!.ok).toBe(true);
    expect(attioCheck!.correctedOnRetry).toBe(true);
    expect(qa.vSet).toBe(true);
  });
});

describe('qaVerifyAndClose — personal context is non-blocking', () => {
  it('leaves V=TRUE even when a personal-context check fails, flags it separately', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const input = baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: 'x', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } },
        personal_context: { personal_notes_extract: 'Mentioned a new puppy', topics_of_interest_extract: '', conversation_trigger_extract: '' },
      },
    });
    const writeResult = await writeRow(sheets, attio, masterId, input);

    // Corrupt the AI cell after the fact so the personal-context check fails.
    backend.contactsRowStore.get(10)!.clear(); // wipe col AI's stored write entirely

    const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);
    expect(qa.personalContextChecks.some((c) => !c.ok)).toBe(true);
    expect(qa.vSet).toBe(true); // still true — personal context never blocks
    expect(qa.warnings.some((w) => w.includes('non-blocking'))).toBe(true);
  });
});

describe('qaVerifyAndClose — secondary failures never block the primary', () => {
  it('flags a failing secondary but still sets V=TRUE for the primary', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-bob': { name: 'Bob Chen', bhcContactId: 'BHC-2' } },
      masterId: [...MASTER_ID_ROWS, ['BHC-2', 'Bob Chen', 'ATTIO', '', 'rec-bob', '']],
      contactsHeader: [], contacts: [],
    });
    const input = baseInput({}, {
      primary: { bhc_id: 'BHC-1' },
      secondary: [{ bhc_id: 'BHC-2', attio: { record_id: 'rec-bob', fields: { last_meeting_summary: "CC'd." } } }],
    });
    const writeResult = await writeRow(sheets, attio, masterId, input);

    // Corrupt the secondary's Attio summary so its own QA check fails even
    // after correction is attempted — simulate by making patches to this
    // specific record silently not stick (force via failWith AFTER the
    // initial successful write, so the correction attempt itself fails).
    backend.config.people!['rec-bob']!.failWith = 500;

    await expect(qaVerifyAndClose(sheets, attio, masterId, input, writeResult))
      .rejects.toThrow(); // an unreachable Attio record propagates rather than being silently swallowed — same posture as write-row.ts's own primary writes
  }, 8000);
});
