/**
 * STEP 3 — the deterministic score, 0-100.
 *
 * THESE WEIGHTS ARE A STARTING HYPOTHESIS, NOT SETTLED VALUES, and they were
 * re-derived from scratch on 2026-08-08 when scoring moved onto Attio's
 * computed signals. Every weight lives in one exported table and the score is
 * returned with the itemized contributions that produced it: tuning should be
 * reading a report and editing WEIGHTS, never re-deriving arithmetic.
 *
 * Shape of the model now:
 *   - CONNECTION STRENGTH IS PRIMARY. It is Attio's own analysis of the full
 *     mailbox, it covers 97% of candidates, and it discriminates: 133 of the
 *     170 compromise-blast records score Very weak while 42 people
 *     workspace-wide score Very strong. It replaces the old direction weights
 *     outright.
 *   - Span still matters, and is now the second-strongest signal.
 *   - Client-team coherence is positive but deliberately cannot, on its own,
 *     lift a Very weak contact into keepers — its corroborating gates were
 *     lost with the message metadata, so it is no longer trusted alone.
 *   - Last-interaction direction is a WEAK signal at most. It describes one
 *     interaction, not a history.
 */

import { BAND_JUNK_MAX, BAND_KEEPER_MIN, type StrengthBand } from '../../config/triage-constants.js';
import type { ContactSignals, DeterministicScore, QueueColumn, ScoreContribution } from './types.js';

export const WEIGHTS = {
  base: 10,

  /**
   * PRIMARY. Attio computes this from the full mailbox; we are consuming the
   * conclusion. Very weak is a real negative rather than a zero — Attio having
   * looked and found almost nothing is evidence, unlike a missing value.
   */
  strengthVeryStrong: 45,
  strengthStrong: 35,
  strengthGood: 22,
  strengthWeak: 5,
  strengthVeryWeak: -12,
  /** No strength computed at all: absence of evidence, scored as such. */
  strengthMissing: 0,

  // Span, from first_interaction/last_interaction (100% populated).
  spanYearPlus: 18,
  spanQuarterPlus: 14,
  spanMonthPlus: 10,
  spanWeekPlus: 6,
  spanDayPlus: 2,
  spanSingleDay: -6,

  // Identity.
  hasName: 8,
  noName: -10,
  localPersonal: 6,
  localGenericRole: -8,
  domainCompany: 3,
  hasLinkedin: 6,

  // Shape of the relationship.
  clientTeam: 12,
  transactionalSubject: -15,

  /**
   * THE VOLUME TRAP. Connection strength measures how much contact there is,
   * and a personal relationship or a frequently-used vendor produces exactly
   * that — a resort booked every summer scores Very strong. All three of the
   * first --llm run's clamp events were this shape, with the model scoring 35,
   * 35 and 12 against deterministic 77, 82 and 67.
   *
   * Requires ALL THREE together: a freemail domain, no resolved company, and
   * Good-or-above strength. NEVER freemail alone — a freelance creative
   * director at gmail.com is a real contact and Bobby has many. The company
   * test is what separates "unaffiliated individual Bobby emails a lot" from
   * "freelancer with a business behind them".
   *
   * Sized to move the target shape out of keepers without sinking anyone into
   * junk on this signal alone: the lowest-scoring contact it can reach is a
   * named Good-strength freemail contact at ~46, which lands at 28 — still
   * unclear, still a card, still reviewable.
   */
  freemailNoCompanyHighStrength: -18,

  /**
   * "A contact whose last interaction is Inbound is mildly more interesting
   * than one whose last is Outbound — nothing more." Deliberately tiny, and
   * only 3% of candidates carry the field at all.
   */
  lastInboundNudge: 3,
} as const;

export const SPAN_YEAR = 365;
export const SPAN_QUARTER = 90;
export const SPAN_MONTH = 30;
export const SPAN_WEEK = 7;

const STRENGTH_WEIGHTS: Readonly<Record<StrengthBand, number>> = {
  'Very strong': WEIGHTS.strengthVeryStrong,
  Strong: WEIGHTS.strengthStrong,
  Good: WEIGHTS.strengthGood,
  Weak: WEIGHTS.strengthWeak,
  'Very weak': WEIGHTS.strengthVeryWeak,
};

/**
 * Freemail + no company + Good-or-above strength. All three, always.
 * Exported so the condition is testable in isolation rather than only through
 * a score.
 */
export function isVolumeTrap(signals: ContactSignals): boolean {
  if (signals.domainKind !== 'freemail') return false;
  if (signals.hasCompany) return false;
  return signals.strength === 'Good' || signals.strength === 'Strong' || signals.strength === 'Very strong';
}

function add(list: ScoreContribution[], label: string, delta: number): void {
  if (delta !== 0) list.push({ label, delta });
}

export function scoreContact(signals: ContactSignals): DeterministicScore {
  const c: ScoreContribution[] = [];
  add(c, 'base', WEIGHTS.base);

  // --- Primary: Attio's computed connection strength.
  if (signals.strength !== null) {
    const legacy = signals.strengthLegacy;
    const detail = legacy !== null ? ` (${legacy.toFixed(1)})` : '';
    add(c, `connection strength ${signals.strength}${detail}`, STRENGTH_WEIGHTS[signals.strength]);
  } else {
    c.push({ label: 'no connection strength computed by Attio', delta: WEIGHTS.strengthMissing });
  }

  // --- Span. Missing evidence is not negative evidence: a record with no
  // first/last interaction pair gets no span contribution AND no penalty.
  if (signals.spanKnown) {
    if (signals.spanDays >= SPAN_YEAR) add(c, `${signals.spanDays}d span (years)`, WEIGHTS.spanYearPlus);
    else if (signals.spanDays >= SPAN_QUARTER) add(c, `${signals.spanDays}d span (months)`, WEIGHTS.spanQuarterPlus);
    else if (signals.spanDays >= SPAN_MONTH) add(c, `${signals.spanDays}d span`, WEIGHTS.spanMonthPlus);
    else if (signals.spanDays >= SPAN_WEEK) add(c, `${signals.spanDays}d span`, WEIGHTS.spanWeekPlus);
    else if (signals.spanDays >= 1) add(c, `${signals.spanDays}d span`, WEIGHTS.spanDayPlus);
    else add(c, 'single day only, no span', WEIGHTS.spanSingleDay);
  } else {
    c.push({ label: 'no interaction dates on record — span unknown', delta: 0 });
  }

  // --- Shape.
  if (signals.clientTeam) {
    add(c, `client-team coherence (${signals.sameDomainCandidates} candidates @${signals.clientTeamDomain})`, WEIGHTS.clientTeam);
  }
  if (signals.transactionalSubject) {
    add(c, 'transactional subject line', WEIGHTS.transactionalSubject);
  }
  if (isVolumeTrap(signals)) {
    add(
      c,
      `high contact volume on a personal address with no company (${signals.strength})`,
      WEIGHTS.freemailNoCompanyHighStrength,
    );
  }
  if (signals.lastDirection === 'inbound') {
    add(c, 'last interaction was inbound', WEIGHTS.lastInboundNudge);
  }

  // --- Identity.
  if (signals.hasName) add(c, 'real name on record', WEIGHTS.hasName);
  else add(c, 'no name on record (unmintable until added)', WEIGHTS.noName);

  if (signals.localPart === 'personal') add(c, 'personal address', WEIGHTS.localPersonal);
  else if (signals.localPart === 'generic-role') add(c, 'generic company inbox', WEIGHTS.localGenericRole);

  if (signals.domainKind === 'company') add(c, 'company domain', WEIGHTS.domainCompany);
  if (signals.hasLinkedin) add(c, 'LinkedIn URL present', WEIGHTS.hasLinkedin);

  const raw = c.reduce((sum, x) => sum + x.delta, 0);
  const score = Math.max(0, Math.min(100, raw));

  return { score, contributions: c, reason: buildReason(c, score) };
}

/**
 * One line, biggest movers first, sign preserved. This is what Bobby reads on
 * the card, so it names the evidence rather than the arithmetic.
 */
export function buildReason(contributions: readonly ScoreContribution[], score: number): string {
  // Zero-delta entries are caveats about the evidence itself ("span unknown"),
  // not weak signals. They lead the line and are never ranked away — a caveat
  // that gets sorted off the end is a caveat Bobby never sees.
  const notes = contributions.filter((x) => x.delta === 0).map((x) => x.label);

  const ranked = contributions
    .filter((x) => x.delta !== 0 && x.label !== 'base')
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 4)
    .map((x) => `${x.label} (${x.delta > 0 ? '+' : ''}${x.delta})`);

  const parts = [...notes, ...ranked];
  if (parts.length === 0) return `score ${score}: no distinguishing signals`;
  return `score ${score}: ${parts.join('; ')}`;
}

/** Banding, per STEP 5: keepers >= 75, junk <= 25, unclear in between. */
export function bandFor(score: number): QueueColumn {
  if (score >= BAND_KEEPER_MIN) return 'keepers';
  if (score <= BAND_JUNK_MAX) return 'junk';
  return 'unclear';
}
