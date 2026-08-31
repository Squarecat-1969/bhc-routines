/**
 * THE FRESHNESS GUARD — Fix must not repair from a stale audit.
 *
 * The workflow_run arm runs LIVE unconditionally, deliberately. But it assumes
 * the Reconciler that triggered it WROTE Reconciler_Report. A DRY Reconciler
 * writes nothing at all, so the tab still holds whatever the last LIVE run
 * left; Fix then chains live and repairs from it. Observed 2026-08-30: a dry
 * Reconciler chained into a live Fix which quoted a ten-hour-old audit as
 * current.
 *
 * The sheet cannot tell a dry run from a live one — a dry run leaves no marker
 * of any kind — so this is a STALENESS test against col B (Checked_At), not a
 * dry-run test.
 */

import { describe, expect, it } from 'vitest';

import { STALE_GRACE_MS, runReconcilerFix } from '../../src/passes/reconciler-fix/index.js';
import type { Logger } from '../../src/passes/reconciler-fix/ports.js';

const silent: Logger = { info: () => {}, warn: () => {} };

const TRIGGERED_AT = '2026-08-30T23:36:00.000Z';
const TRIGGER_MS = Date.parse(TRIGGERED_AT);

/** One A3 row — the cheapest real candidate — stamped with the given Checked_At. */
function reportRow(checkedAt: string, runId = 'RECON-1788096872496'): unknown[] {
  return [runId, checkedAt, 'BHC-2', 'Bo Geddes', '3', '', 'rec-dead', 'BOTH', 'A3', '', '', '', '', ''];
}

const MASTER = [['BHC-2', 'Bo Geddes', 'BOTH', '101', 'rec-dead', '']];

function fakes(report: unknown[][]) {
  const writes: string[] = [];
  const sheets = {
    async read(range: string) {
      if (range.startsWith('Reconciler_Report')) return report;
      if (range.startsWith('Master_ID!A2')) return MASTER;
      const m = /Master_ID!([A-F])(\d+)/.exec(range);
      if (m) return [[m[1] === 'A' ? (MASTER[Number(m[2]) - 2]?.[0] ?? '') : '']];
      return [];
    },
    async update(range: string) { writes.push(range); },
    async batchUpdate(data: { range: string }[]) {
      data.forEach((d) => writes.push(d.range));
      return { totalUpdatedCells: data.length, fieldsPresent: true, rangesRequested: data.length };
    },
  };
  const attio = {
    async getPersonRecord() { throw new Error('404 not found'); },
    async queryPeople() { return []; },
    async updatePersonRecord() { writes.push('ATTIO'); },
  };
  return { sheets, attio, writes };
}

async function run(report: unknown[][], triggeredAt?: string) {
  const f = fakes(report);
  const posted: string[] = [];
  const r = await runReconcilerFix({
    sheets: f.sheets as never, attio: f.attio as never, logger: silent,
    dryRun: false, fixRunId: 'RECON-FIX-TEST',
    slack: { post: async (t: string) => { posted.push(t); } },
    ...(triggeredAt !== undefined ? { triggeredAt } : {}),
  });
  return { report: r, posted, writes: f.writes };
}

describe('a STALE report is refused before any repair pass runs', () => {
  // Ten hours before the trigger — the observed 2026-08-30 gap.
  const STALE = new Date(TRIGGER_MS - 10 * 3600_000 - 2 * 60_000).toISOString();

  it('refuses, names both timestamps and the age, and writes nothing', async () => {
    const { report, writes } = await run([reportRow(STALE)], TRIGGERED_AT);

    expect(report.staleRefusal).not.toBeNull();
    expect(report.staleRefusal!).toContain('REFUSED');
    expect(report.staleRefusal!).toContain('STALE');
    expect(report.staleRefusal!).toContain(STALE);          // when the report was written
    expect(report.staleRefusal!).toContain(TRIGGERED_AT);   // when this run was triggered
    expect(report.staleRefusal!).toContain('10h 02m');      // the age, in words
    expect(report.staleRefusal!).toContain('RECON-1788096872496'); // the source audit

    // Nothing ran and nothing was written.
    expect(writes).toEqual([]);
    expect(report.candidates).toEqual({ S1: 0, A1: 0, A3: 0, S4: 0, I1: 0 });
    expect(report.a3.counts.considered).toBe(0);
  });

  it('posts the refusal to Slack — an operator should not need the artifact', async () => {
    const { posted } = await run([reportRow(STALE)], TRIGGERED_AT);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('REFUSED');
  });

  it('refuses when rows are present but Checked_At cannot be parsed', async () => {
    // writeReport always writes one, so this is an anomaly — and freshness
    // cannot be established on a pass that writes Attio and Master_ID.
    const { report, writes } = await run([reportRow('not-a-date')], TRIGGERED_AT);
    expect(report.staleRefusal!).toContain('cannot be dated');
    expect(writes).toEqual([]);
  });
});

describe('a FRESH report proceeds — a valid chain must be untouched', () => {
  it('proceeds when Checked_At is after the trigger', async () => {
    const fresh = new Date(TRIGGER_MS + 90_000).toISOString();
    const { report } = await run([reportRow(fresh)], TRIGGERED_AT);
    expect(report.staleRefusal).toBeNull();
    expect(report.candidates.A3).toBe(1); // the pass actually ran
  });

  it('proceeds inside the grace, since created_at precedes the Reconciler starting', async () => {
    // checkout + npm ci sit between workflow_run.created_at and the pass's own
    // startedAt. A zero grace would refuse valid chains.
    const withinGrace = new Date(TRIGGER_MS - (STALE_GRACE_MS - 30_000)).toISOString();
    const { report } = await run([reportRow(withinGrace)], TRIGGERED_AT);
    expect(report.staleRefusal).toBeNull();
    expect(report.candidates.A3).toBe(1);
  });
});

describe('the guard is inert without the flag', () => {
  it('a decade-old report still proceeds when --triggered-at is unset', async () => {
    // Dispatch and local runs pass nothing. A human running this by hand gets
    // exactly today's behaviour and no new failure mode.
    const ancient = '2016-01-01T00:00:00.000Z';
    const { report } = await run([reportRow(ancient)]);
    expect(report.staleRefusal).toBeNull();
    expect(report.candidates.A3).toBe(1);
  });

  it('does not refuse on a malformed --triggered-at — a workflow typo must not disable the routine', async () => {
    const { report } = await run([reportRow('2016-01-01T00:00:00.000Z')], 'not-a-timestamp');
    expect(report.staleRefusal).toBeNull();
    expect(report.warnings.join('\n')).toContain('freshness guard SKIPPED');
  });
});

describe('an EMPTY report proceeds — decided, not incidental', () => {
  // A live Reconciler with zero findings writes no rows, and writeReport blanks
  // any prior rows over the same span, so an empty tab is positive evidence of
  // a CLEAN live audit rather than the absence of one. Refusing here would
  // break the healthy case permanently — worse than the bug being fixed — and
  // there is nothing to repair anyway.
  it('does not refuse when the tab is empty, even with a trigger time set', async () => {
    const { report, writes } = await run([], TRIGGERED_AT);
    expect(report.staleRefusal).toBeNull();
    expect(report.sourceRunId).toBeNull();
    expect(report.candidates).toEqual({ S1: 0, A1: 0, A3: 0, S4: 0, I1: 0 });
    expect(writes).toEqual([]); // a no-op, not a refusal
  });

  it('does not refuse on rows that are entirely blank', async () => {
    const { report } = await run([['', '', '', '', '', '', '', '', '', '', '', '', '', '']], TRIGGERED_AT);
    expect(report.staleRefusal).toBeNull();
  });
});
