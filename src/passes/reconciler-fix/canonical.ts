/**
 * Reconciler Fix - canonical/orphan scoring. PHASE 1: pure logic only.
 *
 * PASS 3 Step 1 (S1, duplicate BHC_ID) and PASS 6 Step 1 (S4, duplicate Attio
 * pointer) state the identical rule in two places. It is implemented once here
 * so the two passes cannot drift apart - the same reasoning that keeps one
 * name gate rather than two.
 *
 * NO I/O. Nothing in this file reads or writes Sheets or Attio.
 */

/** One Master_ID row, as far as scoring cares. */
export interface CandidateRow {
  readonly masterRow: number;
  readonly bhcId: string;
  /** GOOGLE / ATTIO / BOTH / SUPERSEDED, uppercased by the caller. */
  readonly location: string;
  readonly googleRow: number | null;
  readonly attioRecordId: string;
}

export const SUPERSEDED = 'SUPERSEDED';

export interface CanonicalResult {
  /** Highest scorer; null when every candidate was excluded. */
  readonly canonical: CandidateRow | null;
  readonly orphans: readonly CandidateRow[];
  /** Retired identities, removed before scoring. Never canonical, never orphan. */
  readonly excludedSuperseded: readonly CandidateRow[];
  /** masterRow -> score, for the audit trail and for explaining a decision. */
  readonly scores: ReadonlyMap<number, number>;
}

/**
 * Spec: Google_Row populated -> +2, Attio_Record_ID populated -> +2.
 *
 * "Populated" is deliberately strict about a blank: a whitespace-only cell is
 * not a pointer, and treating it as one is the same class of mistake as the
 * 245-row trap that groupBySharedAttioPointer exists to prevent.
 */
export function scoreRow(row: CandidateRow): number {
  let score = 0;
  if (row.googleRow !== null && row.googleRow > 0) score += 2;
  if (row.attioRecordId.trim() !== '') score += 2;
  return score;
}

/**
 * Highest score wins; a tie goes to the LOWER master row number.
 *
 * SUPERSEDED rows are removed before scoring, never after. Non-negotiable 6c:
 * a retired identity is correct as it stands, and its blank pointers are by
 * design. If one were scored it would score 0, lose, be classified an orphan,
 * and PASS 6 Step 3 would then clear its pointer and overwrite its Location -
 * silently undoing the retirement and writing over its own audit line. The
 * Reconciler already excludes them upstream; this is the second line of defence
 * the spec asks for.
 */
export function chooseCanonical(rows: readonly CandidateRow[]): CanonicalResult {
  const excludedSuperseded = rows.filter((r) => r.location.trim().toUpperCase() === SUPERSEDED);
  const eligible = rows.filter((r) => r.location.trim().toUpperCase() !== SUPERSEDED);

  const scores = new Map<number, number>();
  for (const r of eligible) scores.set(r.masterRow, scoreRow(r));

  if (eligible.length === 0) {
    return { canonical: null, orphans: [], excludedSuperseded, scores };
  }

  // Sort by score desc, then master row asc. Stable and total, so the winner is
  // deterministic for identical inputs - no reliance on input order.
  const ranked = [...eligible].sort((a, b) => {
    const d = scores.get(b.masterRow)! - scores.get(a.masterRow)!;
    return d !== 0 ? d : a.masterRow - b.masterRow;
  });

  return { canonical: ranked[0]!, orphans: ranked.slice(1), excludedSuperseded, scores };
}

/**
 * S4 grouping: rows sharing a POPULATED Attio_Record_ID, two or more per group.
 *
 * THE 245-ROW TRAP, and why this filter is here rather than inside
 * chooseCanonical. The spec: "S4 considers ONLY rows with a POPULATED
 * Attio_Record_ID. A blank is not a shared value... 245 live rows have a blank
 * col E, so a literal reading of 'two or more rows share the same
 * attio_record_id' produces one 245-row group and then 'fixes' 244 of them."
 *
 * It cannot live in the scorer, because PASS 3 (S1, duplicate BHC_ID) shares
 * that scorer and its rows may legitimately have a blank Attio pointer. The
 * blank rule is about what forms an S4 GROUP, not about what can be canonical.
 */
export function groupBySharedAttioPointer(
  rows: readonly CandidateRow[],
): ReadonlyMap<string, readonly CandidateRow[]> {
  const byId = new Map<string, CandidateRow[]>();
  for (const r of rows) {
    const id = r.attioRecordId.trim();
    if (id === '') continue; // a blank is not a shared value
    byId.set(id, [...(byId.get(id) ?? []), r]);
  }
  return new Map([...byId].filter(([, group]) => group.length >= 2));
}
