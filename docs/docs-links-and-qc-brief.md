# Build brief — heading IDs, link writes, and the documents QC routine

**Drafted:** 2026-09-06 · **Repos:** `bhc-aida` (the route), `bhc-routines` (the routine and the QC pass)

Three pieces, strictly in order. **Each one is a gate on the next.**

1. **Heading IDs on reads** — small, no safety trade, unlocks the most
2. **Link writing** — a real decision about the write surface, not just work
3. **The documents QC routine** — only possible once 1 and 2 land

---

## PART 1 — Heading IDs on `/api/brain/docs` reads

### Why

Two separate blockers turned out to be the same one.

**Index entries cannot be hyperlinked.** Migrated links point at `…/edit?tab=<tabId>#heading=h.xxxx`. The routine has no way to learn `h.xxxx`, so all 90 lines it has written are plain text sitting next to 610 linked ones — demonstrated live, adjacent lines in the same term block.

**The Plan cannot be indexed at all.** It is not `§`-structured: the index cites it by chapter numbers, sub-labels and section titles in caps — **document headings, not a text pattern.** 291 of the index's references are to the Plan, and the routine currently contributes zero to them.

### What

The Docs API returns `headingId` on paragraph styles. The route flattens to plain text and discards it. **Expose it.**

⚠ **DO NOT CHANGE THE EXISTING RESPONSE SHAPE.** Callers depend on `format: "text"` and `format: "markdown"`. Add heading structure as an additional field or an additional format — never by altering what those two return. A caller that breaks because a read grew a field is a worse outcome than the gap this closes.

**Each heading should carry:** its `headingId`, its level, its text, and its position, so a caller can both build a link and know what the heading contains.

### Verify

- Read the Plan tab and report how many headings come back, with the first five quoted. The ToC lists roughly 90 — a materially different count means the parse is wrong.
- Read a Dev log month tab and confirm `§NNN` entries surface as headings with IDs.
- ⚠ **Confirm an ID matches a real anchor**: take one, build the URL, and check it against a link the 2026-08-30 migration already wrote to the same heading. **If they disagree, stop** — the IDs are useless if they do not match what Google actually serves.
- Confirm existing `text` and `markdown` reads are byte-identical to before.

---

## PART 2 — Link writing

### ⚠ The decision, stated before the work

The route's safety property is not "it doesn't format." It is that **every write is byte-verifiable and no action can change a tab wholesale.**

**A general styling action would break that.** Applying formatting over a range could restyle an entire tab in one call, and **byte comparison would not catch it — verification compares TEXT, and styling is not text.** A styled write could report `verified: true` having changed something the verification cannot see. Styling also has no anchor equivalent: you cannot assert "this range was not bold."

**A link insert is different in kind.** It arrives with new text at a position, modifies nothing existing, and its text half stays byte-comparable exactly as now.

**So: build `insertLink`, NOT `applyStyle`.** Text, URL, position. It must not be able to bold anything, restyle a paragraph, or touch existing formatting.

### ⚠ The question that decides the safety story

**Is a linked insert ONE Docs API request or TWO?**

If `insertText` carries the link, verification is unchanged. If it is `insertText` **then** `updateTextStyle`, then a failure between them leaves text with no link — silently, and byte comparison would pass because the text is correct.

**Establish this before building.** If it is two requests, say so and propose how a partial write is detected and reported. Do not paper over it.

### Verify

- Write one link to a scratch document. Read it back **through the bridge's markdown**, which renders links.
- ⚠ **`/api/brain/docs` markdown STRIPS LINK MARKUP** — a check there returns zero links even for the 610 migrated ones, which reads as "no links anywhere" and is wrong. Use the bridge, and use a known-linked line as a control. (This exact mistake was made and caught 2026-09-06 by checking against §098's record that `SOURCES INDEXED` holds exactly one hyperlink.)
- Confirm `insertLink` cannot modify existing text. Attempt it; it must be refused or impossible to express.
- Confirm the byte verification still fires on the text half.

### Then: the routine writes links

Once both parts land, the index routine builds `…/edit?tab=<tabId>#heading=<headingId>` per entry and writes a linked reference.

⚠ **Do NOT retrofit the 90 plain lines in the same change.** Ship link-writing, confirm the next run's entries are linked, and backfill separately. A backfill touches lines that are already correct-but-plain, and mixing it with a new capability means one failure has two possible causes.

---

## PART 3 — The documents QC routine

**Only after Parts 1 and 2.** It needs heading IDs to check link targets.

### What it enforces

**A contract per document, not a judgement about correctness.** Rules are checkable statements, and every one below comes from a real error rather than an imagined one.

| Document | Holds | Never holds |
|---|---|---|
| **Dev log** | dated `§NNN` entries, newest last | schema definitions, chapter content |
| **Plan** | chapters, schemas, decisions, the incident ledger | `§NNN` log entries |
| **Plan's ToC** | lines matching headings in the Plan tab | Dev log document IDs, log tab names, `§NNN` references |
| **Index** | term references to BOTH Plan and Log | anything about itself |

⚠ **Every rule here is earned.** Log content was written into the Plan's ToC on 2026-09-05 and removed the same day. The project instructions describe log-001 as having a Table of Contents tab and a Session Notes tab — verified 2026-09-05, **it has neither**. Speculative rules would be numerous, wrong, and would train the reader to ignore the report.

### Checks

**Placement** — each rule above, as a mechanical test. The negative form is stronger: *"the Plan's ToC contains no Dev log document ID"* needs no judgement at all.

**Coverage** — every `§NNN` in the Log, and every Plan heading, is referenced by the index. Report the gaps by name.

**Link integrity** — every index reference carries a link; every link's `tabId` and `headingId` resolve to a heading that still exists. ⚠ **Nothing checks this today.** A renamed tab or a moved document would break links silently until someone clicked one. The 2026-08-30 migration fixed 610 links and nothing has verified them since.

**Recorded figures** — any count or range a document states about another is checked against what was actually read. ⚠ Two of these went stale within one session on 2026-09-05: the ToC said `§106–§127` after §133 was written, and the index's coverage note said the same.

**ToC completeness** — every heading in the Plan tab appears in its ToC, and nothing appears that is not a heading. Allow the ToC's prose preamble explicitly; it is deliberate.

### ⚠ It reports. It does not fix.

**Read-only.** Reports to Slack or an artifact.

My addition to the ToC was wrong, but a routine that deletes prose failing to match a generated list would also delete that ToC's opening paragraph and its note about blank page-break headings — both deliberate. **A checker cannot tell a mistake from an intention without judgement, so it surfaces and a human decides.**

⚠ **The rules belong in a MANIFEST FILE, not in code.** A rule living in a routine's logic cannot be read by the person writing the document. In a manifest it is the thing you check before writing — which is where it prevents the error rather than reporting it.

### Cadence

Weekly, alongside or after the index run. Nothing here is urgent; all of it is silent.

---

## Sequencing, and why

1. **Heading IDs.** Small, no safety trade. Immediately answers whether Plan indexing is tractable.
2. **Decide on links** with Part 1's result in hand. The answer might be that the index is searchable enough without them — 610 were migrated because they were load-bearing for humans clicking through, which is not automatically true of generated entries.
3. **Link writing**, if decided yes.
4. **QC routine**, which needs both.

⚠ **Do not start Part 3 before Parts 1 and 2 are live.** Its link-integrity check is most of its value, and without heading IDs it cannot do it.
