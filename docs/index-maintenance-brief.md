# Build brief — the index maintenance routine

**Repo:** `bhc-routines` · **Drafted:** 2026-09-05

---

## 0. ⚠ READ THE PRIOR SCOPING FIRST — DO NOT WORK FROM THIS BRIEF ALONE

This routine has been scoped across several sessions and the notes are in the Dev log. **Read them before designing anything.** They are in log-003 (`1Qa3cHgEmWsWMEa4vc4WxKjVbLeLoeldSX9eyz54Z1zA`), tab `August 2026 pt.2` (`t.hh7xro7j1cqz`), around plain-text offsets **232814**, **269218** and **275509** — the last of which begins *"WHAT REMAINS: the index maintenance routine itself. Its hardest constraint is alrea…"* and runs to the end of the tab.

Use `/api/brain/docs` with `action: read` and that `tabId`. **This brief was written without being able to read that passage cheaply, so where the two disagree, THE LOG WINS.** Report any disagreement rather than silently reconciling it.

Also read §089.4 in the same tab (offset ~142598) — the log migration spec — because it established the escaping and anchoring rules this routine must obey.

---

## 1. The problem

The index is a keyword index over the Developer's Plan and every Dev log tab. **Its links are current; its coverage is not** — and those are different properties, only one of which was fixed when 610 hyperlinks were migrated on 2026-08-30.

Entries added after the 2026-08-24 snapshot are absent from the GROUP tabs. That backlog has grown every session since, and this session added §106–§127 plus a new source tab.

⚠ **A stale index fails silently and in the worst direction: a search returning nothing reads as "this was never discussed" when it means "this was never indexed."**

---

## 2. The sources, verified 2026-09-05

| document | tab | tabId |
|---|---|---|
| Developer's Plan | BHC Aida ROS — Developer's Plan | `t.6r0bmznlg6id` |
| log-001 `1RuYdyhoaaL8xBfBIdvGoxgJ39gA-nxQaN9qx-I3lFX4` | May 2026 | `t.ybpd957vf9sx` |
| | June 2026 | `t.eih8e5g59tms` |
| | July 2026 | `t.qygk8166n6kr` |
| log-002 `1gVUPxKAo19UyQN2isYuqfVuha3i6340gEylsVdX9Snw` | August 2026 pt.1 | read live |
| log-003 `1Qa3cHgEmWsWMEa4vc4WxKjVbLeLoeldSX9eyz54Z1zA` | August 2026 pt.2 | `t.hh7xro7j1cqz` |
| | **September 2026 (NEW)** | `t.jknmiezen1ga` |

⚠ **The project instructions describe log-001 as having a "Table of Contents" tab and a "Session Notes (original)" tab. IT HAS NEITHER** — verified 2026-09-05, it holds exactly the three month tabs above. The Table of Contents is a tab of the Developer's Plan. Do not build against the instructions' description.

**Target:** `1XDMVXmVAKd0q2uaUqRHk4_34J6nruzU8nmkqPSEcBuI` — nine tabs: `SOURCES INDEXED` (`t.0`), seven `GROUP:` tabs, and `ADDITIONAL TERMS`.

---

## 3. ⚠ THE HARDEST CONSTRAINT IS ALREADY SOLVED — USE IT

`/api/brain/docs` shipped phases 1 and 2 and is verified in production. **This routine is the reason it was built.**

- **Reads** are `tabId`-scoped. ⚠ **`tabId` is REQUIRED on every call.** A `doc_replace_range` without one silently resolves to the FIRST TAB — it failed on 2026-09-04 only because the target tab was short; against a longer first tab it would have written to the wrong tab and reported success.
- **Writes re-read the range and compare STORED BYTES TO SENT BYTES.** `verified` is true only when `deltaVariance === 0` AND the byte comparison passes.
- Budget 45,000ms per invocation. A verified write costs roughly **2.5× a preRead**, not 1.4× — the read-back is a second full fetch.
- Measured preReads: Plan 180,587 chars / 678ms · log-001 231,633 / 1,707 · log-003 268,894 / 1,244 · index 310,967 / 1,647 · **log-002 327,303 / 6,477ms — a 3× outlier.** The `chars^1.94` model does NOT describe this corpus.

⚠ **`doc_replace_range` anchors must be COPIED FROM A READ, NEVER RETYPED.** Curly-quote anchors cause silent `TEXT_NOT_FOUND`.

⚠ **ESCAPE EVERY UNDERSCORE AND ASTERISK UNCONDITIONALLY.** "Intraword underscores are safe" is FALSE for a PAIR across a span: `CHANNEL_MAP fix, Interaction_Date` lost both underscores and reported `verified: true`. This routine writes terms like `bhc_contact_id` and `last_email_interaction` constantly — it will hit this on its first run if the rule is not applied.

---

## 4. Shape

**Deterministic TypeScript plus ONE narrow LLM call per entry.** Not one call over the whole corpus. The deterministic half finds which entries are unindexed and where terms already live; the LLM assigns terms to a single entry against a controlled vocabulary.

⚠ **The vocabulary is CONTROLLED, not open.** The seven GROUP tabs define it. New terms go to `ADDITIONAL TERMS` — proposed, not silently promoted. An index whose vocabulary drifts stops being an index.

**Append and update in place, never rewrite.** Existing entries and their 610 migrated links must survive untouched. ⚠ A wholesale rewrite would re-render every anchor and is the hazard the per-link narrow-range approach was chosen to avoid on 2026-08-30.

**Watermark it.** Only process entries not already indexed. Without that, every run re-judges the entire corpus — real Anthropic spend for no new information, and the same requirement `pass2_6` has.

**Trigger:** `workflow_dispatch` at session close. Not scheduled — the Log is written by a human at session end, and there is nothing to index until then.

---

## 5. ⚠ Do not

- **Do not rewrite a whole tab.** Append or narrow-range replace only.
- **Do not run against log-002 without budgeting for it.** 6,477ms preRead, a 3× outlier, and a verified write is 2.5× that.
- **Do not promote a new term into a GROUP tab automatically.** `ADDITIONAL TERMS`, for review.
- **Do not trust a write's success response.** Byte-compare, which the route already does — check the field.
- **Do not index the index.** It is not a source.

---

## 6. Verify

`npm run typecheck && npm test`.

⚠ **DRY-RUN FIRST and report what WOULD be written**, per tab, before writing anything. The index is 310,967 characters of hand-corrected work and 610 migrated links.

Then: **index the September tab alone** — §106–§127, the smallest and newest source — and verify byte-exactly before touching the older backlog. **The first live run is not a catch-up.**

**Mutation-check every guard.** Across this session three tests passed on their first attempt for reasons unrelated to the guard they named. Specifically mutate: the watermark (removing it must fail a test), the escaping rule, and the `tabId` requirement.

---

## 7. Report

What the prior scoping in the log says that this brief got wrong. The dry-run output per tab. Measured timings against the real corpus, especially log-002. The September run's byte verification. All mutation results.
