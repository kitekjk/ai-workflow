import type { Artifact, Document, DocumentType } from "../document-core/domain";
import type {
  WorkflowJobResult,
  WorkflowRun,
  WorkflowTask
} from "../workflow-core/domain";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";
import type { WorkflowFeedbackItem } from "./workflow-mutation-applier";
import {
  type RepositoryTransition,
  booleanOrUndefined,
  createFollowUpJob,
  documentTypeOrUndefined,
  feedbackRecordedEventFor,
  isRecord,
  positiveIntegerOrUndefined,
  resultStatusFor,
  stringOrUndefined,
  taskIdForDocument
} from "./repository-transition-planner-shared";

// Public entry: dispatches to the three implementation.* handlers.
export function planImplementationTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const jobType = input.job.jobType;
  if (jobType === "implementation.open_pr")           return planImplementationOpenPr(input, idGenerator, now);
  if (jobType === "implementation.update_pr")         return planImplementationUpdatePr(input, idGenerator, now);
  if (jobType === "implementation.collect_pr_status") return planImplementationCollectPrStatus(input, idGenerator, now);
  throw new Error(`Unknown implementation job type: ${jobType}`);
}

function planImplementationOpenPr(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const pullNumber = positiveIntegerOrUndefined(input.result.output.pullRequestNumber);
  const pullRequestUrl = stringOrUndefined(input.result.output.pullRequestUrl);
  const documentVersionId = stringOrUndefined(input.result.output.documentVersionId) ?? stringOrUndefined(input.job.input.documentVersionId);
  const workflowJobs = pullNumber
    ? [
        createFollowUpJob(input, "implementation.collect_pr_status", {
          documentType: input.document.type,
          documentId: input.document.id,
          documentVersionId,
          pullNumber,
          pullRequestUrl
        }, idGenerator)
      ]
    : [];

  return {
    transitionType: "implementation_pr_opened",
    documentStatus: input.document.status,
    documents: [],
    workflowTasks: [implementationTaskForJob(input, input.result, now, pullRequestUrl ? "in_progress" : "failed")],
    workflowJobs,
    artifacts: pullRequestUrl
      ? [
          pullRequestArtifactFor({
            document: input.document,
            documentVersionId,
            jobId: input.job.id,
            pullNumber,
            pullRequestUrl,
            output: input.result.output,
            now
          })
        ]
      : []
  };
}

function planImplementationUpdatePr(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const pullNumber =
    positiveIntegerOrUndefined(input.result.output.pullRequestNumber) ??
    positiveIntegerOrUndefined(input.job.input.pullNumber);
  const pullRequestUrl =
    stringOrUndefined(input.result.output.pullRequestUrl) ??
    stringOrUndefined(input.job.input.pullRequestUrl);
  const documentVersionId =
    stringOrUndefined(input.result.output.documentVersionId) ??
    stringOrUndefined(input.job.input.documentVersionId);
  const workflowJobs = pullNumber
    ? [
        createFollowUpJob(input, "implementation.collect_pr_status", {
          taskId: input.job.taskId,
          documentType: input.document.type,
          documentId: input.document.id,
          documentVersionId,
          pullNumber,
          pullRequestUrl,
          previousImplementationJobId: input.job.id
        }, idGenerator)
      ]
    : [];

  return {
    transitionType: "implementation_pr_updated",
    documentStatus: input.document.status,
    documents: [],
    workflowTasks: [implementationTaskForJob(input, input.result, now, pullNumber ? "in_progress" : "failed")],
    workflowJobs,
    artifacts: pullRequestUrl
      ? [
          pullRequestArtifactFor({
            document: input.document,
            documentVersionId,
            jobId: input.job.id,
            pullNumber,
            pullRequestUrl,
            output: input.result.output,
            now
          })
        ]
      : []
  };
}

function planImplementationCollectPrStatus(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const merged = booleanOrUndefined(input.result.output.merged) === true;
  const reviewed = input.result.output.reviewStatus === "approved" && input.result.output.ciStatus === "success";
  const pullNumber =
    positiveIntegerOrUndefined(input.result.output.pullRequestNumber) ??
    positiveIntegerOrUndefined(input.job.input.pullNumber);
  const pullRequestUrl =
    stringOrUndefined(input.result.output.pullRequestUrl) ??
    stringOrUndefined(input.job.input.pullRequestUrl);
  const documentVersionId =
    stringOrUndefined(input.result.output.documentVersionId) ??
    stringOrUndefined(input.job.input.documentVersionId);
  const pullRequestArtifacts = pullRequestUrl
    ? [
        pullRequestArtifactFor({
          document: input.document,
          documentVersionId,
          jobId: input.job.id,
          pullNumber,
          pullRequestUrl,
          output: input.result.output,
          now
        })
      ]
    : [];

  if (!merged && !reviewed && implementationRequiresDocumentRevision(input.result)) {
    const feedbackId = `fb_${input.result.id}_implementation_review`;
    const revisionTarget = implementationRevisionTargetFor(input, feedbackId);
    const revisionJob = createFollowUpJob(
      input,
      revisionTarget.documentType === "prd" ? "prd.apply_feedback_revision" : "document.revise",
      revisionTarget.jobInput,
      idGenerator
    );
    const feedbackItem = implementationRevisionFeedbackItemFor(input, revisionTarget, revisionJob.id, now);

    return {
      transitionType: "implementation_revision_requested",
      documentStatus: revisionTarget.documentId === input.document.id ? "needs_revision" : input.document.status,
      documents: [],
      workflowTasks: [implementationTaskForJob(input, input.result, now, "blocked")],
      workflowJobs: [revisionJob],
      artifacts: pullRequestArtifacts,
      feedbackItems: [feedbackItem],
      documentEvents: [feedbackRecordedEventFor(feedbackItem, now)]
    };
  }

  if (!merged && !reviewed && implementationRequiresCodeRework(input.result)) {
    const updateJob = createFollowUpJob(
      input,
      "implementation.update_pr",
      implementationUpdateJobInputFor(input),
      idGenerator
    );

    return {
      transitionType: "implementation_rework_requested",
      documentStatus: input.document.status,
      documents: [],
      workflowTasks: [implementationTaskForJob(input, input.result, now, "in_progress")],
      workflowJobs: [updateJob],
      artifacts: pullRequestArtifacts
    };
  }

  const implementationTask = implementationTaskForJob(
    input,
    input.result,
    now,
    merged || reviewed ? "completed" : "in_progress"
  );

  return {
    transitionType: merged ? "implementation_pr_merged" : reviewed ? "implementation_pr_reviewed" : "implementation_pr_in_review",
    documentStatus: input.document.status,
    workflowRuns: merged ? completedWorkflowRunFor(input, now, implementationTask) : undefined,
    documents: [],
    workflowTasks: [implementationTask],
    workflowJobs: [],
    artifacts: pullRequestArtifacts
  };
}

function pullRequestArtifactFor(input: {
  document: Document;
  documentVersionId?: string;
  jobId: string;
  pullNumber?: number;
  pullRequestUrl: string;
  output: Record<string, unknown>;
  now: string;
}): Artifact {
  const externalId =
    stringOrUndefined(input.output.pullRequestId) ??
    (input.pullNumber ? String(input.pullNumber) : undefined);

  return {
    id: `art_${input.jobId}_pull_request`,
    documentId: input.document.id,
    documentVersionId: input.documentVersionId,
    producerJobId: input.jobId,
    type: "pull_request",
    location: "external",
    uri: input.pullRequestUrl,
    externalId,
    externalVersion: stringOrUndefined(input.output.latestCommitSha) ?? stringOrUndefined(input.output.commitSha),
    metadata: {
      source: "repository_runner_result",
      provider: stringOrUndefined(input.output.provider),
      repository: stringOrUndefined(input.output.repository),
      repositoryCloneUrl: stringOrUndefined(input.output.repositoryCloneUrl),
      pullRequestNumber: input.pullNumber,
      pullRequestState: stringOrUndefined(input.output.pullRequestState),
      pullRequestTitle: stringOrUndefined(input.output.pullRequestTitle),
      pullRequestBody: stringOrUndefined(input.output.pullRequestBody),
      runnerSkill: isRecord(input.output.runnerSkill) ? input.output.runnerSkill : undefined,
      branchName: stringOrUndefined(input.output.branchName),
      baseBranch: stringOrUndefined(input.output.baseBranch),
      draft: booleanOrUndefined(input.output.draft),
      merged: booleanOrUndefined(input.output.merged),
      reviewStatus: stringOrUndefined(input.output.reviewStatus),
      ciStatus: stringOrUndefined(input.output.ciStatus)
    },
    createdAt: input.now
  };
}

interface ImplementationRevisionTarget {
  documentId: string;
  documentType: DocumentType;
  taskId?: string;
  feedbackId: string;
  feedback: string;
  pullNumber?: number;
  pullRequestUrl?: string;
  reviewStatus?: string;
  ciStatus?: string;
  jobInput: Record<string, unknown>;
}

function implementationRequiresDocumentRevision(result: WorkflowJobResult): boolean {
  const explicit = booleanOrUndefined(result.output.revisionRequired);

  if (explicit !== undefined) {
    return explicit;
  }

  const status = resultStatusFor(result);
  const reviewStatus = stringOrUndefined(result.output.reviewStatus);
  const failureScope = stringOrUndefined(result.output.failureScope);

  return failureScope === "document" || status === "needs_revision" || reviewStatus === "changes_requested";
}

function implementationRequiresCodeRework(result: WorkflowJobResult): boolean {
  const explicit = booleanOrUndefined(result.output.reworkRequired);

  if (explicit !== undefined) {
    return explicit;
  }

  const failureScope = stringOrUndefined(result.output.failureScope);
  const ciStatus = stringOrUndefined(result.output.ciStatus);

  return failureScope === "implementation" || ciStatus === "failure";
}

function implementationUpdateJobInputFor(input: PlanRepositoryWorkflowTransitionInput): Record<string, unknown> {
  const output = input.result.output;
  const pullNumber = positiveIntegerOrUndefined(output.pullRequestNumber) ?? positiveIntegerOrUndefined(input.job.input.pullNumber);
  const pullRequestUrl = stringOrUndefined(output.pullRequestUrl) ?? stringOrUndefined(input.job.input.pullRequestUrl);
  const repository = stringOrUndefined(output.repository) ?? stringOrUndefined(input.job.input.repository);
  const repositoryCloneUrl =
    stringOrUndefined(output.repositoryCloneUrl) ??
    stringOrUndefined(input.job.input.repositoryCloneUrl) ??
    stringOrUndefined(input.job.input.implementationRepositoryCloneUrl);
  const branchName =
    stringOrUndefined(output.branchName) ??
    stringOrUndefined(input.job.input.branchName) ??
    stringOrUndefined(input.job.input.pullRequestBranch);
  const baseBranch = stringOrUndefined(output.baseBranch) ?? stringOrUndefined(input.job.input.baseBranch);
  const latestCommitSha = stringOrUndefined(output.latestCommitSha) ?? stringOrUndefined(output.commitSha);
  const reviewStatus = stringOrUndefined(output.reviewStatus);
  const ciStatus = stringOrUndefined(output.ciStatus);
  const feedback = implementationUpdateFeedbackFor({
    feedback: stringOrUndefined(output.feedback) ?? stringOrUndefined(output.reworkFeedback),
    summary: stringOrUndefined(output.summary),
    reviewStatus,
    ciStatus,
    pullRequestUrl,
    checkRuns: output.checkRuns
  });

  return {
    taskId: input.job.taskId,
    requestedBy: "implementation.collect_pr_status",
    documentType: input.document.type,
    documentId: input.document.id,
    documentVersionId: stringOrUndefined(output.documentVersionId) ?? stringOrUndefined(input.job.input.documentVersionId),
    sourceDocumentId: input.document.id,
    currentDocumentVersionId: input.document.currentVersionId,
    pullNumber,
    pullRequestUrl,
    repository,
    repositoryCloneUrl,
    branchName,
    baseBranch,
    latestCommitSha,
    feedback,
    reworkSource: "implementation.collect_pr_status",
    sourceImplementationJobId: input.job.id,
    sourceImplementationResultId: input.result.id,
    reviewStatus,
    ciStatus,
    checkRuns: output.checkRuns,
    runnerSkill: implementationPrUpdaterSkill(),
    runnerJobTemplate: {
      runner: {
        sandbox: "workspace-write",
        workdir: "implementation"
      }
    }
  };
}

function implementationPrUpdaterSkill(): Record<string, string> {
  return {
    id: "implementation.pr-updater",
    version: "0.1.0"
  };
}

function implementationUpdateFeedbackFor(input: {
  feedback?: string;
  summary?: string;
  reviewStatus?: string;
  ciStatus?: string;
  pullRequestUrl?: string;
  checkRuns?: unknown;
}): string {
  const failedChecks = Array.isArray(input.checkRuns)
    ? input.checkRuns.flatMap((checkRun) => {
        if (!isRecord(checkRun)) {
          return [];
        }

        const status = stringOrUndefined(checkRun.status);
        const conclusion = stringOrUndefined(checkRun.conclusion);
        const name = stringOrUndefined(checkRun.name);

        return status === "completed" && conclusion && !["success", "neutral", "skipped"].includes(conclusion)
          ? [name ?? conclusion]
          : [];
      })
    : [];
  const lines = [
    input.feedback,
    input.summary,
    input.reviewStatus ? `PR review status: ${input.reviewStatus}` : undefined,
    input.ciStatus ? `CI status: ${input.ciStatus}` : undefined,
    failedChecks.length > 0 ? `Failing checks: ${failedChecks.join(", ")}` : undefined,
    input.pullRequestUrl ? `Pull request: ${input.pullRequestUrl}` : undefined
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join("\n") : "Implementation PR needs a code-only update.";
}

function implementationRevisionTargetFor(
  input: PlanRepositoryWorkflowTransitionInput,
  feedbackId: string
): ImplementationRevisionTarget {
  const output = input.result.output;
  const documentId = stringOrUndefined(output.revisionTargetDocumentId) ?? input.document.id;
  const documentType = documentTypeOrUndefined(output.revisionTargetDocumentType) ?? input.document.type;
  const taskId =
    stringOrUndefined(output.revisionTargetTaskId) ??
    (documentId === input.document.id ? input.document.workflowTaskId ?? taskIdForDocument(input.document.id) : undefined);
  const pullNumber = positiveIntegerOrUndefined(output.pullNumber) ?? positiveIntegerOrUndefined(input.job.input.pullNumber);
  const pullRequestUrl = stringOrUndefined(output.pullRequestUrl) ?? stringOrUndefined(input.job.input.pullRequestUrl);
  const reviewStatus = stringOrUndefined(output.reviewStatus);
  const ciStatus = stringOrUndefined(output.ciStatus);
  const feedback = implementationRevisionFeedbackFor({
    feedback: stringOrUndefined(output.feedback) ?? stringOrUndefined(output.revisionFeedback),
    summary: stringOrUndefined(output.summary),
    reviewStatus,
    ciStatus,
    pullRequestUrl
  });

  return {
    documentId,
    documentType,
    taskId,
    feedbackId,
    feedback,
    pullNumber,
    pullRequestUrl,
    reviewStatus,
    ciStatus,
    jobInput: {
      taskId,
      requestedBy: "implementation.collect_pr_status",
      documentType,
      sourceDocumentId: documentId,
      currentDocumentVersionId:
        stringOrUndefined(output.revisionTargetDocumentVersionId) ??
        (documentId === input.document.id ? input.document.currentVersionId : undefined),
      currentDocumentArtifactUrl:
        stringOrUndefined(output.revisionTargetArtifactUrl) ??
        stringOrUndefined(output.currentDocumentArtifactUrl),
      feedback,
      feedbackItemIds: [feedbackId],
      revisionSource: "implementation.collect_pr_status",
      sourceTaskId: input.job.taskId,
      targetTaskId: taskId,
      sourceImplementationJobId: input.job.id,
      sourceImplementationResultId: input.result.id,
      pullNumber,
      pullRequestUrl,
      reviewStatus,
      ciStatus
    }
  };
}

function implementationRevisionFeedbackFor(input: {
  feedback?: string;
  summary?: string;
  reviewStatus?: string;
  ciStatus?: string;
  pullRequestUrl?: string;
}): string {
  const lines = [
    input.feedback,
    input.summary,
    input.reviewStatus ? `PR review status: ${input.reviewStatus}` : undefined,
    input.ciStatus ? `CI status: ${input.ciStatus}` : undefined,
    input.pullRequestUrl ? `Pull request: ${input.pullRequestUrl}` : undefined
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0
    ? lines.join("\n")
    : "Implementation review requested a document revision.";
}

function implementationRevisionFeedbackItemFor(
  input: PlanRepositoryWorkflowTransitionInput,
  target: ImplementationRevisionTarget,
  revisionJobId: string,
  now: string
): WorkflowFeedbackItem {
  return {
    id: target.feedbackId,
    documentId: target.documentId,
    workItemId: target.taskId ?? taskIdForDocument(target.documentId),
    source: "github",
    body: target.feedback,
    externalId: target.pullNumber ? String(target.pullNumber) : input.result.id,
    externalUrl: target.pullRequestUrl,
    metadata: {
      source: "implementation.collect_pr_status",
      sourceJobId: input.job.id,
      sourceResultId: input.result.id,
      reviewStatus: target.reviewStatus,
      ciStatus: target.ciStatus
    },
    revisionJobId,
    createdAt: now
  };
}

function implementationTaskForJob(
  input: PlanRepositoryWorkflowTransitionInput,
  result: WorkflowJobResult,
  now: string,
  status: WorkflowTask["status"]
): WorkflowTask {
  const taskId = input.job.taskId ?? `task_${input.document.id}_code`;

  return {
    id: taskId,
    runId: input.job.runId,
    parentTaskId: input.document.workflowTaskId,
    taskType: "code",
    sourceKey: input.document.sourceKey,
    title: `Code Implementation for ${input.document.sourceKey}`,
    status,
    currentDocumentId: input.document.id,
    metadata: {
      documentId: input.document.id,
      jobId: input.job.id,
      resultId: result.id
    },
    createdAt: input.job.createdAt,
    updatedAt: now
  };
}

function completedWorkflowRunFor(
  input: PlanRepositoryWorkflowTransitionInput,
  now: string,
  completedTask: WorkflowTask
): WorkflowRun[] | undefined {
  if (!input.workflowRun || !allCodeTasksCompleted(input, completedTask)) {
    return undefined;
  }

  return [
    {
      ...input.workflowRun,
      status: "completed",
      updatedAt: now
    }
  ];
}

function allCodeTasksCompleted(input: PlanRepositoryWorkflowTransitionInput, completedTask: WorkflowTask): boolean {
  const codeTasks = (input.workflowTasks ?? []).filter((task) => task.taskType === "code");

  if (codeTasks.length === 0) {
    return true;
  }

  return codeTasks.every((task) => {
    if (task.id === completedTask.id) {
      return completedTask.status === "completed";
    }

    return task.status === "completed";
  });
}
