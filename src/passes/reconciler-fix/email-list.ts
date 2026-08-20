/**
 * Reconciler Fix - the I1 Email list builder. PHASE 1: pure logic only.
 *
 * PASS 6.5 Step 2, Email sub-bullet:
 *   "Build the new list: Expected first (the primary), then every existing
 *    address except a case-insensitive duplicate of Expected - secondaries are
 *    preserved, order otherwise unchanged."
 *
 * NO ATTIO CALL INSIDE. The write, and the workspace-uniqueness conflict
 * handling the spec describes right after this step, belong to a later phase.
 */

/**
 * Returns the address list to write, with `newPrimary` at position 0.
 *
 * Secondaries keep their relative order. The only address removed is one that
 * case-insensitively equals the new primary - otherwise Attio would end up
 * holding the same address twice, once as primary and once as a leftover
 * secondary.
 *
 * Whitespace-only entries in the current list are dropped: an empty string is
 * not an address, and writing one back would put junk on a real record.
 *
 * Throws on a blank `newPrimary`. I1 only ever fires for a field Google has a
 * value for (the Reconciler skips a blank Google value), so a blank here is a
 * programming error - and silently writing it would clear a real person's
 * primary email. A later phase's per-row error handling keeps one bad row from
 * aborting the run, per non-negotiable 5.
 */
export function buildEmailList(
  current: readonly string[],
  newPrimary: string,
): readonly string[] {
  const primary = newPrimary.trim();
  if (primary === '') {
    throw new Error('buildEmailList: newPrimary is blank - refusing to build a list that would clear the primary email');
  }

  const needle = primary.toLowerCase();
  const secondaries = current
    .map((e) => String(e ?? '').trim())
    .filter((e) => e !== '' && e.toLowerCase() !== needle);

  return [primary, ...secondaries];
}
