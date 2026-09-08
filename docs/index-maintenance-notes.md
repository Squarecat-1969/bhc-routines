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

## 5. The GitHub Actions wiring (2026-09-05)

`.github/workflows/index-maintenance.yml`. Triggers are §089.4's, verbatim:
*"Triggered by workflow_dispatch at session close rather than cron, since the
log only changes when a session writes to it, plus a weekly safety-net run."*

### The cron, and why it is one expression rather than two

```
cron: '0 17 * * 6'   Saturday 17:00 UTC
  · Saturday 10:00 PDT (UTC-7, roughly Mar-Nov)
  · Saturday 09:00 PST (UTC-8, roughly Nov-Mar)
```

Verified against real tz data for 2026-01-10, 2026-07-11 and 2026-11-07.

⚠ **Deliberately NOT a DST pair.** `late-edition.yml` needs two expressions and
a runtime guard because it must hit a specific Pacific hour — and it shipped a
real double-run bug on exactly that. A weekly safety net has an hour of slack
by design, so the DST shift is absorbed rather than corrected for, and there is
no second expression that could double-fire.

⚠ **Saturday morning, because a mid-session fire would index a half-written
entry** — the excerpt would quote an unfinished sentence, and the watermark
would then record that entry as done, so the finished version would never be
re-read. The window is also what makes it safe against GitHub cron being
"best effort": Late Edition was observed running **2.5-4 hours late every
night**. Four hours late here is Saturday 13:00-14:00 PT, still nowhere near a
session and clear of Late Edition (Sun-Thu 23:00 PT).

### The backlog is OPT-IN, and separately bounded

Both, because either alone is insufficient:

- **`scope: latest` (the default, and what the schedule always uses)** restricts
  a run to the newest source tab. `latestSourceLabel()` reads the END of
  `SOURCE_TABS` rather than naming a month, so adding an October tab moves it
  with no workflow edit — pinned by test. **Reaching the 68-entry backlog
  requires choosing `all-sources` by hand.**
- **`max_entries`** (default 40) caps entries assigned per run regardless, and
  the run reports how many were left.

A bound alone would still chew through the backlog silently over consecutive
Saturdays, spending real Anthropic budget on a corpus nobody is waiting on. An
opt-in alone would let one deliberate backlog run do all 68 in a single
invocation. The pair means the backlog only moves when someone asks, and then
only in reviewable batches.

### Safe with nothing to do — verified, not assumed

The weekly net will find nothing most weeks. Running the exact scheduled
command (`--live --latest-source`) against the current index:

```
0 unindexed · 0 LLM calls · 0 planned writes · attempted 0 · CONFIRMED 0
EXIT CODE: 0
```

The CLI fails only on an abort or on `writesConfirmed !== writesAttempted`;
0 === 0, so a no-op run is green rather than a false alarm.

⚠ **A scheduled trigger has no `inputs` context at all** — only
`workflow_dispatch` populates it. The run step branches on
`github.event_name` before reading any input, because without that the weekly
run reads every input as empty, falls through to `--dry-run`, and reports
success having written nothing. That is the failure `late-edition.yml` records
having shipped.

### The first dispatch failed on shared env, not on anything in this routine

`Invalid environment: ATTIO_API_KEY: Required`, thrown by `loadEnv` before any
work started. The flags were correct — the `event_name` branch worked.

⚠ **`loadEnv` validates the WHOLE shared schema up front.** Derived
empirically by removing each key in turn rather than read off the file, its
required set is **exactly two**:

| key | |
|---|---|
| `BRAIN_API_TOKEN` | **required** |
| `ATTIO_API_KEY` | **required** |
| `ANTHROPIC_BHC_ROUTINES_API`, `ZAPIER_SLACK_HOOK_URL`, `FATHOM_API_KEY`, `FATHOM_API_BASE` | optional |
| `RUN_TIMEZONE`, `SHEETS_PROXY_URL`, `DOCS_PROXY_URL`, `ATTIO_API_BASE` | defaulted |

So a routine that reads Google Docs and calls Anthropic still fails at startup
without an Attio key. **All seven other workflows pass both**; this was the only
one that did not, and that is the whole defect. One line, in the workflow —
narrowing the schema per-routine is a change to config seven workflows depend on.

`ANTHROPIC_BHC_ROUTINES_API` is worth naming separately: optional in the schema,
but the CLI hard-requires it unless `--no-llm`. That requirement lives outside
`env.ts` and an audit of the schema alone would miss it.

**The artifact warning was downstream, confirmed rather than assumed.**
Reproduced with `ATTIO_API_KEY` unset: same error, same line, and **no report
file** — `loadEnv` throws before `writeFileSync` is reached. The CLI exits **1**,
so the job goes red at the run step; `if-no-files-found: warn` is noise after an
already-failed run, not a silent no-op upload. With the key present the report
is written and the run exits 0.

**`tests/workflows.test.ts` now derives the required set from `loadEnv` itself
and asserts every workflow passes it.** Mutation-checked both ways: reverting
the fix fails it, and making an optional key required fails it. A hardcoded list
would have rotted exactly the way the schema changed.

*(An aside worth keeping: verifying this, a hand-rolled harness passed the token
with its surrounding quotes and the route answered **404**. That is Rule 1
working — a bad Bearer is indistinguishable from a missing route — and §105
records the same trap. The fix was the harness, not the routine.)*

---

## 6. Linked references (2026-09-06)

Both prerequisites shipped in `bhc-aida`, and both were verified live rather
than taken on description:

- `read` accepts **`includeHeadings: true`** and returns `headings[]` with
  `headingId`, `level`, `text`, `startIndex`/`endIndex`, `plainTextStartIndex`,
  `linkable`, **and a pre-built `url`**, plus `headingCount` and
  `unlinkableHeadingCount`.
- **`insertLink`** is in `writeActions` and `validActions`, taking
  `action, documentId, tabId, index, text, url`.

⚠ **THE ROUTE BUILDS THE URL; THE ROUTINE DOES NOT.** The brief describes
constructing `…/edit?tab=<tabId>#heading=<headingId>`, and the route hands that
string over already assembled. Concatenating it a second time here would be the
same string built in two places — the shape that drifts — and a wrong anchor
writes a link that resolves to the top of the document while every verification
still passes. `heading.url` is used verbatim.

⚠ **ANCHORS ARE KEYED BY LOCATOR, NEVER BY ARRAY POSITION.** The headings array
and the parsed entries are two independent walks of the same tab, and the tab
title is itself a heading; pairing them by index would mis-link every entry
after the first non-entry heading. `linkable: false` means the reference is
written PLAIN rather than linked to the wrong place.

### Three runs, inserted in reverse at one fixed index

The 610 migrated references link the `§NNN · DATE · Log` prefix only, leaving
the bullet and the quotation outside the link, so a line is three runs:
`· ` + **linked locator** + ` “excerpt”`.

They are inserted **in reverse order at a single fixed index**, which removes
two failure modes at once:

1. **No index arithmetic.** Every insert goes at exactly `at` and pushes what
   was already inserted rightward, so no run's position is derived from another
   run's length. Document indices count structural positions as well as
   characters, so that arithmetic is exactly the kind that drifts.
2. **No style inheritance.** Google Docs inherits formatting from the text
   immediately BEFORE an insertion point, and `at` always sits at the end of
   the plain anchor line. Inserting forward would place the excerpt directly
   after the linked run, where it would inherit the link and swallow the
   quotation into it.

### ⚠ Both verification dimensions, checked separately

`contentVerified` is the byte comparison — **exactly as true for a plain
unlinked run as for a linked one, because the text is identical either way.**
`linkVerified` re-reads and confirms the stored link resolves. The state that
matters is `contentVerified: true, linkVerified: false`: a reference that reads
correctly and is not clickable, which is the whole defect this removes.
`assertLinkVerified` requires both explicitly rather than delegating to the
route's outer `verified`, and the run counts **links confirmed**, not writes
confirmed.

### Live results, 2026-09-06 — §128 to §133

| | |
|---|---|
| entries indexed | **6** — §128 §129 §130 §131 §132 §133 |
| references planned LINKED / plain | **16 / 0** |
| links CONFIRMED on both dimensions | **16 of 16** |
| writes confirmed | **34 of 34** |

Sample outcome: `linked · content=true link=true · deltas 3/23/147`.

**Verified through the BRIDGE's markdown, with a control.** `/api/brain/docs`
strips link markup and reports zero across every link in the document, so a
zero result there is indistinguishable from a real absence — a migrated line is
used as the control that proves the renderer works. All three generations are
visible in one term block:

```
· [Ch 11 · Plan](…1Hx1gXee…#heading=h.knelq9wzlctn) “never landed in the CRM's…”   <- control, migrated
· §106 · 2026-09-01 · Log “Task reconciliation needed calendar as an evidence…”     <- 2026-09-05, plain
· [§128 · 2026-09-05 · Log](…1Qa3cHgE…?tab=t.jknmiezen1ga#heading=h.81qozxqtdz99)
    “The routine the Docs route was built for, three weeks after that route…”       <- LINKED
```

The bullet and the quotation sit outside the link, matching the migrated shape
exactly — the reverse-insert ordering held.

**The 90 plain lines from 2026-09-05 were NOT retrofitted**, confirmed in the
same read: §106, §108, §109, §111, §115-§124 are all still plain. Backfill is a
separate pass; mixing it in would have given one failure two possible causes.

### Two things this run surfaced

**§133 hit the response schema's 12-term cap on the dry run** (`terms: Array
must contain at most 12 element(s)`) and produced no assignment, though it
succeeded on the live run. Session-close entries summarise everything and are
the natural outlier — measured range elsewhere is 2-6 terms per entry. Left as
is: the cap is doing its job, the failure is visible, and the watermark retries
the entry. Raising it is tuning, and should follow evidence rather than one
outlier.

**`health.writeNote` is stale and now self-contradictory.** It still reads
*"Writing is insertText and replaceRange only … no styling"* while
`writeActions` lists `insertLink`, and `measuredAt` is `2026-08-31`. That is a
point-in-time fact standing as a rule (Contract Rule 8) in the one place a
caller checks capability. `bhc-aida` owns it.

---

## 7. The 12-term cap, and the entries it blocked (2026-09-08)

### The defect: a cap the model was never told about

`AssignmentSchema` has capped `terms` at 12 since this shipped. **Nothing in the
prompt or the system message mentioned it.** So the model returned what a dense
investigation entry deserves and every one failed validation:

| entry | terms returned | consecutive failed runs |
|---|---|---|
| §092 — Zoom DISCOVERY port | **20** | 3 |
| §096 — write-verification sweep | **15** | 3 |
| §102 — intended-not-confirmed counters | **20** | 2 |

Each produced nothing, was retried at full cost on the next run because the
watermark cannot distinguish a failed entry from a new one, and **the run
reported GREEN** with a warning that scrolled past. That is the exact shape
this routine exists to prevent.

### The fix is instruction, NOT a bigger cap

⚠ **Raising the cap would be fitting the rule to its outliers.** The cap exists
to stop unbounded assignment — a dense entry legitimately touches twenty
concepts, and indexing it under all twenty is how an index becomes unscannable.

The prompt now states the limit and says what to do when more apply: prioritise
in a stated order — the mandatory failure-class term first, then the terms a
reader searching for this entry would type, then terms specific to this entry
over terms matching hundreds of others — and drop the marginal ones. **What is
lost is marginal terms rather than the whole entry.**

**Verified against the three real entries, not a fixture.** All three now index,
each returning exactly 12, each carrying a failure-class term:

- **§092** → `stale spec`, `BHC Zoom`, `DISCOVERY`, `Zoom_Staging`,
  `Meeting triage`, `Fathom`, `phased by risk`, `PASS 1`, `PASS 2`, `STEP 0`,
  `Claude Code`, `capture loss`
- **§096** → `stale spec`, `read-back verification`, `PASS 0`, `PASS 1`,
  `PASS 2`, `Reconciler`, `Reconciler_Report`, `Brain_Complete`, `Activity_Log`,
  `Thread_Staging`, `Part D`, `lib/sheetsProxy.ts`
- **§102** → `false positive`, `read-back verification`, `Part D`, `PASS 2`,
  `PASS 3`, `PASS 4.5`, `PASS 5`, `Reconciler`, `Contacts Triage`, `Tasks_Log`,
  `Name_Conflicts`, `Attio`

(A dry run against the live index plans 8, 4 and 5 *reference lines*
respectively — fewer than 12 because Rule A/Rule B terms take a count update and
no reference line.)

### Blocking, and why N is three

`Index_Maintenance_State` (Sheets, 7 columns) records consecutive failures per
entry. **After three, the entry is BLOCKED and not attempted.**

Two consecutive failures can still be two transient faults — a 429, a timeout,
a truncated response. Three identical rejections on the same entry is a
pattern, and §092 and §096 reaching exactly three is what made this visible.
The asymmetry sets the threshold: one extra attempt costs one LLM call, while
blocking too early costs an entry that would have indexed and is now silently
absent — the failure this routine exists to prevent. So it sits one attempt
past "could plausibly be transient", not at it.

⚠ **A block is a conclusion from a version of the prompt, not a fact about the
entry.** `PROMPT_VERSION` and the vocabulary size are both recorded, and either
changing re-opens every block exactly once, automatically. Without that,
§092/§096/§102 would have stayed blocked forever under a prompt that never
judged them, and someone would have had to remember to clear the tab by hand.
Same lesson as the re-resolution pass's derivation version.

⚠ **Blocked entries are reported BY NAME on every run**, with failure count and
last error, whether or not anything else happened — a blocked entry that
vanished from the report would make the backlog look closed, which is the same
defect in a new costume.

⚠ **Without the state tab the routine still runs but CANNOT block**, and says
so loudly in the report and the warnings. Degraded, never silent. The tab needs
creating by hand — the Sheets proxy cannot create tabs — with header:
`locator, consecutive_failures, blocked, last_error, last_attempt_date,
prompt_version, vocabulary_size`.

10 mutation checks, all caught.

---

## 8. Plan indexing — the additive half (2026-09-08)

Built per `docs/plan-indexing-spec.md` §0: **additive only.** The routine adds
references for Plan sections the index does not yet mention, and never removes
or rewrites one. Reached by `--source plan` alone.

### The truncation, fixed before anything else

`ENTRY_CHARS_IN_PROMPT` is 3,500 — sized for a log entry. A Plan unit is a
chapter section. Measured live across all 89 L2/L3 units: median 1,184, p90
2,734, p95 4,022, **max 17,184**.

At 3,500, five units truncate and **27,145 characters — 18.9% of all unit text
— never reaches the prompt**, while the reference lines built from the 14% that
did are byte-indistinguishable from complete ones. Plan units now have their
own budget, `PLAN_UNIT_CHARS_IN_PROMPT = 20000`, at which **nothing truncates
today**. 12,000 was rejected: it leaves one unit clipped, and the marginal token
cost of the larger budget is trivial against a chapter silently indexed from 70%
of itself.

That does not make truncation impossible, only currently absent — so a
partially-read unit is a **named, top-level report section** (`PARTIALLY READ`)
carrying the locator and both lengths. It is never a warning and never inferred
from a character count. `buildPrompt` also stopped re-slicing the body: the
parser slices, and the parser is what records `truncatedTo`, so there was a
second place that could truncate without saying so.

The five that would have truncated at 3,500 are all already-referenced, so
under add-only none of them would have been indexed anyway. The fix still
matters: it removes a silent failure that was one provenance decision away from
firing, and it keeps the prompt cap out of the hash (below).

### The content hash — built although nothing consumes it yet

`Plan_Index_State`, eight columns, one row per section. This is the real
deliverable of the exercise and the reason it was built ahead of any consumer.

A log entry is appended and never changes, so "referenced once" means "done
forever". **A Plan chapter is rewritten in place** — Chapters 1, 3, 4, 5.3 and
11 were substantially rewritten between 2026-08-25 and 08-27 while their index
references predate every one of those edits, and nothing noticed. The watermark
answers "has this ever been indexed"; the hash answers "is the index still right
about it", and only the second question catches that.

Two decisions inside it:

- **The hash covers the whole unit body, whitespace-normalised — never the
  truncated prompt slice.** A hash of what the model saw would miss every change
  in the part it did not. This is also why the prompt cap and the hash are kept
  apart.
- **A heading-only hash was rejected.** It never fires when a body is rewritten,
  which is exactly the August case. A whole-body hash over-triggers on a typo
  fix; that is the failure worth having here, because nothing is repaired
  automatically — a false positive costs a glance, a false negative costs a
  chapter silently misdescribed.

`indexedBy` is decided on first sight and never upgraded. Anything unrecognised
in that column parses as `hand`, never `routine`: the permissive direction would
let the routine believe it owns references a human wrote, and **all 291 existing
Plan references are human**.

### Dedup is prefix matching, and the guard that could not be tested

The 69 hand-written locators truncate long heading text by eye at between 48 and
64 characters, so a generated locator can differ from a hand-written one only in
where it was cut. Comparing exactly would add a second reference for a section
already indexed — the one thing add-only must not do. `planLocatorMatches`
therefore prefix-matches above a 12-character floor. On live data it resolves
**56 of 89 sections as already referenced**.

An earlier version carried a second, explicit branch in front of the floor: *a
numeric locator is exact or nothing*, so that `5.1` could never match `5.10`.
**Mutation testing killed the branch's justification rather than the branch.**
Removing it changed no test result, because every numeric locator this file
produces is a bare token of at most six characters and the floor already decides
every numeric comparison. No input can distinguish the two rules. Paired guards
masking each other is now the third time this repo has found that pattern; the
branch was deleted, the floor's numeric consequence is documented on the floor
itself, and the `5.1` / `5.10` test kills a mutation of the floor.

### Scope: the schedule cannot reach the Plan

`plan` is a third explicit scope, excluded in `selectSources` rather than only
in the CLI — the CLI is one of two callers and a workflow flag is not a guard.
Neither the weekly safety net (`--latest-source`) nor the log-backlog opt-in (no
`--source` at all) selects it. The Plan is 89 units against the September tab's
22, and acquiring that by default is the same failure as the log backlog: real
spend on a corpus nobody dispatched.

### Filing order differs by source kind

A term's Log references run in date order and its Plan references follow them —
visible in exactly one place, the document itself. `insertionIndexFor` files a
Log entry after the last **Log** line and a Plan unit after the last line of
**any** kind. Reusing the Log rule for Plan units would file every new section
above the hand-written ones, so the additive half would visibly disorder a block
it is forbidden to rewrite.

### ⚠ OPEN — the unit granularity is wrong for one chapter, and no rule fixes it

The spec's unit is "an L2/L3 heading and its text to the next heading". On live
data that is correct for 88 sections and wrong for one writeup.

**INCIDENT 7's detail is twelve consecutive paragraphs, each styled Heading 2.**
Read live 2026-09-08: `DISCOVERED 2026-08-28…`, `src/part-d/write-row.ts:69
declares…`, `ROOT CAUSE — …`, `WHY IT SURVIVED…`, `DAMAGE ALREADY DONE…`,
`REPAIR…`, `CODE FIXED 2026-08-28…`, `ONE MORE INSTANCE…`, `confirm.ts's
counts.tasks…`, `STILL TO VERIFY LIVE…`, `HOW IT WAS NEARLY MISSED…` are all
level 2, the same level as `5.3 BHC Zoom`. Indexing them as written files one
incident under eleven separate reference lines.

**Every candidate exclusion rule is contradicted by the human precedent.** A
"prose-shaped heading" rule — heading text over 64 characters, or ending in a
full stop — catches all eleven, and also catches eight sections a human chose to
index by hand: `INCIDENT 1`, `INCIDENT 2`, `3a`, `3b`, `8.6 STAGING TABS`,
`OPERATIONAL BACKLOGS`, `STATUS AT A GLANCE`, and `(KEPT FOR REFERENCE…`.
`INCIDENT 3`–`INCIDENT 7` have the identical shape to `INCIDENT 1` and
`INCIDENT 2`, which are indexed. The document encodes no signal separating a
section title from a headed paragraph, so this is **flagged, not resolved** —
picking a rule here would quietly overrule a human's own filing.

## 9. Deliberately not built

**No wholesale replacement, expressible nowhere.** **No Plan indexing** (§2). **No backlog run** — 68 older entries remain unindexed, including §002 and §005; the first live run was September alone by instruction, and the backlog is a separate, larger decision. **No schedule** — `workflow_dispatch` plus §089.4's weekly safety net still to be wired.
