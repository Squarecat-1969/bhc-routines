# Build spec — continuous task reconciliation

**Drafted:** 2026-08-31 · **Status:** specced, not started
**Repos:** `bhc-routines` (the engine), `bhc-aida` (the surface)

---

## 0. What this is, and the problem it actually solves

Thirty-four Attio tasks sat open for two months. Not because anyone declined to close them — because **nothing ever showed them, and nothing ever re-checked them.** They were waiting for an event that could not happen.

Three fixes shipped on 2026-08-30/31 and they are the foundation this builds on:

- `readAttioTasks` un-stubbed, so Attio tasks reach the Queue (`bdd78f9`)
- A working, verified close path — PATCH then GET, throws unless `is_completed` is actually true (`6a5ec4a`)
- `current-state` stopped silently closing tasks as a side effect of loading the briefing (`541f9f6`)

What remains is the loop: **a task, once open, should be continuously re-evaluated against everything that has happened since — and close itself when the evidence says it is done.**

---

## 1. The governing decision, and it amends §4.10

§4.10 currently says nothing a human would care about closes without Bobby's confirmation. **This design moves that confirmation earlier rather than removing it.**

When Bobby triages a surfaced task and says *keep*, he authorises its whole lifecycle. Completing it later is the task reaching its natural end, not a second judgement someone else made.

Two properties make that safe, and both are load-bearing:

- **Visible.** An auto-closed task is greyed and struck through, never removed. It stays in the list.
- **Reversible.** One click reopens it, and reopening writes back to Attio through the same verified path.

§4.10's stated fear is that "a wrong one breaks trust with a real person". A wrongly-closed task Bobby can see and undo does not do that. A silently deleted one would. **Amend §4.10 to say so** rather than leaving this design in tension with the rule it actually satisfies.

---

## 2. Precedence — closed anywhere wins

```
Attio open   +  Tasks_Log closed   →  CLOSED
Attio closed +  Tasks_Log open     →  CLOSED
```

**Any system saying closed trumps any system saying open.** The rule is monotonic: nothing can flip back to open by itself, only by an explicit Reopen. That removes a whole class of oscillation between two systems disagreeing on every run.

A `Tasks_Log`-closed / Attio-open state means Bobby closed it manually through Aida — so the Attio side should be brought into line, not re-opened.

---

## 3. The evidence sources, and what each is good for

| Source | Sees | Freshness | Gap |
|---|---|---|---|
| `Activity_Log` | email, Zoom, DMs, texts, manual logs | nightly (Late Edition) | stale between runs |
| Fathom | recorded meetings | continuous | only recorded ones |
| **Calendar** | scheduled + in-person meetings | continuous | scheduled ≠ held |
| Attio timestamps | *that* something happened, and when | continuous | no content |

**One engine, not two.** An Attio-native workflow using a Custom Agent was considered and rejected: its evidence is a strict subset of `Activity_Log`, it costs credits on a plan whose current pricing is unverified, **Attio has no sandbox — you publish to test**, and a verdict computed there would be invisible to every diagnostic this project has built. One path to trace is worth more than fifteen minutes of latency.

⚠ **Recorded so it is not re-derived:** AI *attributes* in Attio cannot read notes or emails — only attribute values. The Custom Agent *workflow block* can. Anyone reaching for the obvious tool would build something that cannot see the evidence it needs and fails silently.

---

## 4. Calendar — measured, not assumed

Sampled 25 of 76 Outlook events in August 2026.

**MEASURED, not sampled — all 72 August events, 2026-09-01.** The earlier "~64% personal recurring noise" figure came from a 25-event sample and is superseded:

| | |
|---|---|
| recurring occurrences (carry `seriesMasterId`, `type: "occurrence"`) | **37 of 72** |
| **dropped by the filter** | **46 of 72** |
| · `recurring_no_external` | 28 |
| · `no_external_participant` | 18 |
| · `cancelled` | 0 |

Recurrence is a reliable discriminator — no title heuristics needed. **Filtering is the first design problem, not an afterthought**, and it removes roughly two thirds of the source.

**The remaining third correlates directly with open tasks:**

- `Call re: Transition Agreement Revisions`, 4 Aug, with `sholmes@hmlglaw.com` — against the open task *"Notify HMLG counsel once Chuck Granade responds"*
- `NICK B LAMB and Bobby Hougham`, 4 Aug, `nicklamb@insnw.com` — against the insurance thread
- **`Lunch w Brian Johnson`, 7 Aug, DERU, `showAs: oof`** — in person, no Zoom link. **Fathom will never see this. The calendar entry is the only record it happened.** This single case is the argument for the whole source.

⚠ **THREE EXTRACTION PATHS, AND PATH 3 IS THE LARGEST — measured across all 72 August events, re-measured identical 2026-09-01:**

| Path | Events | |
|---|---|---|
| 1 — native `attendees[]` | **25** | name, address, response status |
| 2 — attendee block in the `body` | **8** | `attendees` EMPTY; unreachable without the body |
| 3 — **subject line only** | **39** | neither |

**Path 3 is the main path, not a fallback.** `Lunch w Brian Johnson` — in person, no Zoom link, no guest list, the name only in the subject — is the case that justifies calendar as a source at all, and it is the single largest bucket. Attendee-email matching alone would miss more than half the source.

**Try all three; do not stop at the first that returns something** — a native event can carry both a guest list and a different name in the subject, and they may not be the same set.

**Task type changes what calendar proves:**

- *"Plan/schedule a meeting with X"* → a calendar entry **is** the completion. High confidence.
- *"Discuss X with Y"* → the meeting must have **happened**. A calendar entry is a hint; a Fathom recording is proof.

Both types exist in the current 34 — `Schedule audio sound design`, `Check team availability`, `Attend Hammer Creative x TNB` are the first kind.

### RESOLVED — Outlook via delegated Graph, built and verified. Google was tried and abandoned.

This section previously recommended *"Outlook primary, Google secondary"* and *"consider building Google first to prove the matching logic."* **Google was built first, and abandoned.** The outcome, not the recommendation:

⚠ **WHY GOOGLE FAILED, kept because it is exactly the kind of thing someone would retry.** The service account gets `reader`, which cannot see events the OWNER marked private — and CalendarBridge marks every synced event private by design. **32 of 72 August events came back masked**, a perfectly clean split where every masked event had `visibility: "private"` and no visible one did. The alternatives were per-event visibility edits (fights the sync, and new events keep arriving private) or granting **writer** access — a materially larger privilege for a read-only consumer, and the wrong trade.

**Outlook via delegated Microsoft Graph is built, deployed and verified live.** Delegated rather than app-only because a delegated read is *proven* to return private events and app-only visibility of them is unverified; and delegated is narrower — one mailbox, no tenant-wide grant. One calendar is sufficient because CalendarBridge syncs both directions and each calendar sees its own events plainly, so reading one as its owner gets everything. No dedupe problem, no second integration.

The credential cost was real and was paid: an Azure app registration is an eighth credential home, accepted because a Graph credential is infrastructure the C-Suite integration needs regardless. Its client-secret expiry belongs in `System_Counters`.

The M365 MCP connector cannot serve this: it authenticates as Bobby interactively and there is no MCP host in a GitHub Actions container. Same wall as Fathom and Docs.

---

## 5. Cadence — every 30 minutes, watermarked

`*/30`, matching `zoom-discovery.yml`. Read-only per run except for confirmed closes.

⚠ **A watermark is mandatory, not an optimisation.** Without it the engine re-judges 34 tasks against the same evidence 48 times a day — real Anthropic spend for no new information. **Evaluate only where the contact has new interaction since that task's last check.** Most runs will find nothing and cost one read with zero LLM calls.

⚠ **THE CONSTRAINT THAT DECIDES WHAT FREQUENCY ACTUALLY BUYS — measured 2026-08-31.** `GET /v2/emails` returns **403 with the `ATTIO_API_KEY` `bhc-routines` uses**. Verified directly, one curl. It is a product boundary, not a scope misconfiguration, and it does not change with configuration. Attio's own email search *does* work over MCP — but MCP authenticates as **Bobby, via OAuth**, and an unattended routine cannot.

**So email CONTENT reaches this engine only through `Activity_Log`, which Late Edition populates NIGHTLY. There is no path to fresher email content for an unattended routine.** A 30-minute pass does not get fresh email, and any design that assumes otherwise is wrong at the foundation.

That does not make `*/30` theatre — it makes it justified by **calendar** and by Attio's interaction **timestamps**, and by nothing else. Stated plainly because the natural reading of "every 30 minutes" is "sees everything every 30 minutes", and that reading is false here.

### Three layers, three different clocks

| Layer | Clock | What it gives | What it does NOT give |
|---|---|---|---|
| **Calendar** | continuous | Closes scheduling tasks in near-real-time — a meeting appearing **is** the completion for *"schedule a call with X"* | anything about what was said |
| **`last_interaction`** | continuous | A **timestamp only**: marks a contact as worth re-checking within minutes | any content — it never reveals what was said |
| **`Activity_Log`** | **nightly** | The actual content — email bodies, Zoom, DMs, manual logs | freshness; it is an overnight snapshot all day |

⚠ **THE TRIGGER IS `last_interaction`, NOT `last_email_interaction`. Measured across all 2506 Attio people, 2026-09-01:**

| Attribute | Populated |
|---|---|
| `last_calendar_interaction` | **0 of 2506 (0.0%)** |
| `last_email_interaction` | **0 of 2506 (0.0%)** |
| `last_interaction` | **2440 of 2506 (97.4%)** |

**The two channel-specific attributes exist in the schema and carry no values.** Verified against the raw attribute keys on a live record rather than through an accessor — with `first_interaction` populated on that same record as a control, so this is an empty field and not a parsing failure.

This is recorded rather than silently corrected because **`last_email_interaction` is the obvious thing to reach for and it is always empty.** A future session that picks it on name alone gets a trigger that never fires, and a watermark that never fires looks exactly like a watermark that is working.

`last_interaction` carries `interaction_type`, so **calendar can still be distinguished from email** from the generic field. It also arrives in the SAME query that resolves identity — so the watermark can skip untouched contacts **with no calendar read at all**.

**`last_interaction` is the watermark trigger, not evidence in itself.** It answers *"has something happened here?"* — never *"what happened?"* Treating a timestamp change as evidence would close tasks on the fact that an email exists, which is exactly the unverified-inference failure this spec is built to avoid. It moves a contact into the next run's candidate set; the verdict still waits for content.

The practical consequence: a scheduling task can close within half an hour of the meeting appearing, and an email-resolved task cannot close before the next Late Edition run. Those are different latencies for different task types, and the surface should not imply otherwise.

**Page load does a cheap staleness check, cron does the expensive evaluation.** §4.11 says nothing reconciles live while Bobby works, and that stands. On load: compare open tasks' contacts against `last_interaction` — one read, no AI — and flag "may have moved" for the next scheduled pass. **The page displays state; it does not compute it.**

---

## 6. What the surface shows

**All tasks, always.** Open and closed in one list, ordered by urgency, not segregated by state or origin.

**Closed = greyed and struck through.** Never removed.

**Every closed row carries its evidence in a twirl-down**: which email (date, subject, summary), which Fathom recording (linked), or which calendar event (subject, date, attendees) justified the close. Without this, Reopen is a guess. This is Rule 3 — no bare success.

**Reopen** sets `is_completed: false` through the verified PATCH-then-GET path, **and records that Bobby reopened it** so the next pass does not immediately re-close it on the same evidence.

⚠ **Auto-closed needs to be louder than grey, once.** Grey is easy to skim past, and a wrongly-closed task nobody notices is the failure mode this design must not have. Something like *"3 tasks closed automatically since you last looked"* — dismissable, then they settle into grey.

---

## 7. The engine — `pass2_6`, a SEPARATE pass

⚠ **This section previously read "extending `pass2_5`". Calendar reconciliation shipped as `pass2_6`, its own pass.** Two reasons, and the second is load-bearing:

**`pass2_5` is already the pass with the most moving parts**, and adding a second evidence source to it makes the hardest pass harder.

**THEY RUN ON DIFFERENT CLOCKS.** `pass2_5` reads `Activity_Log`, which Late Edition fills **nightly** — so a 30-minute pass reading only that re-reads the same overnight snapshot all day. Calendar is **continuously fresh**. Folding them together forces one cadence onto two sources that do not move at the same rate, and whichever cadence wins is wrong for one of them.

`pass2_6` mirrors `pass2_5`'s shape — same `Reconciliation_Queue`, same 15 columns, so Part D's Accept path works unchanged — without living inside it.

Established by investigation on 2026-08-31, so this does not need re-deriving:

- **The close path does NOT assume a `Tasks_Log` row.** A miss degrades to a warning; UUID-shaped IDs are already split out and closed directly against Attio.
- **Attio tasks have already been through this queue.** Three rows carry UUID `Source_Task_ID`s from a June Late Edition run; two are ACCEPTED.
- **Nothing assumes the `TASK-` prefix.** `Source_Task_ID` already holds five shapes.
- **`sheetRow` is written and never read** — so the field an Attio task cannot supply is already dead weight.

**Identity comes from `linked_records`, never from the prose.** All 34 Attio tasks carry it.

⚠ **RESOLUTION IS ONE HOP, NOT TWO. This previously read "Resolve `attioRecordId` → `Master_ID` col E → `BHC_ID`."** Measured live 2026-09-01: **the Attio person record carries `bhc_contact_id` directly.** `Master_ID` is consulted only as a FALLBACK, when that field is absent.

That fallback is itself a finding worth counting: **251 of 2506 Attio people (10.0%) have no `bhc_contact_id`**, where Non-negotiable #15 says every Attio person should carry one before leaving PASS 1. Every run reports the count rather than silently absorbing it.

Once you have the BHC_ID everything downstream works unchanged: clustering keys on it, `activity-candidates` filters `Activity_Log` on it.

⚠ **Clustering keys on `contactId || contactName`.** An Attio task with neither would land in a bare-description bucket and could wrongly cluster with another contact's identically-worded task. Resolve identity **before** clustering.

**Architecture: Part D calls `bhc-aida`'s verified close endpoint** rather than reimplementing it. Forty lines of PATCH-plus-read-back with three distinct failure messages, and a second copy would be a second thing to keep correct — this project has spent two sessions this month on defects that were exactly "the same logic implemented twice, drifting". `bhc-routines` already cannot function without `bhc-aida` for every Sheets read, so this joins an existing coupling rather than creating one, and keeps the Attio key in one home.

Two caveats: `syncAttioTaskClose` lives inside the commit route's handler and needs extracting to be callable. And its description fuzzy-match must be **optional** — right for a human clicking Accept, wrong for an unattended pass.

---

## 8. Verdict semantics — SETTLED 2026-08-31

Reconciliation asks *"does the evidence show this was handled?"* For a Google task that is fair: task and log are both Bobby's system of record, so silence is informative. **An Attio task may have been completed by something that never touched `Activity_Log`**, so the same silence often just means Attio knows something the log does not.

Folding both into one label produces a true statement that reads as a different claim than it is — same words, two confidence levels, and nothing at triage to tell them apart.

`LIKELY_STALE_NO_EVIDENCE` is already the most common verdict at **138 of 364**. Adding 34 Attio tasks — precisely the ones nothing has been logging against — could land most of them there at once. **That is the alert-fatigue shape removed from the Reconciler on 2026-08-30, reintroduced.**

### The decision

**Option 2: a distinct verdict for tasks whose evidence is thin, surfaced separately rather than folded into `LIKELY_STALE_NO_EVIDENCE`.**

Rejected: option 1 (same verdicts, accept the weaker signal) — it is the alert-fatigue shape, and it makes a strong claim on weak grounds. Rejected: option 3 (do not reconcile Attio-native tasks at all) — it leaves 34 tasks permanently outside the analysis §4.11 exists to provide.

### The refinement — and it is what stops the new verdict becoming a dumping ground

**The real distinction is not Attio-native versus Google. It is whether the evidence sources could reasonably have seen it.** An Attio task for a contact Bobby emails weekly is *not* unevaluable; a Google task for a contact with no logged interaction in a year is not meaningfully stale. Splitting on task origin would put both in the wrong bucket.

| Verdict | Means | Action it implies |
|---|---|---|
| `NO_EVIDENCE` | the log had **coverage** of this contact in the relevant window and found nothing | genuinely stale — worth reviewing |
| `UNEVALUABLE` | **no logged interaction with this contact at all**; nothing was ever going to speak to it | not stale, waiting for evidence to exist |

These warrant different actions and must not share a label. `UNEVALUABLE` is not a soft `NO_EVIDENCE` — it is a statement that the question could not be asked, which is why it does not belong in a review queue at the same priority.

### Coverage — SETTLED 2026-08-31

> **Coverage** = at least one `Activity_Log` entry for this contact, dated at or after the task's creation, that is **not** an unresolved reply placeholder.

| Condition | Verdict | Means |
|---|---|---|
| coverage present, no match | `NO_EVIDENCE` | the log was watching and found nothing — genuinely stale, worth reviewing |
| no coverage | `UNEVALUABLE` | nothing was ever going to speak to it — not stale, waiting for evidence to exist |

The definition is written down here, before implementation, because a vague one collapses the distinction back into a single verdict: generous enough and everything is `NO_EVIDENCE` so the split has bought nothing; strict enough and everything is `UNEVALUABLE` so the review queue empties for the wrong reason.

**Outbound-only counts.** Coverage asks whether the sources *could* have seen the resolution, not whether the contact replied. If Bobby emailed someone about the task, the log had every chance to capture what came back. A silent contact after an outbound is exactly the state worth surfacing — excluding outbound would misfile the most-chased tasks as unevaluable, which is precisely backwards.

**A placeholder does not count.** A reply placeholder records that something was sent and a reply is awaited — `pass0` exists because they sit unresolved. It marks a pending question, not an interaction. Counting it would assert the log had coverage while the log is itself still waiting. The nuance matters and is easy to lose: **an outbound entry with real content counts; an outbound *placeholder* does not.** Same direction, different substance.

**The window starts at task creation.** A fixed lookback answers a question nobody asked — whether Bobby has spoken to this contact lately. The relevant question is whether anything happened *since the task existed*, because only that could have resolved it. A task created yesterday against a contact emailed last month is `UNEVALUABLE`; a fixed 90-day window would wrongly call it `NO_EVIDENCE`.

### How `UNEVALUABLE` surfaces — a count, not proposals

**`UNEVALUABLE` appears as a count. It does not generate individual review cards.**

"12 tasks have no evidence either way" is useful. Twelve cards each demanding a verdict on a question that cannot be answered is **the Reconciler's twenty findings again** — the alert-fatigue shape removed on 2026-08-30, rebuilt somewhere new. This is the difference between the split being an improvement and it being the same problem under a better label.

A count invites the right action, which is usually none: an `UNEVALUABLE` task is not waiting on a decision, it is waiting on evidence to exist. When evidence appears, the next run reclassifies it and it surfaces then, on its own merits.

---

## 9. Probe results

Probe results below measured **2026-08-31** unless stated.

### Still open

**None.** Every question in this section is answered or explicitly conditional on a rejected option.

### Answered

1. **Is the Attio workspace token still 403 on `GET /v2/emails`? — YES. ANSWERED 2026-08-31, and it constrains the design.**

   Measured directly with one curl against the `ATTIO_API_KEY` `bhc-routines` uses: **403**. The recorded finding holds — **a product boundary, not a scope issue**, so no amount of configuration changes it.

   Last night's successful Attio email search **does not transfer**: MCP authenticates as **Bobby via OAuth**, and an unattended routine cannot. The AI-generated per-email summaries seen over that path are real, and they are unreachable from a routine. Worth stating precisely, because "Attio email search works" and "the engine can read email" are two different claims and only the first is true.

   **Consequence, recorded in §5 where the cadence is set rather than here:** email content reaches this engine only through `Activity_Log`, which Late Edition populates nightly. There is no path to fresher email content for an unattended routine, so `*/30` is justified by calendar and by interaction timestamps — not by email.

2. **`Reconciliation_Queue` column O — RESOLVED 2026-08-31. It was never a schema conflict.**

   **All FOUR paths agree on 15 columns.** `pass2_5`'s `buildReconciliationQueueRow` returns **15**, not 14, with a trailing blank commented *"O Placeholder_Activity_ID — PASS 0's field only"*. An earlier investigation reported the row as 14 wide and **that was wrong** — recorded here because the wrong number was used to argue a conflict that did not exist.

   **Column O is `Placeholder_Activity_ID`, added deliberately 2026-07-19.** `pass0` documents why: a `placeholder_reconciliation` row has a blank `Source_Task_ID` because it has no task to close, so the correlation ID its Accept action needs lives in col O — added specifically so `bhc-aida`'s commit route has a real field to read rather than parsing it back out of `Item_Description`'s prose.

   **It is empty on all 364 rows because every row is `item_type: "task"`** — `pass0`'s INFERRED path has never produced one live. Emptiness was evidence of an unexercised path, not of a broken one.

   **The only actual defect was a missing header**, written to `O1` and verified 2026-08-31.

3. **The concrete definition of "coverage"** — settled 2026-08-31. See §8.

4. **Does `POST /v2/tasks/query` honour its `linked_records` filter?** **Yes — verified.** Filtering to a single person record returned **4 tasks rather than all 134**. It also **validates the record ID**, rejecting a nonexistent one rather than silently ignoring the filter — so a typo fails loudly instead of quietly returning everything.

   This is **the opposite of `GET /v2/tasks`**, which discards every parameter except `is_completed` and `limit`/`offset` (`deadline_at_lte`, assignee and sort all silently ignored). Two endpoints on the same resource with opposite parameter discipline: use `POST /query` for anything filtered, and never assume a `GET` parameter was applied.

   ⚠ The caller still matters: `attioListOpenTasksForRecord` returns `[]` on any non-OK response, so a failure there is silent regardless of whether the filter works.

5. **⚠ Connected mailboxes are excluded from Attio's email search scope.** Filtering by a workspace member's own address, or by the company's own domain, returns **no results**. Filters are for **EXTERNAL participants only**. Worth stating loudly: a filter built the intuitive way — "find emails involving Bobby" — returns nothing and looks like a broken query or an empty dataset rather than a scope rule.

### Not open — conditional on a rejected option

6. **Does `last_email_interaction` fire Attio's Attribute-value-changed trigger? — CLOSED 2026-09-01. Moot twice over.**

   **First:** it was only ever conditional on the Attio-native-workflow option, which §11 rejects.

   **Second, and it closes the question outright:** §5 records `last_email_interaction` as populated on **0 of 2506** Attio people. **The question cannot be answered because there is nothing to fire — an attribute that never carries a value cannot trigger on change.** No test workflow would settle it; it would only observe silence.

   ⚠ **The SHAPE is the more useful part, and it is worth carrying past this item.** A trigger built on an empty field never fires, and **a watermark that never fires is indistinguishable from a watermark that is working perfectly.** Both look like "nothing has moved, nothing to re-evaluate" — a quiet, healthy-looking run, forever. That is the same failure §5 warns against, arriving through a different door: there the risk was picking the field by name, here it is building an event source on it. Anything gated on an Attio attribute needs its populated-ness measured **before** it is wired, not after it appears to work.

7. **What Attio charges for AI blocks at current pricing.** The numbers found — Free 100/month, Plus 1000/month, most blocks 1 credit — are from March 2025 and predate the engine rebuild. Same condition as above: only relevant if the Attio-workflow option is revisited.

---

## 10. Build order

Everything that was a judgement call is now settled. **Done, 2026-08-31:** §8's verdict semantics, the concrete definition of "coverage" (§8), and **column O** — which turned out to need only a header, not a schema decision (§9).

**Steps 1 and 2 shipped 2026-09-01, both differently than written:**

- ~~Google Calendar read + matcher~~ → **the calendar route runs on Microsoft Graph, not Google.** Google was built first and abandoned when the service account could not see owner-private events (§4). The route is deployed and verified; the matcher, noise filter and three-path extraction are built and live-measured.
- ~~`pass2_5` extension~~ → **`pass2_6`, a separate pass** (§7), because the two sources run on different clocks.

Also shipped with them: identity resolution **Attio-first, one hop** (§7), the `Pass26_Watermark` tab, and the privileged-body boundary enforced by type rather than by convention.

**Remaining:**
1. **Part D closes through `bhc-aida`'s endpoint** — extract `syncAttioTaskClose`, make the fuzzy match optional.
2. **The surface** — all tasks, greyed closed rows, evidence twirl-down, Reopen, the once-loud notice.
3. **A second calendar source**, only if Outlook proves insufficient — which it has not. Outlook is the shipped source (§4); this item previously read *"Outlook, if calendar has earned its place by then"* and was written when Google was still primary.

---

## 11. Do not

- **Do not auto-close without the evidence trail.** A close with no visible justification is indistinguishable from a bug, and Reopen becomes a guess.
- **Do not let the page compute verdicts.** §4.11 — the surface displays what the nightly pass decided.
- **Do not build the Attio-native workflow as well.** Two systems closing tasks means two places to look when one closes wrongly.
- **Do not reimplement the Attio close.** It exists, it is verified, it took a session to get right.
- **Do not skip the watermark.** Without it this is 34 LLM evaluations every thirty minutes, forever.
