# The Shared Bridge Contract

**v1 · 25 August 2026 · KAYLEE (CTO), with corrections from Aida**

**What this is:** thirteen rules for building an HTTP surface that lets an automated caller reach a third-party API it cannot otherwise reach. Every rule was earned by a defect in production, not derived from principle.

**How to use it:** implement it. Do not import it. Each repository carries its own copy of this document and its own implementation. Two independent implementations of one contract is the point — it is what makes a later integration cheap instead of a rewrite, without creating a dependency between codebases that must stay separable.

**Status:** rules 1–9 are proven in production in the TNB Docs Bridge since 13 August 2026. Rules 10–13 were added 21–22 August after a build that found six defects, all of them in error paths. Rule 6 carries a correction contributed by Aida on 25 August that neither original implementation had right.

---

## §0 — The one-sentence version

Every rule below is a specific instance of a single failure: **a true statement that reads as a different claim than it is.** A `null` that reads as zero. A 400 that reads as a timeout. A first-tab character count that reads as a document size. An example that reads as a measurement. A warning that was accurate last week. A config file that compiles and is never imported.

None of these are lies and none of them fail loudly. They are correct artifacts in a context that makes them misleading, and no amount of testing the success path catches any of them. That is why the contract is mostly about failure.

---

## §1 — The thirteen rules

### Rule 1 — Path-secret auth, returning 404 rather than 401

The shared secret lives in the URL path, not in a header. An unauthenticated request gets **404 Not Found**, not 401 Unauthorized.

*Why:* a 401 confirms the endpoint exists. A 404 tells a scanner nothing. The endpoint is not discoverable by probing.

*Verify:* request the route with a wrong secret and confirm the response is indistinguishable from a route that does not exist.

### Rule 2 — Fail loud on missing config, with a health endpoint reporting presence, never values

Missing configuration is a startup-time or first-call hard error naming what is absent. A health endpoint reports **whether** each required variable is present. It never reports its value, or any prefix, suffix or length of it.

*Why:* silent fallback to a default is how a service runs for a week against the wrong target.

*Verify:* remove each required variable in turn and confirm the failure names it. Then confirm the health endpoint's output is safe to paste into a chat log.

*Corollary, added 25 August:* configuration must have exactly one home. A duplicate config file that no longer has importers will compile, pass review, and silently do nothing when edited. If your build resolves two files with the same name by path precedence, the shadowed one is a trap, not a backup. Delete it or make it fail to compile.

### Rule 3 — Never a bare success or a bare failure, and a hard error names the valid options

No response is ever just `ok: true`. No error is ever just "failed". An error caused by an unrecognised identifier — an alias, a key, a name — enumerates the valid ones in its message.

*Why:* a caller that cannot see the valid options guesses, and a guessed identifier that happens to resolve is worse than an error.

*Verify:* pass a deliberately wrong identifier to every tool and confirm the error names the alternatives.

### Rule 4 — An explicit timeout, comfortably under the platform ceiling

Set your own upstream timeout well below whatever the hosting platform kills the function at. The handler must always win the race and return a structured envelope rather than being killed mid-flight.

*Why:* a killed function returns nothing. No envelope, no error code, no indication of whether a write landed. That is the worst possible outcome and it is the one this rule exists to prevent.

*Verify:* force an upstream hang and confirm you get your error rather than the platform's.

*Do not raise the ceiling to accommodate a slow input.* If an operation cannot fit, the correct answer is a truthful refusal that explains why and states whether retrying helps. See §3 on why this came up and what it cost to establish.

### Rule 5 — Output schemas stay loose

Never `additionalProperties: false` on a response schema.

*Why:* a strict output schema means every new field is a breaking change, and the first thing you will want to add is diagnostic information to an error. Strictness on outputs buys nothing and costs the ability to improve an envelope without a coordinated release.

Input schemas are the opposite: validate them strictly, and see the hazard in §2.5.

### Rule 6 — Verification is structural wherever anything is written

Every write reads the target back and returns proof. The minimum envelope:

```
charsBefore, charsAfter, delta, expectedDelta, deltaVariance, verified
```

The caller treats the write as done only when `verified` is true **and** `deltaVariance` is 0. A positive but too-small delta is a truncated write, not a success.

Where the write targets a subdivision of a document — a tab, a sheet, a section — **every part of verification must follow the target**: the before and after measurements, any content anchors, and any styling or structural ranges. Measuring the whole document, or the first subdivision, produces an envelope that describes something other than what was written.

**The correction, and this is the part most likely to be got wrong.**

A verification envelope proves what **landed**. It never proves that what landed matches what the caller **intended**. Those two diverge wherever the input is transformed en route — a markdown renderer, a spreadsheet's value coercion, any normalisation between the caller's string and the stored bytes.

The failure is silent and it verifies clean, because the arithmetic over the *transformed* text is correct. A literal `NLPROBE_MARKER_LINE_000001` sent through a markdown renderer arrives as `NLPROBEMARKERLINE_000001`; the envelope reports `expectedDelta` 25, `delta` 25, variance 0, `verified: true`. Nothing is wrong except the content.

Aida's contribution, 25 August, which sharpens this and corrects a rule both implementations had wrong: **do not reason about whether a given instance is safe.** A working rule of "intraword underscores are safe in CommonMark" survived validation against five real strings and was still wrong. A single underscore does survive — `Master_ID` is fine. A **pair across a span** does not: `CHANNEL_MAP fix, Interaction_Date` lost both underscores to emphasis parsing, two characters gone, reported verified. The safe instances and the unsafe instances are indistinguishable without parsing the whole span.

**Therefore: escape unconditionally at the boundary. Never per-instance judgement.** And where the API offers a literal path alongside a rendered one, prefer the literal path for any content that is identifier-shaped.

*Verify:* write a string containing at least two identifier-shaped tokens in one span, read it back with a **literal** search rather than a rendered one, and confirm byte equality. Length checks cannot detect this.

### Rule 7 — Specs are committed to the repository, never handed over as attachments

This document lives in `docs/`. So does every spec it references.

*Why:* an attachment is not addressable, not versioned, and not there in six months. A spec that exists only in a chat history will be cited by a document that outlives it. Attachments also mangle encoding — a UTF-8 document round-tripped through an attachment arrived with 59 corrupted sequences, and the section that was hardest to read was the one arguing against reconstructing text from memory.

*Corollary:* examples inside a spec use **obviously synthetic identifiers**. Never a real file ID, never a real record key, never a plausible-but-nonexistent name. A reader cannot distinguish an illustration from a measurement when the identifier is real, and a fabricated-but-realistic name is worse than either.

### Rule 8 — No point-in-time fact written as a standing rule

A measurement is not a law. A count of things that exist today is not a constraint. A description of what current callers do is not a specification.

Every empirical fact recorded in a spec, a runbook, a tool description or an error message carries **the date it was measured and the conditions it was measured under**, or it does not go in.

*Why this is the rule that catches everyone:* it was violated four times in a two-day build convened partly to fix it. A branch state from six days prior was quoted as current and shaped two instructions. A tool count was written into a permanent log wrong. A tool description asserted behaviour that a change three hours earlier had made false. A parameter description stated "what every existing caller does" — true that day, guaranteed by nothing.

*Corollary — a paginated or truncated result is not the whole picture.* This applies to API pages, to search results, to the first tab of a document, and to any query that returns a subset by default. Whatever you measured, record its **scope** beside it. A character count with no scope is not a fact.

*Verify:* write a test that fails if any tool description or error string states what existing callers do, or names a count of things. Description-only regressions are otherwise invisible.

### Rule 9 — No cross-repository dependency in either direction

Two systems that must remain separable share **contracts**, never code, never build artifacts, never runtime calls.

This document is the shape that satisfies it. Each side implements independently. Neither imports from the other. A change to this contract is a change both sides adopt deliberately, not a change one side ships and the other inherits.

*Why:* the moment one repository imports from the other, they must be deployed, versioned and reasoned about together, and any future decision to merge or separate them becomes a rewrite rather than a decision.

### Rule 10 — One time budget per tool invocation, not per HTTP attempt

The timeout in Rule 4 belongs to **the whole operation the caller asked for**, spent down across every upstream call and every retry inside it. Not per request. Not per attempt.

*Why:* a verified write makes at least three upstream calls — a pre-read for the baseline, the write, and a read-back for verification. Three separate 20-second ceilings is a 60-second handler sitting exactly on the platform wall. And HTTP client libraries retry 5xx silently by default: a 6-second failure retried four times overran a nominal 20-second ceiling by 31%.

*Implement:* open the budget in whatever wrapper every tool passes through, so no tool can forget it. Hand each attempt only what remains.

*Verify:* simulate an upstream that fails slowly and confirm total wall time stays inside the budget across all retries.

### Rule 11 — An explicit retry policy, never the library's default

Idempotent reads may retry inside the budget. **A mutating call is never retried, whatever the status code.** Every mutation call site carries a comment stating why.

*Why:* our implementation avoided sending a spreadsheet append four times purely because POST is absent from one library version's default retry set, while an update survived four sends only because rewriting identical cells happens to be harmless. Both were accidents of the HTTP verb, not decisions. One dependency bump changes that.

*Verify:* assert request counts directly — reads send at most N, mutations send exactly one.

### Rule 12 — Exhaustion names its phase

When the budget runs out, the envelope states **where**: pre-read, write, or verification. Each carries a different meaning and a different instruction to the caller.

| Phase | `writeMayHaveLanded` | What the caller is told |
|---|---|---|
| pre-read | false | Nothing was written. Safe to retry. |
| write | true | **Do not retry.** Read the target back first. |
| verification | true | Sent and accepted; verification was not reached. **This is not a failed write. Do not send it again.** |

The verification case is the one that matters and the one most likely to be omitted. Exhaustion during read-back means the write almost certainly landed and cannot be confirmed — the opposite of a failure, and a caller who reads it as a failure writes twice.

### Rule 13 — Ambiguity defaults to true, and drops to false only on evidence

`writeMayHaveLanded` is computed from whether the outcome is **knowable**, not from which error code fired. It defaults to true. It drops to false only on evidence: the call was a read, or a pre-dispatch tag proves the failure preceded the mutation, or the status proves rejection before mutation.

- Below 500 is conclusive — validation, auth and quota all resolve ahead of the write. `writeMayHaveLanded: false`.
- 408 and 5xx are inconclusive, including 504. A gateway timeout is a response that arrived, so it is not a client-side timeout — but the request may still have been processed upstream. `true`.
- No status at all is inconclusive: a connection can drop after the server acted. `true`.

**Emit the flag on every failure path, including reads**, so its absence can never be misread as safety. A failed read must report `false` — a read cannot land.

*The asymmetry is deliberate and load-bearing:* a false "safe" costs a duplicate write, a false "unsafe" costs one extra read. Do not let a later simplification pass collapse it.

*Related, Rule 3 applied to classification:* **an error carrying an HTTP status is never a client-side timeout.** Disqualify on the status before consulting the message. We reported a Google 400 as "did not respond within 20s" after failing in 1.2 seconds, because the classifier matched the word "timeout" anywhere in the error text — and the 400 itself came from passing a `timeout` option among the API parameters instead of in the client's per-request options argument.

---

## §2 — The failure catalogue

Five things a Google Docs client will hit. All five were hit in eighteen hours by an implementation whose success paths were already rigorous.

**2.1 — Writes silently default to the first tab of a multi-tab document, and verify clean.** The delta is right, the verification passes, the content is in the wrong tab. Decide up front whether an untargeted write on a multi-tab document **warns** or **refuses**; do not leave it silent. Our destructive replace-all tool refuses; our append tool warns, because changing its default would break existing single-tab callers. Both are defensible. Silence is not.

**2.2 — Character counts describe the first tab unless you say otherwise.** Ours reported 108,504 for a 1,535,005-character document — a factor of 14 — and the wrong figure propagated into a committed spec before anyone noticed, where it made a correct hypothesis look implausible. Return an explicit `charCountScope` on every measurement.

**2.3 — Tab identifiers are opaque, per-document, and unobtainable by construction.** Provide a tool that lists them and say in its description that IDs must never be constructed. A tab-targeting parameter that a caller cannot populate is not a feature; it is a parameter that will be omitted, which returns you to 2.1.

**2.4 — There is no per-tab read in the Docs API.** Tab structure is only obtainable by fetching the entire document with tab content. Field masks trim the response *after* the content is materialised, so they do not reduce the cost — five masks were measured and none helped. Above a certain document size the whole tab dimension becomes unreachable, not merely slow. See §3.

**2.5 — An unknown optional parameter is silently discarded.** Most validators strip unrecognised keys rather than rejecting them. A misspelled `tab_id` where `tabId` was meant vanishes, the parameter reads as absent, and the write defaults — silently, and back to 2.1. Required parameters fail loudly because their absence is caught; optional ones do not. **Consider rejecting unknown input keys outright**, which is the one place strictness pays. This is the mirror image of Rule 5: loose on the way out, strict on the way in.

---

## §3 — Measurements, not laws

Recorded under Rule 8: these are dated observations of one implementation against one API on one platform. They are the correct shape of the reasoning, not portable numbers. **Re-measure before relying on any of them.**

Measured by Aida, 25 August 2026, against Google Docs via a 20,000ms fixed budget:

| Document size (chars) | Outcome |
|---|---|
| 231,633 | Verified write to a third tab — passes |
| 553,058 | Fails by 516ms (pre-read 8,416; needed 12,100; remaining 11,584) |
| 816,000 | Fails by 18,558ms |

Derived, same conditions: a verified write costs roughly **1.4× its pre-read**, and pre-read time scales at approximately **chars^1.94** — very nearly quadratic. Break-even near **544,000 characters**.

**What generalises is the shape, not the numbers.** Cost is superlinear in document size, so a document that works comfortably today fails abruptly rather than gradually, and the margin disappears faster than the content grows. The operational rule Aida derived — begin an entry only under 400,000 characters, never let one pass 500,000 — is the right *kind* of rule: a working threshold set well inside a measured cliff, not at it.

**The ruling that produced all of this, and it is the reusable part.** When a document needed 48.5 seconds against a 20-second budget and a 60-second platform wall, the available moves were: raise the ceiling toward the wall, or refuse honestly. We refused. Raising it would have traded a truthful failure for a silent one — losing the race against the platform returns no envelope at all — on a few seconds of margin, against an input that only grows. **The fix for a document too large to work with is a smaller document, not a longer timeout.**

---

## §4 — Notes for an append-and-update-in-place job

Written for the keyword-index maintenance case: a routine that reads several source documents and maintains a derived index which contains content that exists nowhere else.

**Never regenerate. The index is not a projection of its sources.** Where a derived document holds a controlled vocabulary whose source spec has been retired, a section recorded nowhere else, and deliberate records of things that were searched for and *not* found, a regeneration pass rebuilds the cheap half and destroys the expensive half. Negative findings are the most expensive content in any index and the most likely to be silently discarded by a rebuild, because nothing in the sources reproduces them.

**Make this structural, not a rule in a comment.** The routine should have no code path capable of wholesale replacement. If a full rewrite is impossible to express, it cannot happen by accident at 3am.

**Idempotency:** the job runs on a schedule and may run twice. An update-in-place must be safe to repeat. Anchor updates on stable content and verify the anchors before writing, per Rule 6 — an anchor check that rejects a stale range is the cheapest protection available and the only thing that catches a range computed against a document that has since moved.

**Ordering:** read every source and compute the complete set of changes before writing anything. A job that interleaves reads and writes across several documents has no coherent state to resume from when the budget exhausts mid-run.

**On partial completion:** if the budget runs out after some entries are written, say so explicitly in the run's output — which entries landed, which did not. A run that reports success having completed 60% is Rule 3 and Rule 8 failing together.

---

## §5 — What this contract does not cover

Not addressed here, deliberately: authentication topology beyond Rule 1, rate limiting, caching, concurrency and write conflicts, and schema migration of the target documents.

**One credential note, since it cost real time to establish.** A service account is its own identity with its own empty Drive. Scope is necessary and not sufficient — every target document must additionally be shared with the account's address. And a service account does not "carry" scopes the way an OAuth client does: **scopes are requested at token-mint time, in source.** Where a codebase mints its own JWT rather than using a client library, the granted scope is a space-delimited string in a singular `scope` claim, and a search for the library's plural option name will not find it. Fifteen inline constructions of the same credential were found where four were expected.

**Two problems that follow from that and belong on someone's list:** a credential minted in fifteen places has fifteen homes for a scope change, and a shared service account that predates the surface using it grants its scopes to everything else authenticating as it — which nobody has inventoried.

---

*Shared Bridge Contract v1 · 25 August 2026 · implement independently, never import*
