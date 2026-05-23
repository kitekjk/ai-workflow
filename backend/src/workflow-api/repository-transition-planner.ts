import type {
  Artifact,
  Document,
  DocumentType
} from "../document-core/domain";
import type {
  WorkflowEngineTransitionType,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun,
  WorkflowTask
} from "../workflow-core/domain";
import type {
  WorkflowFeedbackItem,
  WorkflowMutation
} from "./workflow-mutation-applier";
import {
  documentOutputProjection,
  qualityResultFor,
  feedbackRecordedEventFor,
  createFollowUpJob,
  qualityTransitionTypeFor,
  nextJobInputFor,
  nextRevisionEvaluationInputFor,
  revisionResumeForQualityPass,
  latestWorkflowJobForTask,
  resultStatusFor,
  documentTypeOrUndefined,
  stringOrUndefined,
  positiveIntegerOrUndefined,
  booleanOrUndefined,
  workflowTaskForDocument,
  taskIdForDocument,
  isRecord,
  defaultIdGenerator,
  type RepositoryTransition
} from "./repository-transition-planner-shared";

export type { RepositoryTransition } from "./repository-transition-planner-shared";

export interface PlanRepositoryWorkflowTransitionInput {
  workflowRun?: WorkflowRun;
  workflowTasks?: WorkflowTask[];
  workflowJobs?: WorkflowJob[];
  document: Document;
  job: WorkflowJob;
  result: WorkflowJobResult;
  now: Date;
  idGenerator?: (prefix: string) => string;
}

export interface RepositoryWorkflowTransitionPlan {
  transitionType: WorkflowEngineTransitionType;
  mutation: WorkflowMutation;
}

export const repositoryWorkflowTransitionJobTypes = [
  "prd.generate_draft",
  "prd.evaluate_quality",
  "prd.apply_feedback_revision",
  "prd.route_downstream",
  "document.generate",
  "document.evaluate",
  "document.revise",
  "document.fan_out",
  "implementation.open_pr",
  "implementation.update_pr",
  "implementation.collect_pr_status"
] as const;

export function planRepositoryWorkflowTransition(
  input: PlanRepositoryWorkflowTransitionInput
): RepositoryWorkflowTransitionPlan {
  const idGenerator = input.idGenerator ?? defaultIdGenerator;
  const now = input.now.toISOString();
  const transition = repositoryTransitionFor(input, idGenerator, now);
  const document = {
    ...input.document,
    status: transition.documentStatus,
    ...transition.documentFields,
    updatedAt: now
  };
  const documentCurrentPointers = transition.documentFields
    ? [
        {
          id: document.id,
          status: document.status,
          currentVersionId: document.currentVersionId,
          currentMarkdownArtifactId: document.currentMarkdownArtifactId,
          currentWikiArtifactId: document.currentWikiArtifactId,
          updatedAt: document.updatedAt
        }
      ]
    : [];

  return {
    transitionType: transition.transitionType,
    mutation: {
      documentStates: [document],
      workflowRuns: transition.workflowRuns,
      workflowTasks: [workflowTaskForDocument(document), ...transition.workflowTasks],
      documents: transition.documents,
      workflowJobs: transition.workflowJobs,
      documentVersions: transition.documentVersions,
      artifacts: transition.artifacts,
      documentCurrentPointers,
      qualityResults: transition.qualityResults,
      feedbackItems: transition.feedbackItems,
      documentEvents: transition.documentEvents,
      events: [
        {
          runId: input.job.runId,
          jobId: input.result.jobId,
          type: "workflow.engine_transition",
          message: `Workflow engine transition: ${transition.transitionType}`,
          metadata: {
            transitionType: transition.transitionType,
            source: "repository",
            processedResult: {
              resultId: input.result.id,
              jobId: input.result.jobId,
              jobType: input.job.jobType,
              status: resultStatusFor(input.result)
            },
            qualityStatus: transition.qualityStatus,
            documentIds: [input.document.id, ...transition.documents.map((child) => child.id)],
            taskIds: [
              workflowTaskForDocument(document).id,
              ...transition.workflowTasks.map((task) => task.id)
            ],
            createdDocumentIds: transition.documents.map((child) => child.id),
            createdFeedbackItemIds: transition.feedbackItems?.map((feedback) => feedback.id) ?? [],
            createdTaskIds: transition.workflowTasks.map((task) => task.id),
            createdJobIds: transition.workflowJobs.map((job) => job.id),
            workflowRunStatus: transition.workflowRuns?.[0]?.status
          },
          createdAt: now
        }
      ]
    }
  };
}

export function canPlanRepositoryWorkflowTransition(jobType: string): boolean {
  return repositoryWorkflowTransitionJobTypes.includes(
    jobType as (typeof repositoryWorkflowTransitionJobTypes)[number]
  );
}

function repositoryTransitionFor(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  if (input.result.status === "failed" || input.result.output.status === "failed") {
    return {
      transitionType: "job_failed",
      documentStatus: "canceled",
      documents: [],
      workflowTasks: [],
      workflowJobs: []
    };
  }

  if (input.job.jobType === "prd.generate_draft") {
    const projection = documentOutputProjection(input, now);

    return {
      transitionType: "prd_draft_generated",
      documentStatus: "quality_review",
      documents: [],
      workflowTasks: [],
      workflowJobs: [createFollowUpJob(input, "prd.evaluate_quality", nextJobInputFor(input.document, "prd.evaluate_quality"))],
      ...projection
    };
  }

  if (input.job.jobType === "prd.apply_feedback_revision") {
    const projection = documentOutputProjection(input, now, { revision: true });

    return {
      transitionType: "prd_feedback_revision_applied",
      documentStatus: "quality_review",
      documents: [],
      workflowTasks: [],
      workflowJobs: [
        createFollowUpJob(input, "prd.evaluate_quality", nextRevisionEvaluationInputFor(input, "prd.evaluate_quality"))
      ],
      ...projection
    };
  }

  if (input.job.jobType === "document.generate") {
    const projection = documentOutputProjection(input, now);

    return {
      transitionType: "document_generated",
      documentStatus: "quality_review",
      documents: [],
      workflowTasks: [],
      workflowJobs: [createFollowUpJob(input, "document.evaluate", nextJobInputFor(input.document, "document.evaluate"))],
      ...projection
    };
  }

  if (input.job.jobType === "document.revise") {
    const projection = documentOutputProjection(input, now, { revision: true });

    return {
      transitionType: "document_revision_applied",
      documentStatus: "quality_review",
      documents: [],
      workflowTasks: [],
      workflowJobs: [
        createFollowUpJob(input, "document.evaluate", nextRevisionEvaluationInputFor(input, "document.evaluate"))
      ],
      ...projection
    };
  }

  if (input.job.jobType === "prd.evaluate_quality" || input.job.jobType === "document.evaluate") {
    const passed = resultStatusFor(input.result) === "passed";
    const revisionResume = passed ? revisionResumeForQualityPass(input, idGenerator, now) : undefined;
    return {
      transitionType: qualityTransitionTypeFor(input.job.jobType, passed),
      documentStatus: passed ? "approval_pending" : "needs_revision",
      documents: [],
      workflowTasks: revisionResume?.workflowTasks ?? [],
      workflowJobs: revisionResume?.workflowJobs ?? [],
      qualityResults: [qualityResultFor(input, passed, now)],
      qualityStatus: passed ? "passed" : "needs_revision"
    };
  }

  if (input.job.jobType === "prd.route_downstream") {
    if (input.result.output.status === "needs_scope_confirmation") {
      return {
        transitionType: "prd_downstream_scope_confirmation_required",
        documentStatus: "needs_revision",
        documents: [],
        workflowTasks: [],
        workflowJobs: []
      };
    }

    const created = createDownstreamDocuments(input, downstreamDocumentsFor(input.result), {
      route: input.result.output.route,
      routeRationale: input.result.output.rationale
    }, idGenerator, now);

    return {
      transitionType: "prd_downstream_documents_created",
      documentStatus: input.document.status,
      ...created
    };
  }

  if (input.job.jobType === "document.fan_out") {
    const created = createDownstreamDocuments(input, downstreamDocumentsForFanOut(input.document, input.result), {
      fanOutRationale: input.result.output.rationale,
      parentDocumentType: input.document.type
    }, idGenerator, now);

    return {
      transitionType: "document_fan_out_created",
      documentStatus: input.document.status,
      ...created
    };
  }

  if (input.job.jobType === "implementation.open_pr") {
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

  if (input.job.jobType === "implementation.update_pr") {
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

  if (input.job.jobType === "implementation.collect_pr_status") {
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

  throw new Error(`No repository workflow transition mapped for job type: ${input.job.jobType}`);
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

function createImplementationResumeJob(
  input: PlanRepositoryWorkflowTransitionInput,
  task: WorkflowTask,
  idGenerator: (prefix: string) => string
): WorkflowJob {
  const previousJob = latestWorkflowJobForTask(input.workflowJobs ?? [], task.id);
  const previousInput = previousJob?.input ?? {};
  const pullNumber = positiveIntegerOrUndefined(previousInput.pullNumber) ?? positiveIntegerOrUndefined(previousInput.pullRequestNumber);
  const pullRequestUrl = stringOrUndefined(previousInput.pullRequestUrl);
  const repository = stringOrUndefined(previousInput.repository);
  const repositoryCloneUrl =
    stringOrUndefined(previousInput.repositoryCloneUrl) ??
    stringOrUndefined(previousInput.implementationRepositoryCloneUrl);
  const branchName = stringOrUndefined(previousInput.branchName) ?? stringOrUndefined(previousInput.pullRequestBranch);
  const baseBranch = stringOrUndefined(previousInput.baseBranch);
  const latestCommitSha = stringOrUndefined(previousInput.latestCommitSha) ?? stringOrUndefined(previousInput.commitSha);
  const jobType = pullNumber || pullRequestUrl || branchName ? "implementation.update_pr" : "implementation.open_pr";
  const jobInput: Record<string, unknown> = {
    taskId: task.id,
    requestedBy: "workflow.task_revision_resume",
    documentType: input.document.type,
    documentId: input.document.id,
    documentVersionId: input.document.currentVersionId,
    sourceDocumentId: input.document.id,
    currentDocumentVersionId: input.document.currentVersionId,
    feedback: `Upstream ${input.document.type.toUpperCase()} task ${input.document.sourceKey} was revised; update the implementation.`,
    reworkSource: "workflow.task_revision_resume",
    sourceRevisionEvaluationJobId: input.job.id,
    sourceRevisionEvaluationResultId: input.result.id,
    pullNumber,
    pullRequestUrl,
    repository,
    repositoryCloneUrl,
    branchName,
    baseBranch,
    latestCommitSha
  };

  if (jobType === "implementation.update_pr") {
    jobInput.runnerSkill = implementationPrUpdaterSkill();
    jobInput.runnerJobTemplate = {
      runner: {
        sandbox: "workspace-write",
        workdir: "implementation"
      }
    };
  }

  return createFollowUpJob(input, jobType, jobInput, idGenerator);
}

function createDownstreamDocuments(
  input: PlanRepositoryWorkflowTransitionInput,
  downstreamDocuments: Array<{ type: DocumentType; title?: string }>,
  metadata: Record<string, unknown>,
  idGenerator: (prefix: string) => string,
  now: string
): Pick<RepositoryTransition, "documents" | "workflowTasks" | "workflowJobs"> {
  const documents: Document[] = [];
  const workflowTasks: WorkflowTask[] = [];
  const workflowJobs: WorkflowJob[] = [];
  const typeCounts = new Map<DocumentType, number>();

  for (const downstreamDocument of downstreamDocuments) {
    const sequence = (typeCounts.get(downstreamDocument.type) ?? 0) + 1;
    typeCounts.set(downstreamDocument.type, sequence);

    const documentId = idGenerator("doc");
    const taskId = taskIdForDocument(documentId);
    const title = downstreamDocument.title ?? `${downstreamDocument.type.toUpperCase()} for ${input.document.sourceKey}`;
    const task: WorkflowTask = {
      id: taskId,
      runId: input.document.workflowRunId,
      parentTaskId: input.document.workflowTaskId,
      taskType: downstreamDocument.type,
      sourceKey: `${input.document.sourceKey}-${downstreamDocument.type.toUpperCase()}-${sequence}`,
      title,
      status: "draft",
      currentDocumentId: documentId,
      metadata: {
        ...metadata,
        parentDocumentId: input.document.id
      },
      createdAt: now,
      updatedAt: now
    };
    const document: Document = {
      id: documentId,
      workflowRunId: input.document.workflowRunId,
      workflowTaskId: taskId,
      parentDocumentId: input.document.id,
      type: downstreamDocument.type,
      sourceKey: task.sourceKey,
      title,
      status: "draft",
      createdAt: now,
      updatedAt: now
    };
    const job = createFollowUpJob(input, "document.generate", {
      ...metadata,
      taskId,
      documentType: document.type,
      sourceDocumentId: document.id,
      parentDocumentId: input.document.id,
      title
    }, idGenerator);

    workflowTasks.push(task);
    documents.push(document);
    workflowJobs.push(job);
  }

  return { documents, workflowTasks, workflowJobs };
}

function downstreamDocumentsFor(result: WorkflowJobResult): Array<{ type: DocumentType; title?: string }> {
  const explicit = explicitDownstreamDocumentsFor(result);

  if (explicit.length > 0) {
    return explicit;
  }

  const route = documentTypeOrUndefined(result.output.route);
  return route ? [{ type: route }] : [{ type: "hld" }];
}

function downstreamDocumentsForFanOut(
  parentDocument: Document,
  result: WorkflowJobResult
): Array<{ type: DocumentType; title?: string }> {
  const explicit = explicitDownstreamDocumentsFor(result).filter((document) => document.type !== parentDocument.type);

  if (explicit.length > 0) {
    return explicit;
  }

  if (parentDocument.type === "hld") {
    return [
      {
        type: "lld",
        title: `Backend LLD for ${parentDocument.sourceKey}`
      },
      {
        type: "lld",
        title: `Frontend LLD for ${parentDocument.sourceKey}`
      }
    ];
  }

  if (parentDocument.type === "lld") {
    return [
      {
        type: "spec",
        title: `Implementation Spec 1 for ${parentDocument.sourceKey}`
      },
      {
        type: "spec",
        title: `Implementation Spec 2 for ${parentDocument.sourceKey}`
      }
    ];
  }

  return [];
}

function explicitDownstreamDocumentsFor(result: WorkflowJobResult): Array<{ type: DocumentType; title?: string }> {
  if (!Array.isArray(result.output.downstreamDocuments)) {
    return [];
  }

  return result.output.downstreamDocuments.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }

    const type = documentTypeOrUndefined(candidate.type);

    if (!type) {
      return [];
    }

    return [
      {
        type,
        title: stringOrUndefined(candidate.title)
      }
    ];
  });
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

