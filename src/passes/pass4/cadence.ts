/**
 * PASS 4 cadence math — pure functions, no I/O.
 *
 * Transcribed from the 4d pseudocode in routines/BHC_Late_Edition.md. Every
 * deviation or resolved ambiguity is called out in docs/pass4-notes.md and
 * marked with a SPEC NOTE below.
 */

import {
  DEFAULT_TIER,
  FOLLOW_UP_REASON_MAX_LEN,
  STAGE_CADENCE,
  TIER_CADENCE,
  TIERS,
  type CadenceRule,
  type Tier,
  type TouchMode,
  type Track,
} from '../../config/constants.js';
import { addDays, diffDays, isBefore, type CivilDate } from '../../lib/dates.js';

/**
 * Extract the stage integer from a stage string: "Stage 2 – Proposal Sent" → 2.
 * Blank, "Stage 0", or unparseable → 0.
 */
export function stageNum(raw: string | null | undefined): number {
  if (!raw) return 0;
  const m = /stage\s*(\d+)/i.exec(String(raw));
  if (!m?.[1]) return 0;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface StageInput {
  readonly tnbStage: string | null;
  readonly fractionalStage: string | null;
  readonly fteStage: string | null;
}

export interface ActiveStage {
  readonly activeStageNum: number;
  /** null when no track is at Stage >= 1. */
  readonly activeTrack: Track | null;
  /** The raw stage string of the winning track, for Pipeline_Cache col L (PASS 4.5c). */
  readonly activeStageLabel: string | null;
}

/**
 * active_stage_num = max integer across tnb / fractional / fte.
 * active_track = whichever track holds the highest stage, ties broken TNB > FTE > Fractional.
 *
 * The candidate array order *is* the tie-break: the reducer keeps the incumbent
 * on equality, so listing TNB first, then FTE, then Fractional encodes the rule.
 */
export function resolveActiveStage(input: StageInput): ActiveStage {
  const candidates: ReadonlyArray<{ track: Track; label: string | null }> = [
    { track: 'TNB', label: input.tnbStage },
    { track: 'FTE', label: input.fteStage },
    { track: 'Fractional', label: input.fractionalStage },
  ];

  let best: { track: Track; label: string | null; stage: number } | null = null;
  for (const c of candidates) {
    const stage = stageNum(c.label);
    if (best === null || stage > best.stage) best = { ...c, stage };
  }

  const winner = best!;
  if (winner.stage < 1) {
    return { activeStageNum: 0, activeTrack: null, activeStageLabel: null };
  }
  return {
    activeStageNum: winner.stage,
    activeTrack: winner.track,
    activeStageLabel: winner.label,
  };
}

/** Tier values are Core / Strategic / Peripheral. Anything else → Strategic (spec 4b). */
export function normalizeTier(raw: string | null | undefined): Tier {
  if (!raw) return DEFAULT_TIER;
  const needle = String(raw).trim().toLowerCase();
  return TIERS.find((t) => t.toLowerCase() === needle) ?? DEFAULT_TIER;
}

export interface CadenceInput {
  readonly stages: StageInput;
  readonly tier: Tier;
  readonly lastTouch: CivilDate | null;
  readonly today: CivilDate;
}

export interface CadenceResult {
  readonly activeStageNum: number;
  readonly activeTrack: Track | null;
  readonly activeStageLabel: string | null;
  readonly cadenceDays: number;
  readonly touchMode: TouchMode;
  readonly reasonBase: string;
  readonly nextCheckIn: CivilDate;
  /** null when the last touch date is unknown. */
  readonly daysSince: number | null;
  readonly stalled: boolean;
  readonly followUpReason: string;
  /** True when the computed check-in was pulled forward by the overdue rule. */
  readonly overdueCatchUp: boolean;
  /** Non-fatal notes for the run report (e.g. an out-of-range stage number). */
  readonly warnings: readonly string[];
}

export function computeCadence(input: CadenceInput): CadenceResult {
  const { stages, tier, lastTouch, today } = input;
  const { activeStageNum, activeTrack, activeStageLabel } = resolveActiveStage(stages);
  const warnings: string[] = [];

  let rule: CadenceRule;
  let reasonBase: string;

  const stageRule = activeStageNum >= 1 ? STAGE_CADENCE[activeStageNum] : undefined;

  if (activeStageNum >= 1 && stageRule) {
    rule = stageRule;
    reasonBase = `${activeTrack} Stage ${activeStageNum}`;
  } else {
    // SPEC NOTE: a stage integer above the known table (>5) is undefined in the
    // spec. We fall back to tier cadence and warn rather than invent a rule.
    // See docs/pass4-notes.md #3.
    if (activeStageNum >= 1) {
      warnings.push(
        `Stage ${activeStageNum} has no entry in STAGE_CADENCE (known 1-5); fell back to tier cadence`,
      );
    }
    rule = TIER_CADENCE[tier];
    reasonBase = `Tier ${tier} — no active stage`;
  }

  const { days: cadenceDays, touchMode } = rule;

  let nextCheckIn: CivilDate;
  let daysSince: number | null;
  let stalled: boolean;
  let overdueCatchUp = false;

  if (lastTouch) {
    nextCheckIn = addDays(lastTouch, cadenceDays);
    if (isBefore(nextCheckIn, today)) {
      // Overdue: urgency catch-up at half cadence from today.
      nextCheckIn = addDays(today, Math.floor(cadenceDays / 2));
      overdueCatchUp = true;
    }
    daysSince = diffDays(today, lastTouch);
    stalled = daysSince > 2 * cadenceDays;
  } else {
    nextCheckIn = addDays(today, cadenceDays);
    daysSince = null;
    stalled = false;
  }

  let followUpReason = reasonBase;
  if (stalled) {
    followUpReason += ` ⚠ STALLED — ${daysSince}d since last touch (expected every ${cadenceDays}d)`;
  }
  if (daysSince === null) {
    followUpReason += ' — last touch date unknown';
  }
  followUpReason = followUpReason.slice(0, FOLLOW_UP_REASON_MAX_LEN);

  return {
    activeStageNum,
    activeTrack,
    activeStageLabel,
    cadenceDays,
    touchMode,
    reasonBase,
    nextCheckIn,
    daysSince,
    stalled,
    followUpReason,
    overdueCatchUp,
    warnings,
  };
}
