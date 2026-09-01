# Spec addendum — calendar evidence source, verified

**Drafted:** 2026-08-31 · **Amends:** `docs/task-reconciliation-spec.md` §4 (calendar) and §5 (three layers)
**Status:** source decided and verified live. Matcher not built.

---

## 1. The decision: Outlook via Microsoft Graph, delegated, `Calendars.Read`

**One source. Not Google Calendar, not both, not Calendly, not the CalendarBridge API.**

Verified live 2026-08-31 against `/me/calendarView`, August 2026, 50 events returned.

### Why not the alternatives

**Calendly** returns only Calendly-booked events. `/scheduled_events` lists meetings booked through the link; it reads the calendar for *availability* but does not expose arbitrary events with subjects and attendees. Externally-organised meetings would be absent entirely — the wrong subset, not merely a smaller one.

**Google Calendar via the service account** was built, tested, and abandoned. The account gets `reader`, not `freeBusyReader` — but **32 of 72 August events returned masked**, a perfectly clean split where every masked event had `visibility: "private"` and no visible one did. A reader cannot see events the *owner* marked private. Bobby marks all CalendarBridge-synced events private deliberately, and that is not going to change. The alternatives were per-event visibility edits (fights the sync, and new events keep arriving private) or granting **writer** access — a materially larger privilege for a read-only consumer, and the wrong trade.

**Both calendars with dedupe** was rejected because it is unnecessary. See §2.

### Why delegated rather than app-only

⚠ **App-only visibility of private events is UNVERIFIED and one source suggests it fails.** A Microsoft Q&A answer states that with `Calendars.Read.All`, if events are marked private or the calendar is not shared with the application identity, subject and location may not be returned. That is a community answer, not documentation — but it is the same assumption shape that cost two rounds on the Google path, and it is not worth an Azure app registration to discover.

Delegated is **proven**, not inferred. Every private event in the live read came back complete.

Work-account refresh tokens are also long-lived and sliding, avoiding the 7-day consumer-Google testing-mode expiry that would have made an OAuth-as-Bobby Google path fragile. And delegated is *narrower* than app-only: one mailbox, no tenant-wide grant, no application access policy to remember.

---

## 2. Outlook alone is sufficient — CalendarBridge syncs both directions

**A synced copy is marked private in the DESTINATION calendar. The native original is untouched.**

Evidence: `Lunch w Brian Johnson` reads `sensitivity: "normal"` in Outlook, where it is native — and was **masked** to the Google service account, where it is a synced copy. Conversely the Google-origin events in Outlook (`NICK B LAMB`, `transit`, `Dental`) all read `sensitivity: "private"` and are native in Google.

So each calendar sees its own events plainly and the other's as private copies. **Reading one calendar as its owner gets everything**, because the owner sees private events regardless.

**No dedupe problem. No second integration. No Azure-plus-Google.**

CalendarBridge also suffixes synced copies — `(work)` for Outlook-origin in Google, `(personal)` for Google-origin in Outlook. That is a **free provenance signal**: a suffix means synced, no suffix means native.

---

## 3. ⚠ THE BODY IS A SENSITIVE-DATA SURFACE, NOT METADATA

This is the most important finding in the live read and it was not anticipated anywhere in the spec.

**Calendar event bodies contain entire email threads.**

`Call re: Transition Agreement Revisions` carries, in its `body`: Sarah Holmes's redline comments on the transition agreement, the $143,297.38 commission balance, debt schedules with account-level figures, the valuation dispute, and an explicit attorney-client privilege notice. Thousands of words of privileged legal correspondence, in a calendar event.

`Catching up with the numbers- TNB Quarterly` carries a full agenda naming BECU and SBA loan balances, payroll variances, negative payroll liability figures, and specific vendor invoice amounts.

**The standing rule against propagating financial, medical or privileged content applies to calendar bodies directly.** It was written with email and meeting summaries in mind; it covers this.

### The rule for the matcher

**READ the body for attendee extraction. NEVER carry it forward.**

Not into `Activity_Log`. Not into `Contact_History`. Not into a verdict's evidence quote. Not into a Slack post. Not into an LLM prompt beyond what identity resolution requires.

The evidence a closed task needs is *"a meeting titled X happened on DATE with PERSON"* — the subject line, the date, the attendee list. **The body is an input to finding the attendees and nothing else.**

⚠ Where an evidence quote would otherwise carry body text, quote the **subject and date only**. A verdict that pastes a calendar body into a staging tab has copied privileged material into the CRM.

---

## 4. Attendee extraction: three paths, in order

Verified across the 50-event sample. A single strategy is insufficient.

**1. `attendees[]` — native events.** Populated with `emailAddress.name`, `emailAddress.address`, `type`, and `status.response`. `EGSM RFP update` returned all sixteen. Use this whenever it is non-empty.

**2. The body's attendee block — SYNCED events.** CalendarBridge writes the original guest list into the body and leaves `attendees` EMPTY. Confirmed on `NICK B LAMB and Bobby Hougham`, `Greenwood Heating Maintenance`, and `Bobby Hougham & Charlene Fleming CPA`. The shape:

```
Attendees:
Organizer: - bobbyhougham@gmail.com
- nicklamb@insnw.com Status: needsAction
```

⚠ **This is the only path that reaches synced events, and it is also the path that touches privileged content.** Extract addresses, discard the rest, per §3.

**3. The subject line — neither of the above.** `Lunch w Brian Johnson` has `attendees: []` and an empty body. The name is only in the subject. This is the in-person case that justifies calendar as a source at all — Fathom will never see it, and email may not either.

**Try all three. Do not stop at the first that returns something**, since a native event can have both a guest list and a name in the subject, and they may not be the same set.

---

## 5. The noise filter — measured, and cheaper than expected

**~54% of the sample is recurring personal blocks.** `Lunch (personal)` alone expanded into 13 separate occurrences in one month, plus `transit`, `Dental`, `Dr Benhoff`, `hold for Dr Call`.

Every one carries `seriesMasterId` and `type: "occurrence"`, so **recurrence is a reliable discriminator** — no title heuristics needed.

**The filter, in order of cheapness:**

1. **`type === "occurrence"` AND no external attendee → drop.** Catches the entire recurring-personal-block class in one test.
2. **Zero external participants after all three extraction paths → drop.** "External" means not `@thenewblank.com` and not one of Bobby's own addresses, per the owned-domains list. Catches `Dental`, `Transit`, `Ross Lake Resort`.
3. **`isCancelled: true` → drop.** A cancelled meeting is not evidence of anything.

⚠ **Do NOT filter on `showAs`.** `Lunch w Brian Johnson` is `showAs: "oof"` and `Ross Lake Resort` is `showAs: "free"` — a busy/free test would drop a real business lunch and keep nothing useful. Availability is not relevance.

⚠ **Do NOT filter on the `(personal)` suffix.** It marks CalendarBridge provenance, not subject matter — `NICK B LAMB and Bobby Hougham (personal)` is a real business meeting with an insurance broker.

---

## 6. Task-type confidence, unchanged but now evidenced

The distinction from the main spec holds and the sample supports it:

**"Schedule / plan a meeting with X"** → a calendar entry **IS** the completion. The task was to get it booked. High confidence.

**"Discuss X with Y"** → the meeting must have HAPPENED. A calendar entry is a hint; a Fathom recording is proof. Lower confidence, and a `NO_EVIDENCE` verdict may still be right if nothing else corroborates.

Live examples of the first kind in the current open set: `Schedule audio sound design`, `Check team availability`, `Attend Hammer Creative x TNB`, and the Attio task `Schedule Monday/Tuesday call with Joleen Hughes (HMLG)` — for which `jhughes@hmlglaw.com` appears as an attendee on a real August event.

---

## 7. Measured facts, dated

Verified 2026-08-31 via Graph Explorer, delegated as `bobby@thenewblank.com`:

| | |
|---|---|
| Private events readable | **YES** — `EGSM RFP update`, `sensitivity: private`, all 16 attendees returned |
| `Calendars.Read` covers others' invites | **YES** — same event, `isOrganizer: false`, organised by `chuck@thenewblank.com`. `.Shared` NOT required |
| Synced events carry attendees in body | **YES** — 3 confirmed, `attendees: []` in each |
| Recurring blocks carry `seriesMasterId` | **YES** — 13 `Lunch` occurrences in one month |
| Bodies carry privileged content | **YES** — see §3 |
| Page size | 50 events, `@odata.nextLink` present — **pagination is required for a month** |

⚠ **`Calendars.Read` alone is confirmed sufficient. Do not add `.Shared` unless a specific gap appears** — least privilege, and it is one tick to add later on an app already owned.

---

## 8. Build prerequisites

**Azure app registration** — `Aida Graph Reader`, single tenant, delegated `Calendars.Read` and `User.Read`, admin consent granted. Free; the cost is an eighth credential home, accepted because a Graph credential is infrastructure the C-Suite integration will need regardless.

**Client secret expiry belongs in `System_Counters`** under `stored_in` and `consequence`, the moment it is created. A secret that expires in two years with nothing tracking it is the documented failure this project has already had once.

**Pagination** must be implemented, not assumed — a one-month window exceeded the 50-event page in the live read.
