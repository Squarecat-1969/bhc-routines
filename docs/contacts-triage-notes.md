# Contacts Triage — build notes

Resolutions, deliberate deviations, and open questions from building the
Contacts Triage routine against its build spec. Same purpose as
`pass4-notes.md` and friends: where the spec was ambiguous or where the
implementation had to depart from it, the reasoning is recorded here rather
than being quietly baked into the code.

---

## 0a. FIRST LIVE WRITE ATTEMPT — FAILED, 2026-08-09

**Current state of the sheet: one header write landed, ZERO data rows on
either tab.** Verified by reading both tabs back after the failure, not
inferred from the error.

| | State |
|---|---|
| `Contacts_Triage_Queue` header | **24 columns — extended by this run** |
| `Contacts_Triage_Queue` data | **0 rows** |
| `Contact_Exclusions` header | 7 columns (untouched, already correct) |
| `Contact_Exclusions` data | **0 rows** |

The queue write aborted with:

```
HTTP 400 — Requested writing within range [Contacts_Triage_Queue!A2:V98],
           but tried writing to column [W]
```

**Cause: a hardcoded column letter.** `writeQueue` built its range as
`A2:V{n}` by hand while the row serializer had grown to 24 columns when
`provenance_source` and `connection_strength` were appended (#0b). Sheets
refuses a 24-wide row into a 22-wide range and rejects the whole batch.

**Why every test passed anyway** — the more important half. The fake Sheets
backend accepted a write of any width into any range; real Sheets does not.
The fake was more permissive than the thing it stood in for, so a whole class
of range/width bug was invisible to the suite. Both ends are now closed:

- `QUEUE_LAST_COLUMN` is derived from `QUEUE_COLUMNS`; no write range spells a
  column letter by hand.
- `writeQueue` refuses a row whose width isn't `QUEUE_COLUMNS`, so the failure
  is a legible local error rather than a 400 after the run has already spent
  its enumeration and its LLM calls.
- The fake backend now reproduces Sheets' own rejection, message and all.
  Reverting the fix fails 5 tests, including one written specifically for this.

**Not retried, per instruction.** A partial write is diagnostically useful; a
retry on top of one is not. The run is safe to repeat — the queue is empty, the
merge treats an empty tab as "all new", and no exclusion rows were appended, so
nothing will be double-written.

**The header extension is worth noting on its own.** The tab was believed to
already carry all 24 columns; it had 22. The preflight's
extend-a-short-header path (#14) — kept in on the grounds that it was "correct
behaviour for the next tab that's short" — turned out to be needed on this
tab, immediately.

## 0b. Live dry-run results, 2026-08-08 (read-only, nothing written)

First execution against production Attio. **STEP 1 and STEP 2 completed and
match the spec's predictions exactly. STEP 3 onward is blocked on one API-key
scope**, so there is no band histogram yet.

| | Result | Spec expected |
|---|---|---|
| Total people in Attio | 2,505 | — |
| With `bhc_contact_id` | 2,223 | — |
| **Unbridged** | **282** | ~282 ✅ |
| **2026-07-22 compromise blast** | **170** | ~170 ✅ |
| thenewblank.com internal | 7 | — |
| Bobby's own addresses | 3 | — |
| Unattended role/no-reply | 0 | — |
| **Total excluded** | **180** | — |
| **Candidates to score** | **102** | ~111 |
| Enumeration cross-check | **passed** | — |

Two things were fixed as a direct result of this run — see #2 and #3.

### BLOCKER: the Attio API key lacks the Emails scope

```
GET /v2/emails -> 403
"The API Key provided is not authorized to perform the requested action.
 This request requires scopes: Read access to the Emails scope.
 Admins can grant additional scopes to this API key at
 Workspace settings -> Developers -> [the key]"
```

**The endpoint path was right.** `/v2/emails` exists (probed alongside
`/threads`, `/activities`, `/interactions`, `/messages` — the last three return
a genuine 404 "Could not find endpoint"). Attio's workspace has only two
objects, `people` and `companies`, so email data is not an object-records
endpoint; `/v2/emails` is its own thing, exactly as assumed.

The fix is a permission grant, not code: **Workspace settings → Developers →
the bhc-routines key → grant read access to the Emails scope.**

The record-scoping query parameter still can't be confirmed — Attio checks the
scope *before* it validates parameters, so `?linked_record_id=`,
`?record_id=` and a deliberately bogus `?wibble=` all return the identical
403. Once the scope is granted, one command settles it:

```bash
npm run contacts-triage -- --dump-email-shapes <attio_person_record_id>
```

and `ATTIO_EMAILS_RECORD_PARAM` absorbs the answer if it isn't the default.

Scoring was **not** run on partial data. Direction, count, span and
client-team coherence all come from the email metadata, so an
attributes-only histogram would be missing the heaviest weight in the model
for every contact and would be actively misleading as a tuning input. The
run aborts instead, which is the guard working as designed.

---

## 1. Enumeration is a full client-side walk, not a server-side filter

**Spec:** "Attio REST, list people, filter bhc_contact_id empty. Paginate...
Use run-basic-report style counts to verify your enumeration total matches
(total people) − (people with bhc_contact_id) before proceeding."

**What was built:** every person record is fetched via `records/query` and split
into bridged/unbridged in `enumerate.ts`. No server-side emptiness filter.

**Why:** the spec asks for both a filtered enumeration and a cross-check of that
enumeration against a count. If the enumeration itself came from a filter, the
cross-check would be the same query asked twice — it would confirm nothing.
Walking everything makes the count ground truth and leaves the filtered query
free to be a genuinely independent check.

Cost is modest: ~2,900 people at 500/page is six requests.

The walk also carries a structural guard the spec doesn't mention. Offset
pagination without an explicit sort can repeat or skip a record if the
underlying order shifts mid-walk; `listAllPeople` dedupes by record id and
reports any repeat, and the routine **aborts** on one. A duplicate at a page
boundary is the visible symptom of exactly the silent under-enumeration the
spec says is worse than no run.

`sorts` is deliberately not sent on the query. An unsupported sort expression
would 400 the entire enumeration — a worse failure than the one it guards
against.

## 2. "Cross-check failed" and "cross-check unavailable" are different outcomes

**Spec:** "If it doesn't [match], stop and report."

**Corrected after the 2026-08-08 live run.** The original implementation used
`{bhc_contact_id: {$not_empty: true}}`. Attio rejects it:

```
"Invalid operator \"$not_empty\" for field \"value\", must be one of
 (\"$contains\", \"$ends_with\", \"$eq\", \"$in\", \"$starts_with\")"
```

The check now filters `$starts_with` against **the longest common prefix of
the bridged IDs the walk itself observed** (`BHC-` in this workspace, from
values like `BHC-00337`). Derived rather than hardcoded, so it doesn't quietly
break if the ID format changes; if the observed IDs share no usable prefix, the
check reports `unavailable` rather than guessing. **This now passes live**:
2,505 total − 2,223 matching = 282 unbridged, matching the walk.

That the check was written against an unsupported operator and *reported
itself as unavailable* rather than passing is exactly the behaviour below
working as intended:

- **failed** — the check ran and the numbers disagree → **abort**, exactly as
  the spec says.
- **unavailable** — the check could not run at all (unsupported operator, HTTP
  error) → loud warning in the console report, in the `#aida` post, and in
  `warnings[]`; the run continues on the full walk.

Refusing to run because an unverified operator isn't supported would be failing
closed on the wrong signal. If the check turns out to be permanently
unavailable, that is worth knowing and fixing — the warning makes it visible
rather than letting it pass as a green run.

## 3. Attio email metadata — path confirmed, scope missing

**Status after 2026-08-08:** the field shape is confirmed by Bobby against live
data (sender, recipients as a full array, `sent_at`, `subject_line`, `summary`;
`sender === bobby@thenewblank.com` is outbound), and the REST path `/v2/emails`
is confirmed to exist. What blocks the run is the **API key's Emails scope** —
see #0. The record-scoping parameter remains unconfirmed because Attio's scope
check precedes parameter validation.

The confirmed field names now lead their candidate lists in the `FIELDS` table.
The alternates stay: the confirmation was against the data Bobby inspected, and
the REST response may name things differently from what he saw.

Mitigations, all in place and all still earning their keep:

- **Path and record parameter are configuration**, not literals:
  `ATTIO_EMAILS_PATH` and `ATTIO_EMAILS_RECORD_PARAM`. Correcting them is a
  secret change, not a code change and a deploy.
- **The parser accepts several plausible namings per field** and returns null
  rather than guessing when none match. `tests/contacts-triage/attio-emails.test.ts`
  exercises every shape it claims to tolerate.
- **`--dump-email-shapes <record_id>`** prints the raw payload for one record —
  the same discipline PASS 4's `--dump-shapes` used before it was trusted.
- **A contact whose emails can't be fetched is flagged, never silently scored
  as "no history."** `emailDataAvailable: false` suppresses the direction and
  count contributions entirely (missing evidence is not negative evidence),
  falls back to the record's own `first_email_interaction` /
  `last_email_interaction` attributes for span, and puts "email history
  unavailable" at the front of the reason line where Bobby will see it.
- **If it fails for every candidate, the run aborts** rather than producing a
  full queue scored on almost nothing.

**Verification sequence, once the Emails scope is granted:**

```bash
npm run contacts-triage -- --dump-email-shapes <a_real_attio_person_record_id>
```

Read off the real field names, set `ATTIO_EMAILS_RECORD_PARAM` if the scoping
parameter isn't `linked_record_id`, extend the `FIELDS` table in
`lib/attio-emails.ts` if any name differs, then:

```bash
npm run contacts-triage:dry -- --no-llm
```

and confirm `emailFetchFailures` is 0 before anything is staged.

## 4. FLAGGED CONTRADICTION — "junk ASC (shakiest junk calls surface first)"

**Spec, STEP 5:** "keepers and unclear DESC, junk ASC (shakiest junk calls
surface first, where they'll actually be read)."

These two halves disagree. Ascending by `keeper_probability` puts a 3 first —
the *most* confident junk call. The shakiest junk call is a 24, at the top of
the band, which ascending order buries at the bottom.

**Implemented literally** (junk ascending), because the same paragraph says
"Sorting is Aida's job, but record enough for it" — the routine's actual
obligation is to record `column` and `keeper_probability`, which it does, and
the tab's own order is cosmetic. The comparator is one line in
`queue.ts#sortMerged` if Bobby confirms the parenthetical was the intent.

## 5. Clamp events are routed to Unclear

**Spec:** "Violent disagreement means something is wrong, and it should surface
as an Unclear card rather than a confident verdict."

Implemented as: when a clamp fires, `column` is forced to `unclear` regardless
of where the clamped score lands. Without this, a deterministic 84 against an
LLM 100 clamps to 100 and presents as a confident keeper — which is exactly the
confident verdict the spec says a violent disagreement should not produce.

Both scores are stored (`deterministic_score`, `llm_score`) and the clamp is
recorded in `clamped` and named in the reason line, so nothing is hidden by the
reband. Clamp rate is reported, and the console report calls it out explicitly
above 25% of calls — "frequent clamping means the thresholds or the
deterministic weights need tuning."

## 6. Recoverable, per exclusion reason

The spec only mandates recoverable for the compromise cohort. The rest:

| Reason | Recoverable | Why |
|---|---|---|
| 2026-07-22 compromise blast | **TRUE** | Spec-mandated. ~64% had genuine prior correspondence; they're low-value, not "not a person." |
| bobby own address | FALSE | Never a contact to track, under any later reconsideration. |
| thenewblank.com internal | FALSE | Same. |
| unattended role/no-reply address | FALSE | Not a person at all. |
| only interaction is a hard bounce | **TRUE** | A stale address is a data problem, not a verdict about the human. |

## 7. `mail.com` and the bare-subdomain rule

**Spec, STEP 2d:** "bare subdomain senders like `email.*`, `mail.*`,
`notifications.*`".

Taken literally, `mail.*` hard-excludes `mail.com` — a real consumer mailbox
provider people actually use — and a hard exclude never becomes a card at all.
The rule therefore requires the domain to have **three or more labels**, so it
matches `mail.notion.so` but not `mail.com`.

This asymmetry drives every judgment call in `excludes.ts`: a wrongly-excluded
contact disappears silently, while a wrongly-kept one costs Bobby one junk card
he archives in a second. Every rule matches narrowly and is extended
deliberately.

Related: the role-address exclusion only fires when **every** address on the
record is a role address. A record with `orders@shop.com` *and*
`jane.doe@shop.com` is a person with a shared mailbox attached, not a mailbox.

## 8. The weights are a hypothesis, and the report is built to tune them

`score.ts#WEIGHTS` is a single exported table, and `scoreContact` returns the
itemized contributions that produced the score. The console report prints the
**deterministic** band distribution as a labelled histogram, marked as "the
number to tune against", separately from the final post-LLM distribution.

Structural properties the weights are built to preserve, asserted in
`score.test.ts`:

- Two-way correspondence outweighs any other single signal.
- Every count bonus is gated behind span — "12 emails in one hour is one event,
  not a relationship" can never score as a relationship.
- Client-team coherence is positive; blast is negative; recipient count on its
  own contributes nothing to the score.

## 9. Rows are only dropped on positive evidence

STEP 6 says to skip anything that has acquired a `bhc_contact_id` and anything
in `Contact_Exclusions`. Both are implemented as **drops** from the queue —
they're finished.

A row whose contact simply wasn't seen in this run's enumeration is **kept**,
with a warning. Deleted-in-Attio and half-completed-enumeration look identical
from inside the merge, and one of those two silently discards Bobby's pending
decisions. If stale rows accumulate, the warning is the signal to look.

Relatedly, a row with an **unrecognized** status is treated as a decision to
preserve, not as pending. A typo in that column should not be enough to
overwrite a verdict.

## 10. Dry run and the LLM

A dry run makes **real Anthropic calls** for in-band contacts, matching PASS 2's
convention (`pass2:dry` "writes nothing to Sheets, but DOES call the real
Anthropic API"). `--no-llm` gives a free run showing only the deterministic
distribution — which is the number the thresholds get tuned against anyway, so
that is the recommended first command.

## 11. Tabs are not created by this routine

The Sheets proxy supports read/update/append — it cannot create a tab. A
missing tab therefore **aborts a live run** with a message naming the tab and
its required header, and lets a **dry run continue** (showing the distribution
before anything is staged is the dry run's entire job).

Both tabs must be created by hand before the first live run:

- **`Contacts_Triage_Queue`** — 22 columns, A–V, in `QUEUE_HEADER` order.
- **`Contact_Exclusions`** — 7 columns, A–G, in `EXCLUSIONS_HEADER` order.

The routine writes the header row itself if the tab exists but is empty, and
**refuses to write into a tab whose header doesn't match** — Aida reads the
queue positionally, so the column order is a contract.

## 12. Auto-replies are interactions, never replies (correction, 2026-08-08)

An out-of-office was counting as inbound correspondence. Live example: Rachel
Ross's only inbound message is an OOO — enough, under the original logic, to
register as two-way correspondence and collect the single heaviest weight in
the model. Every OOO in the CRM would have become evidence of a relationship,
and the compromise cohort would have lit up with them.

`isAutoReply` matches, case-insensitively and after stripping any Re:/Fwd:
wrappers: `automatic reply`, `out of office`, `auto:`. Auto-replies are
excluded from direction detection **entirely** — including from the outbound
side, symmetrically — and from the client-team reply requirement, while still
counting toward volume, span and distinct days. `autoReplyCount` is carried in
the signals and named in the LLM prompt.

**One extension beyond the correction as given:** auto-replies are also
deprioritised in the provenance line. Fewest-recipients wins, and an OOO is
almost always a one-recipient message, so without this "Automatic reply: Out of
office" would routinely be handed to Bobby as the single most identifying thing
about a contact. Non-auto-reply emails are preferred; auto-replies are used only
when there is nothing else. Flagged here because it wasn't asked for.

## 13. Direction is thread-level, not person-level (correction, 2026-08-08)

The original implementation required the reply to come from one of the
contact's **own** addresses — and shipped with a comment defending that and a
test asserting it. It was wrong, and wrong in the expensive direction: on a
10-recipient client thread, everyone who didn't personally type a reply scores
one-way and falls toward junk.

Live example: "DSG6269 — LOYALTY 15 MOVE app Delivery", 27 Jul – 4 Aug, eight
@dcsg.com recipients. Andrew Kobliska replied; Rachel Ross did not. All eight
are legitimate contacts. A live thread is evidence about everyone on it.

Now: a reply from **any** address at the contact's company domain makes the
contact two-way. Restricted to non-freemail domains — "another gmail.com user
replied" says nothing about a gmail.com contact.

Both kinds are recorded rather than collapsed:

- `inboundCount` — the contact replied personally.
- `teamInboundCount` — a colleague at their domain replied.
- `replySource` — `contact` | `team` | `none`, surfaced in the reason line and
  in the LLM prompt.

`WEIGHTS.directionTwoWayTeam` (28) sits below a personal reply (35) and far
above outbound-only (3): a colleague's reply is real evidence the thread is
live, while a personal reply is *additionally* evidence about that individual.
The gap is small enough that it cannot push a client-team member toward junk —
tested against the real DSG6269 shape, where Rachel Ross scores as a keeper.
**Set the two weights equal to collapse the distinction** if that's preferred.

## 14. A short header is extended, not treated as a conflict (2026-08-08)

The first live dry run aborted on the preflight: `Contact_Exclusions` exists
with its first five columns correct and `recoverable` / `source` absent, and
the guard treated any length difference as a shape conflict.

A header that *disagrees* at some position is a different tab and is still
never written into. A header that agrees as far as it goes but stops short is
merely under-specified: a live run now extends it, a dry run warns. Extra
trailing columns beyond the expected header are left alone with a warning —
writes are scoped to A:V and A:G and never reach them.

**`Contact_Exclusions` still needs its two columns added** (or the next live
run will add them): `recoverable` in F, `source` in G.

## 19. STEP 1b — suppression against prior human decisions (2026-09-01)

> **Numbered 19, not 15.** `#15`–`#18` are already cited from code
> (`excludes.ts`, `index.ts`, `signals.ts`, `triage-constants.ts`,
> `types.ts`, `provenance.ts`, `run-contacts-triage.ts`) for notes that were
> never written into this file — `#15` in particular means "the Attio Emails
> scope is unavailable to workspace tokens". This entry starts above all of
> them so it cannot be mistaken for one of those.
>
> ⚠ **DATES IN THIS FILE ARE BOBBY'S WORKING DATE — PACIFIC, NOT UTC.** Run
> logs stamp UTC, so an evening run reads one day ahead: this run logged
> `2026-09-02T05:31Z`, which is the evening of **2026-09-01** Pacific. Take the
> date from the working day, never from the log timestamp. The same offset put
> a wrong date on a Dev Log entry earlier this week.

Built per `docs/attio-bridging-spec.md` §7 step 1 and §10 item 1. Suppression
runs **before** scoring and before duplicate detection, reading the two places a
human decision is durably recorded: `Master_ID` rows set to `Location:
SUPERSEDED`, and `Contact_Exclusions`.

**Live result, 2026-09-01** (run logged `2026-09-02T05:31Z` UTC — see the date note above)**:** 251 unbridged → **231 suppressed, 20 survive.**

| Signal | Suppressed |
|---|---|
| `Contact_Exclusions` (record id 228, email 1) | 229 |
| `Master_ID` SUPERSEDED | **2** |
| both | 0 |

The two signals are **disjoint**. `Contact_Exclusions` matching already existed
before this change, so the honest attribution is that **the new half caught 2
records — and they are both Raymond Yang**, exactly the case the spec was
written around:

```
SUPPRESSED Raymond Yang <raymond.yang@xa.epicgames.com>
  retired identity — Master_ID row(s) 456, 1585 set to Location: SUPERSEDED.
  Original annotation: "SCRAPPED 2026-08-05: Raymond Yang is TNB staff, not an
  external contact" | "SCRAPPED 2026-08-05: duplicate of BHC-01889 (Raymond
  Yang), TNB staff"
SUPPRESSED Raymond Yang <raymondy@thenewblank.com>   (same two rows)
```

Two records is a small number and it is the right number to report. The other 17
retired identities have no re-created Attio record today; the value is that they
are now covered before they come back, and that Raymond stops costing a decision
every time Attio's sync notices him.

### ⚠ Not every SUPERSEDED row is a retired identity

Measured live: the 31 SUPERSEDED rows are **three different things**, and only
one is a suppression source.

| Shape | Count | Used? |
|---|---|---|
| blank BHC_ID + name in column B | 19 | **yes — the signal** |
| BHC_ID in column A, column B blank (`Merged into BHC-01195 · was Jenny Kim`) | 11 | no — that person still exists under another BHC_ID |
| both populated — row 962, BHC-00920 Rachel Marantz, `A3-FIXED` | 1 | no — an **active** contact whose Location was set to SUPERSEDED in the 2026-08-30 cleanup |

The gate is therefore `blank column A AND non-blank column B`, which yields
exactly the 19 the spec §2 counts. Suppressing on row 962 would have hidden a
live bridged contact; suppressing on the 11 merge tombstones would have hidden
people who were renumbered, not retired.

**Names are read from column B only, never parsed out of the annotation.** The
merge tombstones carry their name *only* inside the note (`· was Jenny Kim`), so
harvesting names from note prose readmits all 11 through the door the column-B
rule closes. There is a mutation-checked test for this.

### ⚠ Why this does NOT use `verifyName`

`name-verify.ts` passes on **one** significant word in common. That is correct
for its job — verifying a pair a human already proposed, before writing through
a pointer — and wrong for generating matches. Live proof: "Raymond Yang"
(scrapped) and "Raymond Worsdale" (BHC-00679, active at NBCUniversal) share
`raymond`, so the loose gate would suppress a live bridged contact.

Suppression uses **exact set equality over significant words**, built from
`significantWords` + `stripDiacritics` so there is still only one normaliser in
`src/` — only the comparison differs. Diacritics are stripped because "Björn
Ahlstedt" is one of the 19 and Attio's enrichment is the documented source of
accent drift; the key is order- and case-insensitive because Master_ID holds
"JEREMY HODERS" in caps.

`Contact_Exclusions` is checked **first**, because it matches on record id or
exact address and has no false-positive surface. The name match is strictly
looser, so it is the fallback rather than the first word.

### The annotation is quoted, not summarised

Column F accretes — the 2026-08-30 Location cleanup appended a second clause to
all 19 after a ` · `. The quote stops at the first appended clause and then at
the first sentence end, which yields the original decision and not the
housekeeping. Both rules are separately mutation-checked; each is load-bearing
(some notes have no sentence period at all).

### Decisions taken, and their reasons

- **Suppressions are reported and logged, NOT written to `Contact_Exclusions`.**
  Master_ID SUPERSEDED already *is* the durable record; re-deriving it each run
  costs one sheet read and stops a name-match verdict ossifying into a permanent
  exclusion row. A wrongly-suppressed contact disappears silently, so the
  reversible option wins.
- **A suppressed record's id joins `priorExcludedIds`**, so a card queued by an
  earlier run — before the suppression existed — is dropped rather than left
  standing.
- **An empty index warns loudly.** Zero retired identities is possible in
  principle, but it is also the exact shape of a Master_ID column-order change
  or a failed read, and it would silently disable the highest-value gate here.

### Pre-existing warning, now more visible

The run reports `COMPROMISE COHORT DRIFT — matched 0 record(s), expected ~170`.
This is **not** caused by STEP 1b: all 170 compromise-blast records are already
in `Contact_Exclusions`, and the previous code also matched exclusions before
`classifyHardExclude`, so the cohort counter has been reading 0 since those rows
were first written. The check counts *newly classified* cohort members and is
satisfied by nothing once the cohort is durably excluded. Worth re-basing or
re-scoping, separately from this build.

### Correction to the spec's §1

`attio-bridging-spec.md` §1 states PASS 4's candidate set is
`master.rows.map(r => r.attioRecordId).filter(id => id !== '')`. The mechanism is
actually narrower: [pass4/index.ts](../src/passes/pass4/index.ts) iterates
`attio.listEntries(ATTIO_PIPELINE_LIST)` — the ~44 **pipeline list entries** —
and uses Master_ID only as a lookup index. The conclusion is unchanged and in
fact stronger: PASS 4 examines 44 of 2506 people, so an unbridged record is
invisible because it is not on the pipeline list, not because of a Master_ID
filter. (Separately, [pass4/load.ts](../src/passes/pass4/load.ts) skips rows with
a blank BHC_ID — which is every one of the 19 retired identities — so STEP 1b
reads Master_ID directly rather than reusing that loader.)

## 20. STEP 1c — duplicate candidate detection (2026-09-04)

Step 2 of `docs/attio-bridging-spec.md`. Detection only: it writes nothing,
mints nothing, merges nothing, and touches no tab. `src/passes/contacts-triage/duplicates.ts`.

### The measured shape held — exactly seven

Re-measured live 2026-09-04 against 2,510 people (2,255 bridged / 255
unbridged): **exact full name against a bridged record returns 7**, the same
seven the spec recorded on 2026-09-01, and three are still wrong. The filter
design rested on that shape and the shape did not move.

Detection also found a second arm the brief did not count: **6 clusters of two
or more UNBRIDGED records sharing a name**, one of which is Raymond Yang. That
is additional to the 7, not a contradiction of it — the spec's table only ever
measured unbridged-against-bridged.

18 candidates in total: 2 high, 5 medium, 11 low.

### ⚠ SIX OF THE SEVEN ARE ALREADY SUPPRESSED — so detection must not run on
### the filtered population

This is the finding that shaped the file. The spec's order of operations
(§7) says suppression runs first and "everything downstream is wasted work on a
record a human already ruled on." Applied literally to duplicate detection,
that is false, and measurably so: of the seven exact-name hits, **six are
already dropped by STEP 1b** — five by `Contact_Exclusions` record id, one by
email — and a seventh cohort is hard-excluded by STEP 2. Detecting on
`survivedSuppression` would have found **one** candidate, passed every fixture
test, and looked like it worked.

The reason the exclusions are there matters:

| Record | Gate | Written by |
|---|---|---|
| Kim Adelman `kima@thenewblank.com` | `thenewblank.com internal` | rule |
| Lana Hougham ×2 | `family` | rule |
| Chuck Granade `chuck@thenewblanks.com` | `archived from triage` | bobby |
| `"Le"` | `archived from triage` | bobby |
| June Yang `june.yang@xa.epicgames.com` | `archived from triage` (by EMAIL) | bobby |

**A `Contact_Exclusions` row answers "should this become a NEW contact?". It
does not answer "is this address a missing address on an EXISTING contact?"**
Those are different questions with different answers, and the queue conflates
them today. June Yang is the clearest case: BHC-01917 already exists carrying
`juney@thenewblank.com`, so the right outcome for her Epic address is not a new
contact — which is what Bobby declined on 2026-08-10 — but a second address on
the record she already has.

So detection runs over `enumeration.unbridged`, the **full** population, and
the gate is recorded on each candidate as `gating.suppressedBy` /
`gating.hardExcludedBy` rather than used as a filter. It changes nothing about
what is queued, scored or excluded — `classifyHardExclude` is called for
annotation only, and the STEP 2 loop below is still the only thing that decides.

The 2026-09-04 policy correction is why this is not a licence to ignore
suppression generally: **TNB staff and former staff ARE contacts, tier
Strategic.** The owned-domain rule is a threading rule. The largest duplicate
cohort in this population is TNB staff on the Epic account carrying both a
`@thenewblank.com` and an `@xa.epicgames.com` address, and under the old policy
every one of them was excluded.

### Zoe Cattolico is the end state, and merge wording follows from it

BHC-02386 carries `zoec@thenewblank.com` **and** `zoe.cattolico@xa.epicgames.com`
on one record. Chuck Granade (BHC-02338) is the same. So **merge here
CONSOLIDATES ADDRESSES onto one record** — it is not the elimination of a
redundant entry, and `proposedAction` says so in those words. The spec's
framing was too narrow; a test pins the wording.

### The signals, and what each one is worth

**Primary: exact set equality over significant words**, reusing step 1's
`nameKeyOf` so the two steps cannot drift about what a name is.

⚠ **Not `verifyName`.** It passes on one significant word in common — right for
verifying a pair a human proposed, wrong for generating them. `Raymond Yang`
and `Raymond Worsdale` (BHC-00679, active at NBCUniversal) share `raymond`.
`verifyName` appears nowhere in this routine except in comments saying why.

⚠ **No exact-email signal, ever.** `email_addresses` is `is_unique: true`:
Attio cannot put one address on two person records, so it returns zero by
construction. It would pass every fixture test and find nothing forever.

Corroboration — never sufficient alone:

| Signal | Weight | Fires live on |
|---|---|---|
| same Attio `company` record reference | strong → high | MOHAI pair (locked low, one-token) |
| identical LinkedIn URL | strong → high | nothing today |
| shared normalised email local part | weak → medium | Bobby Hougham's three own addresses |
| owned-domain pairing | weak → medium | June Yang, Raymond Yang |

**Owned-domain pairing is derived from live data, not hardcoded.** A domain
counts as co-located once it shares a bridged record with an owned-domain
address on at least `COLOCATED_MIN_RECORDS` (2) distinct records. Freemail is
excluded — half the workspace has a gmail address on their record. Measured
live, exactly one domain clears it: **`xa.epicgames.com`, on 12 records**. That
is the Epic cohort, found rather than assumed.

`company_name` is never read: our routines write it on bridged records only and
Attio never populates it, so name-plus-company can only ever agree on zero. The
spec states the reason wrongly (it says the field is empty everywhere); the
conclusion stands.

### The three known-wrong hits, and how each is caught

- **`chuck@thenewblanks.com` and `lana@thenewblanks.com`** — typo domains, one
  edit from an owned domain. Classified `exclude-typo-domain`, which
  **outranks** merge in the kind precedence, so the card asks the right
  question. High confidence — about what they are NOT.
- **`"Le"` matching BHC-01225** — a one-token name key. **Confidence is locked
  low and corroboration cannot raise it**, which is load-bearing rather than
  cosmetic: the MOHAI pair shares an Attio company record, the strongest signal
  there is, and two role mailboxes at one museum are still not one person.

### Repoint

An unbridged record matching an `ORPHAN CLEARED` retired identity becomes a
**repoint**, not a merge: those annotations name a canonical BHC_ID. Verified
live — all 13 name one in the leading clause `leadAnnotation` already keeps
(`"duplicate of BHC-00293 (Ron Buse…)"`, `"Andrew Kobliska is BHC-01541 at
Master_ID row 1572"`). `canonicalBhcIdIn` returns null rather than guessing when
none is present. **It fires on zero records today** — the arm is built and
tested against the real annotation text, and the population simply has no
ORPHAN CLEARED identity re-created by Attio right now.

### Raymond Yang: the second arm exists because Master_ID asked for it

`Master_ID` row 456, in Bobby's own words:

> ⚠ NOT YET UN-SUPPRESSED, DELIBERATELY. Attio's sync has re-created Raymond
> TWICE […] Un-suppressing before step 2's duplicate detection exists would let
> both enter triage and mint TWO BHC_IDs for one person: the exact duplicate
> this retirement was addressing, recreated with new numbers. **Un-suppress when
> step 2 ships and can surface them as one merge candidate.**

Both Raymond records are unbridged (BHC-01889 was retired), so exact-name
against bridged finds nothing for him. `consolidate-unbridged` is the arm that
does, and it now surfaces both at medium confidence with the caution that
neither carries a BHC_ID and minting each separately recreates the duplicate.

**Un-suppressing row 456 / 1585 is a Master_ID write and is therefore NOT part
of this step** (spec §7: "Do NOT write to `Master_ID`"). It is Bobby's call and
it is listed in the open questions.

### Mutation checks — nineteen, and SIX survived the first pass

Every guard was neutered, the suite confirmed failing, then restored and
confirmed passing. **Six survived the first attempt, all for the same reason:
paired guards masking each other**, which is a stronger version of the failure
step 1 hit (two of eleven).

| Survivor | Why | Fix |
|---|---|---|
| owned-domain skip / `distance > 0` | either alone rejects the owned domain | dropped `distance > 0`; the skip now also covers two similar owned domains, and a test injects that list |
| two length floors, one per side | either alone rejects a short pair | one floor on `Math.min` of the pair |
| one-token confidence lock | no fixture had a one-token name WITH corroboration | added the live MOHAI pair (shared company record) |
| freemail excluded from co-location | gmail sat at 1 record, so the count threshold rejected it first | added Chuck's real `cgranade01@gmail.com`, putting gmail at 2 |
| blank name key, index side vs subject side | either alone rejects it | removed the redundant subject-side checks; one guard, one place |
| strong → high confidence | **no test asserted `high` at all** | added the Michael Hayward shape — identical LinkedIn URL *and* identical company record, which Master_ID row 2013 calls "conclusive" |

All nineteen are caught now. The harness that found them is throwaway; the
finding worth keeping is that **a guard duplicated "for safety" is a guard that
cannot be tested**, and two of the six were exactly that.

### What this step deliberately did NOT do

No minting (step 4). No post-merge reconciliation (step 5). No `Master_ID`
write. **No write to `Contacts_Triage_Queue` and no change to its schema** —
detection surfaces its findings in the run report and the `#aida` post, and the
queue-column contract belongs to step 3's card, which is Bobby's to shape. See
the open questions.

## Open questions for Bobby

1. **BLOCKING — grant the Emails scope** to the bhc-routines Attio API key
   (#0). Nothing downstream of STEP 2 can run until then. Then one
   `--dump-email-shapes` call to confirm the scoping parameter.
2. **`Contact_Exclusions` needs columns F and G** — `recoverable`, `source`
   (#14). A live run will add them; adding them by hand is equally fine.
3. **Team-reply weight** (#13) — 28 vs 35 for a personal reply. Collapse them
   if a colleague's reply should count identically.
4. **Junk sort order** (#4) — literal ASC, or the parenthetical's "shakiest
   first"?
5. **Weights and thresholds** (#8) — expected to change after run one's
   histogram, which does not exist yet.
6. **Schedule.** The workflow is `workflow_dispatch`-only, deliberately. Wire
   it to a Launcher Zap once run one's distribution has been reviewed.
7. **Un-suppress Raymond Yang?** (#20) `Master_ID` rows 456 and 1585 say to do
   it "when step 2 ships and can surface them as one merge candidate." It ships
   here and it does. The edit is a `Master_ID` write, which this routine is
   forbidden to make, so it is Bobby's.
8. **The `thenewblank.com internal` exclusion is now wrong** (#20). Seven rows
   in `Contact_Exclusions` carry it, written by rule, and the 2026-09-04 policy
   says TNB staff and former staff ARE contacts. Kim Adelman is suppressed by
   it today. Detection is unaffected — it runs before the filter — but STEP 2
   will keep excluding those records, and every future one, until the rule is
   removed. Removing it is a behaviour change to who gets queued and scored,
   not a detection change, so it was not made here.
9. **Where does a duplicate candidate surface?** (#20) The spec says
   `Contacts_Triage_Queue`, and the queue is one row per unbridged record,
   which fits. But 16 of the 18 candidates have no queue row today because
   suppression or a hard exclude removed them — so surfacing them means either
   admitting suppressed records to the queue with a marker, or a
   `duplicate_*` column set that only step 3 can specify. That contract is
   Bobby's and Aida's to settle, not something to pick quietly.
