import type { FeedbackItem, FeedbackSource } from "../document-core/domain";
import type { WikiFeedbackCollector } from "../integrations/workflow-ports";
import type {
  WorkflowApiCompatibilityActionContext,
  WorkflowApiCompatibilityActionFactory,
  WorkflowApiCompatibilityActions
} from "./compatibility-actions";
import {
  persistLegacyPrdSnapshot,
  recordLegacyPrdDocumentStateCommand,
  recordLegacyPrdEngineTransitionCommands,
  recordLegacyPrdIntakeCommand,
  recordLegacyPrdRevisionJobCommand,
  recordLegacyPrdWorkflowJobCommand,
  recordLegacyPrdWorkflowResultProjectionCommand
} from "./legacy-prd-command-projection";
import {
  intakeLegacyPrdTicket,
  recordLegacyPrdDocumentFeedback,
  recordLegacyPrdWikiFeedback,
  requestLegacyPrdDocumentFanOut,
  requestLegacyPrdDocumentRevision,
  requestLegacyPrdFeedbackRevision
} from "./legacy-prd-route-actions";
import {
  createLegacyPrdWorkflowApiReadModel,
  legacyPrdApprovalGateForDocument,
  legacyPrdCurrentWikiArtifactUri,
  legacyPrdSnapshotJobAfterAction,
  refreshLegacyPrdApprovalGate,
  requireLegacyPrdDocumentForFixture,
  scheduleLegacyPrdDownstreamAfterApproval,
  transitionLegacyPrdApprovalGate
} from "./legacy-prd-read-projection";
import {
  legacyPrdFixtureDisabledMessage,
  runLegacyPrdTick,
  setLegacyPrdQuality,
  type LegacyPrdCompatibility,
  type LegacyPrdFixture
} from "./legacy-prd-compatibility";

export interface LegacyPrdServerActionContext extends WorkflowApiCompatibilityActionContext {
  legacyPrd?: LegacyPrdCompatibility;
}

export type LegacyPrdServerActions = WorkflowApiCompatibilityActions;

export function createLegacyPrdServerActionFactory(
  legacyPrd?: LegacyPrdCompatibility
): WorkflowApiCompatibilityActionFactory | undefined {
  return legacyPrd
    ? (context) =>
        createLegacyPrdServerActions({
          legacyPrd,
          ...context
        })
    : undefined;
}

export function createLegacyPrdServerActions(
  input: LegacyPrdServerActionContext
): LegacyPrdServerActions | undefined {
  if (!input.legacyPrd) {
    return undefined;
  }

  const context: LegacyPrdServerActionContext = {
    legacyPrd: input.legacyPrd,
    prdIntakeCommand: input.prdIntakeCommand,
    feedbackRevisionCommand: input.feedbackRevisionCommand,
    workflowResultCommand: input.workflowResultCommand,
    workflowTransitionCommand: input.workflowTransitionCommand,
    now: input.now
  };

  return {
    readModel: createLegacyPrdWorkflowApiReadModel(input.legacyPrd),
    intakeTicket: (actionInput) => intakeLegacyPrdTicketWithProjection(context, actionInput),
    requestFeedbackRevision: (actionInput) =>
      requestLegacyPrdFeedbackRevisionWithProjection(context, actionInput),
    setQuality: (qualityPasses) => setLegacyPrdQualityForCompatibility(context, qualityPasses),
    recordDocumentFeedback: (actionInput) =>
      recordLegacyPrdDocumentFeedbackWithProjection(context, actionInput),
    recordWikiFeedback: (collector, actionInput) =>
      recordLegacyPrdWikiFeedbackWithProjection(context, collector, actionInput),
    requestDocumentRevision: (actionInput) =>
      requestLegacyPrdDocumentRevisionWithProjection(context, actionInput),
    requestDocumentFanOut: (actionInput) =>
      requestLegacyPrdDocumentFanOutWithProjection(context, actionInput),
    approvalGateForDocument: (documentId) => legacyPrdApprovalGateForFixtureDocument(context, documentId),
    refreshApprovalGate: (actionInput) => refreshLegacyPrdApprovalGateWithProjection(context, actionInput),
    approveApprovalGate: (actionInput) => approveLegacyPrdApprovalGateWithProjection(context, actionInput),
    rejectApprovalGate: (actionInput) => rejectLegacyPrdApprovalGateWithProjection(context, actionInput),
    runTick: () => runLegacyPrdWorkflowTickWithProjection(context)
  };
}

export { createLegacyPrdWorkflowApiReadModel };

export async function intakeLegacyPrdTicketWithProjection(
  context: LegacyPrdServerActionContext,
  input: { prdJiraKey: string; requestedBy?: string }
): Promise<{ status: "accepted" }> {
  const fixture = requireLegacyPrdFixture(context);
  const result = await intakeLegacyPrdTicket(fixture, input.prdJiraKey);
  await recordLegacyPrdIntakeCommand(context, input.prdJiraKey, input.requestedBy);
  await persistLegacyPrdSnapshot(context);

  return result;
}

export async function requestLegacyPrdFeedbackRevisionWithProjection(
  context: LegacyPrdServerActionContext,
  input: { prdJiraKey: string; requestedBy: string; feedback: string; requestedAt: Date }
): Promise<{ status: "accepted"; jobId: string; feedbackItemIds: string[] }> {
  const fixture = requireLegacyPrdFixture(context);
  const result = await requestLegacyPrdFeedbackRevision(fixture, input.prdJiraKey, {
    requestedBy: input.requestedBy,
    feedback: input.feedback,
    now: input.requestedAt
  });
  await recordLegacyPrdRevisionJobCommand(context, result.jobId, result.feedbackItemIds, input.requestedAt);
  await persistLegacyPrdSnapshot(context);

  return result;
}

export function setLegacyPrdQualityForCompatibility(
  context: LegacyPrdServerActionContext,
  qualityPasses: boolean
): { qualityPasses: boolean } {
  return setLegacyPrdQuality(requireLegacyPrdFixture(context), qualityPasses);
}

export async function recordLegacyPrdDocumentFeedbackWithProjection(
  context: LegacyPrdServerActionContext,
  input: {
    documentId: string;
    source?: FeedbackSource;
    author?: string;
    body: string;
    now: Date;
  }
): Promise<{ feedback: FeedbackItem }> {
  const fixture = requireLegacyPrdFixture(context);
  const feedback = recordLegacyPrdDocumentFeedback(fixture, input.documentId, {
    source: input.source,
    author: input.author,
    body: input.body,
    now: input.now
  });
  await recordLegacyPrdFeedbackCommands(context, [feedback]);
  await persistLegacyPrdSnapshot(context);

  return { feedback };
}

export async function recordLegacyPrdWikiFeedbackWithProjection(
  context: LegacyPrdServerActionContext,
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
}> {
  const fixture = requireLegacyPrdFixture(context);
  const { snapshot, document } = requireLegacyPrdDocumentForFixture(fixture, input.documentId);
  const collected = await collector.collectPageFeedback({
    pageId: input.pageId,
    pageUrl: input.pageUrl ?? legacyPrdCurrentWikiArtifactUri(snapshot, document),
    limit: input.limit,
    includeResolved: input.includeResolved
  });
  const result = recordLegacyPrdWikiFeedback(
    fixture,
    input.documentId,
    collected.comments,
    input.now,
    collected.pageId
  );

  await recordLegacyPrdFeedbackCommands(context, result.feedbackItems);
  await persistLegacyPrdSnapshot(context);

  return {
    pageId: collected.pageId,
    ...result
  };
}

export async function requestLegacyPrdDocumentRevisionWithProjection(
  context: LegacyPrdServerActionContext,
  input: {
    documentId: string;
    requestedBy: string;
    feedbackItemIds?: string[];
    requestedAt: Date;
  }
): Promise<{ status: string; revisionJob: unknown; feedbackItemIds: string[] }> {
  const fixture = requireLegacyPrdFixture(context);
  const result = await requestLegacyPrdDocumentRevision(fixture, input.documentId, {
    requestedBy: input.requestedBy,
    feedbackItemIds: input.feedbackItemIds,
    now: input.requestedAt
  });
  await recordLegacyPrdRevisionJobCommand(context, result.jobId, result.feedbackItemIds, input.requestedAt);
  await persistLegacyPrdSnapshot(context);

  return {
    status: result.status,
    revisionJob: legacyPrdSnapshotJobAfterAction(fixture, result.jobId),
    feedbackItemIds: result.feedbackItemIds
  };
}

export async function requestLegacyPrdDocumentFanOutWithProjection(
  context: LegacyPrdServerActionContext,
  input: {
    documentId: string;
    requestedBy?: string;
    includeAdr: boolean;
    adrTitle?: string;
    requestedAt: Date;
  }
): Promise<{ status: string; fanOutJob: unknown; fanOutStatus: string }> {
  const fixture = requireLegacyPrdFixture(context);
  const result = requestLegacyPrdDocumentFanOut(fixture, input.documentId, {
    requestedBy: input.requestedBy,
    includeAdr: input.includeAdr,
    adrTitle: input.adrTitle,
    now: input.requestedAt
  });
  await recordLegacyPrdWorkflowJobCommand(context, result.jobId, input.requestedAt);
  await persistLegacyPrdSnapshot(context);

  return {
    status: result.status,
    fanOutJob: legacyPrdSnapshotJobAfterAction(fixture, result.jobId),
    fanOutStatus: result.status
  };
}

export function legacyPrdApprovalGateForFixtureDocument(
  context: LegacyPrdServerActionContext,
  documentId: string
): { approvalGate: unknown } {
  const fixture = requireLegacyPrdFixture(context);
  const { document } = requireLegacyPrdDocumentForFixture(fixture, documentId);

  return { approvalGate: legacyPrdApprovalGateForDocument(fixture, document) };
}

export async function refreshLegacyPrdApprovalGateWithProjection(
  context: LegacyPrdServerActionContext,
  input: { documentId: string; refreshedAt: Date }
): Promise<{ approvalGate: unknown }> {
  const fixture = requireLegacyPrdFixture(context);
  const { document } = requireLegacyPrdDocumentForFixture(fixture, input.documentId);
  const { approvalGate, downstreamJob } = refreshLegacyPrdApprovalGate(fixture, document);

  await recordLegacyPrdDocumentStateCommand(context, input.documentId, input.refreshedAt);
  await recordLegacyPrdWorkflowJobCommand(context, downstreamJob?.jobId, input.refreshedAt);
  await persistLegacyPrdSnapshot(context);

  return { approvalGate };
}

export async function approveLegacyPrdApprovalGateWithProjection(
  context: LegacyPrdServerActionContext,
  input: {
    documentId: string;
    requestedBy?: string;
    reason?: string;
    includeAdr: boolean;
    adrTitle?: string;
    approvedAt: Date;
  }
): Promise<{ approvalGate: unknown; routingJob?: unknown; routingStatus?: string }> {
  const fixture = requireLegacyPrdFixture(context);
  const { document } = requireLegacyPrdDocumentForFixture(fixture, input.documentId);
  const approvalGate = transitionLegacyPrdApprovalGate(fixture, document, "approved", {
    actor: input.requestedBy,
    reason: input.reason
  });
  const downstreamJob = scheduleLegacyPrdDownstreamAfterApproval(fixture, document, {
    requestedBy: input.requestedBy,
    includeAdr: input.includeAdr,
    adrTitle: input.adrTitle,
    now: input.approvedAt
  });

  await recordLegacyPrdDocumentStateCommand(context, input.documentId, input.approvedAt, {
    actor: input.requestedBy,
    reason: input.reason
  });
  await recordLegacyPrdWorkflowJobCommand(context, downstreamJob?.jobId, input.approvedAt);
  await persistLegacyPrdSnapshot(context);

  return {
    approvalGate,
    routingJob: downstreamJob ? legacyPrdSnapshotJobAfterAction(fixture, downstreamJob.jobId) : undefined,
    routingStatus: downstreamJob?.status
  };
}

export async function rejectLegacyPrdApprovalGateWithProjection(
  context: LegacyPrdServerActionContext,
  input: {
    documentId: string;
    requestedBy?: string;
    reason?: string;
    rejectedAt: Date;
  }
): Promise<{ approvalGate: unknown }> {
  const fixture = requireLegacyPrdFixture(context);
  const { document } = requireLegacyPrdDocumentForFixture(fixture, input.documentId);
  const approvalGate = transitionLegacyPrdApprovalGate(fixture, document, "needs_revision", {
    actor: input.requestedBy,
    reason: input.reason
  });

  await recordLegacyPrdDocumentStateCommand(context, input.documentId, input.rejectedAt, {
    actor: input.requestedBy,
    reason: input.reason
  });
  await persistLegacyPrdSnapshot(context);

  return { approvalGate };
}

export async function runLegacyPrdWorkflowTickWithProjection(
  context: LegacyPrdServerActionContext
): Promise<{ progressed: boolean }> {
  const fixture = requireLegacyPrdFixture(context);
  const { engineStep, progressed } = await runLegacyPrdTick(fixture);
  await recordLegacyPrdEngineTransitionCommands(context, engineStep, context.now());
  await recordLegacyPrdWorkflowResultProjectionCommand(context, engineStep);

  if (progressed) {
    await persistLegacyPrdSnapshot(context);
  }

  return { progressed };
}

function requireLegacyPrdFixture(context: LegacyPrdServerActionContext): LegacyPrdFixture {
  if (!context.legacyPrd) {
    throw new Error(legacyPrdFixtureDisabledMessage);
  }

  return context.legacyPrd.fixture;
}

async function recordLegacyPrdFeedbackCommands(
  context: LegacyPrdServerActionContext,
  feedbackItems: FeedbackItem[]
): Promise<void> {
  if (!context.feedbackRevisionCommand) {
    return;
  }

  for (const feedback of feedbackItems) {
    await context.feedbackRevisionCommand.recordFeedback({ feedback });
  }
}
