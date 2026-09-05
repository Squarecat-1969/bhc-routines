# Index maintenance — build notes

**Built:** 2026-09-05 · `src/passes/index-maintenance/`, `src/lib/docs.ts`
**Specs:** `docs/index-maintenance-brief.md`, `docs/shared-bridge-contract.md`, Dev log §089.4, §089.5, §098, §099, §105

---

## 1. Where the brief and the Dev log disagree — the log wins (brief §0)

### 1.1 ⚠ THE ESCAPING RULE IS WRONG FOR THIS TRANSPORT

The brief §3 says *escape every underscore and asterisk unconditionally*. **Applying it would corrupt the index.**

- §098 scopes the rule to markdown writes: *"escape EVERY underscore and asterisk **in any markdown write**"* — and the migration that established it succeeded by avoiding re-render entirely: *"The re-render never happens, so the hazard does not apply at all rather than being managed."*
- §105: the route *"writes **LITERAL TEXT ONLY** and never renders markdown on the way in, which removes the transformation rather than guarding against it."*
- Verified live 2026-09-05, `health.literalTextNote`: *"Text is written literally… so no escaping is needed — send exactly the bytes you want stored."*

Escaping would store `bhc\_contact\_id`. **Nothing is escaped**, and `runIndexMaintenance` ABORTS if that health note ever stops saying so — the one guard standing between this routine and §098's silent failure.

### 1.2 The brief's write model does not match the transport

§4 says *"append and update in place"*. There is **no append action**: `writeActions: ["insertText","replaceRange"]`, and `replaceRange` requires non-empty anchors. §5's *"do not rewrite a whole tab"* is not a rule to obey — §105 made it **structurally impossible**, verified by rejection test. `PlannedWrite` cannot express one either.

### 1.3 A hazard the brief omits: two index spaces, one set of names

`find` returns `startIndex`/`endIndex` (DOCUMENT indices, what the writes take) **and** `plainTextStartIndex`/`plainTextEndIndex`. Phase 1 shipped the plain-text offsets under the document-index names; substituting one for the other writes to the wrong place with every parameter name matching.

### 1.4 Costs have drifted, twice

| log-002 preRead | source |
|---|---|
| 6,477ms | the brief |
| 8,500ms | §105, the next day |
| **17,800ms** | **measured here, 2026-09-05** |

2.1× §105 and 2.7× the brief. A verified write is ~2.5× its preRead, so a **write** to log-002 would not fit a 45,000ms budget. This routine only reads it. Rule 8 working exactly as intended.

### 1.5 Two §089.4 requirements the brief drops

A **weekly safety-net run** alongside `workflow_dispatch` (the brief says "not scheduled"), and **a failure-class term is mandatory** on any entry describing an incident, bug or correction. The second is in the prompt and checked deterministically afterwards.

### 1.6 Minor

The brief's §0 offsets are ~121 characters high; *WHAT REMAINS* begins at 275388 and is 275 characters, not a long passage.

---

## 2. Four things the live document does that no spec describes

**Term headers have FOUR shapes, not one.**

```
dedup gap  (6 references)                     plain
minting  (26 references, showing 23 of 26)    Rule A — capped at 25 shown
BHC Zoom  (79 references)                     Rule B — WITH A TRAILING SPACE
Attio  (824 references)                       Rule B, plus a "high-frequency;" note line
```

⚠ **The trailing space is load-bearing.** Anchoring the count regex on `$` silently failed to match **481 of 640 headers** — every high-frequency term. An unmatched header is indistinguishable from an absent term, so the entire controlled vocabulary would have been re-proposed as new. Found by counting shapes against the live tabs, not by reading the format.

**Rule A and Rule B mean no reference line may be added** — 48 of 155 terms. The count is not bumped either; see §3.2.

**ADDITIONAL TERMS uses a different format** — `(N occurrences across M tabs)` and a two-line indented body. Its `across 1 tabs` must not be read as a Rule A shown-count. Parsed so its references reach the watermark; never written into as a term.

**The Developer's Plan has no `§NNN` entries at all** — it is chapter-structured (`Ch 11`, `5.9`, `8.6`). This routine indexes Log entries only; **new Plan content is out of its reach** and needs a chapter-heading parser. Reported rather than silently skipped.

Cross-check: the parser finds **155 controlled-vocabulary terms**, exactly the count §090 records.

---

## 3. Two defects found by running it, not by reading it

### 3.1 ⚠ AN ANCHOR THAT IS NOT UNIQUE — 38 of 150 live writes skipped

One entry legitimately appears under several terms in one tab, so **its reference line is byte-identical in each**. Anchoring the next insert on that line returned `409 — "That text appears 2 times… Extend the string until it is unique."`

It **failed closed** and nothing wrong was written. Two fixes:

- Anchors are now the **shortest unique multi-line span** ending at the insertion point, computed against a **simulated post-write copy** of the tab, so inserts made earlier in the same run are accounted for.
- The insertion point is located by **walking the term's block from its header**, not by `indexOf` on a reference line — which found the first copy in the tab and belonged to whichever term sorted first. Caught by a fixture, after the fix.

References are inserted after the term's last **`Log`** reference, not its last reference of any kind: the document orders Log references by date and then Plan references.

### 3.2 ⚠ A COUNT COMPUTED AS A DELTA IS ONLY CORRECT IF EVERY INSERT LANDED

The first run computed `declaredCount + added`. Thirty-eight inserts failed, so **eight terms were left overstated with nothing in the document to reveal it**, and a re-run would have compounded it.

- Non-capped terms: the count is now **derived from the reference list that will exist**. A re-run repairs an inflated count instead of compounding it.
- Capped and high-frequency terms: **the count is not bumped at all**. It cannot be made idempotent — nothing records which entries contributed to a capped total, so a second run cannot tell an already-counted entry from a new one. The delta is reported for a human. *Stale by omission is recoverable; drifting upward every run is not.*

Twelve capped headers inflated by the partial run were restored from the pre-run snapshot, each verified.

### 3.3 A third, smaller one: 700 max_tokens was not enough

All 22 first live calls returned `stop_reason=max_tokens` with only a `thinking` block and no text — the model spends budget reasoning over a 155-term vocabulary before writing JSON. It presented as a parse failure. Raised to 4,000 after measuring, and **only diagnosable because the existing Anthropic-response diagnostic names the block types** rather than reporting "no text content".

---

## 4. Mutation checks — 22 run, all caught

Watermark ×4 · escaping ×3 · `tabId` ×4 · format guards ×7 · vocabulary ×2 · write verification ×4.

Three survived a first pass and were fixed by adding what was missing, not by weakening the check: the health-note guard needed an orchestrator-level test; the start-of-line anchor needed a fixture reproducing a heading's shape **mid-sentence** (`§092 — the fixture failure —`), which is how the log actually cites itself; and "a real term is not also re-proposed" had no test at all.

---

## 5. Deliberately not built

**No wholesale replacement, expressible nowhere.** **No Plan indexing** (§2). **No backlog run** — 68 older entries remain unindexed, including §002 and §005; the first live run was September alone by instruction, and the backlog is a separate, larger decision. **No schedule** — `workflow_dispatch` plus §089.4's weekly safety net still to be wired.
