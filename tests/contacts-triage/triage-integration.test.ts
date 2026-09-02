/**
 * End-to-end orchestration over real HTTP against the fake Attio + Sheets
 * backend. Covers the properties that only show up when the whole run is
 * wired together: the dry-run guarantee, enumeration cross-checking, the
 * exclusion pipeline, the two-tab write, and the read-back.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  QUEUE_COLS,
  QUEUE_COLUMNS,
  QUEUE_HEADER,
  QUEUE_LAST_COLUMN,
  EXCLUSIONS_COLS,
  columnLetter,
} from '../../src/config/triage-constants.js';
import { AnthropicClient } from '../../src/lib/anthropic.js';
import { AttioClient } from '../../src/lib/attio.js';
import type { CivilDate } from '../../src/lib/dates.js';
import { silentLogger } from '../../src/lib/logger.js';
import { SheetsClient } from '../../src/lib/sheets.js';
import { runContactsTriage } from '../../src/passes/contacts-triage/index.js';
import { FakeAnthropicBackend } from '../helpers/fake-anthropic.js';
import { FakeBackend, type FakeBackendConfig, type FakePerson } from '../helpers/fake-backend.js';

const TODAY = '2026-08-08' as CivilDate;

const backends: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.stop()));
});

/** A Very strong, long-span, named contact — a clear keeper. */
function keeperPerson(email: string, name: string): FakePerson {
  return {
    name,
    emailAddresses: [email],
    linkedin: 'https://linkedin.com/in/x',
    createdAt: '2024-01-01T00:00:00Z',
    strengthLegacy: 60,
    strengthLabel: 'Very strong',
    firstInteractionAt: '2024-06-01T00:00:00Z',
    lastInteractionAt: '2026-07-01T00:00:00Z',
    lastInteractionSubject: 'Q1 campaign brief',
  };
}

async function setup(config: Partial<FakeBackendConfig> & { people: Record<string, FakePerson> }) {
  const backend = new FakeBackend({
    entries: [],
    masterId: [],
    contactsHeader: [],
    contacts: [],
    triageQueue: [],
    triageExclusions: [],
    ...config,
  });
  const { attioBase, sheetsUrl } = await backend.start();
  backends.push(backend);

  const attio = new AttioClient({ apiKey: 'k', baseUrl: attioBase, onRetry: () => {} });
  const sheets = new SheetsClient({ token: 't', url: sheetsUrl, onRetry: () => {} });

  return { backend, attio, sheets };
}

describe('Contacts Triage — the dry-run guarantee', () => {
  it('issues ZERO mutating requests in dry run', async () => {
    const { backend, attio, sheets } = await setup({
      people: {
        'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'rec-blast': { name: 'Blast Victim', emailAddresses: ['x@random.com'], createdAt: '2026-07-22T14:00:30Z' },
      },
    });

    const report = await runContactsTriage({
      dryRun: true,
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    expect(report.aborted).toBe(false);
    expect(backend.sheetsWrites).toHaveLength(0);
    expect(backend.mutatingRequests).toHaveLength(0);
    expect(report.queueRowsWritten).toBe(0);
    expect(report.exclusionsAppended).toBe(0);
    expect(report.readBackVerified).toBeNull();
  });

  it('still computes the full band distribution — the whole point of the dry run', async () => {
    const { attio, sheets } = await setup({
      people: {
        'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'rec-junk': {
          name: '',
          emailAddresses: ['a7f39c2b8e4d1f06@shop.io'],
          createdAt: '2026-05-01T00:00:00Z',
          strengthLegacy: 1.2,
          strengthLabel: 'Very weak',
          lastInteractionSubject: 'Your order has shipped',
        },
      },
    });

    const report = await runContactsTriage({
      dryRun: true,
      attio,
      sheets,
      logger: silentLogger,
      today: TODAY,
    });

    expect(report.scored).toHaveLength(2);
    const total =
      report.deterministicDistribution.keepers +
      report.deterministicDistribution.unclear +
      report.deterministicDistribution.junk;
    expect(total).toBe(2);
    expect(report.deterministicDistribution.buckets.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('STEP 1 — enumeration', () => {
  it('splits bridged from unbridged and passes the cross-check', async () => {
    const { attio, sheets } = await setup({
      people: {
        'rec-1': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'rec-2': { name: 'Already Minted', bhcContactId: 'BHC-0001', emailAddresses: ['minted@dcsg.com'] },
      },
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.totalPeople).toBe(2);
    expect(report.bridgedCount).toBe(1);
    expect(report.unbridgedCount).toBe(1);
    expect(report.enumerationCrossCheck).toBe('passed');
  });

  it('paginates past the page size without losing anyone', async () => {
    const people: Record<string, FakePerson> = {};
    for (let i = 0; i < 25; i++) people[`rec-${i}`] = keeperPerson(`p${i}@dcsg.com`, `Person ${i}`);

    const { attio, sheets } = await setup({ people, peoplePageSize: 10 });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.totalPeople).toBe(25);
    expect(report.unbridgedCount).toBe(25);
  });

  it('degrades to a loud warning — not a stop — when the cross-check query is unsupported', async () => {
    const { attio, sheets } = await setup({
      people: { 'rec-1': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      crossCheckFailWith: 400,
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(false);
    expect(report.enumerationCrossCheck).toBe('unavailable');
    expect(report.warnings.join(' ')).toContain('cross-check could not be run');
  });

  it('stops the run when the enumeration itself fails — a silent under-enumeration is worse than no run', async () => {
    const { attio, sheets } = await setup({
      people: { 'rec-1': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      peopleQueryFailWith: 500,
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });
    expect(report.aborted).toBe(true);
  }, 20_000);
});

describe('STEP 2 — exclusions', () => {
  it('excludes the compromise cohort as recoverable and never scores it', async () => {
    const people: Record<string, FakePerson> = { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') };
    for (let i = 0; i < 170; i++) {
      people[`blast-${i}`] = {
        name: `Blast ${i}`,
        emailAddresses: [`b${i}@random${i}.com`],
        createdAt: new Date(Date.parse('2026-07-22T14:00:00Z') + i * 500).toISOString(),
      };
    }

    const { attio, sheets } = await setup({ people });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.excludedByReason['2026-07-22 compromise blast']).toBe(170);
    expect(report.compromiseCohortInRange).toBe(true);
    expect(report.scored).toHaveLength(1);
    expect(report.exclusions.every((e) => (e.reason === '2026-07-22 compromise blast' ? e.recoverable : true))).toBe(true);
  });

  it('says so loudly when the cohort does not land near 170', async () => {
    const { attio, sheets } = await setup({
      people: {
        'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'blast-1': { name: 'One', emailAddresses: ['b@x.com'], createdAt: '2026-07-22T14:00:10Z' },
      },
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.compromiseCohortCount).toBe(1);
    expect(report.compromiseCohortInRange).toBe(false);
    expect(report.warnings.join(' ')).toContain('COMPROMISE COHORT DRIFT');
  });

  it('makes no per-contact Attio request at all — everything arrives with the walk', async () => {
    const { backend, attio, sheets } = await setup({
      people: {
        'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'rec-role': { name: 'Orders', emailAddresses: ['orders@shop.com'], createdAt: '2026-01-01T00:00:00Z' },
      },
    });

    await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    // Consuming Attio's computed conclusion instead of raw message metadata is
    // what removes the per-contact fetch — the cost of a run no longer scales
    // with the number of candidates.
    const perRecordGets = backend.requests.filter(
      (r) => r.method === 'GET' && /^\/objects\/people\/records\/[^/]+$/.test(r.path),
    );
    expect(perRecordGets).toHaveLength(0);
  });

  it('skips anything already in Contact_Exclusions', async () => {
    const { attio, sheets } = await setup({
      people: { 'rec-1': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageExclusions: [['rec-1', 'Jane Doe', 'jane@dcsg.com', 'bobby archived', '2026-06-01', 'FALSE', 'bobby']],
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.alreadyExcludedSkipped).toBe(1);
    expect(report.scored).toHaveLength(0);
  });
});

describe('STEP 4 — the LLM gate', () => {
  it('calls for contacts with readable evidence and applies the clamp', async () => {
    const fakeLlm = new FakeAnthropicBackend({ responseText: '{"score": 100, "reason": "Real client relationship."}' });
    const { baseUrl } = await fakeLlm.start();
    backends.push(fakeLlm);

    const { attio, sheets } = await setup({
      people: {
        // Mid-band: one outbound email, named, company domain.
        'rec-mid': {
          name: 'Mid Band',
          emailAddresses: ['mid@acme.com'],
          createdAt: '2026-01-01T00:00:00Z',
          strengthLegacy: 20,
          strengthLabel: 'Good',
          firstInteractionAt: '2026-01-01T00:00:00Z',
          lastInteractionAt: '2026-03-01T00:00:00Z',
          // Readable evidence is what gates the call now, not band position.
          lastMeetingSummary: 'Discussed a possible Q2 engagement.',
        },
      },
    });

    const anthropic = new AnthropicClient({ apiKey: 'k', baseUrl });
    const report = await runContactsTriage({
      dryRun: true,
      attio,
      sheets,
      anthropic,
      logger: silentLogger,
      today: TODAY,
    });

    expect(report.llmEligible).toBe(1);
    expect(report.llmCallsMade).toBe(1);
    expect(report.clampEvents).toBe(1);

    const scored = report.scored[0]!;
    expect(scored.scoreSource).toBe('llm');
    expect(scored.llm?.rawScore).toBe(100);
    expect(scored.finalScore).toBe(scored.deterministic.score + 30);
    // Violent disagreement surfaces as an Unclear card, not a confident verdict.
    expect(scored.column).toBe('unclear');
    expect(scored.reason).toContain('clamped from 100');
  });

  it('keeps the deterministic score and flags the fallback when the call fails', async () => {
    const fakeLlm = new FakeAnthropicBackend({ responseText: '', failWith: 500 });
    const { baseUrl } = await fakeLlm.start();
    backends.push(fakeLlm);

    const { attio, sheets } = await setup({
      people: {
        'rec-mid': {
          name: 'Mid Band',
          emailAddresses: ['mid@acme.com'],
          createdAt: '2026-01-01T00:00:00Z',
          strengthLegacy: 20,
          strengthLabel: 'Good',
          firstInteractionAt: '2026-01-01T00:00:00Z',
          lastInteractionAt: '2026-03-01T00:00:00Z',
          // Readable evidence is what gates the call now, not band position.
          lastMeetingSummary: 'Discussed a possible Q2 engagement.',
        },
      },
    });

    const anthropic = new AnthropicClient({ apiKey: 'k', baseUrl, onRetry: () => {} });
    const report = await runContactsTriage({
      dryRun: true,
      attio,
      sheets,
      anthropic,
      logger: silentLogger,
      today: TODAY,
    });

    expect(report.aborted).toBe(false);
    expect(report.llmFailures).toBe(1);
    expect(report.scored[0]!.scoreSource).toBe('deterministic-fallback');
    expect(report.scored[0]!.finalScore).toBe(report.scored[0]!.deterministic.score);
  }, 20_000);

  it('does NOT call a contact with no readable evidence, whatever its score', async () => {
    const fakeLlm = new FakeAnthropicBackend({ responseText: '{"score": 90, "reason": "x"}' });
    const { baseUrl } = await fakeLlm.start();
    backends.push(fakeLlm);

    const { attio, sheets } = await setup({
      people: {
        'rec-blank': {
          name: 'No Evidence',
          emailAddresses: ['blank@acme.com'],
          createdAt: '2026-01-01T00:00:00Z',
          strengthLegacy: 20,
          strengthLabel: 'Good',
          firstInteractionAt: '2026-01-01T00:00:00Z',
          lastInteractionAt: '2026-03-01T00:00:00Z',
        },
      },
    });

    const anthropic = new AnthropicClient({ apiKey: 'k', baseUrl });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, anthropic, logger: silentLogger, today: TODAY });

    expect(report.llmBandCount).toBe(1);
    expect(report.llmEligible).toBe(0);
    expect(report.llmCallsMade).toBe(0);
    expect(fakeLlm.requests).toHaveLength(0);
  });

  it('makes no calls at all when no Anthropic client is supplied', async () => {
    const { attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
    });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });
    expect(report.llmCallsMade).toBe(0);
    expect(report.scored.every((s) => s.scoreSource === 'deterministic')).toBe(true);
  });
});

describe('STEP 5 — the live write', () => {
  it('writes the queue, appends exclusions, and verifies the read-back', async () => {
    const { backend, attio, sheets } = await setup({
      people: {
        'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'rec-role': { name: 'Orders', emailAddresses: ['orders@shop.com'], createdAt: '2026-01-01T00:00:00Z' },
      },
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(false);
    expect(report.queueRowsWritten).toBe(1);
    expect(report.readBackVerified).toBe(true);

    const written = backend.config.triageQueue!;
    expect(written).toHaveLength(1);
    expect(written[0]![QUEUE_COLS.attioRecordId]).toBe('rec-keep');
    expect(written[0]![QUEUE_COLS.status]).toBe('pending');
    expect(written[0]![QUEUE_COLS.firstSeen]).toBe(TODAY);

    const exclusions = backend.config.triageExclusions!;
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]![EXCLUSIONS_COLS.attioRecordId]).toBe('rec-role');
    expect(exclusions[0]![EXCLUSIONS_COLS.reason]).toBe('unattended role/no-reply address');
    expect(exclusions[0]![EXCLUSIONS_COLS.source]).toBe('rule');
    expect(exclusions[0]![EXCLUSIONS_COLS.recoverable]).toBe('FALSE');
  });

  it('writes a range whose width matches the row width — the 2026-08-09 live failure', async () => {
    // A live run aborted with "Requested writing within range
    // [Contacts_Triage_Queue!A2:V98], but tried writing to column [W]": the
    // columns grew from 22 to 24 but the range letter was hardcoded. Every
    // test passed because the fake accepted any width. Both ends are pinned
    // now — the range letter is derived, and the fake rejects a mismatch.
    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });
    expect(report.aborted).toBe(false);

    const dataWrite = backend.sheetsWrites.find((w) => {
      const range = (w.body as { range: string }).range;
      return range.startsWith('Contacts_Triage_Queue!A2:') && !range.endsWith('1');
    })!;
    const range = (dataWrite.body as { range: string }).range;
    expect(range).toBe(`Contacts_Triage_Queue!A2:${QUEUE_LAST_COLUMN}2`);

    const rows = (dataWrite.body as { values: unknown[][] }).values;
    for (const row of rows) expect(row).toHaveLength(QUEUE_COLUMNS);
  });

  it('derives the end column from the column count, so the two cannot drift', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(22)).toBe('V');
    expect(columnLetter(24)).toBe('X');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(QUEUE_LAST_COLUMN).toBe(columnLetter(QUEUE_COLUMNS));
    expect(QUEUE_HEADER).toHaveLength(QUEUE_COLUMNS);
  });

  it('WRITES to ONLY its two tabs — never Contacts, Master_ID, Activity_Log or Attio', async () => {
    // Renamed from "touches": STEP 1b READS Master_ID to find retired
    // identities. That read is the point of the step, so the guarantee this
    // test defends is about writes — which is what it always asserted.
    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
    });

    await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    for (const write of backend.sheetsWrites) {
      const range = (write.body as { range: string }).range;
      expect(range.startsWith('Contacts_Triage_Queue!') || range.startsWith('Contact_Exclusions!')).toBe(true);
    }
    // No PATCH/POST to any Attio record — this routine never writes to Attio.
    expect(backend.patched.size).toBe(0);
    expect(backend.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('does not re-append an exclusion that is already recorded', async () => {
    const { backend, attio, sheets } = await setup({
      people: { 'rec-role': { name: 'Orders', emailAddresses: ['orders@shop.com'], createdAt: '2026-01-01T00:00:00Z' } },
      triageExclusions: [['rec-role', 'Orders', 'orders@shop.com', 'unattended role/no-reply address', '2026-06-01', 'FALSE', 'rule']],
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.exclusionsAppended).toBe(0);
    expect(backend.config.triageExclusions).toHaveLength(1);
  });

  it('blanks trailing rows when the queue shrinks', async () => {
    const stale = Array.from({ length: 3 }, (_, i) => {
      const row = new Array(24).fill('');
      row[QUEUE_COLS.attioRecordId] = `old-${i}`;
      row[QUEUE_COLS.status] = 'pending';
      row[QUEUE_COLS.column] = 'unclear';
      return row;
    });

    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueue: stale,
      // All three stale rows are now excluded, so they drop out of the queue.
      triageExclusions: [0, 1, 2].map((i) => [`old-${i}`, '', '', 'bobby archived', '2026-06-01', 'FALSE', 'bobby']),
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.mergeCounts['dropped-excluded']).toBe(3);
    expect(report.queueRowsWritten).toBe(1);
    expect(report.readBackVerified).toBe(true);
    // The tab now reads back as exactly one row; the other three were blanked.
    const live = (backend.config.triageQueue ?? []).filter((r) => String(r[QUEUE_COLS.attioRecordId] ?? '') !== '');
    expect(live).toHaveLength(1);
  });

  it('preserves a decided row verbatim across a re-run', async () => {
    const decided = new Array(24).fill('');
    decided[QUEUE_COLS.attioRecordId] = 'rec-keep';
    decided[QUEUE_COLS.name] = 'Jane Doe';
    decided[QUEUE_COLS.keeperProbability] = 91;
    decided[QUEUE_COLS.column] = 'keepers';
    decided[QUEUE_COLS.status] = 'queued_keep';
    decided[QUEUE_COLS.firstSeen] = '2026-02-02';
    decided[QUEUE_COLS.reason] = 'Bobby said keep';

    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueue: [decided],
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.mergeCounts['preserved-decision']).toBe(1);
    expect(backend.config.triageQueue![0]).toEqual(decided);
  });
});

describe('tab preflight', () => {
  it('refuses to write when a tab is missing, and says how to fix it', async () => {
    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueueTabMissing: true,
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(true);
    expect(report.abortReason).toContain('Contacts_Triage_Queue');
    expect(report.abortReason).toContain(QUEUE_HEADER[0]);
    expect(backend.sheetsWrites).toHaveLength(0);
  });

  it('lets a dry run continue without the tabs — showing the distribution is the point', async () => {
    const { attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueueTabMissing: true,
      triageExclusionsTabMissing: true,
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(false);
    expect(report.scored).toHaveLength(1);
    expect(report.warnings.join(' ')).toContain('a live run would stop here');
  });

  it('refuses to write into a differently-shaped tab', async () => {
    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueueHeaderOverride: ['record_id', 'name', 'score'],
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(true);
    expect(report.abortReason).toContain('disagrees at column 1');
    expect(backend.sheetsWrites).toHaveLength(0);
  });

  it('extends a header that agrees but stops short, rather than treating it as a conflict', async () => {
    // The real Contact_Exclusions tab, found live 2026-08-08: first five
    // columns correct, `recoverable` and `source` absent.
    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueueHeaderOverride: [...QUEUE_HEADER.slice(0, 22)],
    });

    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(false);
    const headerWrite = backend.sheetsWrites.find(
      (w) => (w.body as { range: string }).range === 'Contacts_Triage_Queue!A1:X1',
    );
    expect((headerWrite!.body as { values: unknown[][] }).values[0]).toEqual([...QUEUE_HEADER]);
  });

  it('warns rather than stopping when a dry run finds a short header', async () => {
    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueueHeaderOverride: [...QUEUE_HEADER.slice(0, 22)],
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(false);
    expect(report.warnings.join(' ')).toContain('missing trailing header');
    expect(backend.sheetsWrites).toHaveLength(0);
  });

  it('writes the header row on a brand-new tab', async () => {
    const { backend, attio, sheets } = await setup({
      people: { 'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe') },
      triageQueueHeaderEmpty: true,
    });

    await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });

    const headerWrite = backend.sheetsWrites.find(
      (w) => (w.body as { range: string }).range === 'Contacts_Triage_Queue!A1:X1',
    );
    expect(headerWrite).toBeDefined();
    expect((headerWrite!.body as { values: unknown[][] }).values[0]).toEqual([...QUEUE_HEADER]);
  });
});

describe('coverage of Attio\'s computed signals', () => {
  it('scores a contact with no strength at all, flagged rather than dropped', async () => {
    const { attio, sheets } = await setup({
      people: {
        'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'rec-nostrength': {
          name: 'No Strength',
          emailAddresses: ['nostrength@acme.com'],
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(false);
    expect(report.scored).toHaveLength(2);
    expect(report.strengthMissingCount).toBe(1);
    expect(report.strengthDistribution['(empty)']).toBe(1);
    expect(report.strengthDistribution['Very strong']).toBe(1);
    expect(report.warnings.join(' ')).toContain('no connection strength');
  });

  it('reports the coverage figures the tuning pass needs', async () => {
    const { attio, sheets } = await setup({
      people: {
        'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
        'rec-noname': {
          emailAddresses: ['anon@acme.com'],
          createdAt: '2026-01-01T00:00:00Z',
          strengthLegacy: 2,
          strengthLabel: 'Very weak',
        },
      },
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.noNameCount).toBe(1);
    expect(report.blankProvenanceCount).toBe(1);
    expect(report.provenanceSourceCounts['last-interaction-subject']).toBe(1);
    expect(report.provenanceSourceCounts['none']).toBe(1);
    expect(report.llmBandCount).toBeGreaterThanOrEqual(0);
  });

  it('resolves company names from the record reference, and degrades to blank if that fails', async () => {
    const { attio, sheets } = await setup({
      people: {
        'rec-1': { ...keeperPerson('jane@dcsg.com', 'Jane Doe'), companyRecordId: 'co-1' },
      },
      companies: { 'co-1': 'Dick\'s Sporting Goods' },
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });
    expect(report.scored[0]!.contact.company).toBe('Dick\'s Sporting Goods');
  });

  it('does not fail the run when the companies query fails', async () => {
    const { attio, sheets } = await setup({
      people: { 'rec-1': { ...keeperPerson('jane@dcsg.com', 'Jane Doe'), companyRecordId: 'co-1' } },
      companiesFailWith: 500,
    });

    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });
    expect(report.aborted).toBe(false);
    expect(report.scored[0]!.contact.company).toBeNull();
    expect(report.warnings.join(' ')).toContain('company names could not be resolved');
  }, 20_000);
});

describe('STEP 1b — suppression against prior human decisions', () => {
  /**
   * The two Master_ID rows, real, read live 2026-09-01. Index 0 is sheet row 2,
   * so Raymond lands at 456 and 1585 exactly as he does in production.
   */
  function supersededMaster(): unknown[][] {
    const rows: unknown[][] = [];
    const put = (sheetRow: number, r: unknown[]) => {
      while (rows.length < sheetRow - 2) rows.push(['', '', 'ATTIO', '', '', '']);
      rows[sheetRow - 2] = r;
    };
    put(456, ['', 'Raymond Yang', 'SUPERSEDED', '', '',
      'SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact. Attio record 9878628f ' +
      'deleted by Bobby. · Location set to SUPERSEDED 2026-08-30: identity fields were cleared.']);
    put(582, ['BHC-00537', '', 'SUPERSEDED', '', '', 'Merged into BHC-01195 · 2026-08-10 · was Jenny Kim']);
    put(962, ['BHC-00920', 'Rachel Marantz', 'SUPERSEDED', '', '', 'A3-FIXED: record_id updated.']);
    put(1585, ['', 'Raymond Yang', 'SUPERSEDED', '', '',
      'SCRAPPED 2026-08-05: duplicate of BHC-01889 (Raymond Yang), TNB staff. · Location set to SUPERSEDED']);
    return rows;
  }

  /** Both of Raymond's re-created records, plus the controls. */
  const PEOPLE = {
    'rec-raymond-epic': { name: 'Raymond Yang', emailAddresses: ['raymond.yang@xa.epicgames.com'], createdAt: '2026-08-30T00:00:00Z', strengthLabel: 'Weak' as const },
    'rec-raymond-tnb': { name: 'Raymond Yang', emailAddresses: ['raymondy@thenewblank.example'], createdAt: '2026-09-01T00:00:00Z', strengthLabel: 'Good' as const },
    'rec-jenny': { name: 'Jenny Kim', emailAddresses: ['jenny@dcsg.com'], createdAt: '2026-01-01T00:00:00Z' },
    'rec-rachel': { name: 'Rachel Marantz', emailAddresses: ['rachel@dcsg.com'], createdAt: '2026-01-01T00:00:00Z' },
    'rec-keep': keeperPerson('jane@dcsg.com', 'Jane Doe'),
  };

  it('⚠ suppresses BOTH re-created Raymond Yang records and never scores them', async () => {
    const { attio, sheets } = await setup({ people: PEOPLE, masterId: supersededMaster() });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.aborted).toBe(false);
    const ids = report.suppressed.map((s) => s.attioRecordId).sort();
    expect(ids).toEqual(['rec-raymond-epic', 'rec-raymond-tnb']);

    // Never scored: everything downstream is wasted work on a settled decision.
    const scoredIds = report.scored.map((s) => s.contact.attioRecordId);
    expect(scoredIds).not.toContain('rec-raymond-epic');
    expect(scoredIds).not.toContain('rec-raymond-tnb');
  });

  it('⚠ records WHY, quoting the original annotation and naming both rows', async () => {
    const { attio, sheets } = await setup({ people: PEOPLE, masterId: supersededMaster() });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    const s = report.suppressed.find((x) => x.attioRecordId === 'rec-raymond-tnb')!;
    expect(s.source).toBe('master-id-superseded');
    expect(s.kind).toBe('SCRAPPED');
    expect(s.masterRows).toEqual([456, 1585]);
    expect(s.reason).toContain('SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact');
    expect(s.reason).not.toContain('Location set to SUPERSEDED 2026-08-30');
  });

  it('leaves the merge tombstone and the active SUPERSEDED contact alone', async () => {
    const { attio, sheets } = await setup({ people: PEOPLE, masterId: supersededMaster() });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    const suppressedIds = report.suppressed.map((s) => s.attioRecordId);
    expect(suppressedIds).not.toContain('rec-jenny');
    expect(suppressedIds).not.toContain('rec-rachel');
    expect(report.mergeTombstonesIgnored).toBe(1);
    expect(report.activeSupersededRows).toEqual([962]);
    expect(report.retiredIdentitiesIndexed).toBe(2);
  });

  it('drops a stale queue row for a record that has since become suppressed', async () => {
    // A prior run queued Raymond before suppression existed. That card must go.
    const { backend, attio, sheets } = await setup({
      people: PEOPLE,
      masterId: supersededMaster(),
      triageQueue: [['rec-raymond-tnb', 'Raymond Yang', 'raymondy@thenewblank.example', '', '70', '70', '', 'deterministic', 'FALSE', 'unclear', 'TRUE', '', '', '', '', '', '', 'stale', 'pending', '', '2026-08-31', '2026-08-31', '', 'Good']],
    });
    const report = await runContactsTriage({ dryRun: false, attio, sheets, logger: silentLogger, today: TODAY });
    expect(report.suppressed.map((s) => s.attioRecordId)).toContain('rec-raymond-tnb');

    const written = backend.sheetsWrites
      .map((w) => JSON.stringify((w.body as { values?: unknown[][] }).values ?? []))
      .join(' ');
    expect(written).not.toContain('rec-raymond-tnb');
  });

  it('warns rather than silently disabling itself when the index comes back empty', async () => {
    const { attio, sheets } = await setup({ people: PEOPLE, masterId: [] });
    const report = await runContactsTriage({ dryRun: true, attio, sheets, logger: silentLogger, today: TODAY });

    expect(report.retiredIdentitiesIndexed).toBe(0);
    expect(report.suppressed).toHaveLength(0);
    expect(report.warnings.join(' ')).toContain('SUPPRESSION INDEX IS EMPTY');
  });
});
