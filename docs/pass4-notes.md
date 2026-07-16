# PASS 4 — implementation notes, assumptions, and open questions

Companion to `src/passes/pass4/`. Everything here is a place where the spec
(`routines/BHC_Late_Edition.md`) was ambiguous, self-contradictory, or silent, and
I had to make a call. **Each numbered item needs a yes/no from Bobby.** Items 1, 2
and 4 can change what gets written to production.

---

## 1. `TODAY` is undefined for PASS 4 — currently America/Los_Angeles ⚠ NEEDS A DECISION

**Spec:** PASS 4d uses `TODAY` without ever defining it. PASS 4.5 defines its own as
`datetime.now(timezone.utc).date()`.

**Why it matters:** the routine runs at **11:00 PM PDT**, which is **06:00 UTC the
next calendar day**. So UTC-`TODAY` and Los-Angeles-`TODAY` disagree on *every single
scheduled run* — never on a manual daytime run, which is why this can hide.

Consequences of picking UTC:
- `next_check_in_date` lands one day later than a human would expect.
- `days_since` is inflated by 1, so a contact tips into `stalled` one day early.
- Anything landing exactly on the `> 2 * cadence_days` boundary flips.

**Chosen:** `America/Los_Angeles`, via `RUN_TIMEZONE` (`src/config/env.ts`). Rationale:
cadence is a human-relationship concept — "45 days since I last spoke to them" is
measured in Bobby's calendar, not UTC's. `todayIn()` is tested against exactly the
06:00 UTC case (`tests/dates.test.ts`).

**Risk of this choice:** it may differ by one day from what the current LLM-run
routine has been writing (which is itself probably inconsistent run-to-run — the
agent had no defined `TODAY` either). Expect small diffs against live values.

> **Decision needed:** keep `America/Los_Angeles`, or set `RUN_TIMEZONE=UTC` to match
> PASS 4.5's convention? If PASS 4.5 later reuses PASS 4's `TODAY`, they must agree.

---

## 2. The unknown-tier cadence contradicts itself

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

> **Decision needed:** is an unknown tier Social (pseudocode) or Context (prose table)?

---

## 3. Stage numbers above 5 are undefined

`STAGE_CADENCE` covers Stages 1–5. The spec says nothing about a Stage 6+.

**Chosen:** fall back to tier cadence and attach a warning to the row, rather than
invent a rule or crash. Visible in the report's NOTES section.

> **Decision needed:** can a track ever reach Stage 6+? If not, this is dead code and
> the fallback should probably become a withhold instead.

---

## 4. Attio: MCP → REST, and `last_interaction_at` is unverified ⚠ NEEDS A LIVE CHECK

The spec says "Attio MCP connector". GitHub Actions has no MCP host, so
`src/lib/attio.ts` uses the Attio REST API with `ATTIO_API_KEY`. Same data, different
transport.

**Unverified assumptions** — I could not check these without a live key:

| Assumption | Where | Risk if wrong |
|---|---|---|
| `POST /v2/lists/{id}/entries/query`, entries carry `parent_record_id` + `entry_values` | `listEntries` | 0 entries → pass no-ops |
| Select values read as `entry_values.<slug>[0].option.title` | `selectTitleOf` | every stage reads as 0 → everyone falls to tier cadence |
| `last_interaction_at` is a plain date attr at `values.<slug>[0].value` | `dateOf` | **every contact reads "last touch unknown"** → no one is ever stalled, all dates become today+cadence |
| Writing a select by its title string (`"Context"`) is accepted | `updatePersonRecord` | writes 400 |
| `PATCH /v2/objects/people/records/{id}` with `{data:{values:{…}}}` | `updatePersonRecord` | writes fail |

`dateOf` also accepts `interacted_at`, because Attio's built-in interaction-typed
attribute nests the timestamp that way — but I don't know which one this workspace uses.

**The `last_interaction_at` row is the dangerous one:** if that slug is wrong, PASS 4
fails *silently and plausibly*. Nothing errors. Every contact just quietly reads as
"never touched", `stalled` becomes universally false, and the cadence dates all still
look reasonable. Read the dry-run's LAST TOUCH column before trusting anything else —
if it says `unknown` for everyone, the slug is wrong.

**Verify first:**
```bash
npm run pass4 -- --dump-shapes   # prints one raw entry + one raw person record
```

---

## 5. `Contacts!A3:V` cannot contain the header row

**Spec 4b:** "Read `Contacts!A3:V` once... Parse header row 1 to find the column titled
Relationship_Tier or Tier."

Row 1 is not inside `A3:V`. As literally written this is impossible.

**Chosen:** two reads — `Contacts!A1:V1` for the header, then `Contacts!A3:V` for data
(`loadTierIndex`). The column is resolved **by title, never by letter**, so the index
survives a column insert. Costs one extra Sheets call; the "zero extra Sheets calls"
rule in the spec's Contacts schema note is about per-contact reads, which this isn't.

Data starts at row 3 because row 2 is the ARRAYFORMULA spill row.

> Note: the tier column landed at **V** in the sample fixture, the last column of the
> range. If `Relationship_Tier` actually sits beyond V in the live sheet, the read
> silently finds nothing and `loadTierIndex` throws with the header list it did find.
> That's a loud failure, not a silent one — but the range may need widening.

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
