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

**~64% is personal recurring noise** — `Lunch (personal)` ×8, `transit` ×2, `Reading The Fifth Season` ×2, `Cretins MC` ×2, `Dental`, `hold for Dr Call`. Solo, no attendees, no relevance. **Filtering is the first design problem, not an afterthought.**

**The remaining third correlates directly with open tasks:**

- `Call re: Transition Agreement Revisions`, 4 Aug, with `sholmes@hmlglaw.com` — against the open task *"Notify HMLG counsel once Chuck Granade responds"*
- `NICK B LAMB and Bobby Hougham`, 4 Aug, `nicklamb@insnw.com` — against the insurance thread
- **`Lunch w Brian Johnson`, 7 Aug, DERU, `showAs: oof`** — in person, no Zoom link. **Fathom will never see this. The calendar entry is the only record it happened.** This single case is the argument for the whole source.

⚠ **`attendees` is `null` on that event.** The name is only in the subject line. So matching must read **both attendees and subject text** — attendee-email matching alone would miss precisely the case that justifies the feature.

**Task type changes what calendar proves:**

- *"Plan/schedule a meeting with X"* → a calendar entry **is** the completion. High confidence.
- *"Discuss X with Y"* → the meeting must have **happened**. A calendar entry is a hint; a Fathom recording is proof.

Both types exist in the current 34 — `Schedule audio sound design`, `Check team availability`, `Attend Hammer Creative x TNB` are the first kind.

**Outlook primary, Google secondary**, per Bobby. Note the cost honestly: `bhc-routines` has no Microsoft credential. Graph app-only access needs an Azure app registration with application permissions and admin consent — **free in money, but an eighth credential home** in a system where the seventh caused a full rebuild on 2026-08-14. Google Calendar is one scope line on a service account already in Vercel. **Consider building Google first to prove the matching logic, then adding Outlook** — the matcher is the hard part and it is source-agnostic.

The M365 MCP connector cannot serve this: it authenticates as Bobby interactively and there is no MCP host in a GitHub Actions container. Same wall as Fathom and Docs.

---

## 5. Cadence — every 30 minutes, watermarked

`*/30`, matching `zoom-discovery.yml`. Read-only per run except for confirmed closes.

⚠ **A watermark is mandatory, not an optimisation.** Without it the engine re-judges 34 tasks against the same evidence 48 times a day — real Anthropic spend for no new information. **Evaluate only where the contact has new interaction since that task's last check.** Most runs will find nothing and cost one read with zero LLM calls.

⚠ **AND THE CONSTRAINT THAT DECIDES WHETHER FREQUENCY HELPS AT ALL:** `Activity_Log` is populated by Late Edition, which runs **nightly**. A 30-minute pass reading only `Activity_Log` spends most of the day re-reading the same overnight snapshot. Frequency without fresher evidence buys nothing.

So the run needs at least one continuously-fresh source — calendar, Attio's `last_email_interaction` / `last_calendar_interaction` timestamps, or Fathom directly. **Establish which before setting the cadence**, or the schedule is theatre.

**Page load does a cheap staleness check, cron does the expensive evaluation.** §4.11 says nothing reconciles live while Bobby works, and that stands. On load: compare open tasks' contacts against `last_interaction` — one read, no AI — and flag "may have moved" for the next scheduled pass. **The page displays state; it does not compute it.**

---

## 6. What the surface shows

**All tasks, always.** Open and closed in one list, ordered by urgency, not segregated by state or origin.

**Closed = greyed and struck through.** Never removed.

**Every closed row carries its evidence in a twirl-down**: which email (date, subject, summary), which Fathom recording (linked), or which calendar event (subject, date, attendees) justified the close. Without this, Reopen is a guess. This is Rule 3 — no bare success.

**Reopen** sets `is_completed: false` through the verified PATCH-then-GET path, **and records that Bobby reopened it** so the next pass does not immediately re-close it on the same evidence.

⚠ **Auto-closed needs to be louder than grey, once.** Grey is easy to skim past, and a wrongly-closed task nobody notices is the failure mode this design must not have. Something like *"3 tasks closed automatically since you last looked"* — dismissable, then they settle into grey.

---

## 7. The engine — extending `pass2_5`

Established by investigation on 2026-08-31, so this does not need re-deriving:

- **The close path does NOT assume a `Tasks_Log` row.** A miss degrades to a warning; UUID-shaped IDs are already split out and closed directly against Attio.
- **Attio tasks have already been through this queue.** Three rows carry UUID `Source_Task_ID`s from a June Late Edition run; two are ACCEPTED.
- **Nothing assumes the `TASK-` prefix.** `Source_Task_ID` already holds five shapes.
- **`sheetRow` is written and never read** — so the field an Attio task cannot supply is already dead weight.

**Identity comes from `linked_records`, never from the prose.** All 34 Attio tasks carry it. Resolve `attioRecordId` → `Master_ID` col E → `BHC_ID`. Once you have the BHC_ID everything downstream works unchanged: clustering keys on it, `activity-candidates` filters `Activity_Log` on it.

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

### Before implementation: define "coverage" concretely

**Write the definition down before building it.** The likely shape is *any `Activity_Log` entry for this contact between the task's creation and now* — but that is a starting proposal, not the decision.

A vague definition collapses the distinction back into a single verdict, which is the failure this refinement exists to prevent: if "coverage" is generous enough, everything is `NO_EVIDENCE` and the split has bought nothing; if it is strict enough, everything is `UNEVALUABLE` and the review queue empties for the wrong reason. Questions the definition has to answer explicitly: does an outbound-only entry count as coverage, does a placeholder row count, and does the window start at task creation or at some fixed lookback.

---

## 9. Open questions, before code

Probe results below measured **2026-08-31** unless stated.

### Still open

1. **Is the Attio WORKSPACE token still 403 on `GET /v2/emails`?** ⚠ **Still open, and the whole email-evidence path depends on it.** What was verified 2026-08-31 is the **MCP path**, which authenticates as *Bobby*, not as the workspace token `bhc-routines` uses: email search works there, and returns **AI-generated summaries per email**, which is a materially better evidence source than metadata alone. That result does **not** transfer. The recorded 403 applies to the workspace token and **has not been re-checked**, so treat the token as unproven. If it holds, `pass2_5` learns *that* and *when* from Attio, never *what* — and the AI summaries are unreachable from a routine.

2. **`Reconciliation_Queue` column O.** No header, empty on all 364 rows, and three code paths write or read it — `pass2_5:124` supersedes over `A:O`, `pass0:162` appends 15 values, `bhc-aida`'s commit route reads `A:O`. `pass0`'s INFERRED path has never landed a row live, which is why nobody noticed. **Resolve before adding columns** — now step 1 of the build order.

3. **The concrete definition of "coverage"** for §8's `NO_EVIDENCE` / `UNEVALUABLE` split. Named here as well as in §8 because it gates implementation, not design.

### Answered

4. **Does `POST /v2/tasks/query` honour its `linked_records` filter?** **Yes — verified.** Filtering to a single person record returned **4 tasks rather than all 134**. It also **validates the record ID**, rejecting a nonexistent one rather than silently ignoring the filter — so a typo fails loudly instead of quietly returning everything.

   This is **the opposite of `GET /v2/tasks`**, which discards every parameter except `is_completed` and `limit`/`offset` (`deadline_at_lte`, assignee and sort all silently ignored). Two endpoints on the same resource with opposite parameter discipline: use `POST /query` for anything filtered, and never assume a `GET` parameter was applied.

   ⚠ The caller still matters: `attioListOpenTasksForRecord` returns `[]` on any non-OK response, so a failure there is silent regardless of whether the filter works.

5. **⚠ Connected mailboxes are excluded from Attio's email search scope.** Filtering by a workspace member's own address, or by the company's own domain, returns **no results**. Filters are for **EXTERNAL participants only**. Worth stating loudly: a filter built the intuitive way — "find emails involving Bobby" — returns nothing and looks like a broken query or an empty dataset rather than a scope rule.

### Not open — conditional on a rejected option

6. **Does `last_email_interaction` fire Attio's Attribute-value-changed trigger?** **Unanswerable without building a test workflow inside Attio**, and it only matters if the Attio-native-workflow option — rejected in §11 — is revisited. Not an open question for this build; a prerequisite for a different one.

7. **What Attio charges for AI blocks at current pricing.** The numbers found — Free 100/month, Plus 1000/month, most blocks 1 credit — are from March 2025 and predate the engine rebuild. Same condition as above: only relevant if the Attio-workflow option is revisited.

---

## 10. Build order

§8's verdict semantics are **settled** (2026-08-31) and no longer a build step. What remains from it is the concrete definition of "coverage", which belongs with step 2 rather than ahead of it.

1. Resolve **column O** — do not build on an ambiguous schema.
2. **Define "coverage"** concretely and write it down (§8) — it gates the `NO_EVIDENCE` / `UNEVALUABLE` split and cannot be settled while implementing.
3. **Google Calendar** read + the matcher, including the noise filter and subject-line matching. Prove the hard part on the cheap source.
4. **`pass2_5` extension** — `listTasks` on `AttioClient`, identity via `linked_records` → `Master_ID`, watermark.
5. **Part D closes through `bhc-aida`'s endpoint** — extract `syncAttioTaskClose`, make the fuzzy match optional.
6. **The surface** — all tasks, greyed closed rows, evidence twirl-down, Reopen, the once-loud notice.
7. **Outlook**, if calendar has earned its place by then.

---

## 11. Do not

- **Do not auto-close without the evidence trail.** A close with no visible justification is indistinguishable from a bug, and Reopen becomes a guess.
- **Do not let the page compute verdicts.** §4.11 — the surface displays what the nightly pass decided.
- **Do not build the Attio-native workflow as well.** Two systems closing tasks means two places to look when one closes wrongly.
- **Do not reimplement the Attio close.** It exists, it is verified, it took a session to get right.
- **Do not skip the watermark.** Without it this is 34 LLM evaluations every thirty minutes, forever.
