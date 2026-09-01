# Build brief — `pass2_6`, calendar-evidence reconciliation

**Repo:** `bhc-routines` · **Drafted:** 2026-09-01
**Read first:** `docs/task-reconciliation-spec.md` (the governing spec), then `docs/calendar-evidence-addendum.md`, then `src/passes/pass2_5/` — this mirrors its shape without living inside it.

---

## 0. What this is, and why it is a separate pass

`pass2_5` reconciles open tasks against `Activity_Log`. This does the same job against **calendar evidence**, and it is deliberately its own pass rather than an extension.

Two reasons, and the second is the load-bearing one:

**`pass2_5` is already the pass with the most moving parts.** Adding a second evidence source to it makes the hardest pass harder.

**They run on different clocks.** `Activity_Log` is filled by Late Edition, nightly — a 30-minute pass reading only that re-reads the same overnight snapshot all day. Calendar is continuously fresh. Folding them together forces one cadence onto two sources that do not move at the same rate.

**Cadence: `*/30`**, matching `zoom-discovery.yml`.

---

## 1. Where evidence comes from

**`/api/brain/calendar` on `aida.hougham.us`**, `action: listEvents`. Bearer `BRAIN_API_TOKEN`, exactly as `src/lib/sheets.ts` calls the Sheets proxy. No new credential; Graph auth lives entirely in Vercel.

Verified live 2026-09-01 against deployed `1069d54`: a one-month window returns **72 events across two pages**, `complete: true`, preRead median **1451ms** — 3.2% of the route's budget. `subjectlessCount: 0`.

⚠ **The end of the range is EXCLUSIVE.** `Aug01 → Sep01` returns 72; `Aug01 → Sep02` returns 76, the four extras all falling on September 1. That mismatch cost an hour during verification. Treat the window as `[start, end)`.

⚠ **Check `complete` on every response.** The route reports `partial: true` with a `partialReason` when it cannot exhaust pagination. **A partial page is not a smaller month — it is an unknown month**, and evaluating against it would produce `NO_EVIDENCE` verdicts for meetings that exist. On partial, log loudly and skip the run rather than judging on a truncated set.

---

## 2. ⚠ THE BODY IS PRIVILEGED CONTENT AND IT CROSSES THE NETWORK TO THIS REPO

Calendar bodies carry entire email threads. Observed on this mailbox: a $143,297.38 commission balance, debt schedules, an explicit attorney-client privilege notice, loan balances, payroll figures.

The route returns the body because **8 of 72 events carry their guest list there and nowhere else** — CalendarBridge writes it into the body and leaves `attendees` empty on synced events. It is the only path that reaches them.

**The route cannot enforce anything once the data leaves it. This repo must.**

- **Extract participants, then DISCARD.** The body must not survive past the extraction function.
- **NEVER write it** to `Activity_Log`, `Contact_History`, `Reconciliation_Queue`, or any staging tab.
- **NEVER log it.** Not on error, not truncated, not in a diagnostic. A stack trace carrying privileged legal correspondence is worse than the failure it describes.
- **NEVER put it in an LLM prompt** beyond what identity resolution requires — and identity resolution needs email addresses, not prose.
- **Evidence quotes carry the SUBJECT and DATE only.** Never body text.

Add a test asserting no body content reaches any written value. This is the one rule where a mistake is not recoverable by a later fix.

---

## 3. Attendee extraction — three paths, all required

Measured across all 72 August events:

| Path | Events | |
|---|---|---|
| 1 — native `attendees[]` | **25** | populated with name, address, response status |
| 2 — attendee block in `body` | **8** | `attendees` EMPTY; unreachable without the body |
| 3 — subject line only | **39** | neither; the largest bucket |

**Path 3 is the main path, not a fallback.** `Lunch w Brian Johnson` — in person, no Zoom link, no guest list, name only in the subject — is the case that justifies calendar as a source at all. Fathom will never see it.

Path 2's shape:

```
Attendees:
Organizer: - someone@example.com
- other@example.com Status: needsAction
```

**Try all three. Do not stop at the first that returns something** — a native event can have both a guest list and a name in the subject, and they may not be the same set.

---

## 4. The noise filter

**37 of 72 events are recurring occurrences.** All carry `seriesMasterId` and `type: "occurrence"`, so recurrence is a reliable discriminator — no title heuristics needed.

In order:

1. **`type === "occurrence"` AND no external participant → drop.**
2. **Zero external participants after all three extraction paths → drop.** External means not `@thenewblank.com` and not one of Bobby's own addresses.
3. **`isCancelled: true` → drop.** A cancelled meeting is evidence of nothing.

⚠ **Do NOT filter on `showAs`.** `Lunch w Brian Johnson` is `showAs: "oof"` — an availability test would discard a real business lunch. Verified live.

⚠ **Do NOT filter on the `(personal)` suffix.** It marks CalendarBridge provenance, not subject matter. `NICK B LAMB and Bobby Hougham (personal)` is a real meeting with an insurance broker.

---

## 5. Identity

`attendees[].emailAddress.address`, or an address parsed from the body block, or a name from the subject.

**Address → `Contacts` / Attio → `BHC_ID`.** A name from the subject is weaker and must be matched conservatively — an exact or near-exact match on a known contact's name, never a fuzzy guess. **An unmatched participant produces no verdict.** Never mint a contact; that is Aida's job, human-confirmed, per the standing contract.

---

## 6. Task-type confidence

**"Schedule / plan a meeting with X"** → a calendar entry **IS** the completion. The task was to get it booked. High confidence.

**"Discuss X with Y"** → the meeting must have HAPPENED. A calendar entry is a hint; a Fathom recording is proof. Lower confidence, and `NO_EVIDENCE` may still be right.

⚠ **A scheduled meeting is not a held meeting.** It can be cancelled, no-showed or moved. That is the whole reason for the split — do not let one confidence level cover both.

---

## 7. Output — `Reconciliation_Queue`, 15 columns A–O

Same tab, same shape, so Part D's Accept path works unchanged and everything surfaces in one place.

**Two values are distinct and baked in:**

- `Item_Type` (col C) = **`calendar_reconciliation`** — every existing row reads `task`
- `Evidence_Source` (col J) = **`calendar`**

`Evidence_Quote` (col I) carries **subject and date only**, per §2.

⚠ **Column O is `Placeholder_Activity_ID`, PASS 0's field.** Write blank. It is populated on zero of 364 rows because pass0's INFERRED path has never fired live — that is an unexercised path, not a free column.

**Verdicts** per the spec's §8: `NO_EVIDENCE` when the sources had coverage and found nothing; `UNEVALUABLE` when there was nothing to search. `UNEVALUABLE` surfaces as a **count, never as individual review cards.**

---

## 8. The watermark — `Pass26_Watermark`

⚠ **A watermark is mandatory, not an optimisation.** Without it this re-judges every open task against the same events 48 times a day — real Anthropic spend for no new information.

**A new tab, and the reason it is not a column is worth understanding.** A `Reconciliation_Queue` row is per-*proposal*; the watermark is per-*task*. Tasks that have never produced a proposal have no queue row — and those are precisely the ones with no evidence yet, which is exactly what this pass must keep re-checking. A column there would track only tasks that already have verdicts and silently skip the rest. `Tasks_Log` fails too: Attio-native tasks have no row there.

```
A Task_ID           TASK-… or an Attio UUID
B Source            attio | sheet
C BHC_ID
D Last_Evaluated_At ISO timestamp
E Last_Event_Seen   latest calendar event start considered
F Last_Verdict      what it last produced, or blank
G Eval_Count
H Notes
```

**Evaluate a task only when something has moved** — a calendar event newer than `Last_Event_Seen` involving that contact. Most runs find nothing and cost one read with **zero LLM calls**.

---

## 9. Write discipline — the house rules, all of which have been earned here

- **Count CONFIRMED writes, never intended.** `append` and `batchUpdate` return update facts; a counter incremented beside a discarded return measures intent. Seven counters were found doing this in August.
- **A write followed by a state change is gated on the write's result.** Never stamp a watermark over an unconfirmed queue write.
- **Never a full-row positional array from a partial read.**
- **Derive range letters from the column list; never hardcode them.**
- **Verify by reading back.** A tool reporting success is not evidence.
- **Mutation-check every guard**: neuter it, confirm the test fails, restore it, confirm it passes. A guard whose test passes with the guard removed is decorative.

---

## 10. Verify

`npm run typecheck && npm test`.

**Fixtures must be built from the REAL response shape**, including all three attendee paths and at least one recurring occurrence. Idealised fixtures have three times this month produced tests that passed without exercising what they named — most recently a `calendar_invitees` fixture with no duplicates, against which a dedupe test would have passed with the dedupe deleted.

Then, live, **dry-run first**:

1. A `*/30`-shaped run over a **7-day** window. Report events fetched, events surviving the filter, participants resolved, tasks evaluated, verdicts by type.
2. **Confirm the body never appears** in any written value or log line — grep the output.
3. Confirm the watermark suppresses a second immediate run: same window, **zero** tasks re-evaluated.
4. Confirm `Item_Type` and `Evidence_Source` are the new values on every row written.

**Do not write to `Reconciliation_Queue` until the dry run is reviewed.**

---

## 11. Report

The three extraction paths' counts on live data against the expected 25/8/39 split. Filter survivors. Verdicts by type. Mutation-check results. Confirmation the body reached nothing. Anything you stopped on.

**If the extraction split differs materially from 25/8/39, report before proceeding** — that would mean the source has changed shape since 2026-09-01 and the filter design rests on it.
