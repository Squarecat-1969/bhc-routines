/**
 * EVERY Master_ID note against its OWN key.
 *
 * ⚠ A KEY THAT DOES NOT MATCH ITS OWN NOTE NEVER SKIPS, so that note is appended
 * again on every run — visible and non-destructive, but it grows a cell with a
 * 50,000-character ceiling. And a key that matches TOO MUCH skips a genuinely
 * new condition, which is silent. So each row checks both directions:
 *
 *   · the key matches its note, and still matches under a different run id;
 *   · the key does NOT match a different condition — including near-misses a
 *     bare substring would accept ("2 Attio records" inside "12 Attio records",
 *     "a@x.com" inside "ba@x.com").
 *
 * The exhaustiveness test at the bottom fails if a `*Note` builder is exported
 * without a row here, so a note added later cannot ship with an unchecked key.
 */

import { describe, expect, it } from 'vitest';

import * as A1 from '../../src/passes/reconciler-fix/a1.js';
import * as A3 from '../../src/passes/reconciler-fix/a3.js';
import * as I1 from '../../src/passes/reconciler-fix/i1.js';
import * as S1 from '../../src/passes/reconciler-fix/s1.js';
import * as S4 from '../../src/passes/reconciler-fix/s4.js';
import { sameCondition, type NoteKey } from '../../src/passes/reconciler-fix/master-write.js';

const RUN_A = 'RECON-FIX-1788957352183';
const RUN_B = 'RECON-FIX-1789999999999';
// UUID-shaped, like real Attio record ids.
const U1 = '97141475-87ab-4513-95ad-adcb2bf68764';
const U2 = 'c91fc34c-3edd-48cf-9856-e9902f28411b';
const U3 = 'e241eec0-db25-4413-9d31-f431c6a00001';

interface Row {
  readonly builder: string;
  readonly note: (run: string) => string;
  readonly key: NoteKey;
  /** Notes that record a DIFFERENT condition and must not be skipped as a repeat. */
  readonly different: readonly { readonly why: string; readonly note: string }[];
}

const ROWS: readonly Row[] = [
  {
    builder: 's1DuplicateNote',
    note: (r) => S1.s1DuplicateNote('BHC-00143', 'Kyle Kendrick', r),
    key: S1.s1DuplicateKey('BHC-00143'),
    different: [
      { why: 'a different duplicated BHC_ID', note: S1.s1DuplicateNote('BHC-00144', 'Kyle Kendrick', RUN_A) },
      { why: 'a BHC_ID that merely STARTS with it', note: S1.s1DuplicateNote('BHC-001430', 'Kyle Kendrick', RUN_A) },
    ],
  },
  {
    builder: 'a1NameMismatchNote',
    note: (r) => A1.a1NameMismatchNote('Kyle K', 'Kyle Kendrick', 'BHC-00143', r),
    key: A1.a1NameMismatchKey('BHC-00143'),
    different: [
      { why: 'a different expected BHC_ID', note: A1.a1NameMismatchNote('Kyle K', 'Kyle Kendrick', 'BHC-00144', RUN_A) },
      { why: 'a BHC_ID that merely STARTS with it', note: A1.a1NameMismatchNote('Kyle K', 'Kyle Kendrick', 'BHC-001430', RUN_A) },
      { why: 'the name-UNAVAILABLE note for the same BHC_ID', note: A1.a1NameUnavailableNote('BHC-00143', RUN_A) },
    ],
  },
  {
    builder: 'a1NameUnavailableNote',
    note: (r) => A1.a1NameUnavailableNote('BHC-00143', r),
    key: A1.a1NameUnavailableKey('BHC-00143'),
    different: [
      { why: 'a different expected BHC_ID', note: A1.a1NameUnavailableNote('BHC-00144', RUN_A) },
      { why: 'a BHC_ID that merely STARTS with it', note: A1.a1NameUnavailableNote('BHC-001430', RUN_A) },
      { why: 'the name-MISMATCH note for the same BHC_ID', note: A1.a1NameMismatchNote('Kyle K', 'Kyle Kendrick', 'BHC-00143', RUN_A) },
    ],
  },
  {
    builder: 'a3RepointNote',
    note: (r) => A3.a3RepointNote(U1, U2, r),
    key: A3.a3RepointKey(U2),
    different: [
      { why: 'repointed to a DIFFERENT record', note: A3.a3RepointNote(U1, U3, RUN_A) },
      { why: 'a later repoint AWAY from that record', note: A3.a3RepointNote(U2, U3, RUN_A) },
      { why: 'the Google-only A3-FIXED note', note: A3.a3GoogleOnlyNote(RUN_A) },
    ],
  },
  {
    builder: 'a3GoogleOnlyNote',
    note: (r) => A3.a3GoogleOnlyNote(r),
    key: A3.a3GoogleOnlyKey(),
    different: [
      { why: 'a repoint A3-FIXED note', note: A3.a3RepointNote(U1, U2, RUN_A) },
    ],
  },
  {
    builder: 'a3AmbiguousNote',
    note: (r) => A3.a3AmbiguousNote(2, r),
    key: A3.a3AmbiguousKey(2),
    different: [
      { why: 'a different count', note: A3.a3AmbiguousNote(3, RUN_A) },
      { why: '12 records, which CONTAINS "2 Attio records found"', note: A3.a3AmbiguousNote(12, RUN_A) },
    ],
  },
  {
    builder: 's4OrphanNote',
    note: (r) => S4.s4OrphanNote(U1, 'BHC-00143', r),
    key: S4.s4OrphanKey(U1, 'BHC-00143'),
    different: [
      { why: 'a different Attio record', note: S4.s4OrphanNote(U2, 'BHC-00143', RUN_A) },
      { why: 'a different canonical owner', note: S4.s4OrphanNote(U1, 'BHC-00144', RUN_A) },
    ],
  },
  {
    builder: 'i1NameMismatchNote',
    note: (r) => I1.i1NameMismatchNote('Kyle K', 'Kyle Kendrick', 'Email', r),
    key: I1.i1NameMismatchKey('Kyle Kendrick', 'Email'),
    different: [
      { why: 'a different FIELD', note: I1.i1NameMismatchNote('Kyle K', 'Kyle Kendrick', 'Title', RUN_A) },
      { why: 'a different Master_ID name', note: I1.i1NameMismatchNote('Kyle K', 'Kyle Kendricks', 'Email', RUN_A) },
      { why: 'a name that merely ENDS with it', note: I1.i1NameMismatchNote('Kyle K', 'Mike Kyle Kendrick', 'Email', RUN_A) },
    ],
  },
  {
    builder: 'i1PointerMismatchNote',
    note: (r) => I1.i1PointerMismatchNote('BHC-00999', 'BHC-00143', 'Email', r),
    key: I1.i1PointerMismatchKey('BHC-00143', 'Email'),
    different: [
      { why: 'a different FIELD', note: I1.i1PointerMismatchNote('BHC-00999', 'BHC-00143', 'Title', RUN_A) },
      { why: 'a different expected BHC_ID', note: I1.i1PointerMismatchNote('BHC-00999', 'BHC-00144', 'Email', RUN_A) },
      { why: 'a BHC_ID that merely STARTS with it', note: I1.i1PointerMismatchNote('BHC-00999', 'BHC-001430', 'Email', RUN_A) },
    ],
  },
  {
    builder: 'i1EmailConflictNote',
    note: (r) => I1.i1EmailConflictNote('john@x.com', r),
    key: I1.i1EmailConflictKey('john@x.com'),
    different: [
      { why: 'a different address', note: I1.i1EmailConflictNote('jane@x.com', RUN_A) },
      { why: 'an address that CONTAINS it', note: I1.i1EmailConflictNote('ajohn@x.com', RUN_A) },
    ],
  },
];

describe.each(ROWS)('$builder', (row) => {
  it('its note starts with its key\'s marker', () => {
    expect(row.note(RUN_A).startsWith(`${row.key.marker}:`)).toBe(true);
  });

  it('⚠ its own key MATCHES its note — otherwise the note appends every run', () => {
    expect(sameCondition(row.note(RUN_A), row.key)).toBe(true);
  });

  it('still matches under a DIFFERENT run id — the run is not part of the condition', () => {
    expect(sameCondition(row.note(RUN_B), row.key)).toBe(true);
  });

  it('⚠ does NOT match a different condition, including near-misses', () => {
    for (const d of row.different) expect(sameCondition(d.note, row.key), d.why).toBe(false);
  });
});

describe('the table is exhaustive', () => {
  it('⚠ every exported *Note builder in reconciler-fix has a row — a new note cannot ship with an unchecked key', () => {
    const exported = [A1, A3, I1, S1, S4]
      .flatMap((m) => Object.entries(m))
      .filter(([name, v]) => typeof v === 'function' && /Note$/.test(name))
      .map(([name]) => name)
      .sort();
    expect(ROWS.map((r) => r.builder).sort()).toEqual(exported);
  });
});
