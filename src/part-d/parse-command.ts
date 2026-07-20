/**
 * Part D STEP 1 — parse the command. Spec: "Command — exactly one of
 * RESOLVE, PROCEED, CORRECTIONS. Run_ID — the LATE-EDITION-<digits> token.
 * If absent: post 'Couldn't find a run id — ignoring.' and stop.
 * Corrections (CORRECTIONS only) — lines after command shaped {n}: {note}
 * → list of {n, note}. Unrecognised command → post 'Couldn't read a valid
 * command — no action taken.' and stop."
 *
 * MIXED is not in the original spec — it's the addition drafted this
 * session (see the roadmap doc's "MIXED command spec" entry) for
 * accept/correct/dismiss batches from a single Aida submission. Same
 * parsing shape as CORRECTIONS' {n}: {note} lines, extended: {n}:ACTION or
 * {n}:CORRECT:{note}, where ACTION is ACCEPT or DISMISS. A CORRECT line
 * with no note is malformed — skipped, not defaulted to an empty note,
 * since a correction with no explanation isn't a correction.
 *
 * Returns a discriminated union rather than throwing on STOP conditions
 * (no run ID, unrecognized command) — the caller (index.ts) owns exactly
 * which Slack message to post for each, matching the spec's own distinct
 * wording per case; this module's only job is figuring out what was asked.
 */

const RUN_ID_RE = /LATE-EDITION-\d+/;
const COMMANDS = ['RESOLVE', 'PROCEED', 'CORRECTIONS', 'MIXED'] as const;
type Command = (typeof COMMANDS)[number];

export interface Correction {
  readonly n: number;
  readonly note: string;
}

export type ItemAction =
  | { readonly n: number; readonly action: 'ACCEPT' }
  | { readonly n: number; readonly action: 'DISMISS' }
  | { readonly n: number; readonly action: 'CORRECT'; readonly note: string };

export type ParsedCommand =
  | { readonly kind: 'NO_RUN_ID' }
  | { readonly kind: 'UNRECOGNIZED' }
  | { readonly kind: 'PROCEED'; readonly runId: string }
  | { readonly kind: 'RESOLVE'; readonly runId: string }
  | { readonly kind: 'CORRECTIONS'; readonly runId: string; readonly corrections: readonly Correction[] }
  | { readonly kind: 'MIXED'; readonly runId: string; readonly itemActions: readonly ItemAction[]; readonly skipped: readonly string[] };

function parseCorrectionLines(lines: readonly string[]): readonly Correction[] {
  const out: Correction[] = [];
  for (const line of lines) {
    const m = /^\s*(\d+)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    const note = m[2]!.trim();
    if (!note) continue; // a correction with no note is malformed, skip it
    out.push({ n, note });
  }
  return out;
}

function parseItemActionLines(lines: readonly string[]): { itemActions: readonly ItemAction[]; skipped: readonly string[] } {
  const itemActions: ItemAction[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const acceptOrDismiss = /^(\d+)\s*:\s*(ACCEPT|DISMISS)\s*$/i.exec(trimmed);
    if (acceptOrDismiss) {
      itemActions.push({ n: Number(acceptOrDismiss[1]), action: acceptOrDismiss[2]!.toUpperCase() as 'ACCEPT' | 'DISMISS' });
      continue;
    }
    const correct = /^(\d+)\s*:\s*CORRECT\s*:\s*(.+)$/i.exec(trimmed);
    if (correct) {
      const note = correct[2]!.trim();
      if (note) {
        itemActions.push({ n: Number(correct[1]), action: 'CORRECT', note });
        continue;
      }
    }
    skipped.push(trimmed); // malformed line — a bad position, unrecognized action, or a CORRECT with no note
  }
  return { itemActions, skipped };
}

export function parseCommand(commandText: string): ParsedCommand {
  const lines = commandText.split('\n');
  const firstLine = (lines[0] ?? '').trim();

  const runIdMatch = RUN_ID_RE.exec(firstLine);
  if (!runIdMatch) return { kind: 'NO_RUN_ID' };
  const runId = runIdMatch[0];

  const commandToken = firstLine.split(/\s+/)[0]?.toUpperCase();
  const command = COMMANDS.find((c) => c === commandToken) as Command | undefined;
  if (!command) return { kind: 'UNRECOGNIZED' };

  const restLines = lines.slice(1);

  if (command === 'PROCEED') return { kind: 'PROCEED', runId };
  if (command === 'RESOLVE') return { kind: 'RESOLVE', runId };
  if (command === 'CORRECTIONS') return { kind: 'CORRECTIONS', runId, corrections: parseCorrectionLines(restLines) };

  const { itemActions, skipped } = parseItemActionLines(restLines);
  return { kind: 'MIXED', runId, itemActions, skipped };
}
