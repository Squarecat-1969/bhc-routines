import { describe, expect, it } from 'vitest';

import {
  chooseCanonical, groupBySharedAttioPointer, scoreRow, type CandidateRow,
} from '../../src/passes/reconciler-fix/canonical.js';
import { nameGate, namePasses } from '../../src/passes/reconciler-fix/name-gate.js';
import { buildEmailList } from '../../src/passes/reconciler-fix/email-list.js';
import { NAME_PARTICLES } from '../../src/lib/name-verify.js';

function row(o: Partial<CandidateRow> = {}): CandidateRow {
  return { masterRow: 10, bhcId: 'BHC-1', location: 'BOTH', googleRow: 100, attioRecordId: 'rec-1', ...o };
}

// ─── 1. canonical / orphan scoring ──────────────────────────────────────────
describe('scoreRow - Google +2, Attio +2', () => {
  it('scores each pointer independently', () => {
    expect(scoreRow(row({ googleRow: 100, attioRecordId: 'rec-1' }))).toBe(4);
    expect(scoreRow(row({ googleRow: 100, attioRecordId: '' }))).toBe(2);
    expect(scoreRow(row({ googleRow: null, attioRecordId: 'rec-1' }))).toBe(2);
    expect(scoreRow(row({ googleRow: null, attioRecordId: '' }))).toBe(0);
  });

  it('does not count a whitespace-only Attio ID as populated', () => {
    expect(scoreRow(row({ googleRow: null, attioRecordId: '   ' }))).toBe(0);
  });

  it('does not count a zero/negative Google_Row as populated', () => {
    expect(scoreRow(row({ googleRow: 0, attioRecordId: '' }))).toBe(0);
  });
});

describe('chooseCanonical', () => {
  it('picks the highest scorer', () => {
    const both = row({ masterRow: 50, googleRow: 100, attioRecordId: 'rec-1' });
    const googleOnly = row({ masterRow: 20, googleRow: 100, attioRecordId: '' });
    const r = chooseCanonical([googleOnly, both]);
    expect(r.canonical!.masterRow).toBe(50); // 4 beats 2, despite the higher row number
    expect(r.orphans.map((o) => o.masterRow)).toEqual([20]);
  });

  it('GENUINE TIE: the lower master row number wins', () => {
    const later = row({ masterRow: 900, googleRow: 100, attioRecordId: 'rec-1' });
    const earlier = row({ masterRow: 12, googleRow: 200, attioRecordId: 'rec-2' });
    const r = chooseCanonical([later, earlier]);
    expect(r.scores.get(900)).toBe(4);
    expect(r.scores.get(12)).toBe(4); // genuinely tied on score
    expect(r.canonical!.masterRow).toBe(12);
  });

  it('is order-independent - the same set gives the same winner either way round', () => {
    const a = row({ masterRow: 900, googleRow: 100, attioRecordId: 'rec-1' });
    const b = row({ masterRow: 12, googleRow: 200, attioRecordId: 'rec-2' });
    expect(chooseCanonical([a, b]).canonical!.masterRow).toBe(chooseCanonical([b, a]).canonical!.masterRow);
  });

  it('classifies every non-winner as an orphan', () => {
    const r = chooseCanonical([
      row({ masterRow: 1, googleRow: 100, attioRecordId: 'rec-1' }),
      row({ masterRow: 2, googleRow: 100, attioRecordId: '' }),
      row({ masterRow: 3, googleRow: null, attioRecordId: '' }),
    ]);
    expect(r.canonical!.masterRow).toBe(1);
    expect(r.orphans.map((o) => o.masterRow)).toEqual([2, 3]);
  });
});

describe('chooseCanonical - the SUPERSEDED exclusion (non-negotiable 6c)', () => {
  it('a SUPERSEDED row NEVER enters scoring - not canonical, not orphan', () => {
    // Mirrors the row-962 / BHC-00920 pin in the Reconciler tests: retirement is
    // declared by the Location field, never deduced from blank pointers.
    const retired = row({ masterRow: 962, bhcId: 'BHC-00920', location: 'SUPERSEDED', googleRow: null, attioRecordId: '' });
    const live = row({ masterRow: 40, googleRow: 100, attioRecordId: 'rec-1' });
    const r = chooseCanonical([retired, live]);

    expect(r.excludedSuperseded.map((x) => x.masterRow)).toEqual([962]);
    expect(r.orphans).toHaveLength(0);            // <- would be written to by PASS 6 Step 3
    expect(r.canonical!.masterRow).toBe(40);
    expect(r.scores.has(962)).toBe(false);        // never even scored
  });

  it('scores 0 if it were included - which is exactly why exclusion must come FIRST', () => {
    const retired = row({ masterRow: 962, location: 'SUPERSEDED', googleRow: null, attioRecordId: '' });
    expect(scoreRow(retired)).toBe(0); // would always lose, always be an orphan, always be written to
  });

  it('matches SUPERSEDED case-insensitively and ignores surrounding whitespace', () => {
    for (const loc of ['superseded', ' SUPERSEDED ', 'Superseded']) {
      expect(chooseCanonical([row({ location: loc })]).excludedSuperseded).toHaveLength(1);
    }
  });

  it('returns a null canonical when every candidate was superseded', () => {
    const r = chooseCanonical([row({ masterRow: 1, location: 'SUPERSEDED' }), row({ masterRow: 2, location: 'SUPERSEDED' })]);
    expect(r.canonical).toBeNull();
    expect(r.orphans).toHaveLength(0);
  });

  it('does NOT exclude a damaged live row that merely LOOKS retired', () => {
    // Blank pointers + a live Location is a defect, not a retirement.
    const damaged = row({ masterRow: 962, location: 'BOTH', googleRow: null, attioRecordId: '' });
    const r = chooseCanonical([damaged, row({ masterRow: 40 })]);
    expect(r.excludedSuperseded).toHaveLength(0);
    expect(r.orphans.map((o) => o.masterRow)).toEqual([962]);
  });
});

describe('groupBySharedAttioPointer - the 245-blank-Attio-ID trap', () => {
  it('a BLANK Attio_Record_ID is NEVER a shared value', () => {
    // The literal reading of "two or more rows share the same attio_record_id"
    // would make one 245-row group out of the blanks and "fix" 244 of them.
    const blanks = Array.from({ length: 245 }, (_, i) => row({ masterRow: i + 1, attioRecordId: '' }));
    expect(groupBySharedAttioPointer(blanks).size).toBe(0);
  });

  it('whitespace-only is also not a shared value', () => {
    const rows = [row({ masterRow: 1, attioRecordId: '  ' }), row({ masterRow: 2, attioRecordId: '' })];
    expect(groupBySharedAttioPointer(rows).size).toBe(0);
  });

  it('groups only genuinely shared, populated pointers', () => {
    const groups = groupBySharedAttioPointer([
      row({ masterRow: 1, attioRecordId: 'rec-shared' }),
      row({ masterRow: 2, attioRecordId: 'rec-shared' }),
      row({ masterRow: 3, attioRecordId: 'rec-alone' }),
      row({ masterRow: 4, attioRecordId: '' }),
    ]);
    expect([...groups.keys()]).toEqual(['rec-shared']);
    expect(groups.get('rec-shared')!.map((r) => r.masterRow)).toEqual([1, 2]);
  });

  it('a blank-pointer row can still be scored by PASS 3 - the filter is S4-only', () => {
    // S1 groups by duplicate BHC_ID, and those rows may legitimately have no
    // Attio pointer. The blank rule belongs to S4 grouping, not to the scorer.
    const r = chooseCanonical([row({ masterRow: 5, attioRecordId: '' }), row({ masterRow: 9, attioRecordId: '' })]);
    expect(r.canonical!.masterRow).toBe(5);
  });
});

// ─── 2. the name gate ───────────────────────────────────────────────────────
describe('nameGate - PASS 4 / 6.5 Step 1.5', () => {
  it('PROCEEDs on at least one significant word in common', () => {
    const g = nameGate('Rachel Marantz-Cohen', 'Rachel Marantz');
    expect(g.decision).toBe('PROCEED');
    expect(g.verdict).toBe('MATCH');
    expect(g.sharedWords.length).toBeGreaterThan(0);
  });

  it('NEEDS_MANUAL on zero words in common - the wrong-person case', () => {
    const g = nameGate('Joel Eby', 'Bo Geddes');
    expect(g.decision).toBe('NEEDS_MANUAL');
    expect(g.verdict).toBe('MISMATCH');
  });

  it('NEEDS_MANUAL when the name is unavailable, with a DIFFERENT reason', () => {
    // The spec writes a different note for each case, so the two must stay
    // distinguishable rather than collapsing into one boolean.
    const missing = nameGate('', 'Bo Geddes');
    expect(missing.decision).toBe('NEEDS_MANUAL');
    expect(missing.verdict).toBe('UNVERIFIABLE');
    expect(missing.reason).not.toBe(nameGate('Joel Eby', 'Bo Geddes').reason);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(namePasses("o'brien, sean", 'Sean OBrien')).toBe(true);
  });

  it('handles null/undefined without throwing', () => {
    expect(nameGate(null, 'Bo Geddes').decision).toBe('NEEDS_MANUAL');
    expect(nameGate('Bo Geddes', undefined).decision).toBe('NEEDS_MANUAL');
  });
});

describe('nameGate - the particle-exclusion set', () => {
  it('NO particle alone ever counts as a shared word', () => {
    // Every particle the spec names: the, of, a, an, and, de, van, von.
    for (const p of ['the', 'of', 'a', 'an', 'and', 'de', 'van', 'von']) {
      expect(namePasses(`${p} Smithson`, `${p} Kowalczyk`)).toBe(false);
    }
  });

  it('uses the SAME particle set as the shared name module - not a second copy', () => {
    expect([...NAME_PARTICLES].sort()).toEqual(['a', 'an', 'and', 'de', 'of', 'the', 'van', 'von']);
  });

  it('still matches when a real word is shared alongside a particle', () => {
    expect(namePasses('Ludwig van Beethoven', 'van Beethoven')).toBe(true);
  });

  it('rejects two names sharing only particles, even several of them', () => {
    expect(namePasses('the Duke of Aquitaine', 'the Earl of Sandwich')).toBe(false);
  });
});

// ─── 3. the email list builder ──────────────────────────────────────────────
describe('buildEmailList - PASS 6.5 Step 2, Email', () => {
  it('puts the new primary first and PRESERVES secondaries in order', () => {
    expect(buildEmailList(['old@x.com', 'a@x.com', 'b@x.com'], 'new@x.com'))
      .toEqual(['new@x.com', 'old@x.com', 'a@x.com', 'b@x.com']);
  });

  it('removes a case-insensitive duplicate of the new primary', () => {
    expect(buildEmailList(['a@x.com', 'NEW@X.com', 'b@x.com'], 'new@x.com'))
      .toEqual(['new@x.com', 'a@x.com', 'b@x.com']);
  });

  it('promotes an address that was already present but not primary', () => {
    expect(buildEmailList(['first@x.com', 'target@x.com'], 'target@x.com'))
      .toEqual(['target@x.com', 'first@x.com']);
  });

  it('is idempotent when the primary is already correct', () => {
    const list = ['p@x.com', 's@x.com'];
    expect(buildEmailList(buildEmailList(list, 'p@x.com'), 'p@x.com')).toEqual(list);
  });

  it('handles an empty current list', () => {
    expect(buildEmailList([], 'only@x.com')).toEqual(['only@x.com']);
  });

  it('drops whitespace-only entries rather than writing junk back', () => {
    expect(buildEmailList(['  ', 'keep@x.com', ''], 'new@x.com')).toEqual(['new@x.com', 'keep@x.com']);
  });

  it('trims the incoming primary', () => {
    expect(buildEmailList(['a@x.com'], '  new@x.com  ')).toEqual(['new@x.com', 'a@x.com']);
  });

  it('never emits the primary twice, even with several case variants present', () => {
    const out = buildEmailList(['NEW@x.com', 'new@X.COM', 'other@x.com'], 'new@x.com');
    expect(out).toEqual(['new@x.com', 'other@x.com']);
    expect(out.filter((e) => e.toLowerCase() === 'new@x.com')).toHaveLength(1);
  });

  it('THROWS on a blank primary rather than clearing a real email', () => {
    expect(() => buildEmailList(['real@x.com'], '')).toThrow(/blank/);
    expect(() => buildEmailList(['real@x.com'], '   ')).toThrow(/blank/);
  });

  it('does not mutate the caller\'s array', () => {
    const original = ['a@x.com', 'b@x.com'];
    buildEmailList(original, 'new@x.com');
    expect(original).toEqual(['a@x.com', 'b@x.com']);
  });
});
