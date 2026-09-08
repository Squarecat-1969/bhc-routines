# BHC Zoom — Activity_Log `Timestamp` (B) vs `Interaction_Date` (V)

Raised by the standing OPEN QUESTION in `routines/BHC_Zoom.md` step 3a, which
instructs a run to *read the live header row across A:V before assuming B is
correct, and surface the finding rather than change the mapping unilaterally.*

Checked on run `ZOOM-1788851457886` (2026-09-08). **Nothing was changed.** The
routine's mapping is untouched; this note exists so the finding is not lost,
because that run was a complete no-op and STEP 6 skips the Slack post on a
no-op.

## What the live tab says

Header row `Activity_Log!A1:V1`, read live:

```
A Activity_ID   B Timestamp     C Contact_ID    D LinkedIn_URL   E Contact_Name
F Activity_Type G Channel       H Direction     I Subject        J Body
K Transcript    L Links         M Tags          N Outcome        O Next_Action_Date
P Next_Action_Note              Q Source        R Created_By     S Source_CRM
T Attio_Task_ID U Hook_Used     V Interaction_Date
```

So **B is the write timestamp and V is the real interaction date** — exactly the
separation the system contract describes.

## What each writer actually does

787 data rows read live (`A2:V`), grouped by `Created_By` (col R):

| Created_By             | rows | B filled | V filled |
| ---------------------- | ---: | -------: | -------: |
| Orbit Pass 2           |  176 |      176 |       13 |
| Part D Resolve Handler |  153 |      153 |       23 |
| System                 |  125 |      125 |        0 |
| Part D                 |  121 |      121 |        0 |
| **BHC Zoom**           |   85 |       85 |    **0** |
| Zap_B                  |   43 |       43 |        0 |
| bobbyhougham@gmail.com |   27 |       27 |        0 |
| Operator v5            |   18 |       18 |        0 |
| Operator v6            |   12 |       12 |        0 |
| Bobby                  |    5 |        5 |        0 |
| Aida                   |    4 |        4 |        0 |

The writers that populate V put an ISO-Z **write time** in B and the
**interaction date** in V:

```
row 493 | Part D Resolve Handler | B = 2026-08-17T05:26:50.449Z | V = 2026-08-12
row 495 | Part D Resolve Handler | B = 2026-08-17T05:27:00.836Z | V = 2026-08-12
```

BHC Zoom puts the **meeting date, date-only**, in B and leaves V empty on every
one of its 85 rows:

```
row 236 | ACT-1781827830049-W3P | B = 2026-06-15 | V = ''
row 238 | ACT-1781827908034-W4P | B = 2026-06-15 | V = ''
```

The low V-fill counts for Orbit Pass 2 and Part D are **not** a second instance
of this bug. `src/part-d/write-row.ts:329` writes `interactionDate` with the
comment *"'' when unknown, never today's date"* — those writers deliberately
leave V blank when they have no real interaction date. A blank V there means
"unknown". A blank V on a Zoom row means "we had the date and put it in the
wrong column".

## The finding

The reference implementation in this repo, `src/part-d/write-row.ts:309–330`,
builds the row as:

```ts
activityId,   // A
nowIso,       // B Timestamp        <- write time
...
interactionDate, // V Interaction_Date <- the interaction's own date
```

BHC Zoom's 3a does the opposite: it writes `meeting_date` into B and never
writes V. The two fields are inverted relative to both the live header and the
only implementation that has the contract encoded in code.

This matters because the contract holds that **cadence is clocked off the
interaction date**, not the write time. A Zoom meeting *is* an interaction, so
V should carry the meeting date. Today it is blank on every Zoom row, and the
meeting date sits in the field that is supposed to record when the row was
created.

## Why this note does not fix it

Two reasons, both from the routine's own text:

1. 3a says to surface, not resolve — *"getting this wrong in either direction
   moves a cadence clock on a real person's record."*
2. The fix is not just a forward-looking mapping change. 85 existing Zoom rows
   carry a meeting date in B and a blank V. Any consumer that reads B as a write
   timestamp is already reading a meeting date from those rows, and a change to
   the mapping without a decision about backfill leaves the tab in two shapes at
   once.

Deciding both halves — the mapping and what to do with the 85 existing rows —
is Bobby's call.

## Suggested resolution, for the decision rather than as a change

- 3a writes `datetime.now(timezone.utc)` ISO-Z into **B**, matching Part D.
- 3a writes the meeting date (`YYYY-MM-DD`) into **V**.
- Separately decide whether to backfill the 85 existing Zoom rows by copying B
  to V and restoring B from the `ACT-` ID's embedded unix-ms write time, which
  is recoverable — `ACT-1781827830049-W3P` carries its own creation timestamp.

## Incidental confirmation

The read also confirms the documented `Activity_Log` ordering gap is still
present and still 18 rows, matching the warning in 3a. The gap is not consumed
by appends, so it persists until someone closes it by hand.
