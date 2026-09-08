# Spec — indexing the Developer's Plan

**Repo:** `bhc-routines` · **Drafted:** 2026-09-08 · **Status:** SPEC ONLY, not built
**Measured live 2026-09-08** against the Plan content tab (`t.6r0bmznlg6id`) and the live index. Every figure carries its date.

---

## 0. The recommendation, stated first

**Automate the ADDITIVE half. Do not automate the UPDATE half.**

- **Index Plan sections that have never been indexed** — additive, idempotent by `(term, locator)`, needs no delete. ~41 sections by the QC pass's own count.
- **Do NOT keep already-indexed sections current.** That requires removing references the routine wrote, which requires a delete capability the transport deliberately lacks *and* a provenance record that cannot be retrofitted onto 291 hand-written references. **Detect the drift and report it; let a human act.**

The split falls exactly on a capability boundary, not on effort. §4 is why.

---

## 1. The unit of indexing

### Measured distribution

**197,409 characters · 117 headings · 0 unlinkable.**

| level | count | median section | max section |
|---|---|---|---|
| L0 | 1 | 2,474 | 2,474 |
| L1 (chapters) | 15 | 532 | **24,739** |
| L2 | 77 | 841 | 11,075 |
| L3 | 24 | 1,528 | 17,184 |

Section = heading to the next heading of any level. Across all 117: min **1**, p25 302, median **948**, p75 1,805, p90 2,899, max **24,739**. **23 sections are under 200 characters; 7 are over 5,000.** 15 headings are blank page-break artifacts.

**17 headings hold entire paragraphs** (>120 chars), longest **1,887** — the `INCIDENT 1…6` blocks and the `3a`/`3b` sub-entries. For these the heading *is* the body.

### ⚠ What the human already chose, and it settles this

The 291 references use only **69 distinct locators** — 4.2 references per locator. Resolving each against the heading list:

| | references |
|---|---|
| **L2 heading** | **202** |
| L3 heading | 55 |
| no heading match | 34 |

**The unit is the level-2 or level-3 heading and its text up to the next heading of any level.** That is not a design choice; it is the granularity the index already uses, and matching it is what lets routine-written and hand-written references sit in one list without looking like two schemes.

**Excluded:** the 15 blank headings (no text to index — the ToC omits them deliberately and says so), and L1 chapter headings as units in their own right (a chapter is its sub-sections; indexing it separately double-counts).

### ⚠ Two shapes that break the naive unit

**The paragraph-headings.** For the 17, heading text and body are the same thing. Feed the heading text as the body and take the locator from its leading fragment (`INCIDENT 2`, `3a`) — which is what the human did. A unit that assumes `heading = short title` produces a 1,887-character "title" in the reference line.

**⚠ SECTIONS EXCEED THE PROMPT BUDGET, AND TRUNCATION IS SILENT.** `ENTRY_CHARS_IN_PROMPT` is 3,500. Log entries mostly fit — §092, the largest, is 11,314 and was already being truncated. Plan sections reach **24,739 at L1 and 17,184 at L3**. At 3,500 the routine would index 14% of a chapter and report success. Either raise the cap for Plan units, or split long sections and index each part, **or accept partial coverage and say so in the report** — but it must not stay silent, because a section indexed from its first 3,500 characters looks identical to one indexed in full.

---

## 2. The watermark

### What it hashes

**The section body — heading text plus everything to the next heading — normalised for whitespace only.** Stored per locator in a state tab, alongside the vocabulary size and prompt version the existing routine already versions on.

### ⚠ Which failure I would rather have

The two candidates fail in opposite directions:

- **Hash the whole section:** a typo fix re-triggers. Cost: one LLM call, and a duplicate reference unless re-indexing can remove the old one.
- **Hash the heading alone:** the body can be rewritten entirely and nothing notices. Cost: the index describes a chapter that no longer exists.

**I would rather over-trigger.** The under-triggering failure is exactly the one this routine exists to prevent — §098 records five Plan chapters (1, 3, 4, 5.3, 11) substantially rewritten between 2026-08-25 and 08-27 while the GROUP tabs predate every one of them. A heading-only hash would have caught none of it. **A stale index fails silently and in the worst direction: a search returning the wrong thing reads as an answer.**

⚠ **But that preference is only affordable if re-indexing is cheap AND idempotent, and §4 shows it is neither.** Over-triggering without the ability to remove the superseded references produces accumulation — two sets of references for one chapter, the older describing text that no longer exists. **That is worse than not re-indexing at all**, because a wrong reference is worse than a missing one.

**So the watermark's answer depends on §4, and §4 says don't.** The hash is still worth computing — not to trigger a re-index, but to *report* drift. See §6.

---

## 3. The 291 hand-written references

**It must not duplicate them and must not delete them.**

**Not duplicating is already solved and needs no new mechanism.** The planner skips a reference whose locator already exists under that term:

```
if (existing.term.references.some((r) => r.locator === entry.locator)) continue;
```

So `(term, locator)` is the idempotency key, and the 69 hand-written locators are simply never re-added under the terms that already carry them. **A first Plan run adds only pairs that do not exist.**

### ⚠ It cannot tell its own work from a human's, and that is the finding

**Nothing in a reference line records who wrote it.** The format is `· <locator> · Plan "excerpt"` with a hyperlink, and a routine-written line is byte-indistinguishable from a hand-written one — deliberately, because they had to sit in one list.

Three ways to change that, and none is free:

1. **A provenance marker in the line.** Pollutes a document a human reads, changes a format 610 migrated links already follow, and cannot be applied retroactively to the 291.
2. **A state tab recording every `(term, locator)` the routine wrote.** Clean going forward, and **says nothing about the 291** — they would be permanently "unknown provenance", which is the safe answer but means the routine can never touch them.
3. **Infer from the excerpt.** Fragile and exactly the kind of guess this codebase refuses.

**Recommendation: option 2, and treat "unknown provenance" as permanently untouchable.** The routine may add; it may never remove a reference it cannot prove it wrote. That is a strict, checkable rule and it makes the 291 safe by construction.

---

## 4. ⚠ Why the update half should not be automated

Keeping a rewritten chapter current means **removing the references that describe the old text**. That runs into two walls:

**The transport has no delete action, deliberately.** `writeActions` are `insertText`, `replaceRange`, `insertLink`. A delete is expressible only as `replaceRange` with empty text — so the capability is *reachable* but the route's design (§105: "no action capable of replacing a document or a tab wholesale… absent rather than disabled") is built on the routine never removing content. Adding a delete path to a routine whose consumer holds a controlled vocabulary, a match-modes section and two records of things searched for and NOT found is a materially larger risk surface than anything it does today.

**And provenance cannot be retrofitted.** By §3 the routine cannot prove it wrote any of the 291. So the sections most likely to need updating — the hand-indexed, frequently-rewritten chapters — are precisely the ones it must never touch. **The update capability would be unusable exactly where it is needed.**

**Therefore: additive automation, and drift reported rather than repaired.** This is not caution standing in for capability; it is the capability boundary, and it happens to fall in a place where the honest answer is a smaller routine.

---

## 5. Links — yes, and the mechanism already exists

**The Plan's references are already linked.** Verified through the bridge: `[Ch 11 · Plan](…/edit?tab=t.6r0bmznlg6id#heading=h.knelq9wzlctn)`, `[5.9 · Plan](…)`, `[IDENTITY MINTING — the standing procedure · Plan](…)`.

**New Plan references should link too**, and nothing new is needed: `includeHeadings` returns a ready-built `url` for all 117 headings with **0 unlinkable**, `insertLink` is live with dual verification, and the three-run insert (`· ` + linked locator + ` "excerpt"`) is proven — 16 of 16 links confirmed on 2026-09-06.

One caveat inherited from the QC pass: **a link's target can be demoted.** `PERMANENT IDENTITY CORRECTIONS` was a heading when the migration linked it and is normal text now, so `h.68mlrx18r7t` resolves nowhere. Plan headings move more than log headings do, so link rot is a live risk here in a way it is not for the log — another argument for the QC pass owning drift detection.

---

## 6. Cost, and the gate

At the measured September rate (22 entries → 22 calls, 82 writes, ~11 minutes):

| unit set | units | LLM calls | writes | wall time |
|---|---|---|---|---|
| every non-blank heading | 102 | ~102 | ~380 | **~51 min** |
| levels 1–2 only | 77 | ~77 | ~287 | ~38 min |
| the human's 69 locators | 69 | ~69 | ~257 | ~34 min |

**4.6× the largest log run.** The additive-only slice is far smaller — the QC pass measures **41 uncovered Plan headings** — so a realistic first pass is ~41 calls and ~150 writes, roughly 20 minutes.

⚠ **It needs the same opt-in gate the backlog has**, and for the same reason: `scope: latest` must not silently acquire the Plan. Add `plan` as an explicit third scope value, never reachable from the weekly schedule. And the timings are indicative only — log-002's preRead moved 6,477 → 8,500 → 17,800ms across three measurements, so wall time here should be re-measured, not extrapolated.

---

## 7. What this would actually deliver, stated honestly

**It closes the additive gap: ~41 sections that have never been indexed.** That is real and it is the reason to build it.

**It does not make the index current, and should not claim to.** Five chapters were rewritten in August while their references predate them; those references stay stale under this design. What changes is that the drift becomes **visible** — a per-locator content hash lets the QC pass report *"Chapter 5.3 has changed since it was indexed"* by name, which today nothing does.

**And if the answer is that this stays manual, that is defensible.** 291 references across 69 locators is a hand-maintained index that works, on a document whose structure moves. The automatable part is the part nobody has got to yet — the never-indexed sections — and the part that would keep it honest over time is the part the transport is deliberately built to prevent. **A handoff can say that plainly rather than describing a gap.**
