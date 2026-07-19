# Changelog

All dates are the routine-config install date. Newest first.

## 2026-07-19 — Late Edition scheduled to run live, 11pm Sun-Thu Pacific — a real double-run bug caught before enabling it

- **Enabled the cron schedule** in `.github/workflows/late-edition.yml` — Late Edition now runs automatically 11pm Sunday-Thursday Pacific, live, all eight passes.
- **Real bug caught before shipping**: the two DST-covering cron expressions (`0 6 * * 1-5` for PDT, `0 7 * * 1-5` for PST) are each unconditional — cron has no concept of season, so *both* fire every single weekday year-round, one hour apart. With `cancel-in-progress: false`, the second fire wouldn't get skipped, it would queue and run right after the first finished — meaning the entire routine, including real Sheets/Attio writes and a real Slack post, would have run **twice every night**, not once.
- **Fixed with a runtime guard**: a new first step reads the actual current Pacific hour (`TZ='America/Los_Angeles' date +%H`) and only proceeds if it's genuinely 11pm there right now — letting the OS's own DST-aware tzdata decide which of the two fires is correct for today, rather than hand-maintaining the cron twice a year. Verified directly against all four combinations (summer/winter × both cron times) — exactly one passes in each case, every time.
- **Also fixed**: the run command branched on `inputs.mode`, which only exists for manual `workflow_dispatch` — a scheduled trigger has no `inputs` context at all, so without a fix a cron-triggered run would have silently fallen through to `--dry-run` forever, never doing the real nightly work. Scheduled runs now always pass `--live`; manual dispatches still respect the mode dropdown.
- Manual `workflow_dispatch` is unaffected by the guard (skips it entirely) and remains available for testing.
- 407/407 across the whole repo unaffected (no TypeScript changed). YAML validity and the guard's shell logic both verified directly.

## 2026-07-19 — GitHub Actions workflow rewritten to invoke the combined orchestrator

- **Real gap found**: `.github/workflows/late-edition.yml` was still a PASS-4-only stub, untouched since before this entire rebuild. It invoked `run-pass4.ts` alone, had no `ANTHROPIC_BHC_ROUTINES_API` secret wired up, and had never heard of PASS 0/1/2/2.5/3/5 or the combined orchestrator. Running the existing workflow as-is (even via manual `workflow_dispatch`) would have silently run only PASS 4.
- **Rewritten**: the workflow now invokes `run-late-edition.ts` (the full eight-pass orchestrator), with `ANTHROPIC_BHC_ROUTINES_API` added to the job's env. Timeout raised `20 → 30` minutes, based on the real observed full `--live` runtime (~8m49s) plus CI setup overhead and margin for LLM/network variance. Report artifact renamed to `late-edition-report-${{ github.run_id }}`.
- **Cron trigger intentionally still left commented out** — the full chain is now proven at real production scale, but enabling unattended scheduling is a deliberate decision for Bobby to make, not a default to flip once the code works. The existing DST-aware cron-timing documentation in the file is unchanged and still accurate for whenever that decision is made.
- **`.env.example` updated to match** — was still framed as "Required for PASS 4" only; now reflects that `ANTHROPIC_BHC_ROUTINES_API` is required by the orchestrator (PASS 2 and PASS 2.5 both need it), not "unused by every other pass" as it previously (incorrectly) said.
- 407/407 across the whole repo unaffected (no TypeScript changed), YAML validity confirmed directly.

## 2026-07-19 — Orchestrator's first full-scale live run: two real PASS 3 drift bugs found and fixed

- **Ran the combined orchestrator unlimited `--dry-run`** (all 79 PASS 2.5 clusters, all 2216 PASS 4.5 targets, real Attio/Sheets throughout, ~7 minutes end to end). Surfaced a false warning: PASS 3 said it was running "standalone" and couldn't surface drift — but it wasn't standalone, the orchestrator explicitly chained it.
- **Bug 1**: PASS 3 destructured `driftNotes = []` before checking whether to warn, collapsing "never given a driftNotes array" (truly standalone) and "given an array that's genuinely empty" (chained, PASS 2 found zero drift) into the same value. Fixed: check `opts.driftNotes === undefined` before applying any default.
- **Bug 2, found while fixing Bug 1**: even with the check fixed, real drift notes chained into a night where nothing else surfaced would still never appear — `buildDigestBody`'s `all_clear` path returned early, before the drift-rendering code ever ran. Identity drift is a standing data-integrity flag, not a "new item," and shouldn't vanish just because no email needed a reply that night. Fixed: the `all_clear` path now renders drift notes too, when present.
- Both bugs would have fired on essentially every real production run with a clean PASS 2 (most nights) — a false "you're not chained" warning that would train Bobby to ignore it, plus real drift silently disappearing on any all-clear night.
- 4 new tests. 407/407 across the whole repo, typecheck clean. Full writeup in `docs/pass3-notes.md`.

## 2026-07-19 — Orchestrator's first live run: clean, zero aborts; fixed a real warnings-visibility gap

- **First live run of the combined orchestrator** (`--dry-run --limit 3`) against real production data: real Contacts (2855 rows), real Master_ID (2450 rows), real Attio pipeline (44 entries), real open tasks (83, 79 clusters), real Thread_Staging (500 rows). All eight passes completed with `aborted: false`. ~37 seconds end to end.
- **One real gap found**: the combined summary report never surfaced any pass's own `warnings` array — visible in the live log stream, but silently absent from the "read this and know if something needs attention" summary at the bottom. Each individual pass's own standalone report always included this.
- **Fixed**: `collectWarnings` aggregates every pass's warnings, prefixed by pass name, into a `WARNINGS (N):` section — present only when there's something to report. 3 new tests.
- 403/403 across the whole repo, typecheck clean.
- **Not yet run `--live`, and not yet run without `--limit`** — a full unlimited run will take considerably longer than 37 seconds.

## 2026-07-19 — The combined Late Edition orchestrator: all eight passes chained, one shared Run_ID

- **New**: `src/passes/orchestrator/` + `npm run late-edition -- --dry-run`/`--live`. Chains PASS 0 → 1 → 2 → 2.5 → 3 → 4 → 4.5 → 5 in one process with one shared `Run_ID`, instead of eight separate commands with a `Run_ID` copied by hand between them.
- **Closes PASS 3's previously-documented drift-alert gap**: PASS 2's identity-drift warnings now flow directly into PASS 3's digest in memory (`extractDriftNotes`) — the one thing standalone operation could never recover (PASS 2's drift detection only ever lived in that run's in-memory report).
- **Deliberately shallow, not a rewrite**: does not restructure any individual pass's own Sheets/Attio reads to share data in memory — every pass keeps its own independent, already-live-verified reads. Real risk on working production code for marginal efficiency gain.
- **Real inconsistency found while wiring this up**: PASS 4's report has no `aborted` field at all, unlike every other pass including its own sibling PASS 4.5 — its existing CLI already posts the Slack addendum unconditionally. Matched that established behavior exactly rather than inventing new gating logic.
- **A real, valuable finding, not a bug**: building the "does PASS 2's write reach PASS 3" test initially failed with both sides in dry-run — traced down to the dry-run safety guarantee working exactly as designed (PASS 2 gates its actual write behind `!dryRun`, `writtenCount` still increments for reporting only). Confirms the dry-run guarantee holds under a full 8-pass chain, not just each pass alone. Fixed the test, not the code.
- **The fake test backend gained a real capability**: no single pass's own tests ever needed a write to be visible to a later read within the same test run. Added targeted state to `FakeBackend` so a `Brain_Complete` append is reflected on the next read — the first genuine cross-pass test needed this.
- 9 new tests, including a full 8-pass chain against fake backends proving one shared `Run_ID`, a clean empty-dataset run, real data genuinely flowing PASS 2 → PASS 3, and the drift-notes flow working end to end. 400/400 across the whole repo, typecheck clean.
- **Never run end-to-end against real production data.** Full writeup in `docs/late-edition-orchestrator-notes.md`.

## 2026-07-19 — PASS 5: add a Daily_Brief size-safety guard, prompted by a real question

- **Confirmed via search**: Google Sheets has a hard, non-adjustable 50,000-character-per-cell limit. Today's real writes come in well under 1,000 characters, and the plan's own bounded design (hard-capped at 10 items, naturally bounded fields) keeps realistic worst-case size a small fraction of the limit.
- **Kept the one-cell design rather than subdividing** — the spec's repeated insistence on "the ONLY valid write shape" reads as protecting a downstream contract (Aida reads this one cell as a single JSON blob), not just caution. Splitting would need coordinated Aida-side changes for a problem the plan's own design doesn't create.
- **Added instead**: a size check before writing. `writeDailyBrief` now refuses to write (returning a clear reason) if the serialized JSON exceeds a 45,000-character safety margin, rather than risking silent truncation or an API rejection — the same "stop silently, don't write a broken shape" instinct the spec already uses, extended to a failure mode it didn't anticipate.
- `writeDailyBrief`'s return type changed from `Promise<void>` to a discriminated `DailyBriefWriteResult`, so the orchestration can distinguish "refused due to size" from "genuinely wrote."
- 2 new tests (refusal path, normal-size success path). 391/391 across the whole repo, typecheck clean.

## 2026-07-19 — PASS 5's first live run: real data confirmed correct, a real numeric-date-serial bug found and fixed in two passes

- **PASS 5 run against real production data** (83 open tasks, 14 real `Brain_Complete` rows, 44 real Attio pipeline entries via the batched fetch, real `Zoom_Staging` count): mission status, counts, and brief text all confirmed correct — including a cross-check where PASS 5's `nextTouch=Ryan Crisman` lined up with a task PASS 2.5 had independently flagged that same night.
- **One real bug, found by reading the output**: a plan item read `"Overdue since 46162 — High priority"` — a raw Excel/Sheets date serial (days since 1899-12-30) leaking verbatim into Bobby-facing text instead of a real date. `buildBucket1` had already correctly parsed the date for its own overdue-days math, but then discarded that parsed value and re-embedded the raw source string for display.
- **Fixed** in `plan.ts`: the already-parsed date is now carried through and rendered via `iso()` for both the reason text and the `dueDate` field.
- **Same bug class caught and fixed in PASS 2.5 too**, before it ever surfaced there: `clusterOpenTasks`'s `latestDueDate` used a raw lexicographic string sort, which would rank a numeric serial *after* a real ISO date purely alphabetically regardless of actual calendar order — and that value gets written directly into `Reconciliation_Queue`'s `Proposed_Completion_Date` column.
- 2 new regression tests reproducing the exact `"46162"` shape found live. 389/389 across the whole repo, typecheck clean. Not yet reverified against a fresh live PASS 5 `--live` run.

## 2026-07-19 — PASS 3's first live-data runs: digest assembly confirmed correct; a real finding about what the task-reconciliation numbers actually mean

- **PASS 3 run three times against real production data**, sharing `Run_ID` with a real PASS 2 run each time: digest assembly correct on real `Brain_Complete` rows throughout — numbered blocks, action labels, the `REPLY_NEEDED` draft, footer, pluralization all confirmed working on live data.
- **Real finding, not a bug**: PASS 2.5's own report showed `handled=4 stale=62 open=13` (79 total) after recomputing every open task fresh, but PASS 3's digest showed `4 · 22 · 11` (37 total) for that same run. The gap is PASS 2.5's "write only on material change" rule — most freshly-computed verdicts matched what was already correctly stored, so nothing got written and those rows kept whichever `Run_ID` last actually touched them. PASS 3's task-reconciliation line reports **"what's newly reconciled or changed tonight,"** not the full backlog — correct behavior for a nightly digest, but a real distinction worth understanding, now documented in `docs/pass3-notes.md`.
- No code changes this round — purely a documentation update from real-data observation.

## 2026-07-19 — PASS 2.5's first live write confirmed correct; the new diagnostic immediately found a real fix

- **The diagnostic added earlier tonight paid off on the very next run**: rerunning PASS 2.5 `--live` against the same real data surfaced `stop_reason=max_tokens, block_types=[thinking]` — the model was spending its entire 1000-token budget on internal reasoning before ever producing the JSON answer, on genuinely complex clusters (cross-referencing several distinct sub-asks against many candidates). Happened on 3 distinct clusters across the dry-run and live-run, confirming a real recurring pattern, not a fluke.
- **Fixed**: `RECONCILIATION_MAX_TOKENS` raised `1000 → 3000` — same "tune from a live result" pattern as every other token-limit fix tonight and last night.
- **The live write itself checked out**: 34 rows superseded in `Reconciliation_Queue`, matching the earlier dry-run's count exactly — real confirmation the write path is correct, not just the read/compute side.
- 387/387 across the whole repo (no test asserted the old numeric constant), typecheck clean. Not yet reverified whether 3000 tokens is enough.

## 2026-07-19 — PASS 2.5's first live dry-run: strong reasoning quality confirmed; a real diagnostic gap found and fixed

- **First live dry-run of PASS 2.5**, sharing `Run_ID` with a real PASS 2 run: 83 real open tasks, 79 clusters, 695 real Activity_Log rows. Reasoning quality genuinely strong, not just structurally valid — the model consistently and correctly distinguished `"Closed from queue"` administrative dismissals from actual proof of completion (a pattern that recurred dozens of times), and correctly downgraded a real evidence match to `medium` confidence rather than `high` when the evidence was topically close but didn't confirm the exact thing the task asked for.
- **SUPERSEDE-IN-PLACE confirmed against genuine historical data**: 34 rows updated in place against real leftover `Reconciliation_Queue` rows from the old agentic system.
- **One real failure, caught cleanly by fail-soft** (1 of 79 clusters) but with no diagnostic detail to actually debug from: `"Anthropic response had no text content — unexpected shape"`.
- **Fixed in `src/lib/anthropic.ts`** (shared by PASS 2 and PASS 2.5): the error now includes `stop_reason` and the actual block types present, and correctly distinguishes a genuinely missing `content` array from one that's present but empty. New `tests/anthropic.test.ts` (3 tests) — the client itself was previously only exercised indirectly through PASS 2/2.5's integration suites.
- **Also**: PASS 2.5's CLI gained a `--run-id` override so it can share a `Run_ID` with a specific prior PASS 2 run, letting PASS 3's task-reconciliation line correlate correctly — without this, PASS 2.5 always generated its own unrelated `Run_ID`.
- 387/387 across the whole repo, typecheck clean.

## 2026-07-19 — PASS 5 (Game Plan Generation) built — the full Late Edition rebuild is now complete

This is the last of the eight passes. Every pass in the original agentic `BHC_Late_Edition.md` spec now has a real, tested TypeScript implementation: PASS 0, 1, 2, 2.5, 3, 4, 4.5, 5.

- **New pass, `src/passes/pass5/`.** Like PASS 3, `--run-id` is required.
- **A real reuse win**: rather than re-deriving cadence math, PASS 5 calls PASS 4's `evaluateContact` directly (exported — a purely additive change, PASS 4's full suite reran clean afterward) on a fresh read-only Attio fetch. PASS 5's cadence numbers are *literally the same code path* as PASS 4's, not a second implementation that could drift.
- **Mission status needed data `CadenceRow` doesn't carry**: a contact can hold an active stage in more than one track simultaneously, but `CadenceRow` only resolves the single *winning* track for cadence purposes. `mission-status.ts` derives lightweight per-track stage membership directly from each Attio entry, while still reusing the shared `CadenceRow`'s `stalled`/`nextCheckIn` once membership is established.
- **A real spec ambiguity in the plan-building logic (5d), resolved and documented rather than silently picked**: two different sort rules are given for the same buckets — each bucket's own stated sort, and a separate generic 3-key "Ranking" paragraph that appears to contradict it. Resolved as bucket-specific sort governs slot-filling; the generic rule's unambiguous work (dedup, trim to 10, priority numbering) governs the final cross-bucket merge.
- **Two count comparisons kept intentionally different**: `tasksOverdue` uses strictly-before-today, `pipelineTouches` uses on-or-before-today — transcribed exactly as the spec's own pseudocode has them.
- 36 new tests (mission status, counts, all four plan buckets plus dedup/trim/priority assembly, brief text including the exact all-clear string, `Daily_Brief`'s exact one-row-two-column write shape, and a full orchestration suite against fake Sheets+Attio together). 384/384 across the whole repo, typecheck clean. `npm run pass5 -- --run-id <id> --dry-run`/`--live` exist. **Not yet run against production.**

## 2026-07-19 — PASS 3 (Slack digest) built

- **New pass, `src/passes/pass3/`.** Unlike every other pass, `--run-id` is required — PASS 3 re-reads and digests a *specific prior* run's `Brain_Complete` output, it doesn't generate its own run.
- **The task-reconciliation line stays standalone-capable**: instead of requiring in-process chaining with PASS 2.5, it independently re-derives the H/S/O counts by reading `Reconciliation_Queue` filtered by `Run_ID`.
- **A real, honestly-documented gap**: drift alerts genuinely can't be recovered standalone — PASS 2's drift detection only ever lived in that run's in-memory report, never persisted anywhere. `Pass3Options` accepts optional `driftNotes` for future in-process chaining; standalone runs emit an explicit warning explaining the gap rather than silently omitting the signal.
- **The empty-body HARD GATE is three distinct outcomes**, not "did it work": `valid` (normal digest), `all_clear` (zero actionable — a legitimate quiet night, not a failure), `failure` (body somehow ends up empty despite staged rows — never posts a stub, posts a failure alert instead).
- **Spec 3e's "verify the send carried a body"** doesn't map cleanly onto a Slack incoming webhook (no rich response body to inspect); implemented the real intent instead — never silently swallow a failed post, retry via the existing HTTP layer, then post a distinct failure alert if it still doesn't go through.
- 19 new tests (digest assembly across all three outcome kinds, the two Run_ID-filtered readers, and a full orchestration suite with a mock Slack poster covering normal/dry-run/all-clear/failure-retry/cross-run-isolation/fail-soft). 342/342 across the whole repo, typecheck clean. `npm run pass3 -- --run-id <id> --dry-run`/`--live` exist. **Not yet run against production.**

## 2026-07-19 — PASS 2.5 (Task Reconciliation) built

- **New pass, `src/passes/pass2_5/`.** Live reconnaissance confirmed `Tasks_Open` matches the spec exactly (memory's "Tasks_Log" was stale) and reused `Reconciliation_Queue`'s already-verified schema from PASS 0.
- **The LLM call is scoped narrower than the spec's literal three verdicts.** Only `LIKELY_HANDLED_EVIDENCE` genuinely needs judgment — `LIKELY_STALE_NO_EVIDENCE` vs. `GENUINELY_OPEN` is pure date math (`Due_Date` vs. today, `>7 days`) once "no evidence" is known, so that split happens in plain TypeScript, not asked of the model.
- **A real safety property**: the model's claimed `evidence_activity_id` is verified against the actual candidate list it was given — a hallucinated or out-of-list ID fails the whole cluster's reconciliation rather than silently accepting fabricated evidence.
- **Conservative clustering**: only merges same-contact tasks with identical-after-normalization descriptions, per the spec's own "when in doubt, keep SEPARATE."
- **SUPERSEDE-IN-PLACE** implemented literally: an existing awaiting row gets updated at its own row (same `Recon_ID`), never duplicated; nothing writes at all when the new verdict isn't materially different from what's already there.
- Zero candidates → zero LLM calls, same "don't spend an API call on a knowable answer" pattern as PASS 2's `noise:internal` filter.
- 40 new tests (clustering, candidate-filter gates, schema safety including the hallucination-rejection test, SUPERSEDE-IN-PLACE logic, and a full orchestration suite against fake Sheets+Anthropic together). 323/323 across the whole repo, typecheck clean. `npm run pass2_5:dry`/`:live` exist. **Not yet run against production.**

## 2026-07-18 — PASS 2: first live writes verified correct; cold-outreach classification gap found and fixed

- **First-ever live write** (`--limit 3`): 3/3 written, 0 failures. Verified correctness by reading the actual Brain_Complete rows back directly (not just trusting the report) — confirmed the noise-filtered row, the unresolved-primary row, and a fully-resolved row (Joleen Hughes, real `BHC_ID` `BHC-02450`, real Attio `record_id`) all landed exactly as designed, including a correctly-computed `Reply_Recipients_JSON`/`Reply_Mode`.
- **Full working set, no limit** (`--live`, 14 threads): 14/14 written, 0 enrichment failures, 0 drift. The `noise:internal` filter caught a second independent real case ("PTO"). A phishing/scam email was correctly classified `NO_ACTION` by the model's own judgment.
- **One real prompt-quality gap found reviewing this batch**: cold-outreach pitches and automated notices that slipped past deterministic triage got inconsistent LLM classifications — some correctly `NO_ACTION`, structurally identical others `FYI_ONLY`, meaning sales pitches would show up in the morning digest. Root cause: the prompt's own framing (*"treat it as a genuine relationship thread worth enriching"*) actively discouraged the model from ever choosing `NO_ACTION`, even for the ambiguous remainder triage was designed to defer to it.
- **Fixed**: rewrote the triage framing to correctly describe it as imperfect-by-design, and added explicit `COLD OUTREACH AND AUTOMATED NOTICES` guidance with a concrete decision test. 5 new tests. 283/283 across the whole repo, typecheck clean. **Not yet reverified against a live run** — the next live run is the real check for a prompt change.

## 2026-07-18 — PASS 2: first content-quality review finds and fixes a real wasted-LLM-call gap

- **First real read of actual PASS 2 output** (the `--limit 5` run, now with content previews). Genuinely good signal: the one `REPLY_NEEDED` draft (a referral thank-you to Joleen Hughes) reads authentically in Bobby's voice — casual, one clean thought, correct sign-off. The LLM correctly caught a Stripe payment-failure notification as `NO_ACTION` even though triage's heuristics missed it — exactly the safety-net split the design intended. An "unresolved primary" on a real law-firm exchange is correct behavior (honest "no CRM record" surfacing), not a bug.
- **One real gap: fully-internal threads were burning LLM calls for nothing.** A Bobby↔Sevrin Daniels thread (both `@thenewblank.com`) has zero external participants — there was never going to be a contact to enrich. Nothing caught this before spending a full API call.
- **Fixed: new `isFullyInternal` check** (`participants.ts`), computed immediately after parsing — before triage, before resolution, before the LLM call. Reuses `identifyPrimaryAndSecondary`'s own output rather than a separate scan. New `noise:internal` tag. Filter order is now test-guard → fully-internal → triage → LLM, each cheaper than the next.
- 4 new tests, including one asserting Anthropic is never called for this exact real-world shape. 280/280 across the whole repo, typecheck clean.

## 2026-07-18 — PASS 2: add content previews to the report

- The `--limit 5` follow-up run came back **5/5 written, 0 enrichment failures** — real confirmation the 4000-token fix from the previous run worked (was 1/3 failing at 2000).
- **Real gap noticed reviewing that result: the report only showed counts.** No way to see what PASS 2 actually produced — the drafted responses, summaries, whether the outbound-ceiling guard fired — without going `--live` and digging through Brain_Complete by hand, which isn't a real review step.
- **Fixed: `Pass2Report` now carries a `previews` array**, one entry per processed thread (contact name, subject, action classification, outcome, running summary, key commitments, the response draft when REPLY_NEEDED, whether personal context was found, and any drift notes). Noise-filtered threads get a lighter preview (just the tag, no LLM content, since none was generated). `report.ts` renders these directly in the CLI output.
- 3 new tests locking in the preview content for an actionable thread, the REPLY_NEEDED-only response_draft rule, and the noise-path preview shape. 276/276 across the whole repo, typecheck clean.

## 2026-07-18 — PASS 2's first live dry-run: token limit too tight, fixed; diagnostic gap fixed

- **First real run against production** (`--limit 3`, real Thread_Staging working set): confirmed the previously-unverified Contacts column resolution (`Personal_Notes`/`Topics_of_Interest`/`Conversation_Trigger`) is correct, and the email map/working-set logic both work against real data (36 emails from 2,855 Contacts rows, 17 real threads found).
- **2 of 3 threads succeeded fully** — real end-to-end proof: resolved, enriched via the real LLM call, wrote a complete Brain_Complete row with a valid `Write_Targets_JSON`.
- **1 of 3 hit `"Unterminated string in JSON"`** — a real `max_tokens` truncation. Fail-soft caught it cleanly (left unprocessed for retry, nothing corrupted), but the failure message didn't show what the model actually returned, making the truncation theory hard to confirm.
- **`ENRICHMENT_MAX_TOKENS` raised `2000 -> 4000`**, from real evidence — same pattern as PASS 4.5's batch-size tuning earlier tonight (tune from a live result, not a guess).
- **`EnrichmentOutcome`'s failure case now carries `rawPreview`** (last 300 chars of the actual response + total length), surfaced directly in the orchestration's warning line. A future failure is diagnosable from the report alone. 2 new tests, including one reproducing this exact truncation shape.
- 273/273 across the whole repo, typecheck clean. **Not yet re-verified whether 4000 tokens is enough** — needs another live run.

## Also on 2026-07-18 — Rename ANTHROPIC_API_KEY -> ANTHROPIC_BHC_ROUTINES_API

Bobby generated a new, deliberately uniquely-named Anthropic key and set it in GitHub, Vercel, and both `.env` files (the two existing console keys didn't match what was saved anywhere). Renamed consistently through the whole call path — `env.ts`'s schema and `loadEnv` mapping, `run-pass2.ts`'s usage and error message, `.env.example` — not just at the loading boundary.

## 2026-07-18 — PASS 2 fully built: orchestration wires everything together

- **New: `src/passes/pass2/index.ts`, `report.ts`, and `src/cli/run-pass2.ts`** — the full orchestration and CLI. Per-thread flow: parse → test-guard → triage → [real thread: resolve participants, drift-check, enrich via the real LLM call] → build `Write_Targets_JSON` → build the Brain_Complete row (A–AD) → append → mark Thread_Staging PROCESSED.
- **New: `thread-staging-row.ts`, `brain-complete-row.ts`, `reply-recipients.ts`, `slack-block.ts`, `contact-context.ts`** — the remaining glue: the full A–W Thread_Staging parser (for the A–U Brain_Complete mirror), the 30-column row assembly, `Reply_Recipients_JSON`/`Reply_Mode` computed deterministically from already-resolved participants, the per-thread Slack block (2g2), and the contact-context lookup for response drafting.
- **Fail-soft is per-thread, not just per-pass**: an enrichment failure leaves that one thread unprocessed (not marked PROCESSED) so it's naturally retried next run, rather than aborting the whole pass or writing bad content.
- **A real gap caught by trying to wire things together**: the enrichment schema was missing `outcome` (Google's CG column) entirely — added to `enrich-schema.ts` and the prompt, importing `OUTCOME_VALUES` from `write-targets.ts` as the single source of truth rather than defining it twice. Exactly the kind of gap isolated unit tests don't surface but an integration attempt does.
- **`contacts-email-map.ts` extended** to cover all three of its purposes (email→BHC_ID, the drift check's Google-side index, and Personal_Notes/Topics_of_Interest/Conversation_Trigger) from one shared wide read, per the spec's own explicit "zero extra Sheets calls" efficiency note.
- 37 new tests (pure-logic pieces plus a full end-to-end orchestration suite against all three fake backends together — noise paths skip the LLM, a real thread produces a complete valid row, dry-run calls Anthropic but writes nothing, an enrichment failure leaves the thread unprocessed, drift withholds only the drifted CRM side, `--limit` works, never throws on systemic failure). 271/271 across the whole repo, typecheck clean.
- **PASS 2 is now fully built** — deterministic logic, the real enrichment call, and the orchestration wiring it all together. Not yet run against production. Unlike every other pass, `npm run pass2:dry` still calls the real Anthropic API (real cost, zero Sheets risk) since that's the only way to see real enrichment output.

## 2026-07-18 — PASS 2's enrichment call built (LLM half, partial)

- **New: `src/lib/anthropic.ts`** — a hand-rolled Anthropic Messages API client, same style as `AttioClient`/`SheetsClient` (not the SDK). One consumer so far: PASS 2's enrichment call.
- **New: `src/passes/pass2/{enrich,enrich-schema,prompt}.ts`** — the actual enrichment call (spec step "e"/"e2"), one narrow single-purpose call per thread with a fixed JSON schema. Three real safety properties, not just prompting:
  - `zod` schema rejects `key_commitments` as anything other than a string — the actual enforcement mechanism for the spec's explicit "never a participant-keyed object, crashes the Aida UI with React error #31" warning, not hopeful prompting. Test asserts this exact failure shape gets rejected.
  - A deterministic guard downgrades `REPLY_NEEDED` to `FYI_ONLY` on an Outbound thread — the spec's own named "most common misfire" ("REPLY_NEEDED on Direction=Outbound is almost always wrong"), actively corrected rather than just prompted against, with a visible warning every time it fires.
  - The HARD DATA GUARDRAIL is applied to every free-text output field, defense in depth against the model echoing sensitive content it saw in the raw thread.
- **`ENRICHMENT_MODEL`/`ENRICHMENT_MAX_TOKENS`** added to `constants.ts` — flagged explicitly as a reasonable default, not a confirmed cost/quality decision.
- 29 new tests (schema validation including the critical safety-rejection test, prompt-builder pure-string tests, and integration tests against a new fake Anthropic backend covering the outbound-ceiling guard, guardrail redaction, and failure handling). 243/243 across the whole repo, typecheck clean.
- **Still no PASS 2 orchestration/CLI** — every building block now exists (parsing, resolution, drift, triage, guardrail, the real enrichment call, Write_Targets assembly) but nothing wires them into a runnable pass, writes the actual Brain_Complete row, builds the Slack block, or marks Thread_Staging PROCESSED. That's real, substantial glue work — the natural next session.

## 2026-07-18 — PASS 2 deterministic half: building blocks built, orchestration deliberately deferred

- **New pass, `src/passes/pass2/`:** email parsing/dedup, primary/secondary participant identification, the full Contacts→Attio→Master_ID resolution cascade (never fabricates a BHC_ID), the drift check, NO_ACTION triage heuristics, the HARD DATA GUARDRAIL, and the complete `Write_Targets_JSON` assembly.
- **Two real findings from live data**, not guesses: `cc_list` is a Python-dict-repr string, not JSON or a clean array; `recipient_email` is often blank on inbound messages, which matters for the outbound "principal recipient" resolution. Both discovered from a live Thread_Staging read while checking PASS 0/1's dry-run numbers earlier tonight.
- **`AttioClient` gains `searchPeopleByEmail`** — the resolution cascade's Attio-by-email step. Filter syntax follows the spec's stated shape; explicitly flagged as unverified against live Attio (unlike the per-record GET shapes, which are proven).
- **Deliberately did NOT build a PASS 2 orchestration/CLI.** The actual enrichment content (summaries, action classification, response drafts, personal-context extraction) needs an LLM call per spec step "e" — none of that exists yet. Wiring an orchestration without it would only meaningfully exercise the small slice of threads resolving straight to NO_ACTION. Matches the migration order's own split ("2 (deterministic half) → 2's LLM calls") — two genuinely different kinds of engineering work.
- 62 new tests, all pure-logic or against the fake Attio/Sheets backend. 214/214 across the whole repo, typecheck clean.
- Full writeup, including the two flagged-not-guessed unknowns, in `docs/pass2-notes.md`.

## 2026-07-18 — PASS 0 (Reply-placeholder reconciliation) built

- **Resolved the spec contradiction** flagged earlier tonight (PASS 0's procedural text vs. the Non-negotiables' "PASS 4 is the only exception") with Bobby, using the project's own §4.10: exact matches auto-finalize (unambiguous fact), inferred matches always propose (never silently executed). Built exactly that hybrid.
- **New pass, `src/passes/pass0/`:** EXACT Thread_ID match writes Activity_Log directly + marks the matched Thread_Staging row PROCESSED. INFERRED (contact+72h window) match stages a `Reconciliation_Queue` row instead. AMBIGUOUS (>1 candidate) tags the candidates' `Brain_Notes` only, leaves them flowing through PASS 2 normally. NO_MATCH writes nothing; staleness (>7d) tracked in the report only (no write target spec'd — flagged as open).
- **Verified `Reconciliation_Queue` reuse against real Aida code**, not assumed: Bobby pasted both `app/api/brain/reconciliation-queue/route.ts` (reader — generic `itemType` passthrough, confirmed safe) and `commit/route.ts`'s `handleReconAction` (writer — Deny/Pass work generically today; Accept requires non-empty `sourceTaskIds` and will 400 on a placeholder-reconciliation row until a follow-up change ships in `bhc-aida`, out of scope for this repo).
- **Two things flagged rather than guessed past:** Thread_Staging's date-column format isn't live-verified the way Activity_Log's was (degrades to NO_MATCH rather than mismatching if wrong); the exact-match's Activity_Log body write is intentionally a placeholder, not real email content, since Raw_Emails_JSON's shape for a body/content key was never confirmed.
- 25 new tests (18 pure-logic, 7 integration). 152/152 across the whole repo, typecheck clean.
- `docs/pass1-and-pass0-notes.md` renamed to `docs/pass0-and-pass1-notes.md` (pass run-order, not build order) and rewritten to reflect PASS 0 built.
- **Not yet run against production** — same next step as every pass before it.

## 2026-07-18 — PASS 1 (Housekeeping) built; PASS 0 blocked on two real open questions

- **New pass, `src/passes/pass1/`:** Brain_Complete resolved-row deletion + survivor compaction, Thread_Staging working-set computation. Fully spec'd, no open questions — unlike PASS 0. Same fail-soft posture as PASS 4.5 (inferred, not spec-mandated, but consistent). 16 tests (8 pure-logic, 8 integration), all passing. `npm run pass1:dry`/`:live` exist. Not yet run against production.
- **PASS 0 — not built.** Found a real contradiction in the spec while scoping it: the document's own Non-negotiables say PASS 4 is "the only exception" to "never write to live CRMs... Part D writes on resolve," but PASS 0's procedural steps describe writing directly to Activity_Log with no Part D gate. Also: Activity_Log's exact column layout is never spelled out the way Thread_Staging's/Brain_Complete's are — PASS 0's "col J"/"col N"/"col P" references assume a layout that isn't actually given anywhere in the spec.
- **New read-only reconnaissance tool:** `npm run inspect:activity-log` — same spirit as `--dump-shapes`, two Sheets reads (header + 3 sample rows), zero writes. Built so the next PASS 0 conversation has real column data instead of guessing.
- Both open questions documented in `docs/pass1-and-pass0-notes.md` with the real spec quotes and two concrete options for the write-authority question — needs Bobby's call before any PASS 0 matching logic gets written.
- 127/127 tests pass, typecheck clean.

## 2026-07-18 — PASS 4.5 verified end-to-end against production; goes live

- **`npm run pass4_5:live`:** real full rewrite of `Pipeline_Cache` (2,216 rows) plus the 4.5h name-conflict check. Matched the dry run's predicted numbers exactly — `written=2216 mismatch=0 unresolved=0 enqueued=0` — nothing surprised us going from dry to live. Runtime ~2m33s including the actual write, in line with the tuned dry runs.
- **PASS 4.5 is now fully verified end-to-end against production.** `docs/pass4_5-notes.md` — every item resolved.
- 111/111 tests pass, typecheck clean.
- Next per the migration order: PASS 1+0.

## 2026-07-18 — PASS 4.5: settle fetch pacing at batch=40/pause=1000ms from real tuning data

- Two more dry runs against production: batch=25/pause=1000ms (~3m23s) and batch=40/pause=1000ms (~2m15s), both zero failures/retries across all 2,216 records — same as the original batch=10 default (~11m19s), just faster. No sign of Attio's rate limiter pushing back even at 40 concurrent.
- Settled on 40/1000ms as PASS 4.5's own default (new `PASS4_5_FETCH_BATCH_SIZE`/`PASS4_5_FETCH_PAUSE_MS` constants, no longer reusing PASS 4's ~44-record-tuned values). ~5x faster than the original default. Still overridable via `--batch-size`/`--pause-ms`.
- `docs/pass4_5-notes.md` #1 updated with the full 3-way comparison table.
- 111/111 tests pass, typecheck clean.

## 2026-07-18 — PASS 4.5 (Pipeline Cache) built and tested

- **New pass, `src/passes/pass4_5/`:** full nightly rewrite of the derived `Pipeline_Cache` tab (~2,213 records) plus ATTIO-only name-drift enqueue to `Name_Conflicts`. Mirrors PASS 4's shape — pure logic separated from I/O, dry-run default, mandatory identity gate, fail-soft (never blocks PASS 5 on an internal exception).
- **`SheetsClient` gains `update`/`append`** (`src/lib/sheets.ts`) — PASS 4.5 is the first pass that writes to Google Sheets. Body shape confirmed against the spec's own `sheets()` helper convention (`action: read|update|append`).
- **New Attio extractors/helpers** (`src/lib/attio.ts`): `emailOf` (the `email_addresses` array attribute — takes the primary/first entry), and `fetchPersonRecordsBatched`, a reusable batched-by-ID fetch extracted from PASS 4's inline pattern so PASS 4.5 doesn't reimplement it at ~50x the record count.
- **New `loadContactsWide`** (`src/passes/pass4_5/contacts.ts`): resolves Relationship_Tier, Primary_Email, and Effective_Segment by header title in one wide Contacts read, keyed by Google_Row (never by inferring a row from a BHC_ID, per the Hard Contracts).
- **A real bug caught before going live:** an early version only wrote/blanked the cache when the run had at least one eligible row, so a run where every target got withheld would leave a stale prior cache untouched instead of clearing it. Fixed — blanking now runs independent of whether the main block wrote anything. Regression test added.
- **38 new tests** (20 integration against a fake Sheets+Attio backend, 18 pure-logic) — 111/111 total pass, typecheck clean.
- Open items and deviations documented in `docs/pass4_5-notes.md` (batch-size timing at real scale, the tab-guard's error-handling scope, and two spots where this runs standalone rather than literally chained after PASS 4 in-memory — no combined entrypoint exists yet).
- **Not yet run against production.** Same posture PASS 4 was in before its own `--dump-shapes` verification — that's the next step: a real dry run against live Attio/Sheets data, review the report, then `--live`.

## 2026-07-18 — PASS 4 verified end-to-end against production; goes live

- **`npm run pass4 -- --dump-shapes` (second run):** confirmed the two remaining read-side assumptions — pipeline entry shape (`parent_record_id`/`entry_values`) and select-value reads (`entry_values.<slug>[0].option.title`) both match the live Attio workspace exactly.
- **`npm run pass4:live -- --limit 1` (canary):** real cadence write to Suzie Schofield (BHC-00103) — `written=1 failed=0 read_back_mismatch=0`. Confirms Attio accepts a select written by title string and the PATCH body shape is correct. **PASS 4 is now fully verified end-to-end against production; `docs/pass4-notes.md` items 1–5 are all resolved.**
- **Fixed a real bug found by that same canary run:** the cadence write and Slack post both succeeded, but the process then crashed — `requestJson` unconditionally `JSON.parse`s its response body, and Slack's incoming webhook returns the literal text `"ok"` on success, not JSON. A fully successful run would have exited non-zero. New `requestText` helper in `src/lib/http.ts`; `slack.ts` now uses it. `requestJson` untouched (still correct for Attio/Sheets, which do return JSON). Regression test added: `tests/http.test.ts`.
- Also landed this session (Claude Code, chat-assisted): `RUN_TIMEZONE` default → `UTC`; unknown-tier touch mode confirmed Social; Stage 6+ is now a `STAGE_OUT_OF_RANGE` withhold (data-integrity flag) instead of a silent tier-cadence fallback, since there's no mechanism for a track to advance past Stage 5; GHA workflow's hardcoded `RUN_TIMEZONE: America/Los_Angeles` fixed to match the UTC default (would have silently overridden the decision on first live run); `last_interaction_at` → `last_interaction` fix (the dangerous slug bug — every contact was reading "last touch unknown"); Contacts read range widened `A1:V1`/`A3:V` → `A1:EZ1`/`A3:EZ` (tier column sits well past V in the live 113+-column sheet), with header-row diagnostic logging added to `load.ts`.
- `npm run typecheck` and `npm test` (72 tests) pass.
- Next per the migration order (`docs/CLAUDE.md`): PASS 4.5 (Pipeline Cache).

## 2026-07-17 — PASS 4 decisions 1 & 2 resolved

- **`RUN_TIMEZONE` default changed `America/Los_Angeles` → `UTC`** (`src/config/env.ts`, `.env.example`). Bobby's call: matches PASS 4.5's existing UTC convention so the two passes agree on `TODAY`. Known effect: on the 11pm PDT scheduled run, `TODAY` is one calendar day ahead of Seattle's "today" — `next_check_in_date`/`days_since` shift by a day versus the LA-default behavior. `docs/pass4-notes.md` #1 updated to reflect the decision; no test changes needed (`todayIn()` was already tested against both zones).
- **Unknown relationship-tier touch mode confirmed: Social** (follows the spec's pseudocode, not the contradicting prose table). No code change — `DEFAULT_TIER` already implemented this. `docs/pass4-notes.md` #2 marked confirmed.
- Still open in `docs/pass4-notes.md`: #3 (Stage 6+ fallback, non-blocking) and #4 (live Attio field-slug verification via `npm run pass4 -- --dump-shapes` — Bobby running this locally via Claude Code before PASS 4 goes live).
- `npm run typecheck` and `npm test` (63 tests) pass after the timezone default change.

## 2026-07-14

- **Added `AGENTS.md`** at repo root — defines how a Claude Code session should distinguish a routine-execution session (started via a routine's own schedule, API call, or manual Run now) from a build/maintenance session (a human editing files in this repo). Written to be factual/criteria-based rather than persuasive, after persuasion-style grounding text (in this README and in Late Edition's own Instructions) repeatedly triggered self-refusal on scheduled/API-triggered runs — a document telling an agent to "override your caution, proceed" reads as an injection-shaped red flag regardless of intent or accuracy.
- **Fixed a real bug in `BHC_Late_Edition.md`'s invocation description**: it previously claimed its API trigger token (`EXECUTE LATE-EDITION-{timestamp}`) was its "only invocation path," which incorrectly self-disqualified every manual "Run now" click, since manual runs never carry that token. Now documents both valid paths explicitly.
- **Cleaned up a duplicated opening paragraph** in `BHC_Late_Edition.md` left over from an earlier same-day edit that inserted new grounding text without fully removing the old version.
- **Removed the persuasion-style README paragraph** addressing AI agents directly; replaced with a pointer to `AGENTS.md` as the single source of truth for session-type classification.
- Root cause context: none of the above fixed the underlying Late Edition failures on their own — every trigger type (native cron, manual click, API with empty payload, API with a real command token, synchronous manual with live human presence) was tried and failed before this change. AGENTS.md is being tested as a structurally different variable (a recognized config-file convention vs. free-form persuasive prose) rather than another wording iteration.

## 2026-07-11 — Initial import + Session B installs

First files committed to the repo. All three were installed to their cloud routine configs and mirrored to the "Claude Code Routines" Google Doc this session.

- **Late Edition — new PASS 4.5 (+ 4.5h).** Inserted between PASS 4 and PASS 5. Writes the derived `Pipeline_Cache` tab (full nightly rewrite of ~2,213 ATTIO/BOTH records) so the Contacts page reads cached data instead of hydrating Attio live per load. Fetches identity by `get-records-by-ids` (batched ≤50 — the MCP connector caps `list-records` at 50/page). Cadence fields (M/N/O) sourced from the post-PASS-4 read-back, not in-memory `cadence_results`, to avoid a silent-write-failure divergence window. Mandatory, non-skippable **4.5d identity cross-check** (Attio `bhc_contact_id` must equal Master_ID BHC_ID or the row is withheld + logged). **4.5h** enqueues ATTIO-only name drift to `Name_Conflicts` with the strict gate + suppression. New Non-negotiable #16.
- **Reconciler — new I1 pass.** PASS 3 read widened `A3:A` → `A3:DI` (single bulk read) to also load Google identity. PASS 4 gains the **A5 split** (non-exact-but-shares-a-word name → `Name_Conflicts` enqueue instead of a silent pass) and **I1** identity-field drift (Title/Company/Email; email match = Google primary present anywhere in Attio's set) → `Reconciler_Report`. Non-negotiable #2 widened to permit `Name_Conflicts` enqueues; `I1` added to the code table.
- **Reconciler Fix — new I1 pass.** New **PASS 6.5** (no renumbering) auto-writes Google's authoritative `job_title` / `company_name` / `email_addresses` (primary-only, reorder-to-primary + keep secondaries; uniqueness-conflict → NEEDS_MANUAL) onto Attio, gated by the reused Step 1.5 name-verification check. Scope + Non-negotiable #1 widened beyond `bhc_contact_id`; new Non-negotiable added. **Name is never auto-written here** — it only ever routes through the `Name_Conflicts` review card.

Companion repo work (BHC-Aida) shipped earlier in commit `88c3840`: `Pipeline_Cache` (A:R) and `Name_Conflicts` (A:M) tabs, reader routes, commit actions, and the NameConflicts review card — build-green and a safe no-op until these routines populate the tabs.

2026-07-13 — All 8 routines migrated to this repo; Repositories field for all 8 repointed here from bhc-aida/bhc-orbit to fix self-refusal bug (routines were misreading their own scheduled runs as injected build-session instructions via bhc-aida's AGENTS.md).
