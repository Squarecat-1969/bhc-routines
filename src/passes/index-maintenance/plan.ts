/**
 * The watermark, and the writes it produces. Pure — no I/O.
 *
 * ⚠ THE WATERMARK IS DERIVED FROM THE INDEX, NEVER STORED SEPARATELY.
 *
 * An entry is indexed if the index already carries a reference to its locator.
 * That is the only definition that cannot drift: a stored high-water §-number
 * would be wrong the moment an entry is added out of order, an older entry is
 * indexed by hand, or a run half-completes — and §089.4's sub-write suffixes
 * (`.1`, `.2`) mean the numbering is not even totally ordered.
 *
 * Without a watermark every run re-judges the whole corpus: real Anthropic
 * spend for no new information, the same requirement pass2_6 carries.
 */

import { excerptFor, type IndexTab, type IndexTerm, type SourceEntry } from './parse.js';

/** Every locator the index already references, across every tab. */
export function buildWatermark(tabs: readonly IndexTab[]): Set<string> {
  const seen = new Set<string>();
  for (const tab of tabs) {
    for (const term of tab.terms) {
      for (const ref of term.references) {
        if (ref.source === 'Log') seen.add(ref.locator);
      }
    }
  }
  return seen;
}

export function unindexedEntries(
  entries: readonly SourceEntry[],
  watermark: ReadonlySet<string>,
): SourceEntry[] {
  return entries.filter((e) => !watermark.has(e.locator));
}

/** The controlled vocabulary: every term the GROUP tabs already define. */
export interface Vocabulary {
  /** term -> the tab that owns it. A term lives in exactly one group. */
  readonly owner: ReadonlyMap<string, string>;
  readonly byTab: ReadonlyMap<string, readonly string[]>;
  readonly duplicates: readonly string[];
}

export function buildVocabulary(groupTabs: readonly IndexTab[]): Vocabulary {
  const owner = new Map<string, string>();
  const byTab = new Map<string, string[]>();
  const duplicates: string[] = [];

  for (const tab of groupTabs) {
    const names: string[] = [];
    for (const term of tab.terms) {
      names.push(term.term);
      if (owner.has(term.term)) duplicates.push(term.term);
      else owner.set(term.term, tab.tabId);
    }
    byTab.set(tab.tabId, names);
  }
  return { owner, byTab, duplicates };
}

/**
 * One planned change. Two shapes only, matching the transport exactly:
 * an insert of a whole new line, or a narrow replace of a term's count.
 *
 * ⚠ THERE IS NO THIRD SHAPE, AND THAT IS STRUCTURAL. The transport offers no
 * wholesale replacement (§105, verified by rejection test), and this type
 * cannot express one either — so a regeneration cannot be written by accident
 * in this repository any more than it can be sent over the wire.
 */
export type PlannedWrite =
  | {
      readonly kind: 'insert-reference';
      readonly tabId: string;
      readonly tabTitle: string;
      readonly term: string;
      readonly locator: string;
      /** The line to insert, WITHOUT escaping. See src/lib/docs.ts. */
      readonly text: string;
      /** The existing line this one goes after — the anchor `find` will locate. */
      readonly afterLine: string;
      /**
       * When present the reference is written as THREE RUNS — plain prefix,
       * LINKED locator, plain excerpt — matching the 610 migrated lines, which
       * link the `§NNN · DATE · Log` prefix only and leave the bullet and the
       * quotation outside the link. Absent means a plain line, which is what
       * an entry with no linkable heading still gets.
       */
      readonly link: { readonly prefix: string; readonly linkText: string; readonly url: string; readonly suffix: string } | null;
    }
  | {
      readonly kind: 'update-count';
      readonly tabId: string;
      readonly tabTitle: string;
      readonly term: string;
      readonly fromLine: string;
      readonly toLine: string;
    }
  | {
      readonly kind: 'insert-term';
      readonly tabId: string;
      readonly tabTitle: string;
      readonly term: string;
      readonly locator: string;
      readonly text: string;
      readonly afterLine: string;
    };

/**
 * The three runs of a reference line, split exactly where the migrated lines
 * split: `· ` + [linked `§NNN · DATE · Log`] + ` “excerpt”`.
 */
export function referenceRuns(
  entry: SourceEntry,
  excerptChars?: number,
): { prefix: string; linkText: string; suffix: string } {
  const excerpt = excerptFor(entry, excerptChars);
  const dated = entry.date ? `${entry.locator} · ${entry.date}` : entry.locator;
  // ⚠ `Log` or `Plan`, matching the two shapes the index already carries:
  // `· §008 · 2026-06-02 · Log “…”` and `· 5.9 · Plan “…”`.
  return { prefix: '· ', linkText: `${dated} · ${entry.sourceKind}`, suffix: ` “${excerpt}”` };
}

export function referenceLine(entry: SourceEntry, excerptChars?: number): string {
  const r = referenceRuns(entry, excerptChars);
  return `${r.prefix}${r.linkText}${r.suffix}`;
}

export function countLine(term: string, count: number): string {
  return `${term}  (${count} ${count === 1 ? 'reference' : 'references'})`;
}

/**
 * Rebuild a term header at a new count, PRESERVING ITS SHAPE.
 *
 * ⚠ The four shapes are not interchangeable. A high-frequency header carries a
 * TRAILING SPACE and a Rule A header carries `, showing K of N`. Rewriting
 * either into the plain form would silently change what the document claims
 * about itself — and the trailing space is exactly the character whose absence
 * made 481 headers invisible to the first version of the parser.
 */
export function recount(term: IndexTerm, newCount: number): string {
  const trailingSpace = /\s$/.test(term.headerLine) ? ' ' : '';
  const word = newCount === 1 ? 'reference' : 'references';
  if (term.shownCount !== null) {
    return `${term.term}  (${newCount} ${word}, showing ${term.shownCount} of ${newCount})${trailingSpace}`;
  }
  return `${term.term}  (${newCount} ${word})${trailingSpace}`;
}

export interface AssignmentInput {
  readonly entry: SourceEntry;
  /** Existing vocabulary terms this entry belongs under. */
  readonly terms: readonly string[];
  /** Terms the model proposed that are NOT in the vocabulary. */
  readonly proposedTerms: readonly string[];
}

export interface PlanResult {
  readonly writes: readonly PlannedWrite[];
  readonly warnings: readonly string[];
  /** term -> how many new references it gains. */
  readonly perTerm: ReadonlyMap<string, number>;
}

/**
 * Turn assignments into writes.
 *
 * ⚠ A NEW TERM IS NEVER PROMOTED INTO A GROUP TAB. It goes to ADDITIONAL
 * TERMS, proposed rather than adopted. An index whose vocabulary drifts stops
 * being an index (§089.4: the vocabulary is controlled precisely because free
 * extraction across hundreds of dense entries produces near-duplicates).
 */
export function planWrites(args: {
  readonly assignments: readonly AssignmentInput[];
  readonly vocabulary: Vocabulary;
  readonly tabsById: ReadonlyMap<string, IndexTab>;
  readonly additionalTermsTabId: string;
  readonly today: string;
  readonly excerptChars?: number;
}): PlanResult {
  const { assignments, vocabulary, tabsById, additionalTermsTabId } = args;
  const writes: PlannedWrite[] = [];
  const warnings: string[] = [];
  const perTerm = new Map<string, number>();
  const cappedSkips: string[] = [];

  // ⚠ A WORKING COPY OF EVERY TAB'S LINES, because an anchor must be unique
  // AGAINST THE DOCUMENT AS IT WILL BE WHEN THE WRITE LANDS, not as it was
  // read. Discovered live: one entry legitimately appears under several terms
  // in one tab, so its reference line is IDENTICAL in each — and anchoring the
  // next insert on that line returned "appears 2 times ... Extend the string
  // until it is unique." It failed closed, but 38 of 150 writes were skipped
  // and the counts that had already landed were left overstated.
  const working = new Map<string, string[]>();
  for (const tab of tabsById.values()) working.set(tab.tabId, tabLines(tab));

  const state = new Map<string, { tab: IndexTab; term: IndexTerm; refs: string[] }>();
  for (const tab of tabsById.values()) {
    for (const term of tab.terms) {
      state.set(term.term, { tab, term, refs: term.references.map((r) => r.line) });
    }
  }

  const newTerms = new Map<string, string[]>();

  for (const { entry, terms, proposedTerms } of assignments) {
    const line = referenceLine(entry, args.excerptChars);

    for (const term of terms) {
      const existing = state.get(term);
      if (!existing) {
        warnings.push(
          `entry ${entry.locator} was assigned "${term}", which is not in the controlled vocabulary — ` +
            'routed to ADDITIONAL TERMS as a proposal rather than created in a GROUP tab',
        );
        push(newTerms, term, entry.locator);
        continue;
      }
      if (existing.term.references.some((r) => r.locator === entry.locator)) {
        // Idempotency: the reference is already there. Nothing to write.
        continue;
      }

      // ⚠ RULE A / RULE B: a capped or high-frequency term shows no individual
      // references, by the index's own stated convention. The count is still
      // bumped — the term really did gain a reference — but adding a line to
      // a list the document says is not maintained would make the header's
      // own arithmetic a lie. 48 of the 155 terms are in this state.
      // ⚠ RULE A / RULE B: a capped or high-frequency term shows no individual
      // references, by the index's own stated convention, so no line is added.
      //
      // ⚠ AND ITS COUNT IS NOT BUMPED EITHER. A bump here CANNOT BE MADE
      // IDEMPOTENT: nothing in the document records which entries contributed
      // to a capped term's total, so a second run has no way to tell an
      // already-counted entry from a new one and would add the same N again.
      // A count that is stale by omission is recoverable; one that drifts
      // upward every run is not. The delta is REPORTED for a human instead.
      if (existing.term.capped || existing.term.highFrequency) {
        cappedSkips.push(
          `${entry.locator} → "${term}" (${existing.term.highFrequency ? 'high-frequency' : 'capped'}: +1, not written)`,
        );
        continue;
      }

      const lines = working.get(existing.tab.tabId)!;
      // ⚠ LOCATE THE TERM'S BLOCK, NOT THE LINE. `indexOf` on a reference line
      // finds the FIRST copy in the tab, which belongs to whichever term comes
      // first alphabetically — so planning for "beta" anchored inside "alpha"
      // and both inserts landed in one block. Term HEADERS are unique; the
      // block is walked forward from there.
      const at = insertionIndexFor(lines, existing.term, entry.sourceKind);
      const anchor = uniqueAnchor(lines, at);
      lines.splice(at + 1, 0, line);

      const runs = referenceRuns(entry, args.excerptChars);
      writes.push({
        kind: 'insert-reference',
        tabId: existing.tab.tabId,
        tabTitle: existing.tab.title,
        term,
        locator: entry.locator,
        text: line,
        afterLine: anchor,
        link: entry.headingUrl ? { ...runs, url: entry.headingUrl } : null,
      });
      existing.refs.push(line);
      perTerm.set(term, (perTerm.get(term) ?? 0) + 1);
    }

    for (const term of proposedTerms) {
      if (vocabulary.owner.has(term)) continue; // already real; handled above
      push(newTerms, term, entry.locator);
    }
  }

  // ⚠ THE COUNT IS DERIVED FROM THE REFERENCES THAT WILL EXIST, NOT FROM
  // `declaredCount + added`. A count computed as a DELTA is only correct if
  // every insert in the same run also landed — and on 2026-09-05 thirty-eight
  // of them did not, leaving eight terms overstated with no way to tell from
  // the document. Recomputing from the reference list makes a re-run
  // self-correcting: it repairs an inflated count instead of compounding it.
  for (const [term] of perTerm) {
    const st = state.get(term)!;
    writes.push({
      kind: 'update-count',
      tabId: st.tab.tabId,
      tabTitle: st.tab.title,
      term,
      fromLine: st.term.headerLine,
      toLine: recount(st.term, st.refs.length),
    });
  }
  if (cappedSkips.length > 0) {
    warnings.push(
      `${cappedSkips.length} assignment(s) landed on a capped or high-frequency term (Rule A/Rule B). NOTHING WAS ` +
        'WRITTEN for these — neither a reference line nor a count bump, because a capped count cannot be bumped ' +
        `idempotently. Apply by hand if wanted: ${cappedSkips.slice(0, 8).join('; ')}` +
        (cappedSkips.length > 8 ? ` (+${cappedSkips.length - 8} more)` : ''),
    );
  }

  const additional = tabsById.get(additionalTermsTabId);
  if (newTerms.size > 0 && additional) {
    // ⚠ APPENDED AS A CLEARLY-MARKED PROPOSAL BLOCK, not as a term entry.
    // ADDITIONAL TERMS uses an "(N occurrences across M tabs)" header and a
    // two-line indented body per reference; writing a `(N references)` header
    // here would look like an adopted term in a format the tab does not use.
    // A proposal is not a term until a human says so.
    const anchor = lastLineOf(additional);
    for (const [term, locators] of newTerms) {
      writes.push({
        kind: 'insert-term',
        tabId: additional.tabId,
        tabTitle: additional.title,
        term,
        locator: locators.join(', '),
        text:
          `PROPOSED TERM — ${term}\n` +
          `    Proposed ${args.today} from ${locators.join(', ')}. NOT adopted: absent from the controlled ` +
          `vocabulary in the GROUP tabs. Review, then add to the appropriate GROUP tab by hand if it earns a place.`,
        afterLine: anchor,
      });
    }
  } else if (newTerms.size > 0) {
    warnings.push(
      `${newTerms.size} proposed term(s) had nowhere to go — the ADDITIONAL TERMS tab was not loaded`,
    );
  }

  return { writes, warnings, perTerm };
}

/** Every line of a tab, reconstructed in document order from the parse. */
function tabLines(tab: IndexTab): string[] {
  const rows: { no: number; text: string }[] = [...tab.unparsedLines.map((u) => ({ no: u.lineNo, text: u.text }))];
  for (const t of tab.terms) {
    rows.push({ no: t.headerLineNo, text: t.headerLine });
    let n = t.headerLineNo;
    for (const r of t.references) rows.push({ no: ++n + 0.5, text: r.line });
  }
  return rows.sort((a, b) => a.no - b.no).map((r) => r.text);
}

/**
 * The line index a new reference goes AFTER.
 *
 * ⚠ THE ANSWER DIFFERS BY SOURCE KIND, because the index has a filing order
 * and it is visible in exactly one place: a term's Log references run in date
 * order, and its Plan references follow them.
 *
 *   Log  entry -> after the term's last **Log** reference. Appending at the
 *                 very end would file a September log entry after a Plan
 *                 section, breaking that convention.
 *   Plan unit  -> after the term's last reference of ANY kind, i.e. the end of
 *                 the block. Reusing the Log rule here would file every new
 *                 Plan section ABOVE the hand-written ones, so the additive
 *                 half would visibly disorder a block it is forbidden to
 *                 rewrite.
 */
export function insertionIndexFor(
  lines: readonly string[],
  term: IndexTerm,
  sourceKind: 'Log' | 'Plan' = 'Log',
): number {
  const header = lines.indexOf(term.headerLine);
  if (header === -1) return Math.max(0, lines.length - 1);
  let at = header;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('· ')) break; // the next term header, or a Rule B note
    if (sourceKind === 'Plan' || / · Log /.test(line)) at = i;
  }
  return at;
}

/**
 * The shortest anchor ending at `at` that appears exactly once in the tab.
 *
 * ⚠ THE ROUTE ASKS FOR THIS BY NAME. Its 409 says "Extend the string until it
 * is unique", and preceding lines are the only material available: a reference
 * line is fixed in shape and identical wherever one entry is filed under
 * several terms in one tab.
 */
export function uniqueAnchor(lines: readonly string[], at: number, maxLines = 6): string {
  for (let span = 1; span <= maxLines && at - span + 1 >= 0; span++) {
    const candidate = lines.slice(at - span + 1, at + 1).join('\n');
    let hits = 0;
    for (let i = span - 1; i < lines.length; i++) {
      if (lines.slice(i - span + 1, i + 1).join('\n') === candidate) hits += 1;
    }
    if (hits === 1) return candidate;
  }
  return lines.slice(Math.max(0, at - maxLines + 1), at + 1).join('\n');
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function lastLineOf(tab: IndexTab): string {
  let best = '';
  let bestLine = -1;
  for (const term of tab.terms) {
    const last = term.references[term.references.length - 1];
    const line = last ? last.line : term.headerLine;
    const no = last ? term.lastLineNo : term.headerLineNo;
    if (no > bestLine) {
      bestLine = no;
      best = line;
    }
  }
  return best;
}
