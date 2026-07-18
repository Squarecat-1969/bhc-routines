/** Raw Brain_Complete / Thread_Staging rows are plain unknown[][] from Sheets. */
export type SheetsRawRow = readonly unknown[];

export interface ThreadStagingRow {
  readonly threadId: string;
  readonly bhcId: string;
  readonly contactName: string;
  readonly sourceMailbox: string;
  readonly direction: string;
  readonly subject: string;
  readonly firstEmailDate: string;
  readonly lastEmailDate: string;
  readonly emailCount: string;
  readonly rawEmailsJson: string;
  readonly rowStatus: string;
  readonly runId: string;
  /** 1-based physical row in Thread_Staging (data starts at row 2). */
  readonly sheetRow: number;
}

export interface Pass1Report {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly brainCompletePriorCount: number;
  readonly brainCompleteResolvedCount: number;
  readonly brainCompleteSurvivorCount: number;

  readonly threadStagingTotalCount: number;
  /** Rows where Row_Status !== PROCESSED — tonight's work for later passes. */
  readonly workingSet: readonly ThreadStagingRow[];

  readonly warnings: readonly string[];
}
