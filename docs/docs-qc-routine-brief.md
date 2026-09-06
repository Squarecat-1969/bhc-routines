# Build brief — the documents QC routine (Part 3)

**Repo:** `bhc-routines` · **Drafted:** 2026-09-06
**Read first:** `docs/docs-links-and-qc-brief.md` §PART 3 in this repo — this expands it with what Parts 1 and 2 established. Where they disagree, this is newer.

⚠ **Parts 1 and 2 are live.** `/api/brain/docs` exposes heading IDs (`includeHeadings`) and writes verified links (`insertLink`). Health now carries `readActions`, `readFormats` and `readNote`. **Read health first and build against what it reports**, not against this brief's description of it.

---

## 0. What this is, and what it is not

**It checks that each governing document holds what it declares it holds, and that the index's links still resolve.** It reports. **It never edits.**

⚠ **THE REASON IT NEVER EDITS IS NOT CAUTION, IT IS CAPABILITY.** On 2026-09-05 a Dev log tab inventory was written into the Plan's Table of Contents — wrong, and removed the same day. But a routine that deleted prose failing to match a generated list would also delete that ToC's opening paragraph and its note about blank page-break headings, both deliberate. **A checker cannot distinguish a mistake from an intention without judgement.** It surfaces; a human decides.

---

## 1. The contract

**Rules are checkable statements about placement, not judgements about quality.** The negative form is stronger wherever it is available — *"the Plan's ToC contains no Dev log document ID"* needs no judgement at all.

| Document | Holds | Never holds |
|---|---|---|
| **Dev log** | dated `§NNN` entries, appended, newest last | schema definitions, chapter content |
| **Plan** | chapters, schemas, decisions, the incident ledger | `§NNN` log entries |
| **Plan's ToC** | lines corresponding to headings in the Plan tab | Dev log document IDs, log tab names, `§NNN` references |
| **Index** | term references to **both** Plan and Log | references to itself |

⚠ **EVERY RULE IS EARNED. DO NOT ADD SPECULATIVE ONES.** A large speculative rule set would be mostly wrong, would generate false positives, and would train the reader to ignore the report — which costs more than the check is worth. Each rule above traces to a real error:

- Log content in the Plan's ToC — 2026-09-05, written and removed the same day
- The project instructions describe log-001 as having a `Table of Contents` tab and a `Session Notes (original)` tab. **Verified 2026-09-05: it has neither** — three month tabs only
- The ToC's `§106–§127` went stale within one session, as did the index's copy of the same figure

---

## 2. The checks

### 2.1 Placement

Each rule in §1, mechanically. Report the offending line and the document.

### 2.2 Link integrity — this is most of the value

⚠ **NOTHING HAS CHECKED THIS SINCE THE 610-LINK MIGRATION ON 2026-08-30.** A renamed tab or a moved document would break links silently until someone clicked one.

**And there is already a known break, which is the acceptance test:** the Plan's ToC links to `h.68mlrx18r7t` for *"PERMANENT IDENTITY CORRECTIONS"*. That heading was **demoted to normal text after the migration linked it**, so the anchor exists nowhere in the document. Found 2026-09-06 while verifying heading IDs — 82 of 83 matched, and the 83rd was this.

**If the check does not find that link, the check is wrong.** Do not proceed until it does.

For every link: the document exists, the `tabId` exists, and the `headingId` appears in that tab's headings. Heading IDs come from `includeHeadings`.

### 2.3 Coverage

Every `§NNN` in the Log, and every heading in the Plan, referenced by the index. **Report gaps by name**, not as a count.

⚠ **Plan coverage will be large and that is expected, not a defect.** The index carries 291 Plan references written by hand; the index routine contributes zero, because the Plan is chapter-structured with no `§NNN` entries and indexing it needs its own parser plus a different watermark — a Plan chapter is rewritten in place, so "already indexed" cannot mean "seen once." **Report the gap; do not treat it as a failure.**

### 2.4 Recorded figures

Any count or range one document states about another, checked against what was actually read.

**Two went stale within a single session on 2026-09-05** — the ToC's `§106–§127` and the index's copy. **And a third has been wrong for longer:** the ToC's preamble says it omits *"ten blank page-break heading paragraphs and one stray blank heading"*, i.e. 11. **There are 15** — 12 `HEADING_2` and 3 `HEADING_1`, all carrying real anchors, measured 2026-09-06.

### 2.5 ToC completeness

Every heading in the Plan tab appears in its ToC, and nothing appears that is not a heading.

⚠ **Two things the naive version gets wrong.** The ToC's prose preamble is deliberate — allow it explicitly. And **the ToC lists levels 1–2 only**: the Plan tab has 117 headings, of which 92 are levels 1–2 and 102 are non-blank. Comparing against all 117 reports 25 phantom omissions.

### 2.6 Document hygiene — report, never act

**Nine Plan headings contain entire paragraphs** — the `INCIDENT 1…6` blocks and the `3a`/`3b` sub-entries are styled `HEADING_2` but hold multi-sentence bodies, one over 900 characters. Links work; the IDs are correct. But anything generating index text from heading text must truncate, and it is worth surfacing as hygiene rather than papering over.

---

## 3. ⚠ THE RULES LIVE IN A MANIFEST, NOT IN CODE

**A rule living in a routine's logic cannot be read by the person writing the document.** In a manifest it is the thing you check *before* writing — which is where it prevents the error rather than reporting it after.

The manifest holds the §1 contract per document, and each rule carries **the incident that earned it**. A reader should be able to see why a rule exists, not just that it does.

---

## 4. Build discipline

**Read-only against every document.** No `insertText`, no `replaceRange`, no `insertLink`.

⚠ **`tabId` is REQUIRED on every read.** A call without one silently resolves to the first tab.

⚠ **Do not check links through `/api/brain/docs` markdown — it strips link markup**, and a link check there reports **zero across 83 real links**, which reads as a finding and is wrong. This has cost time twice and is now documented in that route's `readNote`. Read links through a renderer that emits them, and **use a known-linked line as a control so a zero is distinguishable from a strip.**

**Budget:** log-002 preReads at 6,477–17,800ms depending on where it is measured from. **Where a measurement was taken is part of the measurement** — GitHub runners came in 1.8–2.2× local on the same document, with a 20% spread between two runs minutes apart.

---

## 5. Cadence

**Weekly, after the index run.** Nothing here is urgent; all of it is silent. Reports to Slack or an artifact.

⚠ **A scheduled trigger has no `inputs` context.** Branch on `github.event_name` before reading any input, or the scheduled run reads every input as empty and reports success having done nothing. That failure has shipped twice in this repo.

**Match the other eight workflows:** `checkout@v5`, `setup-node@v5`, `upload-artifact@v6`, and both required env keys — `BRAIN_API_TOKEN` and `ATTIO_API_KEY`. ⚠ `tests/workflows.test.ts` derives the required set from `loadEnv` and asserts every workflow passes it; a new workflow must satisfy it.

---

## 6. Verify

`npm run typecheck && npm test`.

**Mutation-check every rule.** Neuter it, confirm a test fails, restore it. ⚠ Across this session **five guards passed on their first attempt for reasons unrelated to what they named** — a decorative fixture, a mutation that hit a TDZ error, a negative case differing in two fields, a shared guard checked from one caller's side, and a one-directional corpus. **A clean first-attempt bite is worth investigating, not recording.**

⚠ **Test in both directions where a rule could be too tight.** The 84-link corpus proves no legitimate link is rejected, but every member is `docs.google.com` with dots — so it passes an allowlist-only rule happily. One-directional tests miss over-tightening entirely.

**Live, read-only:**

1. **The known broken link must be found.** If it is not, stop.
2. Report every rule's result, with offending lines quoted.
3. Report the Plan coverage gap by name, and confirm it is reported as a gap rather than a failure.
4. Confirm nothing was written anywhere.

---

## 7. Report

Which rules fired and on what. The broken-link result. The recorded-figure results, including the 11-versus-15 blank headings. All mutation results. **And any rule you could not express as a check** — a rule that needs judgement belongs in the manifest as guidance for a human, not as a test that will produce false positives forever.
