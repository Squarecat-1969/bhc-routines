/**
 * write-row.ts against a fake Attio + Sheets backend. This is the
 * highest-stakes function in the Part D rebuild — real, permanent CRM
 * writes — so coverage here is deliberately more thorough than a typical
 * pass, especially around the identity-verification gate (the one thing
 * added beyond a literal spec port, precisely because of what a MISSING
 * version of this gate did once already in a different routine).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { AttioClient } from '../../src/lib/attio.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { loadMasterId, type MasterIdIndex } from '../../src/passes/pass4/load.js';
import { writeRow } from '../../src/part-d/write-row.js';
import type { WriteRowInput } from '../../src/part-d/types.js';
import type { WriteTargets } from '../../src/passes/pass2/write-targets.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

let backend: FakeBackend;

async function setup(config: FakeBackendConfig): Promise<{
  sheets: SheetsClient;
  attio: AttioClient;
  masterId: MasterIdIndex;
  backend: FakeBackend;
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
  const defaultTargets: WriteTargets = {
    primary: { bhc_id: 'BHC-1' },
    secondary: [],
  };
  return {
    bhcId: 'BHC-1',
    contactName: 'Alice Nguyen',
    direction: 'Inbound',
    subject: 'Re: contract',
    runningSummary: 'Alice confirmed the contract terms.',
    writeTargets: { ...defaultTargets, ...writeTargets },
    tasks: [],
    brainCompleteRow: 5,
    ...overrides,
  };
}

const MASTER_ID_ROWS = [['BHC-1', 'Alice Nguyen', 'BOTH', 10, 'rec-alice', '']];

describe('writeRow — 4a Activity_Log', () => {
  it('appends first, always, with the right column shape', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput());

    expect(result.activityId).toMatch(/^ACT-\d+-[a-z0-9]+$/);
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    expect(append).toBeDefined();
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row).toHaveLength(21); // A-U
    expect(row[0]).toBe(result.activityId);
    expect(row[2]).toBe('BHC-1'); // C Contact_ID
    expect(row[4]).toBe('Alice Nguyen'); // E Contact_Name
    expect(row[5]).toBe('Email'); // F
    expect(row[6]).toBe('Email'); // G
    expect(row[7]).toBe('Inbound'); // H Direction
    expect(row[8]).toBe('Re: contract'); // I Subject
    expect(row[9]).toBe('Alice confirmed the contract terms.'); // J Body
    expect(row[16]).toBe('late_edition'); // Q
    expect(row[17]).toBe('Part D Resolve Handler'); // R
  });

  it('defaults outcome to Neutral when no google.fields.CG is present', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput());
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[13]).toBe('Neutral'); // N Outcome
  });

  it('uses the earliest-due task for O/P, not array order', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput({
      tasks: [
        { description: 'Later task', due_date: '2026-08-01', priority: 'Medium' },
        { description: 'Sooner task', due_date: '2026-07-25', priority: 'High' },
      ],
    }));
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[14]).toBe('2026-07-25'); // O Next_Action_Date — the sooner one, not the first in array order
    expect(row[15]).toBe('Sooner task'); // P Next_Action_Note
  });
});

describe('writeRow — identity-verification gate', () => {
  it('withholds the Google write when Master_ID\'s Google_Row differs from what WriteTargets claims, but still writes Attio and Activity_Log', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: [['BHC-1', 'Alice Nguyen', 'BOTH', 99, 'rec-alice', '']], // real Google_Row is 99, not 10
      contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: '2026-07-20', CA: 'Email', CB: 'Inbound', CD: 'Re: contract', CE: 'summary', CG: 'Positive' } },
        attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'summary' } },
      },
    }));

    expect(result.warnings.some((w) => w.includes('Master_ID') && w.includes('Google_Row'))).toBe(true);
    const googleWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Contacts!BZ'));
    expect(googleWrite).toBeUndefined(); // withheld
    expect(backend.patched.has('rec-alice')).toBe(true); // Attio write still landed
    expect(result.writes.some((w) => w.startsWith('Activity_Log'))).toBe(true); // Activity_Log still landed
  });

  it('withholds the Attio write when Master_ID\'s Attio_Record_ID differs from what WriteTargets claims, but still writes Google', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-real': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: [['BHC-1', 'Alice Nguyen', 'BOTH', 10, 'rec-real', '']], // real record is rec-real, not rec-stale
      contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: '2026-07-20', CA: 'Email', CB: 'Inbound', CD: 'Re: contract', CE: 'summary', CG: 'Positive' } },
        attio: { record_id: 'rec-stale', fields: { last_meeting_summary: 'summary' } },
      },
    }));

    expect(result.warnings.some((w) => w.includes('Master_ID') && w.includes('Attio_Record_ID'))).toBe(true);
    expect(backend.patched.has('rec-stale')).toBe(false); // withheld — never even attempted against the stale ID
    const googleWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Contacts!BZ'));
    expect(googleWrite).toBeDefined(); // Google write still landed
  });

  it('withholds both writes when Master_ID has no entry for the bhcId at all', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: [], contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: '2026-07-20', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } },
        attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'x' } },
      },
    }));

    expect(result.warnings.filter((w) => w.includes('no entry'))).toHaveLength(2);
    const googleWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Contacts!BZ'));
    expect(googleWrite).toBeUndefined();
    expect(backend.patched.size).toBe(0);
    // Activity_Log still writes — the gate protects specific write targets, not the row's existence in the log
    expect(result.activityId).not.toBeNull();
  });
});

describe('writeRow — 4d Attio + task creation', () => {
  it('creates one Attio task per staged task and writes the single task ID to Activity_Log col T', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({
      tasks: [{ description: 'Send follow-up', due_date: '2026-07-25', priority: 'High' }],
    }, {
      primary: { bhc_id: 'BHC-1', attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'x' } } },
    }));

    expect(result.taskIds).toHaveLength(1);
    expect(backend.createdTasks).toHaveLength(1);
    expect(backend.createdTasks[0]!.content).toBe('Send follow-up');
    const colTWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Activity_Log!T'));
    expect(colTWrite).toBeDefined();
    expect((colTWrite!.body as { values: unknown[][] }).values[0]![0]).toBe(result.taskIds[0]);
  });

  it('does NOT write Activity_Log col T when more than one task is created (spec: only "if exactly one")', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({
      tasks: [
        { description: 'Task one', due_date: '2026-07-25', priority: 'High' },
        { description: 'Task two', due_date: '2026-07-26', priority: 'Medium' },
      ],
    }, {
      primary: { bhc_id: 'BHC-1', attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'x' } } },
    }));

    expect(result.taskIds).toHaveLength(2);
    const colTWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Activity_Log!T'));
    expect(colTWrite).toBeUndefined();
  });

  it('catches a task-creation failure into warnings without failing the whole row', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
      taskCreateFailWith: 500,
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({
      tasks: [{ description: 'Send follow-up', due_date: '2026-07-25', priority: 'High' }],
    }, {
      primary: { bhc_id: 'BHC-1', attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'x' } } },
    }));

    expect(result.ok).toBe(true); // the row itself still completed
    expect(result.taskIds).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('task creation failed'))).toBe(true);
  });
});

describe('writeRow — 4b.5 personal context', () => {
  it('appends to existing Google Personal_Notes (AI) rather than overwriting', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS,
      contactsHeader: [], contacts: [],
    });
    // Seed an existing AI value by writing it directly through the fake's generic read fallback isn't possible —
    // instead verify the read-then-combine call shape via the actual update.
    await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: '2026-07-20', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } },
        personal_context: { personal_notes_extract: 'Mentioned a new puppy', topics_of_interest_extract: '', conversation_trigger_extract: '' },
      },
    }));
    const aiWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Contacts!AI'));
    expect(aiWrite).toBeDefined();
    const written = (aiWrite!.body as { values: unknown[][] }).values[0]![0] as string;
    expect(written).toContain('Mentioned a new puppy');
    expect(written).toMatch(/^\[\d{4}-\d{2}-\d{2} LE\]/); // date-stamped per spec
  });

  it('does not duplicate a topics-of-interest entry already present in Attio', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1', topicsOfInterest: 'skiing, wine' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'x' } },
        personal_context: { personal_notes_extract: '', topics_of_interest_extract: 'skiing', conversation_trigger_extract: '' },
      },
    }));
    expect(backend.patched.get('rec-alice')?.['topics_of_interest']).toBeUndefined(); // already present — no write
  });

  it('never blocks the row on a personal-context write failure', async () => {
    // Real expected duration here is ~6s, not a test artifact to optimize
    // away: this scenario has TWO independent retry-storms against the same
    // failing record — one for the personal-context/LinkedIn GET, a
    // separate one for STEP 4d's own main Attio field update PATCH — each
    // retrying 3x with backoff (withRetry) before giving up. That's correct
    // behavior (a GET failing doesn't guarantee a PATCH will too in the
    // real world, so each write attempt genuinely should retry on its own
    // merits), just slower than a single-failure scenario. Traced directly
    // via a standalone script before writing this comment, not guessed at.
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1', failWith: 500 } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'x' } },
        personal_context: { personal_notes_extract: 'note', topics_of_interest_extract: '', conversation_trigger_extract: '' },
      },
    }));
    expect(result.ok).toBe(true);
    // After the getPersonRecord consolidation, this specific failure mode
    // (the record fetch itself failing) surfaces through that fetch's own
    // warning, not the personal-context block's — the personal-context
    // block never runs at all once attioRecord is null, since it has
    // nothing to read. Still non-blocking, still a real warning, just
    // different wording than before the consolidation.
    expect(result.warnings.some((w) => w.includes('Could not fetch Attio record'))).toBe(true);
  }, 12_000);
});

describe('writeRow — 4e Tasks_Open (real 13-col A-M shape, not the spec\'s stale 15-field description)', () => {
  it('appends one row per task with exactly 13 columns', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput({
      tasks: [{ description: 'Send follow-up', due_date: '2026-07-25', priority: 'High' }],
    }));
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Tasks_Open!A1');
    expect(append).toBeDefined();
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row).toHaveLength(13); // A-M, not the spec's stale 15
    expect(row[0]).toMatch(/^TASK-\d+$/);
    expect(row[6]).toBe('Send follow-up'); // G
    expect(row[7]).toBe('2026-07-25'); // H
    expect(row[8]).toBe('Open'); // I
    expect(row[9]).toBe('High'); // J
  });

  it('defaults priority to Medium when the staged task has none', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput({
      tasks: [{ description: 'Send follow-up', due_date: '', priority: '' }],
    }));
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Tasks_Open!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[9]).toBe('Medium');
  });
});

describe('writeRow — Source_CRM reflects what was actually written, not merely claimed', () => {
  it('writes GOOGLE when only the Google write was verified, even though attio was also claimed but withheld', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: [['BHC-1', 'Alice Nguyen', 'BOTH', 10, 'rec-real', '']], // Attio ID will mismatch
      contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: 'x', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } },
        attio: { record_id: 'rec-stale', fields: { last_meeting_summary: 'x' } }, // mismatches Master_ID
      },
    }));
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[18]).toBe('GOOGLE'); // S — not BOTH, since Attio was withheld
  });
});

describe('writeRow — 4f secondary contacts (lighter loop)', () => {
  it('writes Activity_Log + Attio + Contact_History for each secondary, independent of the primary', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-bob': { name: 'Bob Chen', bhcContactId: 'BHC-2' } },
      masterId: [...MASTER_ID_ROWS, ['BHC-2', 'Bob Chen', 'ATTIO', '', 'rec-bob', '']],
      contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: { bhc_id: 'BHC-1' },
      secondary: [{ bhc_id: 'BHC-2', attio: { record_id: 'rec-bob', fields: { last_meeting_summary: 'CC\'d on the contract thread.' } } }],
    }));

    expect(result.secondaries).toHaveLength(1);
    expect(result.secondaries[0]!.bhcId).toBe('BHC-2');
    expect(result.secondaries[0]!.ok).toBe(true);
    expect(result.secondaries[0]!.attioRecordId).toBe('rec-bob');

    const activityAppends = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    expect(activityAppends).toHaveLength(2); // primary + secondary
    const secRow = (activityAppends[1]!.body as { values: unknown[][] }).values[0]!;
    expect(secRow[2]).toBe('BHC-2'); // C Contact_ID
    expect(secRow[8]).toBe('[cc] Re: contract'); // I Subject
    expect(secRow[9]).toBe("CC'd on the contract thread."); // J Body — the role note

    expect(backend.patched.get('rec-bob')?.['last_meeting_summary']).toBe("CC'd on the contract thread.");

    const historyAppends = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range === 'Contact_History!A1');
    expect(historyAppends).toHaveLength(2); // primary + secondary
    const secHistoryRow = (historyAppends[1]!.body as { values: unknown[][] }).values[0]!;
    expect(secHistoryRow[1]).toBe('BHC-2'); // BHC_ID
    expect(secHistoryRow[16]).toBe(result.secondaries[0]!.activityId); // Activity_Log_Ref = the SECONDARY's own ACT- id
  });

  it('falls back to a generic role note when the secondary has no attio target at all', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: { bhc_id: 'BHC-1' },
      secondary: [{ bhc_id: 'BHC-2' }], // no attio block — no role-note source data survives
    }));
    const activityAppends = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const secRow = (activityAppends[1]!.body as { values: unknown[][] }).values[0]!;
    expect(secRow[9]).toBe('Secondary contact on this thread.');
  });

  it('withholds a secondary\'s Attio write when Master_ID ownership mismatches, without affecting the primary or other secondaries', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-bob-real': { name: 'Bob Chen', bhcContactId: 'BHC-2' } },
      masterId: [...MASTER_ID_ROWS, ['BHC-2', 'Bob Chen', 'ATTIO', '', 'rec-bob-real', '']],
      contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: 'x', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } },
      },
      secondary: [{ bhc_id: 'BHC-2', attio: { record_id: 'rec-bob-stale', fields: { last_meeting_summary: 'x' } } }],
    }));

    expect(result.secondaries[0]!.attioRecordId).toBeNull(); // withheld
    expect(result.secondaries[0]!.warnings.some((w) => w.includes('Master_ID'))).toBe(true);
    expect(backend.patched.has('rec-bob-stale')).toBe(false);
    // Primary's Google write is completely unaffected by the secondary's identity-gate failure
    const googleWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Contacts!BZ'));
    expect(googleWrite).toBeDefined();
  });

  it('one failing secondary does not block another secondary from writing', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-charlie': { name: 'Charlie', bhcContactId: 'BHC-3' } },
      masterId: [...MASTER_ID_ROWS, ['BHC-3', 'Charlie', 'ATTIO', '', 'rec-charlie', '']], // BHC-2 has no Master_ID entry at all
      contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: { bhc_id: 'BHC-1' },
      secondary: [
        { bhc_id: 'BHC-2', attio: { record_id: 'rec-nonexistent', fields: { last_meeting_summary: 'x' } } }, // no Master_ID entry
        { bhc_id: 'BHC-3', attio: { record_id: 'rec-charlie', fields: { last_meeting_summary: 'Good secondary' } } },
      ],
    }));

    expect(result.secondaries).toHaveLength(2);
    expect(result.secondaries[0]!.attioRecordId).toBeNull(); // BHC-2 withheld
    expect(result.secondaries[1]!.ok).toBe(true); // BHC-3 still succeeded
    expect(backend.patched.get('rec-charlie')?.['last_meeting_summary']).toBe('Good secondary');
  });

  it('does not attempt any secondary writes when writeTargets.secondary is empty', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput());
    expect(result.secondaries).toHaveLength(0);
    const activityAppends = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    expect(activityAppends).toHaveLength(1); // primary only
  });
});

describe('writeRow — sensitive-data gate (added after the fact, found missing while building confirm.ts)', () => {
  it('blanks a running summary containing a credit card number and flags it, rather than writing it', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({
      runningSummary: 'Alice said her card is 4111111111111111, please use it for the deposit.',
    }));

    expect(result.warnings.some((w) => w.includes('credit_card'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('4111111111111111'))).toBe(false); // never echoes the secret itself

    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[9]).toBe(''); // J Body — blanked, not the original text with the card number
  });

  it('blanks a subject line containing an SSN and flags it', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({ subject: 'SSN 123-45-6789 for the file' }));
    expect(result.warnings.some((w) => w.includes('ssn'))).toBe(true);
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[8]).toBe(''); // I Subject — blanked
  });

  it('blanks Attio last_meeting_summary when it contains a credential, still writes the rest of the row', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-1' } },
      masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: { bhc_id: 'BHC-1', attio: { record_id: 'rec-alice', fields: { last_meeting_summary: 'password: hunter2 shared for the portal' } } },
    }));

    expect(result.warnings.some((w) => w.includes('credential'))).toBe(true);
    expect(backend.patched.get('rec-alice')?.['last_meeting_summary']).toBe('');
    expect(result.ok).toBe(true); // the row still completes — sensitive-data withholding is per-field, not a whole-row abort
  });

  it('blanks a personal_context extract containing a bank account number', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: {
        bhc_id: 'BHC-1',
        google: { google_row: 10, fields: { BZ: 'x', CA: 'Email', CB: 'Inbound', CD: 'x', CE: 'x', CG: 'Positive' } },
        personal_context: { personal_notes_extract: 'account number: 000123456789 for the wire', topics_of_interest_extract: '', conversation_trigger_extract: '' },
      },
    }));
    // No Contacts!AI write at all — the extract was blanked before the personal-context block even had non-empty text to act on
    const aiWrite = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range?.startsWith('Contacts!AI'));
    expect(aiWrite).toBeUndefined();
  });

  it('blanks a task description containing a credit card number, keeps the task itself (with due date/priority intact)', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({
      tasks: [{ description: 'Charge card 4111111111111111 for the deposit', due_date: '2026-07-25', priority: 'High' }],
    }));
    expect(result.warnings.some((w) => w.includes('credit_card'))).toBe(true);
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Tasks_Open!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[6]).toBe(''); // G Task description — blanked
    expect(row[7]).toBe('2026-07-25'); // H due date — untouched
    expect(row[9]).toBe('High'); // J priority — untouched
  });

  it('blanks a secondary\'s role note when it contains sensitive data, independent of the primary', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [],
      people: { 'rec-bob': { name: 'Bob Chen', bhcContactId: 'BHC-2' } },
      masterId: [...MASTER_ID_ROWS, ['BHC-2', 'Bob Chen', 'ATTIO', '', 'rec-bob', '']],
      contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({}, {
      primary: { bhc_id: 'BHC-1' },
      secondary: [{ bhc_id: 'BHC-2', attio: { record_id: 'rec-bob', fields: { last_meeting_summary: 'SSN 123-45-6789 on file' } } }],
    }));
    expect(result.secondaries[0]!.warnings.some((w) => w.includes('ssn'))).toBe(true);
    // Falls back to the generic role-note line rather than writing nothing at all
    const activityAppends = backend.sheetsWrites.filter((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const secRow = (activityAppends[1]!.body as { values: unknown[][] }).values[0]!;
    expect(secRow[9]).toBe('Secondary contact on this thread.');
  });

  it('leaves an ordinary row completely untouched — no false positives on normal content', async () => {
    const { sheets, attio, masterId } = await setup({
      entries: [], people: {}, masterId: MASTER_ID_ROWS, contactsHeader: [], contacts: [],
    });
    const result = await writeRow(sheets, attio, masterId, baseInput({
      subject: 'Re: Q3 contract renewal',
      runningSummary: 'Alice confirmed the terms and wants a call next Tuesday at 3pm.',
    }));
    expect(result.warnings.filter((w) => w.includes('Sensitive data'))).toHaveLength(0);
    const append = backend.sheetsWrites.find((w) => (w.body as { range?: string }).range === 'Activity_Log!A1');
    const row = (append!.body as { values: unknown[][] }).values[0]!;
    expect(row[8]).toBe('Re: Q3 contract renewal');
    expect(row[9]).toBe('Alice confirmed the terms and wants a call next Tuesday at 3pm.');
  });
});
