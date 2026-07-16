import { describe, expect, it } from 'vitest';

import { computeCadence, normalizeTier, resolveActiveStage, stageNum } from '../src/passes/pass4/cadence.js';
import type { CivilDate } from '../src/lib/dates.js';

const TODAY = '2026-07-15' as CivilDate;

const noStages = { tnbStage: null, fractionalStage: null, fteStage: null };

describe('stageNum', () => {
  it('extracts the integer from a stage string', () => {
    expect(stageNum('Stage 2 – Proposal Sent')).toBe(2);
    expect(stageNum('Stage 5')).toBe(5);
    expect(stageNum('stage 3 - activation')).toBe(3);
  });

  it('treats Stage 0, blank, and unparseable as 0', () => {
    expect(stageNum('Stage 0')).toBe(0);
    expect(stageNum('')).toBe(0);
    expect(stageNum(null)).toBe(0);
    expect(stageNum(undefined)).toBe(0);
    expect(stageNum('Closed Won')).toBe(0);
  });
});

describe('resolveActiveStage', () => {
  it('takes the max stage across all three tracks', () => {
    const r = resolveActiveStage({
      tnbStage: 'Stage 1 – Intro',
      fractionalStage: 'Stage 4 – Negotiation',
      fteStage: 'Stage 2 – Proposal',
    });
    expect(r.activeStageNum).toBe(4);
    expect(r.activeTrack).toBe('Fractional');
    expect(r.activeStageLabel).toBe('Stage 4 – Negotiation');
  });

  it('breaks ties TNB > FTE > Fractional', () => {
    expect(
      resolveActiveStage({ tnbStage: 'Stage 3', fractionalStage: 'Stage 3', fteStage: 'Stage 3' }).activeTrack,
    ).toBe('TNB');
    expect(
      resolveActiveStage({ tnbStage: null, fractionalStage: 'Stage 3', fteStage: 'Stage 3' }).activeTrack,
    ).toBe('FTE');
    expect(
      resolveActiveStage({ tnbStage: 'Stage 1', fractionalStage: 'Stage 3', fteStage: 'Stage 3' }).activeTrack,
    ).toBe('FTE');
  });

  it('reports no active track when every stage is 0 or blank', () => {
    const r = resolveActiveStage({ tnbStage: 'Stage 0', fractionalStage: '', fteStage: null });
    expect(r.activeStageNum).toBe(0);
    expect(r.activeTrack).toBeNull();
  });
});

describe('normalizeTier', () => {
  it('accepts the three known tiers case-insensitively', () => {
    expect(normalizeTier('Core')).toBe('Core');
    expect(normalizeTier('  strategic ')).toBe('Strategic');
    expect(normalizeTier('PERIPHERAL')).toBe('Peripheral');
  });

  it('defaults anything else to Strategic (spec 4b)', () => {
    expect(normalizeTier('VIP')).toBe('Strategic');
    expect(normalizeTier('')).toBe('Strategic');
    expect(normalizeTier(null)).toBe('Strategic');
  });
});

describe('computeCadence — stage-based', () => {
  it.each([
    [1, 4, 'Context'],
    [2, 6, 'Context'],
    [3, 8, 'Activation'],
    [4, 4, 'Activation'],
    [5, 90, 'Social'],
  ] as const)('Stage %i → %i days, %s', (stage, days, mode) => {
    const r = computeCadence({
      stages: { tnbStage: `Stage ${stage}`, fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: TODAY,
      today: TODAY,
    });
    expect(r.cadenceDays).toBe(days);
    expect(r.touchMode).toBe(mode);
    expect(r.reasonBase).toBe(`TNB Stage ${stage}`);
  });

  it('ignores tier entirely when a stage is active', () => {
    const core = computeCadence({
      stages: { tnbStage: 'Stage 2', fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: TODAY,
      today: TODAY,
    });
    const peripheral = computeCadence({
      stages: { tnbStage: 'Stage 2', fractionalStage: null, fteStage: null },
      tier: 'Peripheral',
      lastTouch: TODAY,
      today: TODAY,
    });
    expect(core.cadenceDays).toBe(peripheral.cadenceDays);
    expect(core.nextCheckIn).toBe(peripheral.nextCheckIn);
  });

  it('falls back to tier cadence and warns for a stage above the known table', () => {
    const r = computeCadence({
      stages: { tnbStage: 'Stage 9', fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: TODAY,
      today: TODAY,
    });
    expect(r.cadenceDays).toBe(45);
    expect(r.reasonBase).toBe('Tier Core — no active stage');
    expect(r.warnings[0]).toMatch(/Stage 9 has no entry/);
  });
});

describe('computeCadence — tier-based', () => {
  it.each([
    ['Core', 45, 'Context'],
    ['Strategic', 90, 'Social'],
    ['Peripheral', 180, 'Social'],
  ] as const)('%s → %i days, %s', (tier, days, mode) => {
    const r = computeCadence({ stages: noStages, tier, lastTouch: TODAY, today: TODAY });
    expect(r.cadenceDays).toBe(days);
    expect(r.touchMode).toBe(mode);
    expect(r.reasonBase).toBe(`Tier ${tier} — no active stage`);
  });
});

describe('computeCadence — next check-in', () => {
  it('is last touch + cadence when that is still in the future', () => {
    const r = computeCadence({
      stages: { tnbStage: 'Stage 2', fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: '2026-07-13' as CivilDate,
      today: TODAY,
    });
    expect(r.nextCheckIn).toBe('2026-07-19'); // 07-13 + 6d
    expect(r.overdueCatchUp).toBe(false);
  });

  it('applies the half-cadence catch-up when the computed date is already past', () => {
    const r = computeCadence({
      stages: { tnbStage: 'Stage 2', fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: '2026-06-01' as CivilDate,
      today: TODAY,
    });
    expect(r.nextCheckIn).toBe('2026-07-18'); // today + floor(6/2) = +3d
    expect(r.overdueCatchUp).toBe(true);
  });

  it('does NOT catch up when the computed date lands exactly on today', () => {
    // isBefore is strict: next_check_in == TODAY is not overdue.
    const r = computeCadence({
      stages: { tnbStage: 'Stage 1', fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: '2026-07-11' as CivilDate,
      today: TODAY,
    });
    expect(r.nextCheckIn).toBe('2026-07-15');
    expect(r.overdueCatchUp).toBe(false);
  });

  it('floors odd cadences when halving', () => {
    const r = computeCadence({
      stages: { tnbStage: 'Stage 3', fractionalStage: null, fteStage: null }, // 8d
      tier: 'Core',
      lastTouch: '2026-01-01' as CivilDate,
      today: TODAY,
    });
    expect(r.nextCheckIn).toBe('2026-07-19'); // +4d
  });

  it('is today + cadence when the last touch is unknown', () => {
    const r = computeCadence({ stages: noStages, tier: 'Core', lastTouch: null, today: TODAY });
    expect(r.nextCheckIn).toBe('2026-08-29'); // +45d
    expect(r.daysSince).toBeNull();
    expect(r.stalled).toBe(false);
  });
});

describe('computeCadence — stalled', () => {
  it('is stalled strictly beyond 2x cadence', () => {
    const at2x = computeCadence({
      stages: { tnbStage: 'Stage 2', fractionalStage: null, fteStage: null }, // 6d
      tier: 'Core',
      lastTouch: '2026-07-03' as CivilDate, // 12d ago == 2x
      today: TODAY,
    });
    expect(at2x.daysSince).toBe(12);
    expect(at2x.stalled).toBe(false);

    const past2x = computeCadence({
      stages: { tnbStage: 'Stage 2', fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: '2026-07-02' as CivilDate, // 13d ago
      today: TODAY,
    });
    expect(past2x.stalled).toBe(true);
  });

  it('never stalls when the last touch is unknown', () => {
    const r = computeCadence({ stages: noStages, tier: 'Peripheral', lastTouch: null, today: TODAY });
    expect(r.stalled).toBe(false);
  });
});

describe('computeCadence — follow_up_reason', () => {
  it('is the bare reason base on the happy path', () => {
    const r = computeCadence({
      stages: { tnbStage: 'Stage 1', fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: '2026-07-14' as CivilDate,
      today: TODAY,
    });
    expect(r.followUpReason).toBe('TNB Stage 1');
  });

  it('appends the stalled fragment verbatim', () => {
    const r = computeCadence({
      stages: { tnbStage: 'Stage 1', fractionalStage: null, fteStage: null }, // 4d
      tier: 'Core',
      lastTouch: '2026-06-01' as CivilDate, // 44d
      today: TODAY,
    });
    expect(r.followUpReason).toBe('TNB Stage 1 ⚠ STALLED — 44d since last touch (expected every 4d)');
  });

  it('appends the unknown-touch fragment', () => {
    const r = computeCadence({ stages: noStages, tier: 'Strategic', lastTouch: null, today: TODAY });
    expect(r.followUpReason).toBe('Tier Strategic — no active stage — last touch date unknown');
  });

  it('stays within the 500-char cap, and does not leak a long stage label into the reason', () => {
    // reason_base is built from the track + stage *number* ("TNB Stage 1"), never
    // the stage label, so no Attio-authored string reaches follow_up_reason. The
    // spec's 500-char truncation is therefore defensive only — unreachable via
    // any current input. Kept because the spec mandates it; asserted as a bound,
    // not as an exact length.
    const r = computeCadence({
      stages: { tnbStage: `Stage 1 – ${'x'.repeat(600)}`, fractionalStage: null, fteStage: null },
      tier: 'Core',
      lastTouch: '2026-01-01' as CivilDate,
      today: TODAY,
    });
    expect(r.followUpReason.length).toBeLessThanOrEqual(500);
    expect(r.followUpReason).not.toMatch(/xxx/);
    expect(r.followUpReason).toMatch(/^TNB Stage 1 ⚠ STALLED/);
  });
});
