import type { FeedbackItem, FeedbackSource } from "../document-core/domain";
import type { WikiFeedbackCollector } from "../integrations/workflow-ports";
import type { FeedbackRevisionCommand } from "./feedback-revision-command";
import type { WorkflowApiReadModel } from "./mysql-read-model";
import type { PrdIntakeCommand } from "./prd-intake-command";
import type { WorkflowResultCommand } from "./workflow-result-command";
import type { WorkflowTransitionCommand } from "./workflow-transition-command";

export const workflowCompatibilityDisabledMessage =
  "Legacy PRD compatibility fixture is disabled; use the repository-backed workflow APIs or set WORKFLOW_COMPATIBILITY_FIXTURE=enabled for old fixture-only routes";

export interface WorkflowApiCompatibilityActionContext {
  prdIntakeCommand?: PrdIntakeCommand;
  feedbackRevisionCommand?: FeedbackRevisionCommand;
  workflowResultCommand?: WorkflowResultCommand;
  workflowTransitionCommand?: WorkflowTransitionCommand;
  now: () => Date;
}

export type WorkflowApiCompatibilityActionFactory = (
  context: WorkflowApiCompatibilityActionContext
) => WorkflowApiCompatibilityActions | undefined;

export interface WorkflowApiCompatibilityActions {
  readModel: WorkflowApiReadModel;
  intakeTicket(input: { prdJiraKey: string; requestedBy?: string }): Promise<{ status: "accepted" }>;
  requestFeedbackRevision(input: {
    prdJiraKey: string;
    requestedBy: string;
    feedback: string;
    requestedAt: Date;
  }): Promise<{ status: "accepted"; jobId: string; feedbackItemIds: string[] }>;
  setQuality(qualityPasses: boolean): { qualityPasses: boolean };
  recordDocumentFeedback(input: {
    documentId: string;
    source?: FeedbackSource;
    author?: string;
    body: string;
    now: Date;
  }): Promise<{ feedback: FeedbackItem }>;
  recordWikiFeedback(
    collector: WikiFeedbackCollector,
    input: {
      documentId: string;
      pageId?: string;
      pageUrl?: string;
      limit?: number;
      includeResolved?: boolean;
      now: Date;
    }
  ): Promise<{
    pageId: string;
    importedCount: number;
    duplicateCount: number;
    feedbackItems: FeedbackItem[];
  }>;
  requestDocumentRevision(input: {
    documentId: string;
    requestedBy: string;
    feedbackItemIds?: string[];
    requestedAt: Date;
  }): Promise<{ status: string; revisionJob: unknown; feedbackItemIds: string[] }>;
  requestDocumentFanOut(input: {
    documentId: string;
    requestedBy?: string;
    includeAdr: boolean;
    adrTitle?: string;
    requestedAt: Date;
  }): Promise<{ status: string; fanOutJob: unknown; fanOutStatus: string }>;
  approvalGateForDocument(documentId: string): { approvalGate: unknown };
  refreshApprovalGate(input: { documentId: string; refreshedAt: Date }): Promise<{ approvalGate: unknown }>;
  approveApprovalGate(input: {
    documentId: string;
    requestedBy?: string;
    reason?: string;
    includeAdr: boolean;
    adrTitle?: string;
    approvedAt: Date;
  }): Promise<{ approvalGate: unknown; routingJob?: unknown; routingStatus?: string }>;
  rejectApprovalGate(input: {
    documentId: string;
    requestedBy?: string;
    reason?: string;
    rejectedAt: Date;
  }): Promise<{ approvalGate: unknown }>;
  runTick(): Promise<{ progressed: boolean }>;
}
