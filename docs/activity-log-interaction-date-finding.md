# Activity_Log `Timestamp` (B) vs `Interaction_Date` (V) — BHC Zoom 3a finding

**Status:** reported, unresolved. **Do not act on this without Bobby.** Filed by a BHC Zoom
routine-execution run, 2026-09-08 (`ZOOM-1788905432838`). All evidence below is read-only;
this run wrote nothing to any tab.

`routines/BHC_Zoom.md` P1-STEP 3a carries a standing OPEN QUESTION: the routine writes the
meeting's own date into **B** and never writes **V**, and the spec asks that the live header be
read and the finding surfaced *rather than the mapping changed unilaterally*. This run had no
`WRITE` rows, so 3a did not execute, but the check is read-only and the question was open, so it
was performed.

## What the live tab says

Header row `Activity_Log!A1:V1` — 22 columns:

| col | header |
|-----|--------|
| B   | `Timestamp` |
| V   | `Interaction_Date` |

The two names are distinct fields, matching the system contract the spec describes: the write
timestamp and the real interaction date are carried separately, and cadence is clocked off the
interaction date.

## What the data says

787 data rows. `V` is populated on **36** of them, by exactly two writers:

| Created_By | rows | B set | V set |
|---|---|---|---|
| Orbit Pass 2 | 176 | 176 | 13 |
| Part D Resolve Handler | 153 | 153 | 23 |
| System | 125 | 125 | 0 |
| Part D | 121 | 121 | 0 |
| **BHC Zoom** | **85** | **85** | **0** |
| Zap\_B | 43 | 43 | 0 |
| bobbyhougham@gmail.com | 27 | 27 | 0 |
| Operator v5 / v6 | 30 | 30 | 0 |
| Bobby / Aida | 9 | 9 | 0 |

On all 36 rows where `V` is set, the shape is unambiguous:

```
ACT-1786944410449-nvgp  B=2026-08-17T05:26:50.44…  V=2026-08-12
ACT-1787460439087-5gna  B=2026-08-23T04:47:19.08…  V=2026-08-18
```

`B` is a full ISO write timestamp; `V` is a bare interaction date. They differ on **25 of 36**.

## What BHC Zoom actually writes

BHC Zoom's own 85 rows carry a **bare meeting date** in `B` and leave `V` empty. Cross-checking
`B` against the true write time — which is recoverable independently, from the unix-ms epoch
embedded in the row's own `ACT-` id — shows they are not the same value:

```
ACT-1781827830049-W3P    B=2026-06-15   ACT epoch → 2026-06-19   Δ 4d   V=''
ACT-1782087051780        B=2026-06-16   ACT epoch → 2026-06-22   Δ 6d   V=''
```

**`B` differs from the actual write date on 78 of 85 BHC Zoom rows, by 1 to 13 days.**

## The finding

BHC Zoom is writing the interaction date into the column named `Timestamp` and leaving the
column named `Interaction_Date` blank — inverted with respect to both the header and the
convention of the only two writers that populate `V`. The spec's own premise in 3a, that "every
other writer on this tab leaves V blank only when there was no interaction," is **not** borne
out: most writers never populate `V` at all, and the two that do populate it on a minority of
their rows. So the inconsistency is wider than BHC Zoom.

Note that `routines/BHC_Part_D_Resolve_Handler.md:157` and `routines/BHC_Zoom.md:224` state the
same rule in identical words — Contact\_History `Entry_Date` is the write time, and "the
interaction's own time is `Activity_Log`'s `Interaction_Date`, column V." Part D Resolve Handler
is one of the two writers that honors it. BHC Zoom's 3c repeats the sentence while its 3a
contradicts it.

## Why this was not fixed here

Per 3a and per `AGENTS.md`, a routine-execution session reports a write target that looks wrong
rather than guessing. Changing the mapping moves a cadence clock on real people's records, in
either direction, and the correct remediation is not obvious from the data alone:

- Writing the meeting date to `V` going forward is the change the header implies, but it does not
  address the 85 existing rows.
- Backfilling `V` from `B` on historical BHC Zoom rows would be correct only if `B` is reliably
  the meeting date on every one of them — true for the 78 checked here, unverified for the rest.
- Whatever consumes cadence today has been reading a tab in this state since at least June 2026.
  What currently reads `V`, and how it treats a blank, needs to be established before either
  change — a consumer that falls back to `B` when `V` is blank would silently change behavior for
  85 records the moment `V` is populated.

Bobby's call. No mapping was changed.
