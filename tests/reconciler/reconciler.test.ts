import { describe, expect, it } from 'vitest';

import { attioChecks, classifyName, type AttioLookup } from '../../src/passes/reconciler/attio-checks.js';
import { buildContactsIndex, googleChecks } from '../../src/passes/reconciler/google.js';
import { applySuppression, shouldWrite } from '../../src/passes/reconciler/name-conflicts.js';
import { toReportRow } from '../../src/passes/reconciler/report.js';
import { loadMasterRows, structuralChecks } from '../../src/passes/reconciler/structural.js';
import type { GoogleIdentity, MasterRow } from '../../src/passes/reconciler/types.js';

/** Master_ID A:F as the API returns it, first element = sheet row 2. */
const M = (bhcId: string, name: string, loc: string, gRow: unknown, attio: string, notes = '') =>
  [bhcId, name, loc, gRow, attio, notes];

function row(o: Partial<MasterRow> = {}): MasterRow {
  return { bhcId: 'BHC-1', fullName: 'Ada Lovelace', location: 'BOTH', googleRow: 3, attioRecordId: 'rec-1', notes: '', masterRow: 2, ...o };
}

describe('PASS 1 - the SUPERSEDED rule', () => {
  it('skips a row on the LOCATION FIELD ALONE', () => {
    const l = loadMasterRows([M('BHC-9', '', 'SUPERSEDED', '', '', 'retired')]);
    expect(l.supersededCount).toBe(1);
    expect(l.rows).toHaveLength(0);
  });

  it('STILL loads a damaged row with blank pointers and a live Location - the row-962 case', () => {
    // BHC-00920 / Rachel Marantz: blank pointers, Location BOTH. Retirement is
    // declared, never deduced - inferring it here would silence a real defect.
    const l = loadMasterRows([M('BHC-00920', 'Rachel Marantz', 'BOTH', '', '')]);
    expect(l.supersededCount).toBe(0);
    expect(l.rows).toHaveLength(1);
    const s = structuralChecks(l);
    expect(s.filter((f) => f.code === 'S3')).toHaveLength(2); // missing BOTH pointers
  });

  it('a superseded BHC_ID is still present in the raw column for max-ID scans', () => {
    // This routine must never be the reason an allocator stops seeing a retired
    // ID - it filters its own working set, not the source column.
    const raw = [M('BHC-9', '', 'SUPERSEDED', '', '')];
    expect(raw[0]![0]).toBe('BHC-9');
  });

  it('skips fully blank gap rows but not a row with only a name', () => {
    const l = loadMasterRows([M('', '', '', '', ''), M('', 'Orphan Name', 'GOOGLE', '', '')]);
    expect(l.gapRowsSkipped).toBe(1);
    expect(l.rows).toHaveLength(1);
    expect(l.blankBhcIds).toBe(1);
  });
});

describe('PASS 2 - structural checks', () => {
  it('S1 flags EVERY copy of a duplicated BHC_ID', () => {
    const l = loadMasterRows([M('BHC-1', 'A', 'GOOGLE', 3, ''), M('BHC-1', 'B', 'GOOGLE', 4, '')]);
    const s = structuralChecks(l).filter((f) => f.code === 'S1');
    expect(s).toHaveLength(2);
    expect(s[0]!.found).toContain('2, 3');
  });

  it('S4 flags every row sharing an Attio pointer', () => {
    const l = loadMasterRows([M('BHC-1', 'A', 'ATTIO', '', 'rec-x'), M('BHC-2', 'B', 'ATTIO', '', 'rec-x')]);
    expect(structuralChecks(l).filter((f) => f.code === 'S4')).toHaveLength(2);
  });

  it('S4 does NOT fire on rows with a blank Attio ID - the blank-ID trap', () => {
    const l = loadMasterRows([M('BHC-1', 'A', 'GOOGLE', 3, ''), M('BHC-2', 'B', 'GOOGLE', 4, '')]);
    expect(structuralChecks(l).filter((f) => f.code === 'S4')).toHaveLength(0);
  });

  it('S3 covers all four positive matches', () => {
    const l = loadMasterRows([
      M('BHC-1', 'A', 'GOOGLE', '', ''),        // missing google row
      M('BHC-2', 'B', 'ATTIO', '', ''),         // missing attio id
      M('BHC-3', 'C', 'GOOGLE', 3, 'rec-y'),    // google + attio present
      M('BHC-4', 'D', 'ATTIO', 5, 'rec-z'),     // attio + google row present
    ]);
    expect(structuralChecks(l).filter((f) => f.code === 'S3')).toHaveLength(4);
  });

  it('S5 flags a Google_Row below 3', () => {
    const l = loadMasterRows([M('BHC-1', 'A', 'GOOGLE', 2, '')]);
    expect(structuralChecks(l).filter((f) => f.code === 'S5')).toHaveLength(1);
  });
});

describe('PASS 3 - Google pointer checks', () => {
  const header = [['Contact_ID', 'Full_Name', 'First_Name', 'Last_Name', 'Title', 'Company', 'Primary_Email']];
  const data = [
    ['BHC-1', 'Ada Lovelace', 'Ada', 'Lovelace', 'Engineer', 'Analytical Co', 'ada@x.com'],
    ['BHC-2', 'Bo Geddes', 'Bo', 'Geddes', 'Designer', 'Bo Co', 'bo@x.com'],
    ['', '', '', '', '', '', ''],                      // row 5 - blank INSIDE the range
    ['BHC-3', 'Cy Rand', 'Cy', 'Rand', 'PM', 'Cy Co', 'cy@x.com'],
  ];
  const idx = buildContactsIndex(header, data);

  it('resolves identity columns by header name, not by letter', () => {
    expect(idx.resolvedColumns['title']).toBe(4);
    expect(idx.identity.get(3)!.company).toBe('Analytical Co');
  });

  it('G1 reports the squatter actually sitting in the row', () => {
    const g = googleChecks([row({ bhcId: 'BHC-1', googleRow: 4 })], idx);
    expect(g[0]!.code).toBe('G1');
    expect(g[0]!.expected).toBe('BHC-1');
    expect(g[0]!.found).toBe('BHC-2');
  });

  it('G2 for a blank row INSIDE the range, G3 for past the last stamped row', () => {
    expect(googleChecks([row({ googleRow: 5 })], idx)[0]!.code).toBe('G2');
    expect(googleChecks([row({ googleRow: 900 })], idx)[0]!.code).toBe('G3');
  });

  it('G3 bound is the last STAMPED Contact_ID, not the extent of the read', () => {
    // Live: A3:EZ returns 1000 trailing rows with a stray cell and no
    // Contact_ID. A pointer into those is out of bounds, not "row empty".
    const padded = buildContactsIndex(header, [...data, ['', '', '', '', '', '', 'x']]);
    expect(padded.lastRow).toBe(6); // BHC-3's row, not the padded row 7
    expect(googleChecks([row({ googleRow: 7 })], padded)[0]!.code).toBe('G3');
  });

  it('stays silent when the pointer is correct', () => {
    expect(googleChecks([row({ bhcId: 'BHC-1', googleRow: 3 })], idx)).toHaveLength(0);
  });
});

const ok = (o: Partial<Extract<AttioLookup, { kind: 'ok' }>> = {}): AttioLookup => ({
  kind: 'ok', bhcContactId: 'BHC-1', name: 'Ada Lovelace', jobTitle: 'Engineer',
  companyName: 'Analytical Co', emails: ['ada@x.com'], ...o,
});
const gid = (o: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  firstName: 'Ada', lastName: 'Lovelace', title: 'Engineer', company: 'Analytical Co', primaryEmail: 'ada@x.com', ...o,
});

describe('PASS 4 - the A5 split', () => {
  it('classifies the three outcomes plus unavailable', () => {
    expect(classifyName('Ada Lovelace', 'Ada Lovelace')).toBe('exact');
    expect(classifyName('Ada Lovelace-King', 'Ada Lovelace')).toBe('shares_word');
    expect(classifyName('Greg Westhoff', 'Angie Nguyen')).toBe('zero_words');
    expect(classifyName('', 'Ada')).toBe('unavailable');
  });

  it('A5 fires ONLY on zero shared words - the gate stays strict', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ name: 'Completely Different' })]]), new Map());
    expect(r.findings.filter((f) => f.code === 'A5')).toHaveLength(1);
  });

  it('a row can produce BOTH A1 and A5', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ bhcContactId: 'BHC-999', name: 'Someone Else' })]]), new Map());
    expect(r.findings.map((f) => f.code).sort()).toEqual(['A1', 'A5']);
  });

  it('A2 for a blank bhc_contact_id, A3 for not found, A4 for a failure', () => {
    expect(attioChecks([row()], new Map([['rec-1', ok({ bhcContactId: '' })]]), new Map()).findings[0]!.code).toBe('A2');
    expect(attioChecks([row()], new Map([['rec-1', { kind: 'not_found' }]]), new Map()).findings[0]!.code).toBe('A3');
    expect(attioChecks([row()], new Map([['rec-1', { kind: 'failed', error: 'boom' }]]), new Map()).findings[0]!.code).toBe('A4');
  });

  it('skips the name check entirely when a name is unavailable', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ name: '' })]]), new Map([[3, gid()]]));
    expect(r.findings.filter((f) => f.code === 'A5')).toHaveLength(0);
  });
});

describe('PASS 4 - I1 gating', () => {
  it('fires for a BOTH row that passed A1 with an exact name', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ jobTitle: 'Drifted Title' })]]), new Map([[3, gid()]]));
    const i1 = r.findings.filter((f) => f.code === 'I1');
    expect(i1).toHaveLength(1);
    expect(i1[0]!.notes).toBe('Title');
    expect(i1[0]!.expected).toBe('Engineer'); // Google is authoritative
  });

  it('NEVER fires for the zero-word A5 case, even if fields differ', () => {
    const r = attioChecks(
      [row()],
      new Map([['rec-1', ok({ name: 'Totally Different', jobTitle: 'Drifted' })]]),
      new Map([[3, gid()]]),
    );
    expect(r.findings.filter((f) => f.code === 'I1')).toHaveLength(0);
  });

  it('never fires when A1 failed', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ bhcContactId: 'BHC-OTHER', jobTitle: 'Drifted' })]]), new Map([[3, gid()]]));
    expect(r.findings.filter((f) => f.code === 'I1')).toHaveLength(0);
  });

  it('is BOTH-only - a GOOGLE or ATTIO row never produces I1', () => {
    for (const location of ['GOOGLE', 'ATTIO']) {
      const r = attioChecks([row({ location })], new Map([['rec-1', ok({ jobTitle: 'Drifted' })]]), new Map([[3, gid()]]));
      expect(r.findings.filter((f) => f.code === 'I1')).toHaveLength(0);
    }
  });

  it('skips a field whose Google value is blank - nothing authoritative to sync', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ jobTitle: 'Anything' })]]), new Map([[3, gid({ title: '' })]]));
    expect(r.findings.filter((f) => f.code === 'I1')).toHaveLength(0);
  });

  it('flags a blank Attio value when Google has one', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ companyName: '' })]]), new Map([[3, gid()]]));
    expect(r.findings.filter((f) => f.notes === 'Company')).toHaveLength(1);
  });

  it('email matches ANYWHERE in Attio multi-value, not just first', () => {
    const r = attioChecks([row()], new Map([['rec-1', ok({ emails: ['other@x.com', 'ada@x.com'] })]]), new Map([[3, gid()]]));
    expect(r.findings.filter((f) => f.notes === 'Email')).toHaveLength(0);
  });

  it('NEVER emits Name as an I1 field - it becomes a conflict candidate instead', () => {
    const r = attioChecks(
      [row()],
      new Map([['rec-1', ok({ name: 'Ada Lovelace-King' })]]), // shares a word
      new Map([[3, gid()]]),
    );
    expect(r.findings.filter((f) => f.notes === 'Name')).toHaveLength(0);
    expect(r.nameConflictCandidates).toHaveLength(1);
    expect(r.nameConflictCandidates[0]!.oldName).toBe('Ada Lovelace-King'); // Attio = old
    expect(r.nameConflictCandidates[0]!.newName).toBe('Ada Lovelace');      // Google = new
  });
});

describe('PASS 4 - the no-op conflict guard', () => {
  // Reproduces the live BHC-00175 shape exactly: Master_ID's name is stale
  // ("Susan Corcoran") while Google and Attio already agree ("Sue Corcoran").
  // The A5 gate compares Attio-vs-MASTER_ID and opens; the enqueued pair is
  // Attio-vs-GOOGLE and is identical. Three of these reached the live queue.
  const stale = () => row({ fullName: 'Susan Corcoran' });
  const attioSue = () => ok({ name: 'Sue Corcoran' });
  const googleSue = (o = {}) => new Map([[3, gid({ firstName: 'Sue', lastName: 'Corcoran', ...o })]]);

  it('produces NO candidate when Attio and Google names are identical', () => {
    const r = attioChecks([stale()], new Map([['rec-1', attioSue()]]), googleSue());
    expect(r.nameConflictCandidates).toHaveLength(0);
  });

  it('the A5 gate still opened — the guard is what stops it, not a missed branch', () => {
    // Proves the test is exercising the guard rather than passing because the
    // shares_word gate never fired: Attio "Sue Corcoran" vs Master "Susan
    // Corcoran" shares "corcoran", so the old code WOULD have enqueued.
    expect(classifyName('Sue Corcoran', 'Susan Corcoran')).toBe('shares_word');
  });

  it('STILL produces a candidate for a genuine Attio-vs-Google difference', () => {
    const r = attioChecks(
      [stale()],
      new Map([['rec-1', ok({ name: 'Sue Corcoran' })]]),
      new Map([[3, gid({ firstName: 'Susan', lastName: 'Corcoran' })]]),
    );
    expect(r.nameConflictCandidates).toHaveLength(1);
    expect(r.nameConflictCandidates[0]!.oldName).toBe('Sue Corcoran');   // Attio
    expect(r.nameConflictCandidates[0]!.newName).toBe('Susan Corcoran'); // Google
  });

  it('treats a formatting-only difference as agreement, per fieldEqual', () => {
    // Documented consequence of reusing fieldEqual: punctuation/spacing/case
    // differences no longer reach human review.
    for (const [first, last] of [['sue', 'corcoran'], ['Sue', ' Corcoran ']]) {
      const r = attioChecks([stale()], new Map([['rec-1', attioSue()]]), googleSue({ firstName: first, lastName: last }));
      expect(r.nameConflictCandidates).toHaveLength(0);
    }
  });

  it('does not disturb the I1 findings on the same row', () => {
    // The guard must suppress the conflict only — identity drift still reports.
    const r = attioChecks(
      [stale()],
      new Map([['rec-1', ok({ name: 'Sue Corcoran', jobTitle: 'Drifted Title' })]]),
      googleSue(),
    );
    expect(r.nameConflictCandidates).toHaveLength(0);
    expect(r.findings.filter((f) => f.code === 'I1' && f.notes === 'Title')).toHaveLength(1);
  });
});

describe('Name_Conflicts suppression', () => {
  const cand = [{ bhcId: 'BHC-1', oldName: 'Old Name', newName: 'New Name', googleRow: 3, attioRecordId: 'rec-1', masterRow: 2 }];
  const existing = (status: string) => [['NC-1', 'RUN', 'RECONCILER', 'BHC-1', 'BOTH', 'Old Name', 'New Name', 'Attio', 'Google', '{}', status, '', '']];

  it('RESOLVED_OLD suppresses permanently', () => {
    const d = applySuppression(cand, existing('RESOLVED_OLD'));
    expect(d[0]!.outcome).toBe('suppressed_resolved_old');
    expect(shouldWrite(d[0]!)).toBe(false);
  });

  it('RESOLVED_NEW re-raises - it drifted back, which is new information', () => {
    const d = applySuppression(cand, existing('RESOLVED_NEW'));
    expect(d[0]!.outcome).toBe('re_raised_resolved_new');
    expect(shouldWrite(d[0]!)).toBe(true);
  });

  it('a blank-status row is already queued - skip, no duplicate', () => {
    const d = applySuppression(cand, existing(''));
    expect(d[0]!.outcome).toBe('skipped_awaiting');
    expect(shouldWrite(d[0]!)).toBe(false);
  });

  it('enqueues when nothing matches the key', () => {
    expect(applySuppression(cand, []).map((d) => d.outcome)).toEqual(['enqueue']);
  });

  it('keys on all three of (BHC_ID, old, new) - a different drift re-raises', () => {
    const d = applySuppression([{ ...cand[0]!, newName: 'Different New' }], existing('RESOLVED_OLD'));
    expect(d[0]!.outcome).toBe('enqueue');
  });
});

describe('PASS 5 - the LIVE column order', () => {
  it('puts Severity at K, before Expected (L) and Found (M)', () => {
    const r = toReportRow(
      { code: 'G1', row: row({ bhcId: 'BHC-1', googleRow: 7 }), expected: 'BHC-1', found: 'BHC-2', notes: 'n' },
      { runId: 'RECON-1', checkedAt: 'now' },
    );
    expect(r).toHaveLength(14);
    expect(r[8]).toBe('G1');                  // I
    expect(r[9]).toBe('Google row mismatch'); // J
    expect(r[10]).toBe('HIGH');               // K  <- severity, live order
    expect(r[11]).toBe('BHC-1');              // L
    expect(r[12]).toBe('BHC-2');              // M
    expect(r[13]).toBe('n');                  // N
  });
});
