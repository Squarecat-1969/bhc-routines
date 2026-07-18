import { describe, expect, it } from 'vitest';

import { AttioClient } from '../../src/lib/attio.js';
import { loadMasterId } from '../../src/passes/pass4/load.js';
import { checkDrift, resolveContact } from '../../src/passes/pass2/resolve.js';
import type { ContactsEmailMap } from '../../src/passes/pass2/contacts-email-map.js';
import { FakeBackend, type FakeBackendConfig } from '../helpers/fake-backend.js';

const MINIMAL: FakeBackendConfig = {
  entries: [],
  people: {},
  masterId: [],
  contactsHeader: [],
  contacts: [],
};

function emptyContactsMap(): ContactsEmailMap {
  return { byEmail: new Map(), contactIdByGoogleRow: new Map(), personalContextByGoogleRow: new Map() };
}

describe('resolveContact — cascade step 1: Contacts email map', () => {
  it('resolves via Contacts when the email is mapped, without touching Attio', async () => {
    const contactsMap: ContactsEmailMap = {
      byEmail: new Map([['alice@x.com', { bhcId: 'BHC-00001', googleRow: 10 }]]),
      contactIdByGoogleRow: new Map(),
      personalContextByGoogleRow: new Map(),
    };
    const backend = new FakeBackend({ ...MINIMAL, masterId: [['BHC-00001', 'Alice Nguyen', 'BOTH', 10, 'rec-alice', '']] });
    const { attioBase, sheetsUrl } = await backend.start();
    const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
    const { SheetsClient } = await import('../../src/lib/sheets.js');
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const masterIndex = await loadMasterId(sheets);

    const resolved = await resolveContact('ALICE@X.COM', { contactsMap, masterIndex, attio });
    await backend.stop();

    expect(resolved.source).toBe('CONTACTS');
    expect(resolved.bhcId).toBe('BHC-00001');
    expect(resolved.googleRow).toBe(10);
    expect(resolved.attioRecordId).toBe('rec-alice'); // cross-referenced from Master_ID
    expect(resolved.location).toBe('BOTH');
  });
});

describe('resolveContact — cascade step 2/3: Attio miss then Master_ID cross-reference', () => {
  it('resolves via Attio search + Master_ID when Contacts has no match', async () => {
    const backend = new FakeBackend({
      ...MINIMAL,
      masterId: [['BHC-00002', 'Bob Ellis', 'ATTIO', '', 'rec-bob', '']],
      emailSearchResults: { 'bob@x.com': [{ bhcContactId: 'BHC-00002', name: 'Bob Ellis' }] },
    });
    const { attioBase, sheetsUrl } = await backend.start();
    const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
    const { SheetsClient } = await import('../../src/lib/sheets.js');
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const masterIndex = await loadMasterId(sheets);

    const resolved = await resolveContact('bob@x.com', { contactsMap: emptyContactsMap(), masterIndex, attio });
    await backend.stop();

    expect(resolved.source).toBe('ATTIO');
    expect(resolved.bhcId).toBe('BHC-00002');
    expect(resolved.location).toBe('ATTIO');
  });

  it('returns NEW_CANDIDATE (never fabricates a BHC_ID) when nothing matches anywhere', async () => {
    const backend = new FakeBackend({ ...MINIMAL, masterId: [] });
    const { attioBase, sheetsUrl } = await backend.start();
    const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
    const { SheetsClient } = await import('../../src/lib/sheets.js');
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const masterIndex = await loadMasterId(sheets);

    const resolved = await resolveContact('nobody@x.com', { contactsMap: emptyContactsMap(), masterIndex, attio });
    await backend.stop();

    expect(resolved.source).toBe('NEW_CANDIDATE');
    expect(resolved.bhcId).toBeNull();
  });

  it('returns UNRESOLVED (not NEW_CANDIDATE) for an ambiguous Attio match', async () => {
    const backend = new FakeBackend({
      ...MINIMAL,
      masterId: [],
      emailSearchResults: {
        'shared@x.com': [
          { bhcContactId: 'BHC-1', name: 'One' },
          { bhcContactId: 'BHC-2', name: 'Two' },
        ],
      },
    });
    const { attioBase, sheetsUrl } = await backend.start();
    const attio = new AttioClient({ apiKey: 'test', baseUrl: attioBase });
    const { SheetsClient } = await import('../../src/lib/sheets.js');
    const sheets = new SheetsClient({ token: 'test', url: sheetsUrl });
    const masterIndex = await loadMasterId(sheets);

    const resolved = await resolveContact('shared@x.com', { contactsMap: emptyContactsMap(), masterIndex, attio });
    await backend.stop();

    expect(resolved.source).toBe('UNRESOLVED');
  });
});

describe('checkDrift', () => {
  it('is clean when Google col A matches and Attio bhc_contact_id matches', () => {
    const result = checkDrift({
      resolved: { email: 'a@x.com', source: 'CONTACTS', bhcId: 'BHC-1', googleRow: 5, attioRecordId: 'rec-1', location: 'BOTH' },
      contactsColAAtGoogleRow: 'BHC-1',
      attioRecordValues: { bhc_contact_id: [{ value: 'BHC-1' }] },
    });
    expect(result.clean).toBe(true);
    expect(result.tags).toEqual([]);
  });

  it('flags drift:google-row-mismatch when Contacts col A disagrees', () => {
    const result = checkDrift({
      resolved: { email: 'a@x.com', source: 'CONTACTS', bhcId: 'BHC-1', googleRow: 5, attioRecordId: null, location: 'GOOGLE' },
      contactsColAAtGoogleRow: 'BHC-999',
      attioRecordValues: null,
    });
    expect(result.clean).toBe(false);
    expect(result.tags).toContain('drift:google-row-mismatch');
  });

  it('flags drift:attio-id-mismatch when the Attio record disagrees', () => {
    const result = checkDrift({
      resolved: { email: 'a@x.com', source: 'ATTIO', bhcId: 'BHC-1', googleRow: null, attioRecordId: 'rec-1', location: 'ATTIO' },
      contactsColAAtGoogleRow: null,
      attioRecordValues: { bhc_contact_id: [{ value: 'BHC-999' }] },
    });
    expect(result.clean).toBe(false);
    expect(result.tags).toContain('drift:attio-id-mismatch');
  });

  it('never drift-checks an unresolved/new-candidate contact (nothing to check)', () => {
    const result = checkDrift({
      resolved: { email: 'a@x.com', source: 'NEW_CANDIDATE', bhcId: null, googleRow: null, attioRecordId: null, location: null },
      contactsColAAtGoogleRow: null,
      attioRecordValues: null,
    });
    expect(result.clean).toBe(true);
  });

  it('only checks the Google side for a GOOGLE-location contact, ignoring a null Attio record', () => {
    const result = checkDrift({
      resolved: { email: 'a@x.com', source: 'CONTACTS', bhcId: 'BHC-1', googleRow: 5, attioRecordId: null, location: 'GOOGLE' },
      contactsColAAtGoogleRow: 'BHC-1',
      attioRecordValues: null,
    });
    expect(result.clean).toBe(true);
  });
});
