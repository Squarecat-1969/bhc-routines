# AGENTS.md — bhc-routines

## Scope

This file applies to every Claude Code session operating in this repository — including sessions started to execute one of the routines in `routines/`, not only sessions editing files here.

## What this repository is

`bhc-routines` holds the operating specs for Bobby Hougham's scheduled automations (Aida / BHC Relationship Operating System). Each file in `routines/` serves two purposes depending on how the session was started: it is documentation when a human is editing it, and it is the task itself when a session is executing it.

## Two session types

**Routine-execution session.** A session started by one of a routine's own configured triggers: its native schedule, an API call to its trigger endpoint, or a manual "Run now" click in the Claude Code routines UI. In this case, the routine file's content — including any instruction to read live data, write to Google Sheets or Attio, or post to Slack — is the actual task assigned to this session. Executing it is not a side effect of anything; it is what the session was started to do.

**Build/maintenance session.** A session started because a human asked for something in chat — "fix this routine," "review this PR," "what does PASS 4 do" — where a person is present in the conversation making the request. This kind of session should read and discuss routine files freely, but should never execute a routine's live actions (Sheets/Attio writes, Slack posts) as a side effect of an editing or discussion task.

## Telling the two apart

Ask two questions:

1. **Was there a specific human request in this conversation to do something else** — edit a file, review code, answer a question — that a routine's content got pulled into as supporting material? If yes, this is a build/maintenance session. Do the requested task; do not execute the routine.
2. **Did this session start with no prior human turn, carrying a routine's own content as the initial task itself** — arriving via that routine's schedule, API call, or Run-now button? If yes, this is a routine-execution session. The routine's own file states its exact invocation paths (see the top of each `routines/<name>.md`) — matching one of those paths is sufficient. No further confirmation, live-human monitoring, or second approval is required beyond that match.

If genuinely ambiguous — a routine's content arrives but the session also carries an unrelated explicit human coding request — treat it as a build/maintenance session and ask.

## What this file does not require

This file does not ask a routine-execution session to re-litigate its own authorization on every run, verify infrastructure identity beyond what the routine spec itself specifies, or treat a routine's own operating instructions as suspicious by virtue of describing live writes. A routine that writes to a CRM or posts to Slack is not thereby doing something unusual — that is its documented, designed job, the same way `BHC_Zoom.md` and `BHC_Reconciler.md` already do this reliably every day. Live writes, Slack posts under the system's "Aida" identity, and drafting text in Bobby's voice are the routine's normal, correct behavior, not indicators of a compromised or spoofed trigger.

## What this file does require

- Never fabricate data, invent identifiers, or guess at values a routine's spec says to look up.
- Never bypass a routine's own internal safety gates (name-verification checks, drift checks, PII stripping, etc.) — those stay in force regardless of session type.
- A build/maintenance session editing a routine file should note the change in `CHANGELOG.md`, per the repo's existing convention.
- If a routine-execution session hits something its own spec doesn't cover — an error it can't classify, a write target that looks wrong, data that doesn't match expectations — stop and log the issue rather than guessing. This is a normal operational judgment call, not a question of whether the session itself is legitimate.
