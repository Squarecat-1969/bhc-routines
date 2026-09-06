# The documents QC manifest

**What this is:** the contract each governing document is held to, and the real error that earned each rule.

⚠ **READ THIS BEFORE WRITING, NOT AFTER.** A rule living in a routine's code cannot be read by the person writing the document. Here it is the thing you check first — which is where it prevents the error rather than reporting it a week later.

⚠ **EVERY RULE IS EARNED. NONE IS SPECULATIVE.** A large invented rule set would be mostly wrong, would generate false positives, and would train you to ignore the report — which costs more than the check is worth. If a rule below has no incident, it should not be here.

⚠ **THE ROUTINE REPORTS. IT NEVER EDITS.** That is capability, not caution. On 2026-09-05 a Dev log tab inventory was written into the Plan's ToC and removed the same day — but a routine that deleted prose failing to match a generated list would also delete that ToC's opening paragraph and its note about blank page-break headings, both deliberate. **A checker cannot tell a mistake from an intention without judgement.**

Implemented in `src/passes/docs-qc/manifest.ts`; a test asserts the two agree.

---

## The contract

| Document | Holds | Never holds |
|---|---|---|
| **Dev log** | dated `§NNN` entries, appended, newest last | schema definitions, chapter content |
| **Plan** | chapters, schemas, decisions, the incident ledger | `§NNN` log entries |
| **Plan's ToC** | lines corresponding to headings in the Plan tab | Dev log document IDs, log tab names, `§NNN` references |
| **Index** | term references to **both** Plan and Log | references to itself |

---

## The rules

### Placement

**`toc-no-log-doc-id`** — The Plan's ToC contains no Dev log document ID.
> A Dev log tab inventory was written into the ToC on 2026-09-05 and removed the same day. The ToC describes the Plan tab; log coverage belongs to the keyword index, and duplicating it gives two places to go stale independently.

**`toc-no-log-tab-name`** — The ToC names no Dev log month tab.
> Same incident — the inventory listed the month tabs by name.

**`toc-no-log-entry-range`** — The ToC carries no `§NNN` **range**. A single `§NNN` citation is allowed and expected.
> Same 2026-09-05 incident, **narrowed 2026-09-06**.
>
> ⚠ **What this rule does NOT cover, and why.** It does not forbid *citing* a log entry. Its original form fired on any `§NNN` and caught the ToC's own *"inserted before PERMANENT IDENTITY CORRECTIONS · Dev log §123"* — a cross-reference saying where Incident 7 is written up in full. That is useful and belongs. A true positive against the letter of the rule and a false one against its purpose, which is how a report earns the reader's indifference.
>
> ⚠ **Checked before narrowing, so the next reader does not re-broaden it.** The 2026-09-05 addition was a log **tab inventory**, and an inventory names tabs — so `toc-no-log-tab-name` would have caught it on its own, and re-stating this rule as "no inventory" would have duplicated that sibling. **It survives as a range rule because a range is the one inventory shape neither sibling can see:** `log-001 §001–§035.1 · log-002 §036–§059` carries no tab name and no document ID, and both siblings pass it. A range is also the figure that went stale — the ToC carried `§106–§127` after §133 was written.
>
> **Known limit, left uncovered deliberately:** an inventory written as a comma-enumeration (`§106, §107, §108`) rather than a range would not fire. No such enumeration has occurred, and a rule for an unobserved shape is the speculative kind this manifest exists to keep out.

**`plan-no-log-entries`** — The Plan tab has no `§NNN` entry heading.
> The document contract: the Plan holds chapters, schemas, decisions and the incident ledger; dated entries live in the Log.

**`index-no-self-reference`** — The index contains no reference to its own document ID.
> "Do not index the index." It is not a source; an index that cites itself grows without adding information.

**`log-001-tab-inventory`** — log-001 holds exactly its three month tabs.
> The project instructions describe log-001 as having a `Table of Contents` tab and a `Session Notes (original)` tab. **Verified 2026-09-05: it has neither.** A routine built against the instructions' description would read tabs that do not exist.

### Link targets and ToC completeness

**`toc-entry-resolves-to-heading`** — Every ToC entry line corresponds to a heading that still exists in the Plan tab.
> **The acceptance test.** The ToC links "PERMANENT IDENTITY CORRECTIONS" to `h.68mlrx18r7t`; that heading was **demoted to normal text after the 2026-08-30 migration linked it**, so the anchor exists nowhere in the document. 82 of 83 heading links matched; this was the 83rd. Nothing had checked link targets since 610 links were migrated.

**`toc-covers-plan-headings`** — Every non-blank level-1 and level-2 Plan heading appears in the ToC.
> The ToC declares itself "generated from that tab's live headings". ⚠ **It lists levels 1–2 only.** The Plan tab has 117 headings, 92 at levels 1–2 and 102 non-blank; comparing against all 117 reports 25 phantom omissions.

### Recorded figures

**`toc-blank-heading-count`** — The ToC's stated count of omitted blank headings matches reality.
> The preamble says it omits *"ten blank page-break heading paragraphs and one stray blank heading"* — eleven. **Measured: fifteen** (12 `HEADING_2`, 3 `HEADING_1`), all carrying real anchors. Two other recorded figures went stale within a single session on 2026-09-05.

### Coverage — reported by name, never as a count

**`index-covers-log-entries`** — Every `§NNN` entry is referenced by the index.
> A stale index fails silently and in the worst direction: a search returning nothing reads as "this was never discussed" when it means "this was never indexed."

**`index-covers-plan-headings`** — Every Plan heading is referenced by the index.
> ⚠ **Expected to be large, and not a defect.** The index carries 291 hand-written Plan references; the index routine contributes zero, because the Plan is chapter-structured with no `§NNN` entries. Indexing it needs its own parser *and* a different watermark — a Plan chapter is rewritten in place, so "already indexed" cannot mean "seen once".

### Hygiene — surfaced, not a defect

**`plan-paragraph-headings`** — No Plan heading holds an entire paragraph.
> The `INCIDENT 1…6` blocks and the `3a`/`3b` sub-entries are styled as headings but hold multi-sentence bodies, one of 1,887 characters. Links work and the IDs are correct — but anything generating index text from heading text must truncate.

---

## Two things the checker allows explicitly

**The ToC's prose preamble.** Its opening paragraph, its note about blank page-break headings and its pointer to the keyword index are deliberate. A naive "every line must be a heading" check reports all of them.

**The hand-appended addendum.** The ToC ends with a block it marks itself: *"Not re-generated from live headings; these were appended by hand."* Its lines describe content filed by hand and are not claims about live headings — checking them reported two findings that were not errors. The boundary is **read from that marker**, not hardcoded to a line number, and the number of excluded lines is reported so the exclusion is visible.

---

## Rules that could not be expressed as checks

These belong here as guidance for a human. Writing them as tests would produce false positives forever.

**"The Dev log never holds schema definitions or chapter content."** Whether a passage is a schema definition or an entry *describing* one is a judgement about meaning. Every mechanical proxy tried — a table, a column-letter list, a field-name run — matches legitimate entries, because entries about schema work quote schemas constantly.

**"The Plan holds chapters, schemas, decisions and the incident ledger."** The positive half of the contract is unfalsifiable mechanically: there is no test for "this is a decision". Only its negative half (`plan-no-log-entries`) is checkable, which is why the manifest states the negative wherever it can.

**"The Dev log's entries are appended, newest last."** Checkable in principle by comparing `§NNN` order to date order — but §089.4 assigns sub-writes `.1 .2 .3` suffixes within a session, and entries have been renumbered and re-dated by hand during two migrations. The check would fire on the document's own history rather than on an error.

**Full link-markup integrity across the index's 610 links.** Not a judgement problem — a capability one. See below.

---

## ⚠ The capability limit this routine works around

`/api/brain/docs` **carries no link markup in either format.** Its own `readNote` says so: measured 2026-09-06 on a tab holding 83 known hyperlinks, a markdown read there reported **0** of them. A link check through that route returns "no links anywhere" — wrong in the direction that looks like a finding.

So `toc-entry-resolves-to-heading` checks the link's **target** rather than the link: a ToC entry naming a heading that no longer exists is the same defect observed from the other side, and it catches the acceptance test exactly. **What it cannot do is read the 610 stored hrefs and confirm each points where it should.** That needs a renderer that emits links — the TNB-Docs-Bridge does — with a known-linked line as a control so a zero is distinguishable from a strip. It is available interactively and not from a GitHub Actions container, where no MCP exists.
