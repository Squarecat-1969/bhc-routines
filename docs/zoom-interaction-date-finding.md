# BHC Zoom PASS 1 · 3a — the `Interaction_Date` finding

Status: **open — reported, not resolved.** No mapping was changed.

`routines/BHC_Zoom.md` PASS 1 step 3a carries a standing instruction:

> ⚠ **OPEN QUESTION, DO NOT RESOLVE BY GUESSING — REPORT IT.** This routine writes the
> meeting's own date into **B**, and never writes **V (`Interaction_Date`)**. […] **Read
> the live header row across A:V before assuming B is correct, and surface the finding in
> the run report rather than changing the mapping unilaterally.**

Checked on run `ZOOM-1788963056708` (2026-09-09). The header read was possible even though
3a itself did not execute that run — there were no `WRITE` rows, so no `Activity_Log` row
was appended and no cadence clock moved. This note records the evidence so the check does
not have to be re-derived on a future run.

---

## 1. The live header confirms B is not the meeting date

`Activity_Log!A1:V1`, read live:

| Col | Header |
|---|---|
| B | `Timestamp` |
| … | … |
| V | `Interaction_Date` |

The tab declares the two-field split the system contract describes: **B is the write
time, V is the real interaction date.** 3a's mapping (`B=meeting_date ISO`, V never
written) is inverted against that header on both halves.

## 2. Every other writer honors the split; BHC Zoom does not

787 `Activity_Log` rows, grouped by `Created_By` (col R):

| Created_By | rows | B populated | V populated |
|---|---:|---:|---:|
| Orbit Pass 2 | 176 | 176 | 13 |
| Part D Resolve Handler | 153 | 153 | 23 |
| System | 125 | 125 | 0 |
| Part D | 121 | 121 | 0 |
| **BHC Zoom** | **85** | **85** | **0** |
| Zap_B | 43 | 43 | 0 |
| others | 84 | 66 | 0 |

The two writers that populate V do so as a bare date alongside an ISO-Z timestamp in B:

```
Part D Resolve Handler | B=2026-08-17T05:26:50.449Z | V=2026-08-12 | Disney Security Assessment
Orbit Pass 2           | B=2026-08-19T20:06:22.657Z | V=2026-08-19 | Cleat 1 and 2
```

BHC Zoom's 85 rows instead carry a bare meeting date in B and nothing in V:

```
BHC Zoom | B=2026-06-11 | V='' | DCSG BTS/Loyalty production sync: campai…
BHC Zoom | B=2026-06-15 | V='' | WEST standup
```

So B holds a **different kind of value** for BHC Zoom than for every other writer on the
same column — a bare date where the rest of the tab holds an ISO-Z instant.

## 3. The TypeScript Part D implementation is the reference for this contract

`src/part-d/write-row.ts` implements the split explicitly:

- `nowIso` — "already exactly that write timestamp" — goes to **B** (line ~437).
- `interactionDate` goes to **V**, commented `'' when unknown, never today's date`
  (line 329), and is threaded to secondaries unchanged — "one thread, one interaction
  date" (line 588).
- Cadence is clocked off it: `const bzValue = interactionDate || dateOnly;` (line 357).
- Leaving V blank is treated as a defect worth warning about: *"Activity\_Log
  Interaction\_Date left blank and Contacts BZ fell back to the run date."* (line 176).
- `tests/part-d/write-row.test.ts` names it directly: *"this is the Timestamp vs
  Interaction\_Date split"* (line ~765).

`routines/BHC_Part_D_Resolve_Handler.md` and `routines/BHC_Zoom.md` both already state the
other half of the same contract for `Contact_History.Entry_Date` ("the WRITE time … the
interaction's own time is `Activity_Log`'s `Interaction_Date`, column V", decided
2026-08-21).

## 4. What this means

3a's suspicion is correct in both directions, and a Zoom meeting is precisely the case V
exists for — the interaction date is always known (it is the meeting date), so V should
never be blank on these rows.

Scope of the impact, stated narrowly:

- BHC Zoom writes `Contacts!BZ` directly from `proposed_entry` in 3b, so **the routine's
  own BZ cadence write is not broken by this.** Part D's `interactionDate || dateOnly`
  fallback is Part D's own path, not BHC Zoom's.
- The exposure is on anything that reads cadence or recency from `Activity_Log` V. All 85
  BHC Zoom rows present there as having no interaction date, and their B is a bare date
  rather than the ISO-Z instant a consumer of a column named `Timestamp` would expect.

## 5. Not resolved here

The fix is presumably to write the write-time ISO-Z into B and the meeting date into V,
matching Part D. That is **not** applied: 3a says to report rather than change the mapping,
and the warning notes that getting it wrong in either direction moves a cadence clock on a
real person's record. It also raises a question this note cannot answer — whether the 85
existing rows should be backfilled, and by whom.

Bobby's call. When it is made, apply it to `routines/BHC_Zoom.md` 3a and reinstall the
routine config per the deploy model in `CLAUDE.md`.
