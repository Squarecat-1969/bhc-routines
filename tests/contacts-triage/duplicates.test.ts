/**
 * STEP 1c duplicate detection — pure, no credentials.
 *
 * ⚠ FIXTURES ARE THE REAL RECORDS, read live from Attio on 2026-09-04, not a
 * tidied version. That matters more here than anywhere else in this routine:
 * the awkward cases ARE the logic. Three of the seven live exact-name hits are
 * WRONG — two typo-domain records and a one-token name collision — and an
 * idealised "two records with the same name" fixture would exercise none of
 * the machinery that catches them. Idealised fixtures have four times this
 * month produced tests that passed without exercising what they named.
 *
 * Every guard below has been mutation-checked: neutered, confirmed failing,
 * restored, confirmed passing. See docs/contacts-triage-notes.md #21.
 */

import { describe, expect, it } from 'vitest';

import {
  buildBridgedNameIndex,
  canonicalBhcIdIn,
  crmTypoHits,
  detectDuplicates,
  editDistance,
  isSingleTokenKey,
  normalizeLocalPart,
  typoDomainHits,
  unbridgedSide,
  type DuplicateSide,
} from '../../src/passes/contacts-triage/duplicates.js';
import { readSuppressionIndex } from '../../src/passes/contacts-triage/suppression.js';
import type { SheetRow } from '../../src/lib/sheets.js';
import type { UnbridgedContact } from '../../src/passes/contacts-triage/types.js';
import { contact } from './fixtures.js';

// --- The real records. -------------------------------------------------------

/** Bridged sides always go through `unbridgedSide` + a BHC_ID so nameKey is derived, never hand-written. */
function bridgedFrom(bhcId: string, c: Partial<UnbridgedContact>): DuplicateSide {
  return { ...unbridgedSide(contact(c)), bhcId };
}

// BHC-02386 — Zoe Cattolico, the worked example of the correct END STATE:
// ONE record carrying BOTH a @thenewblank.com and an @xa.epicgames.com address.
const ZOE = bridgedFrom('BHC-02386', {
  attioRecordId: 'zoe-bridged',
  name: 'Zoe Cattolico',
  primaryEmail: 'zoec@thenewblank.com',
  allEmails: ['zoec@thenewblank.com', 'zoe.cattolico@xa.epicgames.com'],
});

// BHC-02338 — Chuck Granade, likewise already consolidated.
const CHUCK_BRIDGED = bridgedFrom('BHC-02338', {
  attioRecordId: 'chuck-bridged',
  name: 'Chuck Granade',
  primaryEmail: 'chuck@thenewblank.com',
  allEmails: [
    'chuck@thenewblank.com',
    'chuck@crrnt.co',
    'cgranade01@comcast.net',
    // Real, from the live record. It puts gmail.com on TWO bridged records
    // alongside an owned address (Chuck and June), clearing
    // COLOCATED_MIN_RECORDS — so the freemail exclusion is the ONLY thing
    // keeping it out of the co-located set, and the test below can prove it.
    'cgranade01@gmail.com',
    'chuck.granade@xa.epicgames.com',
  ],
  linkedin: 'https://www.linkedin.com/in/cgranade',
  companyRecordId: 'co-tnb',
});

// BHC-01917 — June Yang, bridged on her TNB address only. Her Epic address is
// on a SEPARATE unbridged record: the flagship merge case.
const JUNE_BRIDGED = bridgedFrom('BHC-01917', {
  attioRecordId: 'june-bridged',
  name: 'June Yang',
  primaryEmail: 'juney@thenewblank.com',
  allEmails: ['juney@thenewblank.com', 'juneyang.bln@gmail.com'],
  companyRecordId: 'co-tnb',
});

// BHC-01225 — "Le", a one-token name at the New York Times.
const LE_BRIDGED = bridgedFrom('BHC-01225', {
  attioRecordId: 'le-bridged',
  name: 'Le',
  primaryEmail: 'nytmobile@nytimes.com',
  allEmails: ['nytmobile@nytimes.com'],
  companyRecordId: 'co-nyt',
});

// BHC-00679 — Raymond WORSDALE, active at NBCUniversal. The live proof that
// `verifyName` (one significant word in common) is the wrong gate here.
const WORSDALE = bridgedFrom('BHC-00679', {
  attioRecordId: 'worsdale-bridged',
  name: 'Raymond Worsdale',
  primaryEmail: 'raymond.worsdale@nbcuni.com',
  allEmails: ['raymond.worsdale@nbcuni.com'],
});

// BHC-00511 — Kim Adelman at EarthLink. An unbridged Kim Adelman exists on a
// @thenewblank.com address; name alone is all that connects them.
const KIM_BRIDGED = bridgedFrom('BHC-00511', {
  attioRecordId: 'kim-bridged',
  name: 'Kim Adelman',
  primaryEmail: 'kadelman@earthlink.net',
  allEmails: ['kadelman@earthlink.net'],
  companyRecordId: 'co-earthlink',
  linkedin: 'https://www.linkedin.com/in/kim-adelman-781ba012',
});

/** Enough bridged records to clear COLOCATED_MIN_RECORDS for xa.epicgames.com. */
const BRIDGED_ALL = [ZOE, CHUCK_BRIDGED, JUNE_BRIDGED, LE_BRIDGED, WORSDALE, KIM_BRIDGED];

// --- The real unbridged records. ---------------------------------------------

const JUNE_UNBRIDGED = contact({
  attioRecordId: '9a380247',
  name: 'June Yang',
  primaryEmail: 'june.yang@xa.epicgames.com',
  allEmails: ['june.yang@xa.epicgames.com'],
  companyRecordId: 'co-epic',
});

const CHUCK_TYPO = contact({
  attioRecordId: '16a589c8',
  name: 'Chuck Granade',
  primaryEmail: 'chuck@thenewblanks.com',
  allEmails: ['chuck@thenewblanks.com'],
  companyRecordId: 'co-typo',
});

const LE_UNBRIDGED = contact({
  attioRecordId: 'b7d8e0be',
  name: 'Le',
  primaryEmail: 'buvashle@amazon.com',
  allEmails: ['buvashle@amazon.com'],
  companyRecordId: 'co-amazon',
});

const KIM_UNBRIDGED = contact({
  attioRecordId: '3485efd0',
  name: 'Kim Adelman',
  primaryEmail: 'kima@thenewblank.com',
  allEmails: ['kima@thenewblank.com'],
  companyRecordId: 'co-tnb',
});

// Raymond Yang: TWO unbridged records, no bridged one — BHC-01889 was retired.
// Master_ID row 456 asks step 2 by name to surface these as ONE candidate.
const RAYMOND_EPIC = contact({
  attioRecordId: '97af6c95',
  name: 'Raymond Yang',
  primaryEmail: 'raymond.yang@xa.epicgames.com',
  allEmails: ['raymond.yang@xa.epicgames.com'],
  companyRecordId: 'co-epic',
});
const RAYMOND_TNB = contact({
  attioRecordId: 'fd52a57d',
  name: 'Raymond Yang',
  primaryEmail: 'raymondy@thenewblank.com',
  allEmails: ['raymondy@thenewblank.com'],
  companyRecordId: null,
});

const masterRow = (a: string, b: string, c: string, f: string): SheetRow => [a, b, c, '', '', f];
const SUPPRESSION = readSuppressionIndex([
  masterRow(
    '',
    'Raymond Yang',
    'SUPERSEDED',
    'SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an external contact. Attio record 9878628f deleted.',
  ),
  masterRow(
    '',
    'Ronald Buse',
    'SUPERSEDED',
    'ORPHAN CLEARED: duplicate of BHC-00293 (Ron Buse, Google_Row 293). Same person, same employer.',
  ),
]);

function detect(unbridged: readonly UnbridgedContact[], bridgedSides = BRIDGED_ALL) {
  return detectDuplicates({
    unbridged,
    index: buildBridgedNameIndex(bridgedSides),
    suppression: SUPPRESSION,
  });
}

// --- helpers ------------------------------------------------------------------

describe('editDistance', () => {
  it('measures thenewblanks.com as one edit from the owned domain', () => {
    expect(editDistance('thenewblanks.com', 'thenewblank.com')).toBe(1);
  });
  it('is zero for the owned domain itself', () => {
    expect(editDistance('thenewblank.com', 'thenewblank.com')).toBe(0);
  });
});

describe('normalizeLocalPart', () => {
  it('strips punctuation and plus-tags', () => {
    expect(normalizeLocalPart('June.Yang+news@xa.epicgames.com')).toBe('juneyang');
  });
  it('does NOT collapse juney and june.yang into the same value', () => {
    // A real near-miss. If this ever returns equal, the local-part signal has
    // silently widened into a fuzzy matcher and its precision claim is void.
    expect(normalizeLocalPart('juney@thenewblank.com')).not.toBe(
      normalizeLocalPart('june.yang@xa.epicgames.com'),
    );
  });
});

describe('typoDomainHits', () => {
  it('flags the live typo domain', () => {
    expect(typoDomainHits(['chuck@thenewblanks.com'])).toEqual([
      { email: 'chuck@thenewblanks.com', domain: 'thenewblanks.com', nearest: 'thenewblank.com', distance: 1 },
    ]);
  });

  it('NEVER flags the owned domain itself', () => {
    // The guard that keeps every genuine TNB staff address out of the exclude
    // bucket. Under the 2026-09-04 policy those people ARE contacts.
    expect(typoDomainHits(['chuck@thenewblank.com', 'zoec@thenewblank.com'])).toEqual([]);
    // ...and it is the ONLY thing standing in the way once two owned domains
    // are within one edit of each other. With the live single-domain list this
    // case cannot arise, so it is injected rather than asserted as dead.
    expect(typoDomainHits(['a@thenewblank.co'], ['thenewblank.com', 'thenewblank.co'])).toEqual([]);
  });

  it('does not flag an unrelated domain', () => {
    expect(typoDomainHits(['jane@dcsg.com', 'x@xa.epicgames.com'])).toEqual([]);
  });

  it('stops at ONE edit — two is not a typo', () => {
    // `thenewblanks.co` is two edits away (an inserted `s`, a dropped `m`).
    // Widening the threshold starts matching real unrelated domains.
    expect(typoDomainHits(['a@thenewblanks.co'])).toEqual([]);
  });

  it('refuses to treat a SHORT domain as a typo of a short owned domain', () => {
    // Unreachable with the live owned list (nothing is one edit from
    // `thenewblank.com` and shorter than 14 chars), so it is exercised with an
    // injected one rather than asserted as a dead branch. Without the floor,
    // `tnb.io` would be read as a typo of `tnb.co` and every address there
    // would surface as misaddressed mail.
    expect(typoDomainHits(['a@tnb.io'], ['tnb.co'])).toEqual([]);
    // Short on the OTHER side alone is enough to reject it too — the floor is
    // applied to the pair, not to one side.
    expect(typoDomainHits(['a@tnb.com'], ['tnbg.com'])).toEqual([]);
    // The same shape clears the floor once both domains are long enough.
    expect(typoDomainHits(['a@tnbgroup.io'], ['tnbgroup.co'])).toHaveLength(1);
  });
});

describe('crmTypoHits — CRM-as-reference typo detection', () => {
  const index = () => buildBridgedNameIndex(BRIDGED_ALL);

  it('flags the live pair: same local part, one-character domain difference', () => {
    // `chuck@thenewblanks.com` against `chuck@thenewblank.com`, which is on
    // BHC-02338 — an address a human accepted and that works.
    const hits = crmTypoHits(['chuck@thenewblanks.com'], index());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.referenceEmail).toBe('chuck@thenewblank.com');
    expect(hits[0]!.reference.bhcId).toBe('BHC-02338');
    expect(hits[0]!.distance).toBe(1);
  });

  // ⚠⚠ THE TEST THIS WHOLE DESIGN EXISTS FOR.
  it('produces ZERO candidates for same-domain near-miss LOCAL PARTS', () => {
    // `jim@acme.com` and `tim@acme.com` are Levenshtein 1 and they are
    // colleagues. `raymondy@` and `raymondz@` likewise. The signal is
    // asymmetric: the local part must match EXACTLY and only the domain may
    // vary. A test exercising only the positive case would pass without this
    // guard and prove nothing.
    const colleagues = buildBridgedNameIndex([
      bridgedFrom('BHC-07001', {
        attioRecordId: 'jim-bridged',
        name: 'Jim Acme',
        primaryEmail: 'jim@acmecorp.com',
        allEmails: ['jim@acmecorp.com'],
      }),
      bridgedFrom('BHC-07002', {
        attioRecordId: 'raymondy-bridged',
        name: 'Raymond Yates',
        primaryEmail: 'raymondy@bigcompany.com',
        allEmails: ['raymondy@bigcompany.com'],
      }),
    ]);
    expect(crmTypoHits(['tim@acmecorp.com'], colleagues)).toEqual([]);
    expect(crmTypoHits(['raymondz@bigcompany.com'], colleagues)).toEqual([]);
    // ...and the same holds through the whole detector, not just this function.
    const viaDetector = detectDuplicates({
      unbridged: [
        contact({
          attioRecordId: 'tim',
          name: 'Tim Acme',
          primaryEmail: 'tim@acmecorp.com',
          allEmails: ['tim@acmecorp.com'],
        }),
      ],
      index: colleagues,
      suppression: SUPPRESSION,
    });
    expect(viaDetector.crmTypoCandidates).toBe(0);
    expect(viaDetector.candidates).toEqual([]);
  });

  it('produces ZERO candidates when the local part AND the domain both vary', () => {
    // "Never both varying at once." Two near-misses stacked is not stronger
    // evidence, it is a second guess on top of the first.
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07014', {
        attioRecordId: 'jim2',
        name: 'Jim Acme',
        primaryEmail: 'jim@acmecorp.com',
        allEmails: ['jim@acmecorp.com'],
      }),
    ]);
    expect(crmTypoHits(['tim@acmecorpp.com'], idx)).toEqual([]);
  });

  it('does not match a DIFFERENT local part that happens to sit on the same reference record', () => {
    // A bridged record carries several addresses. Only the one whose local
    // part actually matches may be compared — otherwise the record's first
    // address gets compared against a suspect it has nothing to do with, and
    // the "exact local part" claim quietly becomes "the record has this local
    // part somewhere".
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07011', {
        attioRecordId: 'multi',
        name: 'Nina Park',
        primaryEmail: 'ops@harborlight.com',
        allEmails: ['ops@harborlight.com', 'ninap@quitedifferent.com'],
      }),
    ]);
    // `ninap@harborlights.com` is one edit from `harborlight.com` — but that
    // domain belongs to `ops@`, not to `ninap@`.
    expect(crmTypoHits(['ninap@harborlights.com'], idx)).toEqual([]);
  });

  it('never varies the local part — no normalisation, no fuzzing', () => {
    // `john.smith@` and `johnsmith@` are the same person in practice, and that
    // is exactly why matching them here is forbidden: it is local-part
    // variance, the half of the signal that is not safe.
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07003', {
        attioRecordId: 'js-bridged',
        name: 'John Smith',
        primaryEmail: 'johnsmith@examplecorp.com',
        allEmails: ['johnsmith@examplecorp.com'],
      }),
    ]);
    expect(crmTypoHits(['john.smith@examplecorpp.com'], idx)).toEqual([]);

    // ...and symmetrically, with the punctuation on the BRIDGED side. Checking
    // only one direction leaves the other side free to normalise unnoticed.
    const dotted = buildBridgedNameIndex([
      bridgedFrom('BHC-07012', {
        attioRecordId: 'js-dotted',
        name: 'John Smith',
        primaryEmail: 'john.smith@examplecorp.com',
        allEmails: ['john.smith@examplecorp.com'],
      }),
    ]);
    expect(crmTypoHits(['johnsmith@examplecorpp.com'], dotted)).toEqual([]);
  });

  it('still matches a PUNCTUATED local part against itself', () => {
    // The index key and the lookup have to be derived the same way. If they
    // drift the failure is silent and looks safe — punctuated local parts just
    // stop matching and the arm quietly finds less. `mary-jane@` is the case
    // that shows it; `chuck@` never could, because it has nothing to strip.
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07015', {
        attioRecordId: 'mj',
        name: 'Mary-Jane Ellis',
        primaryEmail: 'mary-jane@northwindmedia.com',
        allEmails: ['mary-jane@northwindmedia.com'],
      }),
    ]);
    const hits = crmTypoHits(['mary-jane@northwindmedias.com'], idx);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.referenceEmail).toBe('mary-jane@northwindmedia.com');
  });

  it('refuses a domain that is ALREADY on a bridged record', () => {
    // Both known-good, so neither is a typo of the other — the direct analogue
    // of "an owned domain is never its own typo". Without this, two legitimate
    // near-named client domains would flag each other forever.
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07004', {
        attioRecordId: 'a1',
        name: 'Alex One',
        primaryEmail: 'alex@brightwater.com',
        allEmails: ['alex@brightwater.com'],
      }),
      bridgedFrom('BHC-07005', {
        attioRecordId: 'a2',
        name: 'Alex Two',
        primaryEmail: 'alex@brightwaters.com',
        allEmails: ['alex@brightwaters.com'],
      }),
    ]);
    expect(crmTypoHits(['alex@brightwaters.com'], idx)).toEqual([]);
  });

  it('refuses a generic role local part', () => {
    // The spec's recorded failure of the local-part signal: "every info@ and
    // sales@ pair across unrelated domains". An exact match on `info` carries
    // no identity at all.
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07006', {
        attioRecordId: 'i1',
        name: 'Info Desk',
        primaryEmail: 'info@companyname.com',
        allEmails: ['info@companyname.com'],
      }),
    ]);
    expect(crmTypoHits(['info@companynames.com'], idx)).toEqual([]);
    // A real personal local part at the very same domain pair DOES flag, so
    // the rejection above is the role rule and not the distance test.
    expect(crmTypoHits(['marcus@companynames.com'], buildBridgedNameIndex([
      bridgedFrom('BHC-07007', {
        attioRecordId: 'm1',
        name: 'Marcus Reed',
        primaryEmail: 'marcus@companyname.com',
        allEmails: ['marcus@companyname.com'],
      }),
    ]))).toHaveLength(1);
  });

  it('refuses freemail on the SUSPECT side', () => {
    // The reference here is NOT freemail, so this isolates the suspect-side
    // guard. Checking both sides in one assertion lets either guard cover for
    // the other and neither gets tested.
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07008', {
        attioRecordId: 'g1',
        name: 'Grace Hall',
        primaryEmail: 'gracehall@xmail.com',
        allEmails: ['gracehall@xmail.com'],
      }),
    ]);
    expect(crmTypoHits(['gracehall@ymail.com'], idx)).toEqual([]);
  });

  it('refuses freemail on the REFERENCE side', () => {
    // `gracehall@gmial.com` really is a plausible typo of `@gmail.com`, and it
    // is refused anyway: `john` at gmail and `john` at ymail are two humans,
    // and these namespaces have millions of users. The trade is deliberate and
    // recorded — see the doc comment on crmTypoHits.
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07013', {
        attioRecordId: 'g2',
        name: 'Grace Hall',
        primaryEmail: 'gracehall@gmail.com',
        allEmails: ['gracehall@gmail.com'],
      }),
    ]);
    expect(crmTypoHits(['gracehall@gmial.com'], idx)).toEqual([]);
  });

  it('stops beyond two edits', () => {
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07009', {
        attioRecordId: 'd1',
        name: 'Dana West',
        primaryEmail: 'danaw@northwindmedia.com',
        allEmails: ['danaw@northwindmedia.com'],
      }),
    ]);
    expect(crmTypoHits(['danaw@northwindmedias.com'], idx)).toHaveLength(1); // 1 edit
    expect(crmTypoHits(['danaw@northwindmediass.com'], idx)).toHaveLength(1); // 2 edits
    expect(crmTypoHits(['danaw@northwindmediasss.com'], idx)).toEqual([]); // 3
  });

  it('refuses a short domain pair', () => {
    const idx = buildBridgedNameIndex([
      bridgedFrom('BHC-07010', {
        attioRecordId: 's1',
        name: 'Sam Ko',
        primaryEmail: 'samko@tnb.co',
        allEmails: ['samko@tnb.co'],
      }),
    ]);
    expect(crmTypoHits(['samko@tnb.io'], idx)).toEqual([]);
  });

  it('takes its reference ONLY from bridged records, never from unbridged ones', () => {
    // An unbridged record is what is under suspicion. Letting one act as the
    // reference would let a typo vouch for itself.
    const noBridged = buildBridgedNameIndex([]);
    expect(crmTypoHits(['chuck@thenewblanks.com'], noBridged)).toEqual([]);
    const viaDetector = detectDuplicates({
      unbridged: [
        contact({
          attioRecordId: 'u1',
          name: 'Nina Park',
          primaryEmail: 'ninap@harborlight.com',
          allEmails: ['ninap@harborlight.com'],
        }),
        contact({
          attioRecordId: 'u2',
          name: 'Nina Park',
          primaryEmail: 'ninap@harborlights.com',
          allEmails: ['ninap@harborlights.com'],
        }),
      ],
      index: noBridged,
      suppression: SUPPRESSION,
    });
    expect(viaDetector.crmTypoCandidates).toBe(0);
  });

  it('emits one hit per reference record, not one per address on it', () => {
    // BHC-02338 carries BOTH `chuck@thenewblank.com` and `chuck@crrnt.co`, so
    // the same local part lands on the record twice. The first live
    // measurement emitted Chuck's candidate twice because of it.
    const hits = crmTypoHits(['chuck@thenewblanks.com'], index());
    expect(hits).toHaveLength(1);
    expect(index().byEmailLocalPart.get('chuck')).toHaveLength(1);
  });
});

describe('canonicalBhcIdIn', () => {
  it('reads the BHC_ID out of a real ORPHAN CLEARED annotation', () => {
    expect(canonicalBhcIdIn('ORPHAN CLEARED: duplicate of BHC-00293 (Ron Buse, Google_Row 293)')).toBe('BHC-00293');
  });
  it('reads the other live phrasing', () => {
    expect(canonicalBhcIdIn('ORPHAN CLEARED: Andrew Kobliska is BHC-01541 at Master_ID row 1572')).toBe('BHC-01541');
  });
  it('returns null rather than guessing when none is named', () => {
    expect(canonicalBhcIdIn('ORPHAN CLEARED: identity resolved by hand')).toBeNull();
  });
});

describe('isSingleTokenKey', () => {
  it('is true for the live one-token collision', () => {
    expect(isSingleTokenKey('le')).toBe(true);
  });
  it('is false for a two-word name', () => {
    expect(isSingleTokenKey('june yang')).toBe(false);
  });
});

// --- the matcher ---------------------------------------------------------------

describe('name matching', () => {
  it('does NOT match Raymond Yang against Raymond Worsdale', () => {
    // THE test. `verifyName` passes this pair on the shared word `raymond`,
    // and Worsdale is an active bridged contact at NBCUniversal. Exact set
    // equality is the only thing standing between detection and proposing a
    // merge of two unrelated people.
    const result = detect([RAYMOND_EPIC]);
    const raymond = result.candidates.find((c) => c.subject.attioRecordId === '97af6c95');
    expect(raymond?.bridgedMatches ?? []).toEqual([]);
    expect(result.exactNameAgainstBridged).toBe(0);
  });

  it('matches regardless of word order', () => {
    const reversed = contact({ attioRecordId: 'rev', name: 'Yang, June', allEmails: ['x@example.com'] });
    expect(detect([reversed]).exactNameAgainstBridged).toBe(1);
  });

  it('does not match on a subset of the words', () => {
    const partial = contact({ attioRecordId: 'p', name: 'June', allEmails: ['x@example.com'] });
    expect(detect([partial]).exactNameAgainstBridged).toBe(0);
  });
});

describe('detectDuplicates', () => {
  it('raises June Yang as a merge into the bridged record, at medium confidence', () => {
    const c = detect([JUNE_UNBRIDGED]).candidates[0]!;
    expect(c.kind).toBe('merge-into-bridged');
    expect(c.confidence).toBe('medium');
    expect(c.bridgedMatches.map((b) => b.bhcId)).toEqual(['BHC-01917']);
    // The owned-domain pairing is what raises it, and it is derived from live
    // co-location (Zoe and Chuck both carry both), not hardcoded.
    expect(c.corroboration.join(' ')).toContain('owned-domain pairing');
    // ⚠ The card's wording has to say what a merge DOES here.
    expect(c.proposedAction).toContain('CONSOLIDATES BOTH ADDRESSES');
  });

  it('classifies the typo domain as EXCLUDE, not merge, even though the name matches a bridged record', () => {
    const c = detect([CHUCK_TYPO]).candidates[0]!;
    expect(c.kind).toBe('exclude-typo-domain');
    expect(c.proposedAction).toContain('EXCLUDE');
    expect(c.proposedAction).not.toContain('MERGE');
    // The bridged record is still shown — it is the evidence, not the target.
    expect(c.bridgedMatches.map((b) => b.bhcId)).toEqual(['BHC-02338']);
    expect(c.cautions.join(' ')).toContain('TYPO DOMAIN');
  });

  it('locks the one-token name collision at LOW confidence', () => {
    const c = detect([LE_UNBRIDGED]).candidates[0]!;
    expect(c.kind).toBe('merge-into-bridged');
    expect(c.confidence).toBe('low');
    expect(c.cautions.join(' ')).toContain('ONE-TOKEN NAME');
  });

  it('keeps a one-token name LOW even when corroboration would otherwise say high', () => {
    // The live MOHAI pair: membership@mohai.org and digital@mohai.org, two
    // unbridged records with the SAME one-word name and the same Attio company
    // record. Shared company is the strongest corroborating signal there is,
    // and it still must not turn a single shared word into an identity — two
    // role mailboxes at one organisation are not one person.
    const a = contact({
      attioRecordId: '69ccc938',
      name: 'MOHAI',
      primaryEmail: 'membership@mohai.org',
      allEmails: ['membership@mohai.org'],
      companyRecordId: 'co-mohai',
    });
    const b = contact({
      attioRecordId: 'eed021c0',
      name: 'MOHAI',
      primaryEmail: 'digital@mohai.org',
      allEmails: ['digital@mohai.org'],
      companyRecordId: 'co-mohai',
    });
    const result = detect([a, b]);
    expect(result.candidates).toHaveLength(2);
    for (const c of result.candidates) {
      expect(c.kind).toBe('consolidate-unbridged');
      expect(c.corroboration.join(' ')).toContain('same Attio company record');
      expect(c.confidence).toBe('low');
    }
  });

  it('keeps a name-only match at LOW confidence', () => {
    // Kim Adelman: same name, different company, one side has a LinkedIn and
    // one does not, no shared local part, no owned-domain pairing. Name alone
    // is weak and the report must say so rather than flattering the match.
    const c = detect([KIM_UNBRIDGED]).candidates[0]!;
    expect(c.confidence).toBe('low');
    expect(c.distinguishing.join(' ')).toContain('different companies');
    expect(c.distinguishing.join(' ')).toContain('only one side has a LinkedIn URL');
  });

  it('raises the two unbridged Raymond Yang records as ONE consolidate candidate each', () => {
    // Master_ID row 456: "Un-suppressing before step 2's duplicate detection
    // exists would let both enter triage and mint TWO BHC_IDs for one person."
    const result = detect([RAYMOND_EPIC, RAYMOND_TNB]);
    expect(result.unbridgedClusters).toBe(1);
    const kinds = result.candidates.map((c) => c.kind);
    expect(kinds).toEqual(['consolidate-unbridged', 'consolidate-unbridged']);
    for (const c of result.candidates) {
      expect(c.unbridgedSiblings).toHaveLength(1);
      expect(c.cautions.join(' ')).toContain('NEITHER record carries a BHC_ID');
      // The retirement is quoted, not silently applied — a human decision that
      // says "TNB staff" no longer holds under the 2026-09-04 policy.
      expect(c.cautions.join(' ')).toContain('SCRAPPED 2026-08-05');
    }
    expect(result.candidates[0]!.confidence).toBe('medium');
  });

  it('turns an ORPHAN CLEARED match into a repoint naming the canonical BHC_ID', () => {
    const ron = contact({ attioRecordId: 'ron', name: 'Ronald Buse', allEmails: ['ron.buse@abc.com'] });
    const c = detect([ron]).candidates[0]!;
    expect(c.kind).toBe('repoint');
    expect(c.repointTo).toBe('BHC-00293');
    expect(c.proposedAction).toContain('REPOINT to BHC-00293');
  });

  it('warns when two BRIDGED records share the name, and downgrades confidence', () => {
    const other = bridgedFrom('BHC-09999', {
      attioRecordId: 'june-2',
      name: 'June Yang',
      primaryEmail: 'june@elsewhere.com',
      allEmails: ['june@elsewhere.com'],
    });
    const c = detect([JUNE_UNBRIDGED], [...BRIDGED_ALL, other]).candidates[0]!;
    expect(c.bridgedMatches).toHaveLength(2);
    // ⚠ spec §5: merging two bridged records silently discards one BHC_ID.
    expect(c.cautions.join(' ')).toContain('SILENTLY DISCARDED');
    expect(c.confidence).toBe('low'); // downgraded from medium
  });

  it('raises to HIGH only when a strong signal corroborates the name', () => {
    // The shape Master_ID row 2013 calls conclusive in its own words:
    // "Identical LinkedIn URL (/mike-hayward-9b94804) and identical Attio
    // company record — conclusive." Name alone is never enough; this is what
    // enough looks like.
    const bridgedHayward = bridgedFrom('BHC-00145', {
      attioRecordId: 'hayward-bridged',
      name: 'Michael Hayward',
      primaryEmail: 'michael@nzgamedev.org',
      allEmails: ['michael@nzgamedev.org'],
      companyRecordId: 'co-nzgd',
      linkedin: 'https://www.linkedin.com/in/mike-hayward-9b94804',
    });
    const unbridgedHayward = contact({
      attioRecordId: 'hayward-unbridged',
      name: 'Michael Hayward',
      primaryEmail: 'mike.hayward@nzgamedev.org',
      allEmails: ['mike.hayward@nzgamedev.org'],
      companyRecordId: 'co-nzgd',
      linkedin: 'https://www.linkedin.com/in/mike-hayward-9b94804',
    });
    const c = detect([unbridgedHayward], [...BRIDGED_ALL, bridgedHayward]).candidates[0]!;
    expect(c.confidence).toBe('high');
    expect(c.corroboration.join(' ')).toContain('identical LinkedIn URL');
    expect(c.corroboration.join(' ')).toContain('same Attio company record');
  });

  it('raises a CRM-ONLY typo as EXCLUDE — no owned domain involved', () => {
    // ⚠ Every CRM hit in the LIVE population is also an owned-domain hit, so
    // without a CRM-only fixture the whole second arm could be unwired and
    // every test would still pass. This is that fixture.
    const bridgedMarcus = bridgedFrom('BHC-07020', {
      attioRecordId: 'marcus-bridged',
      name: 'Marcus Reed',
      primaryEmail: 'marcus@companyname.com',
      allEmails: ['marcus@companyname.com'],
    });
    const suspect = contact({
      attioRecordId: 'marcus-typo',
      name: null, // ⚠ no name: the address evidence has to stand alone
      primaryEmail: 'marcus@companynames.com',
      allEmails: ['marcus@companynames.com'],
    });
    const result = detect([suspect], [...BRIDGED_ALL, bridgedMarcus]);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.kind).toBe('exclude-typo-domain');
    expect(c.ownedDomainTypos).toEqual([]);
    expect(c.crmTypos).toHaveLength(1);
    expect(c.crmTypos[0]!.referenceEmail).toBe('marcus@companyname.com');
    expect(c.cautions.join(' ')).toContain('TYPO OF A KNOWN-GOOD ADDRESS');
    expect(result.crmTypoBeyondOwned).toBe(1);
  });

  it('raises a CRM typo as EXCLUDE even when nothing else matches', () => {
    // A typo record whose name resolves to nothing still has to surface — the
    // address evidence stands on its own.
    const nameless = contact({
      attioRecordId: 'nameless-typo',
      name: null,
      primaryEmail: 'chuck@thenewblanks.com',
      allEmails: ['chuck@thenewblanks.com'],
    });
    const result = detect([nameless]);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.kind).toBe('exclude-typo-domain');
    expect(c.crmTypos).toHaveLength(1);
    expect(c.cautions.join(' ')).toContain('TYPO OF A KNOWN-GOOD ADDRESS');
    expect(c.cautions.join(' ')).toContain('BHC-02338');
  });

  it('counts the CRM arm separately from the owned-domain arm', () => {
    // Live 2026-09-04 the two arms found the SAME two records and the CRM arm
    // found nothing the owned arm missed. Reported as its own number so a
    // future divergence is visible rather than absorbed into a total.
    const result = detect([CHUCK_TYPO]);
    expect(result.ownedTypoCandidates).toBe(1);
    expect(result.crmTypoCandidates).toBe(1);
    expect(result.crmTypoBeyondOwned).toBe(0);
  });

  it('says nothing about a record with no match of any kind', () => {
    const stranger = contact({ attioRecordId: 's', name: 'Nobody Here', allEmails: ['n@elsewhere.com'] });
    expect(detect([stranger]).candidates).toEqual([]);
  });

  it('never matches on a blank name', () => {
    const noName = contact({ attioRecordId: 'nn', name: null, allEmails: ['x@example.com'] });
    const blank = bridgedFrom('BHC-00001', { attioRecordId: 'b-nn', name: null, allEmails: ['y@example.com'] });
    const result = detect([noName], [...BRIDGED_ALL, blank]);
    expect(result.candidates).toEqual([]);
    expect(result.unbridgedWithoutUsableName).toBe(1);
    expect(result.bridgedWithoutUsableName).toBe(1);
  });

  it('carries a per-record app.attio.com link on every side', () => {
    const c = detect([JUNE_UNBRIDGED]).candidates[0]!;
    expect(c.subject.attioUrl).toBe('https://app.attio.com/tnb/person/9a380247/overview');
    expect(c.bridgedMatches[0]!.attioUrl).toBe('https://app.attio.com/tnb/person/june-bridged/overview');
  });

  it('records the gating without letting it filter detection', () => {
    const result = detectDuplicates({
      unbridged: [JUNE_UNBRIDGED],
      index: buildBridgedNameIndex(BRIDGED_ALL),
      suppression: SUPPRESSION,
      suppressedById: new Map([['9a380247', 'contact-exclusions (email)']]),
      hardExcludedById: new Map([['9a380247', 'thenewblank.com internal']]),
    });
    // ⚠ Still raised. A Contact_Exclusions row answers "should this be a NEW
    // contact?", not "is this address missing from an EXISTING one?".
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.gating).toEqual({
      suppressedBy: 'contact-exclusions (email)',
      hardExcludedBy: 'thenewblank.com internal',
    });
  });

  it('reproduces the whole live seven-hit shape, wrong answers included', () => {
    const LANA_BRIDGED = bridgedFrom('BHC-00692', {
      attioRecordId: 'lana-bridged',
      name: 'Lana Hougham',
      primaryEmail: 'lana@thenewblank.com',
      allEmails: ['lana@thenewblank.com'],
      companyRecordId: 'co-tnb',
    });
    const PATRICK_BRIDGED = bridgedFrom('BHC-02489', {
      attioRecordId: 'pat-bridged',
      name: 'Patrick Suarez',
      primaryEmail: 'pat@gsaproposal.com',
      allEmails: ['pat@gsaproposal.com'],
      companyRecordId: 'co-gsa',
      linkedin: 'https://www.linkedin.com/in/pat-suarez-84abb9154',
    });
    const unbridged = [
      CHUCK_TYPO,
      KIM_UNBRIDGED,
      contact({
        attioRecordId: '667cc5c8',
        name: 'Patrick Suarez',
        primaryEmail: 'gsaproposal@gmail.com',
        allEmails: ['gsaproposal@gmail.com'],
        linkedin: 'https://www.linkedin.com/in/patrick-suarez-9402661',
      }),
      contact({
        attioRecordId: '89ba4287',
        name: 'Lana Hougham',
        primaryEmail: 'lhougham@gmail.com',
        allEmails: ['lhougham@gmail.com'],
      }),
      JUNE_UNBRIDGED,
      LE_UNBRIDGED,
      contact({
        attioRecordId: 'f9c2f968',
        name: 'Lana Hougham',
        primaryEmail: 'lana@thenewblanks.com',
        allEmails: ['lana@thenewblanks.com'],
        companyRecordId: 'co-typo',
      }),
    ];
    const result = detect(unbridged, [...BRIDGED_ALL, LANA_BRIDGED, PATRICK_BRIDGED]);

    expect(result.exactNameAgainstBridged).toBe(7);
    // The two typo-domain records become EXCLUDE candidates, not merges.
    expect(result.byKind['exclude-typo-domain']).toBe(2);
    expect(result.byKind['merge-into-bridged']).toBe(5);
    // The three known-wrong hits are the two typo domains and "Le". None of
    // them is offered as a merge at anything above low confidence.
    const le = result.candidates.find((c) => c.subject.attioRecordId === 'b7d8e0be')!;
    expect(le.confidence).toBe('low');
    const merges = result.candidates.filter((c) => c.kind === 'merge-into-bridged');
    expect(merges.every((c) => c.confidence !== 'high')).toBe(true);
  });
});

describe('buildBridgedNameIndex', () => {
  it('derives xa.epicgames.com as co-located, and never freemail', () => {
    const index = buildBridgedNameIndex(BRIDGED_ALL);
    expect(index.colocatedDomains.has('xa.epicgames.com')).toBe(true);
    // June's bridged record carries a gmail address alongside her TNB one.
    // Half the workspace does; treating that as a signal would make the
    // pairing check fire on every freemail address in the population.
    expect(index.colocatedDomains.has('gmail.com')).toBe(false);
    expect(index.colocatedDomains.has('thenewblank.com')).toBe(false);
  });

  it('requires more than one record before calling a domain co-located', () => {
    // crrnt.co appears on exactly one bridged record with an owned address.
    const index = buildBridgedNameIndex(BRIDGED_ALL);
    expect(index.colocatedDomains.has('crrnt.co')).toBe(false);
  });
});
