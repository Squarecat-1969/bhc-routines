import { describe, expect, it } from 'vitest';

import {
  classifyDomain,
  classifyLocalPart,
  countByDomain,
  deriveSignals,
  isAutoReply,
  isTransactionalSubject,
} from '../../src/passes/contacts-triage/signals.js';
import { pickProvenance } from '../../src/passes/contacts-triage/provenance.js';
import { bandStrength } from '../../src/passes/contacts-triage/enumerate.js';
import { contact, withStrength } from './fixtures.js';
import type { UnbridgedContact } from '../../src/passes/contacts-triage/types.js';

function derive(c: UnbridgedContact, others: UnbridgedContact[] = []) {
  const all = [c, ...others];
  return deriveSignals({ contact: c, domainCounts: countByDomain(all) });
}

describe('connection strength — the primary signal', () => {
  it('bands the legacy numeric at the live-derived boundaries', () => {
    expect(bandStrength(0.1, null)).toBe('Very weak');
    expect(bandStrength(4.99, null)).toBe('Very weak');
    expect(bandStrength(5, null)).toBe('Weak');
    expect(bandStrength(14.9, null)).toBe('Weak');
    expect(bandStrength(15, null)).toBe('Good');
    expect(bandStrength(29.9, null)).toBe('Good');
    expect(bandStrength(30, null)).toBe('Strong');
    expect(bandStrength(44.9, null)).toBe('Strong');
    expect(bandStrength(45, null)).toBe('Very strong');
    expect(bandStrength(1820.27, null)).toBe('Very strong');
  });

  it('prefers the numeric over the label when both are present', () => {
    // The numeric is the same measurement without the bucketing loss.
    expect(bandStrength(50, 'Very weak')).toBe('Very strong');
  });

  it('falls back to the label when only the label exists', () => {
    expect(bandStrength(null, 'Good')).toBe('Good');
  });

  it('is null — not zero — when Attio has computed nothing', () => {
    expect(bandStrength(null, null)).toBeNull();
    expect(derive(contact()).strengthMissing).toBe(true);
    expect(derive(contact()).strength).toBeNull();
  });
});

describe('span, from first/last interaction', () => {
  it('measures the span when both dates exist', () => {
    const signals = derive(
      contact({ firstInteractionAt: '2024-02-01', lastInteractionAt: '2026-02-01' }),
    );
    expect(signals.spanKnown).toBe(true);
    expect(signals.spanDays).toBe(731);
  });

  it('reports span as UNKNOWN rather than zero when the record has no dates', () => {
    const signals = derive(contact());
    expect(signals.spanKnown).toBe(false);
    expect(signals.spanDays).toBe(0);
  });
});

describe('CLIENT-TEAM COHERENCE — survives the rewire', () => {
  it('fires for several candidates sharing a company domain', () => {
    // The live DSG6269 case: 13 candidates at dcsg.com in this run.
    const team = Array.from({ length: 7 }, (_, i) =>
      contact({ attioRecordId: `rec-${i}`, primaryEmail: `p${i}@dcsg.com`, allEmails: [`p${i}@dcsg.com`] }),
    );
    const signals = derive(team[0]!, team.slice(1));
    expect(signals.clientTeam).toBe(true);
    expect(signals.clientTeamDomain).toBe('dcsg.com');
    expect(signals.sameDomainCandidates).toBe(7);
  });

  it('does not fire for a lone contact at a domain', () => {
    expect(derive(contact()).clientTeam).toBe(false);
  });

  it('never fires on freemail — two people at gmail.com are unrelated', () => {
    const a = contact({ attioRecordId: 'a', primaryEmail: 'a@gmail.com', allEmails: ['a@gmail.com'] });
    const b = contact({ attioRecordId: 'b', primaryEmail: 'b@gmail.com', allEmails: ['b@gmail.com'] });
    const signals = derive(a, [b]);
    expect(signals.clientTeam).toBe(false);
    expect(signals.clientTeamDomain).toBeNull();
  });

  it('counts each candidate once, from their primary address', () => {
    const counts = countByDomain([
      contact({ attioRecordId: '1', primaryEmail: 'a@dcsg.com' }),
      contact({ attioRecordId: '2', primaryEmail: 'b@dcsg.com' }),
      contact({ attioRecordId: '3', primaryEmail: 'c@other.com' }),
      contact({ attioRecordId: '4', primaryEmail: 'd@gmail.com' }),
    ]);
    expect(counts.get('dcsg.com')).toBe(2);
    expect(counts.get('other.com')).toBe(1);
    expect(counts.has('gmail.com')).toBe(false);
  });
});

describe('last-interaction direction is a weak signal only', () => {
  it('normalises Attio’s select values', () => {
    expect(derive(contact({ lastInteractionDirection: 'Inbound' })).lastDirection).toBe('inbound');
    expect(derive(contact({ lastInteractionDirection: 'Outbound' })).lastDirection).toBe('outbound');
    expect(derive(contact({ lastInteractionDirection: 'Internal' })).lastDirection).toBe('internal');
  });

  it('is unknown when absent — 97% of candidates', () => {
    expect(derive(contact()).lastDirection).toBe('unknown');
  });
});

describe('auto-replies, wherever a subject line is available', () => {
  it.each([
    'Automatic reply: Q1 campaign brief',
    'Out of office',
    'Out of Office: back Monday',
    'Auto: I am away',
    'Re: Automatic reply: Q1 campaign brief',
  ])('recognises %s', (subject) => {
    expect(isAutoReply(subject)).toBe(true);
  });

  it.each(['Re: Q1 campaign brief', 'Automatic renewal of your plan', 'Office move next week'])(
    'leaves %s alone',
    (subject) => {
      expect(isAutoReply(subject)).toBe(false);
    },
  );

  it('is flagged on the signals and kept out of the evidence line', () => {
    const signals = derive(contact({ lastInteractionSubject: 'Out of office', description: 'Brand lead at DCSG' }));
    expect(signals.lastSubjectIsAutoReply).toBe(true);
    expect(signals.provenance?.source).toBe('description');
  });

  it('is never read as transactional evidence either', () => {
    const signals = derive(contact({ lastInteractionSubject: 'Automatic reply: your order has shipped' }));
    expect(signals.transactionalSubject).toBe(false);
  });
});

describe('transactional subjects', () => {
  it.each(['Your order has shipped', 'Receipt from Acme Coffee', 'Reset your password'])(
    'flags %s',
    (subject) => {
      expect(isTransactionalSubject(subject)).toBe(true);
    },
  );

  it('only fires when a subject line actually exists', () => {
    expect(derive(contact()).transactionalSubject).toBe(false);
    expect(derive(contact({ lastInteractionSubject: 'Your order has shipped' })).transactionalSubject).toBe(true);
  });
});

describe('address classification', () => {
  it('separates a person from a generic inbox from machine noise', () => {
    expect(classifyLocalPart('jane.doe@acme.com')).toBe('personal');
    expect(classifyLocalPart('careers@acme.com')).toBe('generic-role');
    expect(classifyLocalPart('staffing@hammercreative.com')).toBe('generic-role');
    expect(classifyLocalPart('talent@agency.com')).toBe('generic-role');
    expect(classifyLocalPart('a7f39c2b8e4d1f06@acme.com')).toBe('opaque');
    expect(classifyLocalPart(null)).toBe('unknown');
  });

  it('matches the generic list as a WHOLE local part, never a substring', () => {
    // `talent` must not catch a real person at talentedpeople@.
    expect(classifyLocalPart('talentedpeople@realcompany.com')).toBe('personal');
    expect(classifyLocalPart('staffingsolutions@realcompany.com')).toBe('personal');
    expect(classifyLocalPart('jobsworth@realcompany.com')).toBe('personal');
  });

  it('penalises the inbox without touching humans at the same domain', () => {
    // Hammer Creative is a real agency relationship; one inbox is noise.
    const inbox = derive(contact({ primaryEmail: 'staffing@hammercreative.com', allEmails: ['staffing@hammercreative.com'] }));
    const human = derive(contact({ primaryEmail: 'jacob.anderson@hammercreative.com', allEmails: ['jacob.anderson@hammercreative.com'] }));
    expect(inbox.localPart).toBe('generic-role');
    expect(human.localPart).toBe('personal');
  });

  it('separates a company domain from freemail', () => {
    expect(classifyDomain('jane@dcsg.com')).toBe('company');
    expect(classifyDomain('jane@gmail.com')).toBe('freemail');
  });
});

describe('PROVENANCE — degrades honestly, never invents', () => {
  it('prefers a real subject line', () => {
    const p = pickProvenance(
      contact({ lastInteractionSubject: 'DSG6269 — LOYALTY 15 MOVE app Delivery', lastInteractionAt: '2026-08-04', lastMeetingSummary: 'A summary' }),
    );
    expect(p).toEqual({
      text: 'DSG6269 — LOYALTY 15 MOVE app Delivery',
      date: '2026-08-04',
      source: 'last-interaction-subject',
    });
  });

  it('falls back to the last-meeting summary', () => {
    const p = pickProvenance(contact({ lastMeetingSummary: 'Discussed the loyalty rollout.', lastInteractionAt: '2026-08-04' }));
    expect(p?.source).toBe('last-meeting-summary');
  });

  it('then to the description', () => {
    expect(pickProvenance(contact({ description: 'Brand lead at DCSG' }))?.source).toBe('description');
  });

  it('then to role and company, using whatever exists', () => {
    expect(pickProvenance(contact({ jobTitle: 'Marketing Manager', company: 'DCSG' }))?.text).toBe(
      'Marketing Manager at DCSG',
    );
    // job_title is 0% populated live, so in practice this rung renders as the company alone.
    expect(pickProvenance(contact({ jobTitle: null, company: 'DCSG' }))?.text).toBe('DCSG');
  });

  it('is BLANK when nothing readable exists — never a generic string', () => {
    const p = pickProvenance(contact({ company: null }));
    expect(p).toBeNull();
    const signals = derive(contact({ company: null }));
    expect(signals.provenance).toBeNull();
  });

  it('collapses whitespace and truncates rather than dumping an essay on the card', () => {
    const long = 'x'.repeat(500);
    const p = pickProvenance(contact({ lastMeetingSummary: `  multi\n  line   text ${long}` }));
    expect(p!.text).not.toContain('\n');
    expect(p!.text.length).toBeLessThanOrEqual(240);
    expect(p!.text.endsWith('…')).toBe(true);
  });
});

describe('signals carry the strength through for the card and the prompt', () => {
  it('exposes band and raw numeric', () => {
    const signals = derive(withStrength('Very strong'));
    expect(signals.strength).toBe('Very strong');
    expect(signals.strengthLegacy).toBe(60);
    expect(signals.strengthMissing).toBe(false);
  });
});
