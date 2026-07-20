# Name_Conflicts review panel — spec for the Aida side

**Status:** not yet built. This is the design for whoever builds it in `bhc-aida`.
`bhc-routines` now does its half of the work — see below — this doc covers what
the Aida web app needs to build on top of it.

## Why this exists

Before July 19, 2026, `Name_Conflicts` had no review surface at all — rows just
accumulated with a blank `Status` until someone (Claude, in a chat session)
manually read the sheet, asked Bobby for judgment calls, and wrote the
resolutions back by hand. That works, but it doesn't scale and it isn't
something Bobby can do from his phone between other things. This panel is
that missing surface.

The July 19 backlog-clearing session (roadmap: "Name Conflicts backlog fully
resolved") also surfaced a real pattern worth designing around: of 31
conflicts, **8 were pure diacritic-restoration cases** (Attio had the
correct accented spelling, Master_ID didn't) and low-risk enough that
one-at-a-time review was pure overhead. The other 23 needed real judgment —
nicknames, enrichment artifacts, genuine toss-ups. Those two categories
should not share one UI.

## What `bhc-routines` already provides

As of the `bhc-routines` change this spec ships alongside:

- Every `Name_Conflicts` row now carries a **`Conflict_Type`** column (N):
  `DIACRITIC_ONLY` or `STRUCTURAL`, computed by
  `classifyConflictType` (`src/passes/pass4_5/name-conflicts.ts`), backed by
  `isDiacriticOnlyVariant` (`src/lib/name-verify.ts`). Diacritic-only means
  the two names differ *solely* in accent marks — same base letters, same
  word count and order. Everything else (nicknames, appended text, malformed
  punctuation, genuine judgment calls) is `STRUCTURAL`.
- This is deliberately narrow — capitalization-only differences
  (`bo geddes` / `Bo Geddes`) are `STRUCTURAL`, not `DIACRITIC_ONLY`, on
  purpose. See the doc comment on `isDiacriticOnlyVariant` for the reasoning;
  don't widen this without re-reading it first.
- PASS 4.5h (Late Edition) is the only current writer of new rows, and it's
  ATTIO-only-scope conflicts (`Old_Source: Master_ID`, `New_Source: Attio`).
  The `BOTH`-scope rows (`Old_Source: Attio`, `New_Source: Google`) come from
  the separate Reconciler routine, which predates this change; those rows
  won't have historically-consistent `Conflict_Type` values going forward
  unless Reconciler is updated the same way — worth doing, not yet done.

## Sheet schema (current, full)

`Name_Conflicts!A2:N`, header row 1:

| Col | Field | Notes |
|---|---|---|
| A | `Conflict_ID` | `NC-{timestamp}-{seq}` |
| B | `Run_ID` | which run detected it |
| C | `Source` | `RECONCILER` or `LATE-EDITION` |
| D | `BHC_ID` | |
| E | `Scope` | `BOTH` or `ATTIO` |
| F | `Old_Name` | for `ATTIO` scope: Master_ID's value. For `BOTH` scope: Attio's value |
| G | `New_Name` | for `ATTIO` scope: Attio's current value. For `BOTH` scope: Google's value |
| H | `Old_Source` | which system `Old_Name` came from |
| I | `New_Source` | which system `New_Name` came from |
| J | `Targets_JSON` | `{google_row?, attio_record_id, master_row}` — everything needed to write the resolution |
| K | `Status` | blank = awaiting. See "Status semantics" below — **do not write a plain "RESOLVED"** |
| L | `Detected_At` | ISO timestamp |
| M | `Notes` | free text, human-readable source description |
| N | `Conflict_Type` | `DIACRITIC_ONLY` or `STRUCTURAL` (new) |

### Status semantics — important, existing code depends on this

`shouldEnqueue` (`src/passes/pass4_5/name-conflicts.ts`) already has real
suppression logic that keys off specific `Status` strings:

- `RESOLVED_OLD` → permanently suppressed (Bobby chose to keep the old/
  Master_ID name; if Attio drifts to the same "new" value again, don't
  re-ask).
- `` (blank) → already awaiting, don't duplicate.
- `RESOLVED_NEW` → if this exact old→new transition recurs, **re-raise it**
  (the assumption is it drifted back and is worth a fresh look).
- Anything else, including a bare `"RESOLVED"` → **not recognized by the
  suppression logic** — it won't match `RESOLVED_OLD` and won't match blank,
  so a recurrence of the exact same (BHC_ID, Old_Name, New_Name) triple would
  enqueue again as if it were new. (The July 19 session used a plain
  `"RESOLVED"` for all 31 rows — harmless there only because every
  resolution made `Old_Name` and `Master_ID` agree going forward, so the
  triple can never recur unchanged. Don't rely on that; write real status
  values.)

**The panel must write `RESOLVED_OLD` or `RESOLVED_NEW`**, matching whichever
side (`Old_Name`/`Old_Source` vs `New_Name`/`New_Source`) the final value
came from. **When the resolution is a custom override** — Bobby typed
something that's neither `Old_Name` nor `New_Name` verbatim (e.g. the
`Dzhuliana "Juliana" El-Kakhat` combined form from July 19) — there's no
existing status value for that. Recommend adding `RESOLVED_CUSTOM` as a third
value; `shouldEnqueue` should treat it the same as `RESOLVED_OLD` (permanent
suppression — a custom value was a deliberate choice, not a "keep current for
now").

## Tier 1 — `DIACRITIC_ONLY`: batch view, no per-row review

**List view**, not cards. One row per conflict:

```
[✓] Rafael Emidio  →  Rafael Emídio           BHC-01140
[✓] Tomé Teixeira  ←  Tome Teixeira           BHC-01301   (arrow direction shows which side is "correct" — see below)
[✓] ...
```

- Every row pre-checked by default (this is the point — it's the low-risk
  bucket).
- Bobby can uncheck any individual row to skip it this round (leaves it
  `Status` blank, comes back next time).
- One **"Apply N corrections"** button, single confirm, single batch commit.
- **Direction isn't always "Attio wins"** — of the 8 real `DIACRITIC_ONLY`
  cases so far, 7 were Attio-correct (`New_Name` wins) and 1
  (`Hervé`/`Herve`, `BHC-00043`) was the reverse, Attio-side had *dropped*
  the accent that Google/Master_ID had right. **Don't hardcode a direction.**
  The correct logic: whichever of the two strings has diacritics and the
  other doesn't is the one that wins; if somehow both or neither have any
  diacritics, that pair shouldn't have classified as `DIACRITIC_ONLY` in the
  first place (flag as a bug in `bhc-routines`, don't guess in the UI).
- On apply: for each checked row, write the winning name to *both* Master_ID
  and Attio's `name` field (`personal-name` type — requires the full
  `{first_name, last_name, full_name}` object; split on the last space unless
  a smarter split is available; see the `bhc-routines` Attio update calls
  from the July 19 session for the exact request shape), and to Google
  Contacts too if `Scope` is `BOTH` and a `google_row` is present in
  `Targets_JSON`. Set `Status` to `RESOLVED_NEW` or `RESOLVED_OLD` depending
  on which source won.

## Tier 2 — `STRUCTURAL`: one-at-a-time review cards

This is the panel Bobby actually asked for — side-by-side names, not a
binary pick.

```
┌─────────────────────────────────────────────────┐
│ BHC-02207 · ATTIO scope                          │
│ Flagged: Master_ID vs Attio name disagree        │
│                                                    │
│  Master_ID          Attio                        │
│  Dzhuliana           Juliana                      │
│  El-Kakhat           El-Kakhat                    │
│                                                    │
│  [ Use Master_ID ]  [ Use Attio ]                 │
│                                                    │
│  Or enter a different name:                       │
│  [___________________________________]            │
│                                                    │
│  [ Save ]  [ Skip for now ]                       │
└─────────────────────────────────────────────────┘
```

Required elements, each tied to a real gap the July 19 session hit:

- **Both names labeled by system** (`Master_ID` / `Attio`, or `Attio` /
  `Google CRM` for `BOTH` scope), never "Old" / "New" — that framing tracks
  detection order, not correctness, and was actively confusing when working
  through the real batch.
- **A free-text override field**, not just the two buttons. The
  `Dzhuliana "Juliana" El-Kakhat` resolution was neither system's value
  verbatim — a two-button UI would have forced a wrong choice.
- **A "why flagged" line** — `Scope` (`BOTH` vs `ATTIO`) plus which two
  systems disagree. Without it, reviewing a card means reverse-engineering
  context from a bare name pair, which is slower and more error-prone than
  just showing it.
- **Skip for now** must leave `Status` blank (not write anything) — it's
  functionally a no-op, just moves to the next card. Don't invent a "skipped"
  status; blank already means "awaiting," which is correct.

On save: write the chosen name to whichever systems disagree (per `Scope`
and `Targets_JSON`, same mechanics as Tier 1), and set `Status` to
`RESOLVED_OLD`, `RESOLVED_NEW`, or `RESOLVED_CUSTOM` depending on which of
the three options was used.

## What this panel does *not* do

- **Identity resolution.** This panel only runs after a `BHC_ID` is already
  settled — it's purely about which name *string* is correct for an
  already-agreed-upon person. Google Contacts stays canonical for identity
  per the existing architecture; this doesn't change that.
- **Auto-resolve `STRUCTURAL` conflicts.** Every one of those needs a human
  choice, by design — see the two rejected enrichment artifacts
  (`Carolina Valdovinos - AllSTEM`, `James Rolfe 'jr'`) from July 19 as the
  reason why: an automated "pick the newer one" rule would have written both
  of those straight into production as real names.

## Open question for whoever builds this

Should `DIACRITIC_ONLY` auto-apply *without even landing in the panel* —
i.e., should `bhc-routines` itself write these on detection, skipping human
review entirely? This spec deliberately keeps a manual (if one-click, batch)
confirmation step, matching the project's standing rule that name fields are
never auto-written (see PASS 4.5h's own spec language: "Name is NEVER
auto-written... handled exclusively through the Name_Conflicts review
queue"). Worth revisiting once there's a larger sample size than 8 cases —
right now there isn't enough data to be confident the diacritic-only
classifier will never have a false positive.
