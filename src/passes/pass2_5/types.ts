export interface OpenTask {
  readonly taskId: string;
  readonly createdAt: string;
  readonly contactId: string; // BHC_ID
  readonly linkedinUrl: string;
  readonly contactName: string;
  readonly taskType: string;
  readonly description: string;
  readonly dueDate: string;
  readonly status: string;
  readonly priority: string;
  readonly owner: string;
  readonly closedAt: string;
  readonly relatedActivityId: string;
  readonly sheetRow: number;
}

/** Spec 2.5b: "Same underlying request across channels = ONE cluster... When in doubt, keep SEPARATE." */
export interface TaskCluster {
  readonly clusterKey: string;
  readonly tasks: readonly OpenTask[];
  readonly contactId: string;
  readonly contactName: string;
  readonly description: string; // representative description (the first task's)
  readonly earliestCreatedAt: string;
  readonly latestDueDate: string;
}

export interface ActivityLogCandidate {
  readonly activityId: string;
  readonly timestamp: string;
  readonly contactId: string;
  readonly contactName: string;
  readonly channel: string;
  readonly direction: string;
  readonly subject: string;
  readonly body: string;
  readonly outcome: string;
  readonly source: string;
  readonly sheetRow: number;
}

export const RECONCILIATION_VERDICTS = ['LIKELY_HANDLED_EVIDENCE', 'LIKELY_STALE_NO_EVIDENCE', 'GENUINELY_OPEN'] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface ReconciliationResult {
  readonly cluster: TaskCluster;
  readonly verdict: ReconciliationVerdict;
  readonly evidenceQuote: string;
  readonly evidenceSource: string;
  readonly proposedCompletionDate: string;
  readonly confidence: ConfidenceLevel | '';
  readonly brainReasoning: string;
}

export interface Pass25Report {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly openTaskCount: number;
  readonly clusterCount: number;
  readonly handledCount: number;
  readonly staleCount: number;
  readonly openCount: number;
  readonly enqueuedCount: number;
  readonly supersededCount: number;

  readonly results: readonly ReconciliationResult[];
  readonly warnings: readonly string[];
}
