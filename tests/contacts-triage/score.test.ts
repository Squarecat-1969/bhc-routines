import { describe, expect, it } from 'vitest';

import { bandFor, isVolumeTrap, scoreContact, WEIGHTS } from '../../src/passes/contacts-triage/score.js';
import { countByDomain, deriveSignals } from '../../src/passes/contacts-triage/signals.js';
import { isInLlmScoreRange, shouldCallLlm } from '../../src/passes/contacts-triage/llm.js';
import { contact, withStrength } from './fixtures.js';
import type { UnbridgedContact } from '../../src/passes/contacts-triage/types.js';

function score(c: UnbridgedContact, others: UnbridgedContact[] = []) {
  return scoreContact(deriveSignals({ contact: c, domainCounts: countByDomain([c, ...others]) }));
}

describe('connection strength is the primary signal', () => {
  it('orders the five bands monotonically, with a wide spread', () => {
    const scores = (['Very weak', 'Weak', 'Good', 'Strong', 'Very strong'] as const).map(
      (band) => score(withStrength(band)).score,
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
    expect(scores[4]! - scores[0]!).toBeGreaterThanOrEqual(50);
  });

  it('outweighs every other single signal — it replaced the direction weights', () => {
    const others = [
      WEIGHTS.spanYearPlus,
      WEIGHTS.hasName,
      WEIGHTS.localPersonal,
      WEIGHTS.hasLinkedin,
      WEIGHTS.clientTeam,
      Math.abs(WEIGHTS.transactionalSubject),
    ];
    expect(WEIGHTS.strengthVeryStrong).toBeGreaterThan(Math.max(...others));
  });

  it('treats Very weak as real negative evidence but a MISSING strength as neutral', () => {
    // Attio looking and finding almost nothing is evidence. Attio not having
    // looked is not.
    const veryWeak = score(withStrength('Very weak'));
    const missing = score(contact());
    expect(veryWeak.score).toBeLessThan(missing.score);
    expect(WEIGHTS.strengthMissing).toBe(0);
    expect(missing.reason).toContain('no connection strength computed');
  });

  it('names the band and the raw numeric in the reason', () => {
    expect(score(withStrength('Good')).reason).toContain('connection strength Good (20.0)');
  });
});

describe('the live cases this model has to get right', () => {
  it('scores a Very strong, named, long-span contact as a keeper', () => {
    const scored = score(
      withStrength('Very strong', {
        firstInteractionAt: '2024-01-01',
        lastInteractionAt: '2026-08-01',
        linkedin: 'https://linkedin.com/in/x',
      }),
    );
    expect(bandFor(scored.score)).toBe('keepers');
  });

  it('scores a Very weak compromise-blast survivor as junk', () => {
    // 133 of the 170 blast records score Very weak. Any that escape the
    // created_at window must still land in junk on their own merits.
    const scored = score(
      withStrength('Very weak', {
        name: null,
        primaryEmail: 'a7f39c2b8e4d1f06@random.io',
        allEmails: ['a7f39c2b8e4d1f06@random.io'],
      }),
    );
    expect(bandFor(scored.score)).toBe('junk');
  });

  it('lifts a DSG6269-style client-team member above a lone contact of equal strength', () => {
    // Identical in every respect except the shared domain, so the delta is
    // attributable to the client-team signal alone.
    const team = Array.from({ length: 13 }, (_, i) =>
      withStrength('Weak', {
        attioRecordId: `dcsg-${i}`,
        primaryEmail: `person.${String.fromCharCode(97 + i)}@dcsg.com`,
        allEmails: [`person.${String.fromCharCode(97 + i)}@dcsg.com`],
        firstInteractionAt: '2026-07-27',
        lastInteractionAt: '2026-08-04',
      }),
    );
    const inTeam = score(team[0]!, team.slice(1));
    const alone = score(
      withStrength('Weak', {
        primaryEmail: 'person.a@elsewhere.com',
        allEmails: ['person.a@elsewhere.com'],
        firstInteractionAt: '2026-07-27',
        lastInteractionAt: '2026-08-04',
      }),
    );
    expect(inTeam.score).toBe(alone.score + WEIGHTS.clientTeam);
    expect(inTeam.reason).toContain('client-team coherence');
  });

  it('client-team coherence ALONE cannot lift a Very weak contact into keepers', () => {
    // Its reply and span gates were lost with the message metadata, so it is
    // no longer trusted on its own — two unrelated people at a big vendor
    // satisfy domain co-occurrence just as a real client team does.
    const vendor = Array.from({ length: 6 }, (_, i) =>
      withStrength('Very weak', {
        attioRecordId: `amz-${i}`,
        primaryEmail: `p${i}@amazon.com`,
        allEmails: [`p${i}@amazon.com`],
        firstInteractionAt: '2024-01-01',
        lastInteractionAt: '2026-08-01',
        linkedin: 'https://linkedin.com/in/x',
      }),
    );
    expect(bandFor(score(vendor[0]!, vendor.slice(1)).score)).not.toBe('keepers');
  });
});

describe('missing evidence is not negative evidence', () => {
  it('applies no span penalty when the record carries no interaction dates', () => {
    const scored = score(withStrength('Good'));
    expect(scored.contributions.some((x) => x.label.includes('single day only'))).toBe(false);
    expect(scored.reason).toContain('span unknown');
  });

  it('does penalise a genuine single-day span, which IS evidence', () => {
    const scored = score(withStrength('Good', { firstInteractionAt: '2026-08-01', lastInteractionAt: '2026-08-01' }));
    expect(scored.contributions.some((x) => x.label === 'single day only, no span')).toBe(true);
  });
});

describe('identity signals', () => {
  it('penalises a missing name — those contacts are unmintable', () => {
    const named = score(withStrength('Good'));
    const unnamed = score(withStrength('Good', { name: null }));
    expect(named.score - unnamed.score).toBe(WEIGHTS.hasName - WEIGHTS.noName);
    expect(unnamed.reason).toContain('unmintable');
  });

  it('gives the last-inbound nudge a deliberately tiny weight', () => {
    expect(WEIGHTS.lastInboundNudge).toBeLessThan(5);
    const inbound = score(withStrength('Good', { lastInteractionDirection: 'Inbound' }));
    const outbound = score(withStrength('Good', { lastInteractionDirection: 'Outbound' }));
    expect(inbound.score - outbound.score).toBe(WEIGHTS.lastInboundNudge);
  });

  it('never returns a score outside 0-100', () => {
    const worst = score(
      withStrength('Very weak', {
        name: null,
        primaryEmail: 'careers@nowhere.com',
        allEmails: ['careers@nowhere.com'],
        lastInteractionSubject: 'Your order has shipped',
        firstInteractionAt: '2026-08-01',
        lastInteractionAt: '2026-08-01',
      }),
    );
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});

describe('banding and the LLM window', () => {
  it('bands at the documented thresholds', () => {
    expect(bandFor(75)).toBe('keepers');
    expect(bandFor(74)).toBe('unclear');
    expect(bandFor(26)).toBe('unclear');
    expect(bandFor(25)).toBe('junk');
  });

  it('treats 15-90 inclusive as the score range where a call could matter', () => {
    expect(isInLlmScoreRange(14)).toBe(false);
    expect(isInLlmScoreRange(15)).toBe(true);
    expect(isInLlmScoreRange(90)).toBe(true);
    expect(isInLlmScoreRange(91)).toBe(false);
  });
});

describe('THE LLM GATE — evidence, not band position', () => {
  const withEvidence = (overrides = {}) =>
    deriveSignals({
      contact: withStrength('Good', { lastMeetingSummary: 'Discussed the loyalty rollout.', ...overrides }),
      domainCounts: new Map(),
    });
  const withoutEvidence = (overrides = {}) =>
    deriveSignals({ contact: withStrength('Good', overrides), domainCounts: new Map() });

  it('calls when there is something to read, at ANY score in range', () => {
    // A contact at 88 with a rich summary is where the model is most decisive.
    expect(shouldCallLlm(withEvidence(), 88)).toBe(true);
    expect(shouldCallLlm(withEvidence(), 20)).toBe(true);
    expect(shouldCallLlm(withEvidence(), 45)).toBe(true);
  });

  it('does NOT call when there is nothing to read, whatever the score', () => {
    // 36 of the first run's 40 calls were this case, and returned "middling".
    expect(shouldCallLlm(withoutEvidence(), 45)).toBe(false);
    expect(shouldCallLlm(withoutEvidence(), 69)).toBe(false);
  });

  it('skips the settled tails even when evidence exists', () => {
    expect(shouldCallLlm(withEvidence(), 14)).toBe(false);
    expect(shouldCallLlm(withEvidence(), 91)).toBe(false);
  });

  it('counts a subject line, a meeting summary or a description — but NOT a company name', () => {
    expect(shouldCallLlm(withEvidence({ lastMeetingSummary: null, lastInteractionSubject: 'Q1 brief' }), 50)).toBe(true);
    expect(shouldCallLlm(withEvidence({ lastMeetingSummary: null, description: 'Brand lead' }), 50)).toBe(true);
    // A resolved company is already an input to the score; it tells a reader nothing new.
    expect(shouldCallLlm(withoutEvidence({ company: 'Dick\'s Sporting Goods' }), 50)).toBe(false);
  });
});

describe('THE VOLUME TRAP — connection strength measures volume, not relevance', () => {
  const trap = (overrides = {}) =>
    deriveSignals({
      contact: withStrength('Strong', {
        primaryEmail: 'someone@gmail.com',
        allEmails: ['someone@gmail.com'],
        company: null,
        ...overrides,
      }),
      domainCounts: new Map(),
    });

  it('fires only when all three conditions hold together', () => {
    expect(isVolumeTrap(trap())).toBe(true);
    // freemail alone must never be enough
    expect(isVolumeTrap(trap({ company: 'Real Co' }))).toBe(false);
    expect(isVolumeTrap(trap({ strengthLabel: 'Weak', strengthLegacy: 9 }))).toBe(false);
    expect(isVolumeTrap(trap({ primaryEmail: 'someone@realco.com', allEmails: ['someone@realco.com'] }))).toBe(false);
  });

  it('does not sink a freelance creative director at gmail with a company', () => {
    // Bobby has many of these; the company field is what separates them.
    const freelancer = trap({ company: 'Freelance Studio' });
    expect(isVolumeTrap(freelancer)).toBe(false);
    expect(bandFor(scoreContact(freelancer).score)).not.toBe('junk');
  });

  it('moves the Susan Massey shape out of keepers', () => {
    // Very strong / long span / gmail / no company — 77 before the penalty.
    const susan = deriveSignals({
      contact: withStrength('Strong', {
        name: 'Susan Massey',
        primaryEmail: 'breemassey55@gmail.com',
        allEmails: ['breemassey55@gmail.com'],
        company: null,
        firstInteractionAt: '2017-01-01',
        lastInteractionAt: '2026-08-01',
      }),
      domainCounts: new Map(),
    });
    const scored = scoreContact(susan);
    expect(bandFor(scored.score)).not.toBe('keepers');
    expect(scored.reason).toContain('high contact volume on a personal address');
  });

  it('leaves anyone it does reach still reviewable, never junk on this signal alone', () => {
    // Lowest reachable: named, Good strength, freemail, no company, no span.
    const lowest = deriveSignals({
      contact: withStrength('Good', {
        primaryEmail: 'jane.doe@gmail.com',
        allEmails: ['jane.doe@gmail.com'],
        company: null,
      }),
      domainCounts: new Map(),
    });
    expect(bandFor(scoreContact(lowest).score)).toBe('unclear');
  });
});
