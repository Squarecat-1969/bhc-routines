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

**`index-link-targets-resolve`** — Every link in the index resolves to a heading that exists **now**, matched by **anchor ID**, never by text.
> **The same defect as `toc-entry-resolves-to-heading`, in the population where nothing was checking it.**
>
> ⚠ **A DEAD-ANCHOR CHECK IS NOT A TEXT-MATCH CHECK.** `INCIDENT 2` passes `toc-entry-resolves-to-heading` today — same text, live heading, dead link — because the paragraph was retyped on 2026-09-07 and Docs minted a fresh ID (`h.lagfoh7a5rp3` → `h.cmytyawr14t8`) while every character stayed put. **A heading's identity dies with the paragraph, not with its text.** Measured the same night: **65 of the 133 reference lines written on 2026-09-07 already pointed at anchors that no longer exist.**
>
> ⚠ **It must read both link forms.** `insertLink` writes `url`; a human linking through the Docs UI writes `heading`, carrying `{id, tabId}` and **no document ID** — heading form is intra-document only. The Plan's ToC holds `{url: 83, heading: 4}`. Reading `url` alone reported three live hand-made links as dead and nearly filed them as findings; reading `heading` alone would miss the other 83. **An unrecognised form is reported, never skipped** — a shape read as "no links" is this trap's entire career.

**`toc-covers-plan-headings`** — Every non-blank level-1 and level-2 Plan heading appears in the ToC.
> The ToC declares itself "generated from that tab's live headings". ⚠ **It lists levels 1–2 only.** The Plan tab has 117 headings, 92 at levels 1–2 and 102 non-blank; comparing against all 117 reports 25 phantom omissions.

### Recorded figures

**`toc-blank-heading-count`** — The ToC's stated count of omitted blank headings matches reality.
> The preamble says it omits *"ten blank page-break heading paragraphs and one stray blank heading"* — eleven. **Measured: fifteen** (12 `HEADING_2`, 3 `HEADING_1`), all carrying real anchors. Two other recorded figures went stale within a single session on 2026-09-05.

### Coverage — reported by name, never as a count

**`index-covers-log-entries`** — Every `§NNN` entry is referenced by the index.
> A stale index fails silently and in the worst direction: a search returning nothing reads as "this was never discussed" when it means "this was never indexed."

**`plan-section-unindexed`** — Every Plan section tracked in `Plan_Index_State` is referenced by the index. Reported **by name**, with a `none` line.
> `ENGINEERING GOTCHAS` and `7.8 API ROUTE INVENTORY` were indexed on 2026-09-07 and got **zero reference lines**, because every term assigned to them was capped or high-frequency and those are never written. Both carried a state row claiming `indexed_by=routine` while nothing in the index pointed at them. A `--no-llm` run the next day created **nine more** the same way.
>
> ⚠ **Narrower than `index-covers-plan-headings`, and that is the point.** That rule compares every Plan heading against the index and reports 13 level-1 chapter headings the indexer deliberately never treats as units, so the actionable rows are buried among them. This one asks only about sections the routine actually **tracks**, which is the set that can be acted on.
>
> ⚠ **Derived from the index, never from `indexed_by`.** A column that says `unindexed` is reporting what it was told; the index is what is true. That also catches a `hand` row whose references were deleted, which the column never will because `hand` is never demoted.
>
> ⚠ **The one cross-store dependency in an otherwise docs-only pass.** The tracked set lives in Sheets. If the client is absent or the tab unreadable the rule does not run, and says so — a rule that vanishes with its dependency is indistinguishable from one that passed.

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

## ⚠ The capability that arrived, and where its trap moved

`includeLinks` shipped on `/api/brain/docs` **2026-09-07**. Passing it returns `links[]`, `linkCount` and `linkForms` — each link carrying its text, its stored target, its form and both index spaces. It runs on the primary transport, so **a GitHub Actions container can do it**; the old workaround note about needing the TNB-Docs-Bridge interactively is obsolete. Cross-checked on `GROUP: Aida surfaces`: `linkCount: 86` against 88 references and 2 known-plain lines, agreeing exactly with an independent read through a second transport.

⚠ **THE TRAP DID NOT RETIRE. IT MOVED, AND IT HAS BITTEN TWICE MORE.**

**The content string still carries no link markup, in either format.** The route's own note says so and says it is *still true* after `includeLinks` shipped: `text` returns stored characters and a link is not a character; the markdown renderer covers headings, bold and italic only. A zero from `content`, or from any read that forgets `includeLinks`, has **twice** been taken as evidence that link *writing* is broken. It never was.

**And there is now a second shape of the same wrong zero.** Docs stores a link in six forms. Reading only `link.url` misses every `heading`-form link — the shape a human produces through the Docs UI — and on 2026-09-08 that nearly filed three live links as dead findings. Any link check must read `heading` as well as `url`, and must **report** an unrecognised form rather than skipping it.

## The reconciliation the drift check performs

`Plan_Index_State` holds a per-locator content hash and a `heading_id`. Reconciling it against the live Plan uses **both keys, together**, because neither alone is an identity:

| Class | Test | Means |
|---|---|---|
| **ALIVE** | id and locator match | nothing moved (content may still have `CHANGED`) |
| **RENAMED** | id matches, locator moved | heading text edited; links still good |
| ⚠ **ANCHOR CHANGED** | locator matches, id died | paragraph retyped — **every link to it is dead** |
| ⚠ **GONE** | neither matches | section no longer exists |

> **A locator is not an identity.** It is derived from heading text, so any edit mints a new one. Measured 2026-09-08: locator-only matching called 18 sections GONE, of which four were alive — `OPERATIONAL BACKLOGS` was reported dead and newborn in the same run, one section counted twice.

⚠ **Every class prints a `none` line.** A class that appears only when non-empty is indistinguishable from one that stopped running.

⚠ **Classes and names, never document totals.** The Plan moved 80 → 82 sections between two reads twenty minutes apart on 2026-09-08. A total is a snapshot that is already wrong by the time it prints.

### `indexed_by` has three values, and collapsing any two loses information

| Value | Means |
|---|---|
| `hand` | a human wrote the references |
| `routine` | this routine wrote them |
| `unindexed` | **tracked, and nothing points at it** — a real reportable condition, not an absence of one |

⚠ **A row becomes `routine` only when reference lines actually land, never at row creation.** Setting it when the row is created records an *intention*; this column records what happened. Provenance is therefore settled **after** the write loop, from confirmed `insert-reference` writes — the same distinction as counting confirmed writes rather than attempted ones, which this repo has now got wrong seven times.

⚠ **`hand` is never demoted.** A hand row with no references stays `hand`, because demoting it would open a path back up to `routine` on a later run, letting the routine claim ownership of references a human wrote. The "nothing points at this" condition is reported from the index instead, by `plan-section-unindexed`.

⚠ **Anchor first, text as fallback — and this was a real defect, now closed.** `index-maintenance` used to decide `referencedInIndex` from reference-line *text* only, because it read the index without `includeLinks`. A section whose heading was reworded keeps its OLD wording in every index reference, so text stopped matching and a `routine` row would have been demoted to `unindexed` while its links worked. Observed on `OPERATIONAL BACKLOGS` (indexed as *"…These a"*, tracked as *"…This is"*); it did not misreport only because that row was `hand`, and `hand` is never demoted — the asymmetry masked the bug rather than preventing it. Both surfaces now read `includeLinks` and match by anchor first. **If the index ever returns zero link anchors the run says so and degrades to text matching, rather than treating a wrong zero as truth.**

⚠ **An unrecognised value still reads as `hand`.** `unindexed` is recognised explicitly; everything else is treated as human work, because the permissive direction must never be `routine`.

### The repair is derived, never declared

An `ANCHOR CHANGED` row resolves — `heading_id ← live_anchor`, `live_anchor ← ''` — **only when the index itself shows the repair happened**: the old anchor no longer appears among its link anchors and the live one does. Same observe-what-happened rule as `routine`. A row is never closed because someone said the work was finished, and **an index read without links resolves nothing**, because an unread index is not evidence of repair.

Leaving the dead anchor in `heading_id` after the references have moved would make the report lie in the other direction — claiming an outstanding repair that is done — which is the same defect as a green report over a real one.

**On `ANCHOR CHANGED` the hash moves and `heading_id` does not.** `heading_id` records the anchor the index's reference lines *actually point at*; the new live anchor goes to `superseded_anchor` as the outstanding repair. Writing the new anchor straight into `heading_id` would make the next report clean while 65 reference lines still point nowhere — **a green report over a real defect, which is the exact shape this system exists to catch. The report must stay truthful about the INDEX, not about the document.**

## ⚠ NOT RUN is a third state, and every rule can reach it

A rule whose input is absent computes nothing, finds nothing, and **renders as a pass**. `toc-blank-heading-count` did exactly that on 2026-09-08: the ToC no longer states a count, so there was nothing to compare, and the rule line showed a green tick while a warning elsewhere said it could not run. **The manifest's own stated failure mode, happening to a rule inside the manifest.**

Every rule now declares the input it needs and reports `⊘ NOT RUN` with a reason when it is absent. The report always prints a `RULES THAT DID NOT RUN` section, with a `none` line.

**A rule that did not run reports no findings, even if it computed some.** This is reachable, not defensive: `log-001-tab-inventory` derives its findings by subtracting the tabs it saw from the tabs it expects, so when `listTabs` returns nothing it computes three "missing tab" findings *and* fails its precondition at the same moment. Reporting them would turn a transport failure into three confident claims about the document.

Audited 2026-09-08, the inputs that can be absent: **Plan headings** (`plan-no-log-entries`, `toc-covers-plan-headings`, `toc-entry-resolves-to-heading`, `toc-blank-heading-count`, `index-covers-plan-headings`, `plan-paragraph-headings`), **ToC content** (the three placement rules, `toc-entry-resolves-to-heading`, `toc-covers-plan-headings`), **index content** (`index-no-self-reference`, `index-covers-log-entries`, `index-covers-plan-headings`), **index links** (`index-link-targets-resolve` — a zero there is the wrong zero this route has produced twice), **log locators** (`index-covers-log-entries`), **the tab list** (`log-001-tab-inventory`), and **the tracked set in Sheets** (`plan-section-unindexed`).

## ⚠ Nothing here is ever repaired automatically

**Never delete, and never re-anchor.** Re-anchoring is a *transform*, and `insertLink` is an insert — the route states it "cannot reach an existing character" — so converting a dead link would mean deleting a line and retyping it, two non-atomic unretryable mutations against anchors that are byte-identical across terms in a tab.

**And a GONE section is usually absorbed, not removed.** All 17 true GONE sections on 2026-09-08 were routine-indexed units whose text still exists verbatim inside a parent: INCIDENT 7 went 73 → 5,039 characters swallowing its eleven fragments, and the addendum merged into Chapters 5, 7, 11 and 12. Their 65 references are wrong about *where*, not about *what*. Deleting them would destroy true pointers to live content — and the error is asymmetric: a false GONE deletes irreversibly, while a true GONE left alone is one stale line, reported every run.
