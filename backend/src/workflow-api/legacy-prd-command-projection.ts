import type { FeedbackItem } from "../document-core/domain";
import {
  createLegacyPrdEngineTransitionCommandInput,
  createLegacyPrdSnapshot,
  type LegacyPrdCompatibility,
  legacyPrdWorkflowJobCommandInputForFixtureJob,
  type LegacyPrdFixture,
  type LegacyPrdSnapshot,
  type LegacyWorkflowEngineStepResult
} from "./legacy-prd-compatibility";
import type { FeedbackRevisionCommand } from "./feedback-revision-command";
import type { PrdIntakeCommand } from "./prd-intake-command";
import type { WorkflowResultCommand } from "./workflow-result-command";
import type { WorkflowTransitionCommand } from "./workflow-transition-command";

interface LegacyPrdCommandProjectionContext {
  legacyPrd?: LegacyPrdCompatibility;
  prdIntakeCommand?: PrdIntakeCommand;
  feedbackRevisionCommand?: FeedbackRevisionCommand;
  workflowResultCommand?: WorkflowResultCommand;
  workflowTransitionCommand?: WorkflowTransitionCommand;
  now: () => Date;
}

export async function recordLegacyPrdIntakeCommand(
  context: LegacyPrdCommandProjectionContext,
  prdJiraKey: string,
  requestedBy?: string
): Promise<void> {
  if (!context.prdIntakeCommand) {
    return;
  }

  const fixture = requireLegacyPrdFixture(context);
  const workItem = fixture.store.workItems.find((candidate) => candidate.primaryJiraKey === prdJiraKey);
  const draftJob = workItem
    ? fixture.store.agentJobs.find(
        (candidate) => candidate.workItemId === workItem.id && candidate.jobType === "prd.generate_draft"
      )
    : undefined;

  if (!workItem || !draftJob) {
    throw new Error(`PRD intake command could not find fixture intake state: ${prdJiraKey}`);
  }

  await context.prdIntakeCommand.recordIntake({
    runId: workItem.runId,
    workItemId: workItem.id,
    jobId: draftJob.id,
    prdJiraKey,
    title: workItem.title ?? fixture.store.externalIssues.get(prdJiraKey)?.summary,
    requestedBy,
    now: context.now()
  });
}

export async function recordLegacyPrdRevisionJobCommand(
  context: LegacyPrdCommandProjectionContext,
  jobId: string,
  feedbackItemIds: string[],
  now: Date
): Promise<void> {
  if (!context.feedbackRevisionCommand) {
    return;
  }

  const fixture = requireLegacyPrdFixture(context);
  const job = fixture.store.agentJobs.find((candidate) => candidate.id === jobId);

  if (!job) {
    throw new Error(`Feedback revision command could not find fixture job state: ${jobId}`);
  }

  const workItem = fixture.store.workItems.find((candidate) => candidate.id === job.workItemId);

  if (!workItem) {
    throw new Error(`Feedback revision command could not find fixture work item state: ${job.workItemId}`);
  }

  await context.feedbackRevisionCommand.recordRevisionJob({
    runId: workItem.runId,
    job,
    taskId: `task_${workItem.id}`,
    feedbackItems: legacyPrdFeedbackItemsForRevision(fixture, feedbackItemIds),
    now
  });
}

export async function recordLegacyPrdDocumentStateCommand(
  context: LegacyPrdCommandProjectionContext,
  documentId: string,
  now: Date,
  metadata: { actor?: string; reason?: string } = {}
): Promise<void> {
  if (!context.workflowTransitionCommand) {
    return;
  }

  const snapshot = createLegacyPrdSnapshot(requireLegacyPrdFixture(context).store);
  const document = snapshot.documents.find((candidate) => candidate.id === documentId);

  if (!document) {
    throw new Error(`Workflow transition command could not find fixture document state: ${documentId}`);
  }

  await context.workflowTransitionCommand.recordDocumentState({
    document,
    workflowTask:
      snapshot.workflowTasks.find((task) => task.id === document.workflowTaskId) ??
      snapshot.workflowTasks.find((task) => task.currentDocumentId === documentId),
    actor: metadata.actor,
    reason: metadata.reason,
    now
  });
}

export async function recordLegacyPrdWorkflowJobCommand(
  context: LegacyPrdCommandProjectionContext,
  jobId: string | undefined,
  now: Date
): Promise<void> {
  if (!context.workflowTransitionCommand || !jobId) {
    return;
  }

  await context.workflowTransitionCommand.recordWorkflowJob({
    ...legacyPrdWorkflowJobCommandInputForFixtureJob(requireLegacyPrdFixture(context).store, jobId),
    now
  });
}

export async function recordLegacyPrdEngineTransitionCommands(
  context: LegacyPrdCommandProjectionContext,
  engineStep: LegacyWorkflowEngineStepResult,
  now: Date
): Promise<void> {
  if (!context.workflowTransitionCommand || !engineStep.progressed) {
    return;
  }

  const commandInput = createLegacyPrdEngineTransitionCommandInput(
    requireLegacyPrdFixture(context).store,
    engineStep,
    now
  );

  if (!commandInput) {
    return;
  }

  if (context.workflowTransitionCommand.recordEngineTransition) {
    await context.workflowTransitionCommand.recordEngineTransition(commandInput);
    return;
  }

  const taskByDocumentId = new Map(
    (commandInput.workflowTasks ?? [])
      .filter((task) => task.currentDocumentId)
      .map((task) => [task.currentDocumentId as string, task])
  );

  for (const document of commandInput.documents) {
    await context.workflowTransitionCommand.recordDocumentState({
      document,
      workflowTask: taskByDocumentId.get(document.id),
      now
    });
  }

  for (const job of commandInput.jobs) {
    await context.workflowTransitionCommand.recordWorkflowJob({ ...job, now });
  }
}

export async function recordLegacyPrdWorkflowResultProjectionCommand(
  context: LegacyPrdCommandProjectionContext,
  engineStep: LegacyWorkflowEngineStepResult
): Promise<void> {
  if (!context.workflowResultCommand || !engineStep.processedResult) {
    return;
  }

  const snapshot = createLegacyPrdSnapshot(requireLegacyPrdFixture(context).store);
  const jobsById = new Map(snapshot.workflowJobs.map((job) => [job.id, job]));
  const job = jobsById.get(engineStep.processedResult.jobId);

  if (!job) {
    throw new Error(`Workflow result command could not find fixture job state: ${engineStep.processedResult.jobId}`);
  }

  await context.workflowResultCommand.recordResultProjection({
    jobId: engineStep.processedResult.jobId,
    ...legacyPrdResultProjectionForRun(snapshot, job.runId)
  });
}

export async function persistLegacyPrdSnapshot(
  context: LegacyPrdCommandProjectionContext
): Promise<void> {
  if (!context.legacyPrd?.snapshotMirror) {
    return;
  }

  await context.legacyPrd.snapshotMirror.persist(createLegacyPrdSnapshot(requireLegacyPrdFixture(context).store));
}

function legacyPrdFeedbackItemsForRevision(
  fixture: LegacyPrdFixture,
  feedbackItemIds: string[]
): FeedbackItem[] {
  const feedbackById = new Map(fixture.store.feedbackItems.map((feedback) => [feedback.id, feedback]));
  const feedbackItems: FeedbackItem[] = [];

  for (const feedbackId of feedbackItemIds) {
    const feedback = feedbackById.get(feedbackId);

    if (!feedback) {
      throw new Error(`Feedback revision command could not find fixture feedback state: ${feedbackId}`);
    }

    feedbackItems.push(feedback);
  }

  return feedbackItems;
}

function legacyPrdResultProjectionForRun(snapshot: LegacyPrdSnapshot, runId: string) {
  const jobs = snapshot.workflowJobs.filter((job) => job.runId === runId);
  const jobIds = new Set(jobs.map((job) => job.id));
  const documents = snapshot.documents.filter((document) => document.workflowRunId === runId);
  const documentIds = new Set(documents.map((document) => document.id));

  return {
    jobs,
    jobResults: snapshot.workflowJobResults.filter((result) => jobIds.has(result.jobId)),
    workflowTasks: snapshot.workflowTasks.filter((task) => task.runId === runId),
    documents,
    documentVersions: snapshot.documentVersions.filter((version) => documentIds.has(version.documentId)),
    artifacts: snapshot.artifacts.filter(
      (artifact) =>
        jobIds.has(artifact.producerJobId) ||
        (artifact.documentId !== undefined && documentIds.has(artifact.documentId))
    ),
    qualityResults: snapshot.qualityResults.filter((result) => documentIds.has(result.documentId))
  };
}

function requireLegacyPrdFixture(context: LegacyPrdCommandProjectionContext): LegacyPrdFixture {
  if (!context.legacyPrd) {
    throw new Error("Legacy PRD fixture is required for compatibility command projection");
  }

  return context.legacyPrd.fixture;
}
