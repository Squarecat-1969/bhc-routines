import { describe, expect, it } from 'vitest';

import { computeMissionStatus, type PipelineEntryStages } from '../../src/passes/pass5/mission-status.js';
import type { CadenceRow } from '../../src/passes/pass4/types.js';

const TODAY = '2026-07-19' as never;

function entry(recordId: string, overrides: Partial<PipelineEntryStages> = {}): PipelineEntryStages {
  return { recordId, tnbStage: null, fractionalStage: null, fteStage: null, ...overrides };
}

function cadenceRow(recordId: string, overrides: Partial<CadenceRow> = {}): CadenceRow {
  return {
    recordId, bhcId: `BHC-${recordId}`, name: `Contact ${recordId}`, masterName: null, tier: 'Strategic',
    tierDefaulted: false, activeStageNum: 1, activeTrack: 'TNB', activeStageLabel: 'Stage 1',
    cadenceDays: 90, touchMode: 'Context', reasonBase: 'TNB Stage 1', lastTouch: null,
    nextCheckIn: '2026-07-19' as never, daysSince: null, stalled: false, followUpReason: '',
    overdueCatchUp: false, nameVerdict: null, attioBhcContactId: null, withheld: null, notes: [],
    ...overrides,
  };
}

describe('computeMissionStatus', () => {
  it('counts active entries per track independently', () => {
    const entries = [entry('1', { tnbStage: 'Stage 2' }), entry('2', { fteStage: 'Stage 1' }), entry('3', { tnbStage: 'Stage 0' })];
    const status = computeMissionStatus(entries, [cadenceRow('1'), cadenceRow('2')], TODAY);
    expect(status.tnb.active).toBe(1);
    expect(status.fte.active).toBe(1);
    expect(status.fractional.active).toBe(0);
  });

  it('counts a contact active in multiple tracks simultaneously in both', () => {
    const entries = [entry('1', { tnbStage: 'Stage 2', fteStage: 'Stage 1' })];
    const status = computeMissionStatus(entries, [cadenceRow('1')], TODAY);
    expect(status.tnb.active).toBe(1);
    expect(status.fte.active).toBe(1);
  });

  it("counts stalled only among that track's active members", () => {
    const entries = [entry('1', { tnbStage: 'Stage 2' }), entry('2', { fteStage: 'Stage 1' })];
    const status = computeMissionStatus(entries, [cadenceRow('1', { stalled: true }), cadenceRow('2', { stalled: true })], TODAY);
    expect(status.tnb.stalled).toBe(1);
    expect(status.fte.stalled).toBe(1);
    expect(status.fractional.stalled).toBe(0);
  });

  it('picks the overdue contact with the earliest next_check_in as nextTouch', () => {
    const entries = [entry('1', { tnbStage: 'Stage 1' }), entry('2', { tnbStage: 'Stage 1' })];
    const status = computeMissionStatus(
      entries,
      [cadenceRow('1', { nextCheckIn: '2026-07-10' as never, name: 'Earlier' }), cadenceRow('2', { nextCheckIn: '2026-07-15' as never, name: 'Later' })],
      TODAY,
    );
    expect(status.tnb.nextTouch).toBe('Earlier');
  });

  it('only includes daysSinceTouch on the FTE block, per spec', () => {
    const entries = [entry('1', { tnbStage: 'Stage 1', fteStage: 'Stage 1' })];
    const status = computeMissionStatus(entries, [cadenceRow('1', { daysSince: 30 })], TODAY);
    expect(status.fte).toHaveProperty('daysSinceTouch', 30);
    expect(status.tnb).not.toHaveProperty('daysSinceTouch');
  });

  it('returns nextTouch null when no entries are active for a track', () => {
    const status = computeMissionStatus([], [], TODAY);
    expect(status.tnb.nextTouch).toBeNull();
    expect(status.tnb.active).toBe(0);
  });
});
