/**
 * THE RULE MANIFEST.
 *
 * ⚠ THE RULES LIVE HERE AND IN docs/qc-manifest.md, NOT SCATTERED THROUGH THE
 * CHECKING LOGIC. A rule buried in a routine's code cannot be read by the
 * person writing the document; in a manifest it is the thing you check BEFORE
 * writing, which is where it prevents the error rather than reporting it after.
 *
 * ⚠ EVERY RULE CARRIES THE INCIDENT THAT EARNED IT, and none is speculative.
 * A large invented rule set would be mostly wrong, would generate false
 * positives, and would train the reader to ignore the report — which costs
 * more than the check is worth. If a rule here has no `earnedBy`, it should
 * not be here.
 *
 * ⚠ NOTHING IN THIS ROUTINE WRITES. Not to a document, not to a tab, not a
 * link. The reason is capability, not caution: on 2026-09-05 a Dev log tab
 * inventory was written into the Plan's ToC and removed the same day — but a
 * routine that deleted prose failing to match a generated list would also
 * delete that ToC's opening paragraph and its note about blank page-break
 * headings, both deliberate. A checker cannot tell a mistake from an intention
 * without judgement. It surfaces; a human decides.
 */

export type RuleSeverity =
  /** Firing means something is wrong and should be fixed. */
  | 'finding'
  /** Firing is expected and informational — reported by name, never as a failure. */
  | 'gap'
  /** Worth surfacing so it is not papered over; not itself a defect. */
  | 'hygiene';

export interface Rule {
  readonly id: string;
  /** The checkable statement, in the negative form wherever that is available. */
  readonly statement: string;
  /** ⚠ The real error this rule came from. No rule ships without one. */
  readonly earnedBy: string;
  readonly severity: RuleSeverity;
  readonly document: string;
}

export const RULES: readonly Rule[] = [
  // --- Placement -------------------------------------------------------------
  {
    id: 'toc-no-log-doc-id',
    document: "Plan's ToC",
    statement: "The Plan's Table of Contents contains no Dev log document ID.",
    earnedBy:
      'A Dev log tab inventory was written into the Plan ToC on 2026-09-05 and removed the same day. ' +
      'The ToC describes the Plan tab; log coverage is the keyword index\'s to hold, and duplicating it ' +
      'gives two places to go stale independently.',
    severity: 'finding',
  },
  {
    id: 'toc-no-log-tab-name',
    document: "Plan's ToC",
    statement: "The Plan's Table of Contents names no Dev log month tab.",
    earnedBy: 'Same incident, 2026-09-05 — the inventory listed the month tabs by name.',
    severity: 'finding',
  },
  {
    id: 'toc-no-log-entry-range',
    document: "Plan's ToC",
    statement:
      "The Plan's Table of Contents carries no §NNN RANGE — the shape of a Dev log inventory. " +
      'A single §NNN citation is allowed and expected.',
    earnedBy:
      'Same 2026-09-05 incident, NARROWED 2026-09-06. ⚠ WHAT THIS RULE DOES NOT COVER, AND WHY: it does ' +
      'NOT forbid citing a log entry. The original form fired on any §NNN and caught the ToC\'s own ' +
      '"inserted before PERMANENT IDENTITY CORRECTIONS · Dev log §123" — a cross-reference saying where ' +
      'Incident 7 is written up in full, which is useful and belongs. That was a true positive against the ' +
      'letter of the rule and a false one against its purpose. ' +
      '⚠ CHECKED BEFORE NARROWING, so the next reader does not re-broaden it: the 2026-09-05 addition was a ' +
      'log TAB INVENTORY, and an inventory names tabs, so `toc-no-log-tab-name` would have caught it alone. ' +
      'Re-stating this rule as "no inventory" would have duplicated that sibling. It survives as a RANGE ' +
      'rule because a range is the one inventory shape neither sibling can see: ' +
      '"log-001 §001–§035.1 · log-002 §036–§059" carries no tab name and no document ID, and both siblings ' +
      'pass it. A range is also the figure that went stale — the ToC carried §106–§127 after §133 was ' +
      'written. ' +
      'KNOWN LIMIT: an inventory written as a comma-enumeration ("§106, §107, §108") rather than a range ' +
      'would not fire. Left uncovered deliberately — no such enumeration has occurred, and a rule for an ' +
      'unobserved shape is the speculative kind this manifest exists to keep out.',
    severity: 'finding',
  },
  {
    id: 'plan-no-log-entries',
    document: 'Plan tab',
    statement: 'The Plan tab has no §NNN entry heading — log entries live in the Log.',
    earnedBy:
      'The document contract in docs/docs-qc-routine-brief.md §1: the Plan holds chapters, schemas, ' +
      'decisions and the incident ledger, never dated log entries.',
    severity: 'finding',
  },
  {
    id: 'index-no-self-reference',
    document: 'Index',
    statement: 'The index contains no reference to its own document ID — it is not a source.',
    earnedBy:
      'The contract in docs/attio-bridging-spec.md-style form and the index build spec: "do not index the ' +
      'index." An index that cites itself grows without adding information.',
    severity: 'finding',
  },
  {
    id: 'log-001-tab-inventory',
    document: 'log-001',
    statement: 'log-001 holds exactly its three month tabs — no Table of Contents tab, no Session Notes tab.',
    earnedBy:
      'The project instructions describe log-001 as having a "Table of Contents" tab and a "Session Notes ' +
      '(original)" tab. VERIFIED 2026-09-05: it has neither. A routine built against the instructions\' ' +
      'description would read tabs that do not exist.',
    severity: 'finding',
  },

  // --- Link targets and ToC completeness -------------------------------------
  {
    id: 'toc-entry-resolves-to-heading',
    document: "Plan's ToC",
    statement: 'Every ToC entry line corresponds to a heading that still exists in the Plan tab.',
    earnedBy:
      'THE ACCEPTANCE TEST. The ToC links "PERMANENT IDENTITY CORRECTIONS" to h.68mlrx18r7t; that heading ' +
      'was DEMOTED TO NORMAL TEXT after the 2026-08-30 migration linked it, so the anchor exists nowhere ' +
      'in the document. 82 of 83 heading links matched and this was the 83rd, found 2026-09-06. ' +
      'Nothing has checked link targets since the 610-link migration.',
    severity: 'finding',
  },
  {
    id: 'toc-covers-plan-headings',
    document: "Plan's ToC",
    statement: 'Every non-blank level-1 and level-2 heading in the Plan tab appears in the ToC.',
    earnedBy:
      'The ToC declares itself "generated from that tab\'s live headings". ⚠ It lists LEVELS 1-2 ONLY: the ' +
      'Plan tab has 117 headings, 92 at levels 1-2 and 102 non-blank. Comparing against all 117 reports 25 ' +
      'phantom omissions, which is how a naive version of this check trains the reader to ignore it.',
    severity: 'finding',
  },

  // --- Recorded figures ------------------------------------------------------
  {
    id: 'toc-blank-heading-count',
    document: "Plan's ToC",
    statement: "The ToC's stated count of omitted blank headings matches how many the Plan tab actually has.",
    earnedBy:
      'The preamble says it omits "ten blank page-break heading paragraphs and one stray blank heading" — ' +
      'eleven. Measured 2026-09-06: FIFTEEN, being 12 HEADING_2 and 3 HEADING_1, all carrying real anchors. ' +
      'Two other recorded figures went stale within a single session on 2026-09-05 (the ToC\'s §106-§127 ' +
      'range and the index\'s copy of it), which is what makes recorded figures worth checking at all.',
    severity: 'finding',
  },

  // --- Coverage --------------------------------------------------------------
  {
    id: 'index-covers-log-entries',
    document: 'Index',
    statement: 'Every §NNN entry in the Dev log is referenced by the index. Gaps are reported BY NAME.',
    earnedBy:
      'A stale index fails silently and in the worst direction: a search returning nothing reads as "this ' +
      'was never discussed" when it means "this was never indexed." A count would hide which entries.',
    severity: 'gap',
  },
  {
    id: 'index-covers-plan-headings',
    document: 'Index',
    statement: 'Every Plan heading is referenced by the index.',
    earnedBy:
      '⚠ EXPECTED TO BE LARGE, AND NOT A DEFECT. The index carries 291 Plan references written by hand; the ' +
      'index maintenance routine contributes zero, because the Plan is chapter-structured with no §NNN ' +
      'entries. Indexing it needs its own parser AND a different watermark — a Plan chapter is rewritten in ' +
      'place, so "already indexed" cannot mean "seen once". Reported as a gap, never as a failure.',
    severity: 'gap',
  },

  // --- Hygiene ---------------------------------------------------------------
  {
    id: 'plan-paragraph-headings',
    document: 'Plan tab',
    statement: 'No Plan heading holds an entire paragraph of body text.',
    earnedBy:
      'The INCIDENT 1-6 blocks and the 3a/3b sub-entries are styled as headings but hold multi-sentence ' +
      'bodies, one of 1,887 characters. The links work and the IDs are correct, so this is not a break — but ' +
      'anything generating index text from heading text must truncate, and it is worth surfacing rather ' +
      'than papering over.',
    severity: 'hygiene',
  },
];

export function ruleById(id: string): Rule {
  const r = RULES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown rule "${id}". Valid: ${RULES.map((x) => x.id).join(', ')}`);
  return r;
}
