# PASS 4 — implementation notes, assumptions, and open questions

Companion to `src/passes/pass4/`. Everything here is a place where the spec
(`routines/BHC_Late_Edition.md`) was ambiguous, self-contradictory, or silent, and
I had to make a call. Items 1, 2, 3, and 5 are decided (2026-07-17). **Item 4's
read-side assumptions are now fully verified (2026-07-18) — only the write path is
still unchecked, and it's the last gate before PASS 4 can go `--live` for real.**

---

## 1. `TODAY` is undefined for PASS 4 — ✅ DECIDED 2026-07-17: UTC

**Spec:** PASS 4d uses `TODAY` without ever defining it. PASS 4.5 defines its own as
`datetime.now(timezone.utc).date()`.

**Why it matters:** the routine runs at **11:00 PM PDT**, which is **06:00 UTC the
next calendar day**. So UTC-`TODAY` and Los-Angeles-`TODAY` disagree on *every single
scheduled run* — never on a manual daytime run, which is why this can hide.

Consequences of picking UTC:
- `next_check_in_date` lands one day later than a human would expect.
- `days_since` is inflated by 1, so a contact tips into `stalled` one day early.
- Anything landing exactly on the `> 2 * cadence_days` boundary flips.

**Decided: `UTC`**, via `RUN_TIMEZONE` (`src/config/env.ts`, default changed 2026-07-17).
Rationale: matches PASS 4.5's existing convention (`datetime.now(timezone.utc).date()`)
so the two passes agree on `TODAY` when 4.5 later reuses PASS 4's report rather than
disagreeing by up to a day depending on run time. `todayIn()` is tested against exactly
the 06:00 UTC boundary case (`tests/dates.test.ts`) for both `UTC` and
`America/Los_Angeles`, so the LA behavior is still verified even though it's no longer
the default.

**Known effect of this choice:** on the 11:00 PM PDT scheduled run (06:00 UTC next
day), `TODAY` under UTC is one calendar day ahead of what a human in Seattle would
call "today." `next_check_in_date` and `days_since` shift by one day versus the
LA-default behavior modeled above — expect small diffs against live values from the
old agentic routine (which had no defined `TODAY` either, so it was likely
inconsistent run-to-run anyway).

---

## 2. The unknown-tier cadence contradicts itself — ✅ CONFIRMED 2026-07-17: Social (pseudocode)

**Spec, prose table (line 244):** `(unknown) → 90 days · Context`
**Spec, 4b:** "Anything else → Strategic"
**Spec, 4d pseudocode:** `tier = tier_index.get(bhc_id, "Strategic")` → Strategic → `90 days · Social`

Both agree on **90 days**. They disagree on **touch mode**: Context vs Social.

**Chosen:** follow the pseudocode → unknown tier becomes `Strategic` → **90 days, Social**.
Rationale: the brief said the exact pseudocode is authoritative, and two of the three
statements point to Strategic. Encoded as `DEFAULT_TIER` in `src/config/constants.ts`.

**Impact:** every contact with no tier in Contacts gets `next_touch_mode_planned = Social`
rather than `Context`. In the sample run that was 1 of 6 contacts; the dry-run report
marks these with `*` and a `tier_defaulted` count so the real number is visible before
going live.

Confirmed by Bobby: Social, no code change needed — `DEFAULT_TIER` in
`src/config/constants.ts` already implements this.

---

## 3. Stage numbers above 5 are undefined — ✅ DECIDED 2026-07-17: withhold + flag, never a rule to invent

`STAGE_CADENCE` covers Stages 1–5. The spec says nothing about a Stage 6+.

**Bobby's call:** there is no mechanism in Attio for a track to advance beyond Stage
5 — if a record shows one, that's a data-integrity problem, not an ambiguous cadence
case. Treating it as "fall back to tier cadence" was wrong: it would silently compute
and (eventually) write a plausible-looking cadence for a contact whose underlying
pipeline data is broken, the same failure shape as the June corruption (a quietly
wrong value, no error, nothing visibly off).

**Implemented:** `STAGE_OUT_OF_RANGE` added to `WithholdReason`. `evaluateContact`
now withholds the write entirely — checked first, ahead of the identity gate, since
it only needs the pipeline entry's stage value, not the person record. The dry-run
table, report, and Slack addendum all surface it with its own guidance ("correct the
Attio pipeline stage value"), separate from the identity-check message ("run the
Reconciler") since that's the wrong fix for this class of issue. `cadence.ts` still
computes filler tier-cadence values for the row's display fields — they're never
written, since the row is withheld.

Covered by `tests/identity-gate.test.ts`.

---

## 4. Attio: MCP → REST — ⚠ READ-SIDE VERIFIED 2026-07-18, write path still open

The spec says "Attio MCP connector". GitHub Actions has no MCP host, so
`src/lib/attio.ts` uses the Attio REST API with `ATTIO_API_KEY`. Same data, different
transport.

**✅ Confirmed and fixed — the dangerous one.** `last_interaction_at` was wrong. Bobby
ran `npm run pass4 -- --dump-shapes` against a real record: the actual field is
Attio's built-in `last_interaction` attribute (`attribute_type: 'interaction'`), with
the timestamp nested under `interacted_at`, not a plain `value`. `PERSON_SLUGS.lastInteractionAt`
now reads `'last_interaction'`; `dateOf` still accepts a plain `value` shape too, for
other date-typed slugs. Regression test in `tests/attio.test.ts` pins the real shape.
Corroborating evidence from the same dump: this record's `follow_up_reason`, written
the night before by the old agentic routine, already read "...last touch date
unknown" — exactly the failure this bug would produce.

**✅ Also found and fixed via the same run:** the Contacts read range was too narrow
(`A1:V1`/`A3:V`) — the tier column sits well past V in the live 113+-column sheet.
Widened to `A1:EZ1`/`A3:EZ`, still resolved by header title. `load.ts` now logs the
full header row and the resolved tier column's letter/index on every run, so this
class of bug is visible in the log instead of silently finding nothing. Folds in
item #5 below — same root cause, same fix.

**✅ Confirmed correct, second `--dump-shapes` run (2026-07-18):**

- **Pipeline entry shape** (`parent_record_id` + `entry_values`) — proven by the dump
  itself: `listEntries()` only returns an entry when `parent_record_id` resolves to a
  real string, and this run successfully fetched a real person record (Suzie
  Schofield, BHC-00103) from it. Had the shape been wrong, `--dump-shapes` would have
  errored ("Pipeline list returned no entries"), not printed real data.
- **Select values as `entry_values.<slug>[0].option.title`** — the dump shows
  `tnb_stage[0].option.title = "Stage 0 – Qualified/Staged"`, exactly the shape
  `selectTitleOf` expects. `stageNum()`'s regex only looks for `stage\s*(\d+)`, so the
  em dash and label text after it don't matter.

**Still open — the write path, only checkable via an actual `--live` write:**

| Assumption | Where | Risk if wrong |
|---|---|---|
| Writing a select by its title string (`"Context"`) is accepted | `updatePersonRecord` | writes 400 |
| `PATCH /v2/objects/people/records/{id}` with `{data:{values:{…}}}` | `updatePersonRecord` | writes fail |

Both are properties of a *write*, so nothing short of an actual `--live` call can
confirm them — that's the next and last gate before PASS 4 is trustworthy end to end.
Recommend a canary first: `npm run pass4:live -- --limit 1` against one low-stakes
contact, read the QA-readback line in the output (the code already re-fetches after
writing and compares), then scale up once that one write is confirmed clean.

---

## 5. `Contacts!A3:V` cannot contain the header row — ✅ RESOLVED, see #4

Folded into #4 above: the range was widened to `A1:EZ1`/`A3:EZ` as part of the same
live-verification pass, for the same reason (tier column sits past V). Two-read
approach (header, then data) is unchanged and still correct — row 1 was never inside
`A3:V` to begin with, and now isn't inside `A3:EZ` either. Data still starts at row 3
because row 2 is the ARRAYFORMULA spill row.

---

## 6. The identity gate is stricter than PASS 4's spec ⚠ DELIBERATE DEVIATION

**Spec 4c** captures `bhc_contact_id` as "cross-check only" — and then never says what
to do when it mismatches. There is no name check in PASS 4 at all.

**Chosen:** a real gate (`evaluateContact`). A contact's cadence is **withheld** —
not written — when any of these hold:

| Condition | Code |
|---|---|
| Attio `bhc_contact_id` ≠ Master_ID `BHC_ID` | `ATTIO_ID_MISMATCH` |
| Attio name shares zero significant words with Master_ID `Full_Name` | `NAME_MISMATCH` |
| Either name is missing/unverifiable | `NAME_UNVERIFIABLE` |
| Two Master_ID rows point at the same Attio record | `MASTER_ID_DUPLICATE_POINTER` |
| The person record couldn't be fetched | `FETCH_FAILED` |

The name check reuses `BHC_Reconciler_Fix.md` **Step 1.5** semantics verbatim
(lowercase, strip punctuation, ≥1 significant word in common, particles excluded) so
every routine agrees on what "the name matches" means. Implemented once in
`src/lib/name-verify.ts`.

**Why, given PASS 4 writes to a `record_id` taken straight off the pipeline list?**
The record itself isn't in doubt — but the **tier** is resolved *through* the
Master_ID pointer (`record_id → bhc_id → tier`). A stale pointer therefore writes a
*plausible but wrong* cadence onto a real person: no error, no crash, just a quietly
wrong date. That's the June failure class, so the brief's non-negotiable applies.

**Cost of this choice:** PASS 4 will now write to *fewer* contacts than the current
routine does. Every withhold is a contact whose cadence goes stale until the
Reconciler fixes the pointer. If the dry run withholds a large fraction, that's a
pre-existing data-quality problem this surfaces — not a bug in this code — but it
needs a look before going live.

A record with **no** Master_ID row at all is *not* withheld: no pointer was resolved,
so there is nothing to verify and no identity was borrowed. It's computed with the
default tier and reported under `unmapped_to_master_id`.

---

## 7. Slack 4f reports `written`, not `total`

**Spec 4f:** `📅 Cadence — {total} pipeline contacts updated`.

**Chosen:** report contacts actually **written**, and add a line naming any withheld
or failed ones. Saying "44 updated" when 3 were withheld and 2 failed would report
success for work that didn't happen — the thing Non-negotiable #8 forbids for the
PASS 3 digest, applied here for the same reason.

The spec's zero-alarm (`⚠ 0 contacts updated. Check Attio pipeline list or connector.`)
now fires **only on a live run**. A dry run writes 0 by design; alarming on that
would cry wolf. (Caught by an integration test, not by reading — see
`tests/pass4-integration.test.ts`.)

---

## 8. Minor: the 500-char `follow_up_reason` cap is unreachable

`reason_base` is built from the track and stage *number* (`"TNB Stage 2"`), never the
Attio-authored stage *label*. With the stalled/unknown fragments the longest possible
reason is well under 100 chars, so `[:500]` can never trigger. Kept anyway (the spec
mandates it, and it guards against a future change); asserted as a bound rather than
an exact length.

---

## 9. Not built yet (deliberately out of scope for Step 1)

- **PASS 4's ordering.** The spec runs PASS 4 *after* PASS 3. Standalone here.
- **`cadence_results` for PASS 5.** `Pass4Report.rows` already carries every field
  PASS 5's 5b/5c need (`record_id`, `name`, `stalled`, `days_since`, `next_check_in`,
  `touch_mode`, `follow_up_reason`, `bhc_id`) — deliberate, so PASS 5 can consume the
  report rather than re-fetch. Note 4.5c says the **cache** must read cadence back
  from Attio live rather than reuse in-memory results; that constraint is PASS 4.5's,
  and this report is not a substitute for that read.
- **Sheets writes.** `SheetsClient` is read-only on purpose — no `update`/`append`
  exists yet. PASS 4 must never write to Google (Non-negotiable #12), and an
  unimplemented method can't be called by accident.
