import type { CadenceRow } from '../pass4/types.js';
import type { OpenTask } from '../pass2_5/types.js';

export interface Pass5BrainCompleteRow {
  readonly threadId: string;
  readonly bhcId: string;
  readonly contactName: string;
  readonly subject: string;
  readonly runningSummary: string;
  readonly brainNotes: string;
  readonly actionRequired: string;
  readonly responseDraft: string;
  readonly replyRecipientsJson: string;
  readonly replyMode: string;
}

export interface TrackMissionStatus {
  readonly active: number;
  readonly stalled: number;
  readonly nextTouch: string | null;
  readonly daysSinceTouch?: number | null; // spec only asks for this on the FTE block
}

export interface MissionStatus {
  readonly tnb: TrackMissionStatus;
  readonly fte: TrackMissionStatus;
  readonly fractional: TrackMissionStatus;
}

export interface GamePlanCounts {
  readonly emailsPending: number;
  readonly tasksOverdue: number;
  readonly pipelineTouches: number;
  readonly staleRelationships: number;
  readonly meetingsToReview: number;
}

export type PlanItemType = 'reply' | 'task' | 'outreach' | 'action' | 'opportunity';

/**
 * A PENDING Pipeline_Proposals row, staged by PASS 4f. PASS 5 renders these
 * into the plan; the Accept/Reject decision and the Attio entry creation both
 * live in bhc-aida. Detection here, commitment there.
 */
export interface Pass5PipelineProposal {
  readonly proposalId: string;
  readonly attioRecordId: string;
  readonly bhcId: string;
  readonly contactName: string;
  readonly companyName: string;
  readonly evidence: string;
  readonly proposedTrack: string;
  readonly status: string;
}

export interface PlanItem {
  readonly type: PlanItemType;
  readonly contact: string;
  readonly bhcId: string;
  readonly reason: string;
  readonly channel: string | null;
  readonly subject: string;
  readonly draft: string;
  readonly replyRecipientsJson: string;
  readonly replyMode: string;
  readonly description: string;
  readonly taskId: string;
  readonly dueDate: string;
  readonly attioRecordId: string;
  readonly priority: number; // assigned after ranking/trimming — 1-based

  // ── 'opportunity' items only ──────────────────────────────────────────────
  // Genuinely new fields, deliberately NOT overloaded onto existing ones. In
  // particular proposalId does NOT ride in taskId: taskId means "a row in
  // Tasks_Open" to every existing consumer, and a proposal is not a task.
  // Optional because the other four types have no such thing.
  readonly proposalId?: string;
  readonly companyName?: string;
  readonly proposedTrack?: string;
}

export interface GamePlan {
  readonly brief: string;
  readonly missionStatus: MissionStatus;
  readonly counts: GamePlanCounts;
  readonly plan: readonly PlanItem[];
  /**
   * Everyone who was a legitimate candidate for today but didn't make the
   * top 10 (bucket-capped or globally-capped or cross-bucket-deduped away —
   * see buildOverflowItems' own doc comment). Bobby's own request
   * (2026-07-19): the 10-item cap is deliberate, keeping the daily plan
   * short enough not to be overwhelming — but anyone cut by it should still
   * be visible somewhere, not silently gone. Aida renders this behind a
   * collapsed "beyond today's 10" expansion, not inline with the plan.
   */
  readonly overflow: readonly PlanItem[];
  readonly generatedAt: string;
  readonly runId: string;
}

export interface Pass5Options {
  readonly runId: string; // same requirement as PASS 3 — digests a specific prior run
  readonly dryRun: boolean;
}

export interface Pass5Report {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly openTaskCount: number;
  readonly brainCompleteRowCount: number;
  readonly pipelineEntryCount: number;
  readonly meetingsToReviewCount: number;
  readonly planItemCount: number;
  readonly overflowItemCount: number;
  readonly written: boolean;

  readonly gamePlan: GamePlan | null;
  readonly warnings: readonly string[];
}

export type { CadenceRow, OpenTask };
