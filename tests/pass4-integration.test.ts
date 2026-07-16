/**
 * End-to-end PASS 4 against a fake Attio + Sheets backend.
 *
 * The unit tests prove the math. These prove the behaviour that the math can't:
 * that dry-run writes nothing, that withheld contacts are never PATCHed, and
 * that a lying read-back is caught.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttioClient } from '../src/lib/attio.js';
import { SheetsClient } from '../src/lib/sheets.js';
import { silentLogger } from '../src/lib/logger.js';
import { runPass4 } from '../src/passes/pass4/index.js';
import { buildSlackAddendum } from '../src/passes/pass4/report.js';
import type { CivilDate } from '../src/lib/dates.js';
import { FakeBackend, type FakeBackendConfig } from './helpers/fake-backend.js';

const TODAY = '2026-07-15' as CivilDate;

const CONTACTS_HEADER = [
  'Contact_ID', 'First_Name', 'Last_Name', 'D', 'LinkedIn_URL', 'Primary_Email',
  'G', 'Company', 'Title', 'J', 'Location', 'L', 'M', 'N', 'O', 'P', 'Q', 'R',
  'S', 'T', 'U', 'Relationship_Tier',
];

function contactRow(bhcId: string, tier: string): unknown[] {
  const row = new Array<unknown>(22).fill('');
  row[0] = bhcId;
  row[21] = tier;
  return row;
}

const BASE_CONFIG: FakeBackendConfig = {
  entries: [
    { recordId: 'rec-alice', tnbStage: 'Stage 2 – Proposal Sent' },
    { recordId: 'rec-bob' }, // tier-based
    { recordId: 'rec-mallory', tnbStage: 'Stage 1 – Intro' }, // name mismatch
    { recordId: 'rec-carol', fteStage: 'Stage 4 – Negotiation' }, // stalled
  ],
  people: {
    'rec-alice': { name: 'Alice Nguyen', bhcContactId: 'BHC-00001', lastInteraction: '2026-07-13' },
    'rec-bob': { name: 'Bob Ellis', bhcContactId: 'BHC-00002', lastInteraction: '2026-07-01' },
    'rec-mallory': { name: 'Kwame Koka', bhcContactId: 'BHC-00003', lastInteraction: '2026-07-14' },
    'rec-carol': { name: 'Carol Diaz', bhcContactId: 'BHC-00004', lastInteraction: '2026-05-01' },
  },
  masterId: [
    ['BHC-00001', 'Alice Nguyen', 'BOTH', 365, 'rec-alice', ''],
    ['BHC-00002', 'Bob Ellis', 'BOTH', 366, 'rec-bob', ''],
    ['BHC-00003', 'Bo Bishop', 'BOTH', 367, 'rec-mallory', ''], // pointer drift
    ['BHC-00004', 'Carol Diaz', 'ATTIO', '', 'rec-carol', ''],
  ],
  contactsHeader: CONTACTS_HEADER,
  contacts: [
    contactRow('BHC-00001', 'Core'),
    contactRow('BHC-00002', 'Peripheral'),
    contactRow('BHC-00003', 'Core'),
    contactRow('BHC-00004', 'Strategic'),
  ],
};

function cloneConfig(overrides: Partial<FakeBackendConfig> = {}): FakeBackendConfig {
  return {
    ...structuredClone(BASE_CONFIG),
    ...overrides,
  };
}

let backend: FakeBackend;
let attio: AttioClient;
let sheets: SheetsClient;

async function boot(config: FakeBackendConfig): Promise<void> {
  backend = new FakeBackend(config);
  const { attioBase, sheetsUrl } = await backend.start();
  attio = new AttioClient({ apiKey: 'test-key', baseUrl: attioBase });
  sheets = new SheetsClient({ token: 'test-token', url: sheetsUrl });
}

afterEach(async () => {
  await backend?.stop();
});

describe('PASS 4 — dry run', () => {
  beforeEach(async () => {
    await boot(cloneConfig());
  });

  it('issues no mutating request whatsoever', async () => {
    const report = await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: true,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    expect(backend.mutatingRequests).toEqual([]);
    expect(backend.patched.size).toBe(0);
    expect(backend.sheetsWrites).toEqual([]);
    expect(report.counts.written).toBe(0);
    expect(report.writes.filter((w) => w.outcome === 'SKIPPED_DRY_RUN')).toHaveLength(3);
  });

  it('computes the same cadence it would have written', async () => {
    const report = await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: true,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    const alice = report.rows.find((r) => r.bhcId === 'BHC-00001')!;
    expect(alice.activeTrack).toBe('TNB');
    expect(alice.cadenceDays).toBe(6);
    expect(alice.nextCheckIn).toBe('2026-07-19');
    expect(alice.touchMode).toBe('Context');
    expect(alice.withheld).toBeNull();

    // Bob has no stage → tier-based. Peripheral = 180d from 2026-07-01.
    const bob = report.rows.find((r) => r.bhcId === 'BHC-00002')!;
    expect(bob.cadenceDays).toBe(180);
    expect(bob.nextCheckIn).toBe('2026-12-28');
    expect(bob.followUpReason).toBe('Tier Peripheral — no active stage');

    // Carol: FTE Stage 4 → 4d, last touch 2026-05-01 (75d) → overdue + stalled.
    const carol = report.rows.find((r) => r.bhcId === 'BHC-00004')!;
    expect(carol.stalled).toBe(true);
    expect(carol.daysSince).toBe(75);
    expect(carol.overdueCatchUp).toBe(true);
    expect(carol.nextCheckIn).toBe('2026-07-17'); // today + floor(4/2)
    expect(carol.followUpReason).toBe('FTE Stage 4 ⚠ STALLED — 75d since last touch (expected every 4d)');
  });

  it('withholds the drifted pointer and reports it', async () => {
    const report = await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: true,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    const mallory = report.rows.find((r) => r.recordId === 'rec-mallory')!;
    expect(mallory.withheld).toBe('NAME_MISMATCH');
    expect(report.counts.withheld).toBe(1);
    expect(report.counts.eligible).toBe(3);
    expect(buildSlackAddendum(report)).toMatch(/withheld — identity check failed/);
  });
});

describe('PASS 4 — live run', () => {
  it('writes cadence only for cleared contacts, never for withheld ones', async () => {
    await boot(cloneConfig());
    const report = await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: false,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    expect(report.counts.written).toBe(3);
    expect(report.counts.failed).toBe(0);
    expect([...backend.patched.keys()].sort()).toEqual(['rec-alice', 'rec-bob', 'rec-carol']);
    expect(backend.patched.has('rec-mallory')).toBe(false);

    expect(backend.patched.get('rec-alice')).toEqual({
      next_check_in_date: '2026-07-19',
      next_touch_mode_planned: 'Context',
      follow_up_reason: 'TNB Stage 2',
    });
  });

  it('writes exactly the three cadence attributes and nothing else', async () => {
    await boot(cloneConfig());
    await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: false,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    for (const values of backend.patched.values()) {
      expect(Object.keys(values).sort()).toEqual([
        'follow_up_reason',
        'next_check_in_date',
        'next_touch_mode_planned',
      ]);
    }
  });

  it('never writes to Google Sheets (Non-negotiable #12)', async () => {
    await boot(cloneConfig());
    await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: false,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });
    expect(backend.sheetsWrites).toEqual([]);
  });

  it('catches a read-back that disagrees with what was sent', async () => {
    const config = cloneConfig();
    config.people['rec-alice']!.readBackOverride = '1999-01-01';
    await boot(config);

    const report = await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: false,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    expect(report.counts.verifiedMismatch).toBe(1);
    expect(report.counts.written).toBe(2);
    const alice = report.writes.find((w) => w.recordId === 'rec-alice')!;
    expect(alice.outcome).toBe('VERIFIED_MISMATCH');
    expect(alice.readBack).toBe('1999-01-01');
  });

  it('continues past a single failing contact rather than aborting the pass', async () => {
    const config = cloneConfig();
    config.people['rec-bob']!.failWith = 500;
    await boot(config);

    const report = await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: false,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    // Bob's fetch fails → withheld as FETCH_FAILED; the others still write.
    expect(report.counts.written).toBe(2);
    const bob = report.rows.find((r) => r.recordId === 'rec-bob')!;
    expect(bob.withheld).toBe('FETCH_FAILED');
    expect(backend.patched.has('rec-alice')).toBe(true);
  });
});

describe('PASS 4 — pagination', () => {
  it('walks every page of the pipeline list', async () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({
      recordId: `rec-${i}`,
      tnbStage: 'Stage 1 – Intro',
    }));
    const people: FakeBackendConfig['people'] = {};
    const masterId: unknown[][] = [];
    const contacts: unknown[][] = [];
    for (let i = 0; i < 120; i++) {
      people[`rec-${i}`] = { name: `Person ${i}`, bhcContactId: `BHC-${i}`, lastInteraction: '2026-07-14' };
      masterId.push([`BHC-${i}`, `Person ${i}`, 'ATTIO', '', `rec-${i}`, '']);
      contacts.push(contactRow(`BHC-${i}`, 'Core'));
    }
    await boot({ entries, people, masterId, contactsHeader: CONTACTS_HEADER, contacts });

    const report = await runPass4({
      runId: 'LATE-EDITION-test',
      dryRun: true,
      timezone: 'America/Los_Angeles',
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
      limit: 5, // keep the fetch phase to one batch; pagination already happened
    });

    expect(report.pipelineEntryCount).toBe(5);
    const queries = backend.requests.filter((r) => r.path.endsWith('/entries/query'));
    expect(queries).toHaveLength(3); // 50 + 50 + 20
  });
});
