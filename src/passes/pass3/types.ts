export interface DigestBrainCompleteRow {
  readonly threadId: string;
  readonly actionRequired: string;
  readonly slackMessage: string; // col AA — blank for NO_ACTION/noise rows
}

export interface Pass3Options {
  readonly runId: string; // the specific run being digested — required, this pass reads back a prior run's output
  readonly dryRun: boolean;
  readonly driftNotes?: readonly string[]; // optional: only available when chained directly after PASS 2 in-memory
}

export type DigestBodyResult =
  | { readonly kind: 'valid'; readonly body: string; readonly surfacedCount: number; readonly filteredCount: number }
  | { readonly kind: 'all_clear'; readonly body: string }
  | { readonly kind: 'failure'; readonly reason: string };

export interface Pass3Report {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly rowCount: number;
  readonly surfacedCount: number;
  readonly filteredCount: number;
  readonly bodyKind: DigestBodyResult['kind'] | null;
  readonly posted: boolean;
  readonly digestBody: string | null;

  readonly warnings: readonly string[];
}
