import { createHash, randomUUID } from "node:crypto";
import type {
  Artifact,
  ArtifactLocation,
  Document,
  DocumentQualityResult,
  DocumentStatus,
  DocumentType,
  DocumentVersion
} from "../document-core/domain";
import type { WorkflowEngineTransitionType } from "../prd-confirmation/workflow-engine";
import type { WorkflowJob, WorkflowJobResult, WorkflowTask } from "../workflow-core/domain";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import type {
  WorkflowDocumentMutationEvent,
  WorkflowFeedbackItem,
  WorkflowMutation
} from "./workflow-mutation-applier";

export interface PlanRepositoryWorkflowTransitionInput {
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
            createdJobIds: transition.workflowJobs.map((job) => job.id)
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

interface RepositoryTransition {
  transitionType: WorkflowEngineTransitionType;
  documentStatus: DocumentStatus;
  documentFields?: Partial<Pick<Document, "currentVersionId" | "currentMarkdownArtifactId" | "currentWikiArtifactId">>;
  documents: Document[];
  workflowTasks: WorkflowTask[];
  workflowJobs: WorkflowJob[];
  documentVersions?: DocumentVersion[];
  artifacts?: Artifact[];
  qualityResults?: DocumentQualityResult[];
  feedbackItems?: WorkflowFeedbackItem[];
  documentEvents?: WorkflowDocumentMutationEvent[];
  qualityStatus?: string;
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
      workflowJobs: [createFollowUpJob(input, "prd.evaluate_quality", nextJobInputFor(input.document, "prd.evaluate_quality"))],
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
      workflowJobs: [createFollowUpJob(input, "document.evaluate", nextJobInputFor(input.document, "document.evaluate"))],
      ...projection
    };
  }

  if (input.job.jobType === "prd.evaluate_quality" || input.job.jobType === "document.evaluate") {
    const passed = resultStatusFor(input.result) === "passed";
    return {
      transitionType: qualityTransitionTypeFor(input.job.jobType, passed),
      documentStatus: passed ? "approval_pending" : "needs_revision",
      documents: [],
      workflowTasks: [],
      workflowJobs: [],
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
    const reviewed = input.result.output.reviewStatus === "approved" && input.result.output.ciStatus === "success";

    if (!reviewed && implementationRequiresDocumentRevision(input.result)) {
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
        feedbackItems: [feedbackItem],
        documentEvents: [feedbackRecordedEventFor(feedbackItem, now)]
      };
    }

    if (!reviewed && implementationRequiresCodeRework(input.result)) {
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
        workflowJobs: [updateJob]
      };
    }

    return {
      transitionType: reviewed ? "implementation_pr_reviewed" : "implementation_pr_in_review",
      documentStatus: input.document.status,
      documents: [],
      workflowTasks: [implementationTaskForJob(input, input.result, now, reviewed ? "completed" : "in_progress")],
      workflowJobs: []
    };
  }

  throw new Error(`No repository workflow transition mapped for job type: ${input.job.jobType}`);
}

function documentOutputProjection(
  input: PlanRepositoryWorkflowTransitionInput,
  now: string,
  options: { revision?: boolean } = {}
): Pick<RepositoryTransition, "documentFields" | "documentVersions" | "artifacts"> {
  const version = nextDocumentVersion(input.document);
  const documentVersionId = `docv_${input.document.id}__v${version}`;
  const markdown = stringOrUndefined(input.result.output.markdown) ?? stringOrUndefined(input.result.output.content);
  const contentHash = stringOrUndefined(input.result.output.contentHash) ?? (markdown ? sha256(markdown) : undefined);
  const summary = stringOrUndefined(input.result.output.summary);
  const markdownArtifact = markdownArtifactFor({
    document: input.document,
    documentVersionId,
    jobId: input.job.id,
    version,
    now,
    output: input.result.output,
    contentHash
  });
  const wikiArtifact = wikiArtifactFor({
    document: input.document,
    documentVersionId,
    jobId: input.job.id,
    version,
    now,
    output: input.result.output
  });
  const artifacts = [markdownArtifact, wikiArtifact].filter((artifact): artifact is Artifact => Boolean(artifact));

  return {
    documentFields: {
      currentVersionId: documentVersionId,
      currentMarkdownArtifactId: markdownArtifact.id,
      currentWikiArtifactId: wikiArtifact?.id ?? input.document.currentWikiArtifactId
    },
    documentVersions: [
      {
        id: documentVersionId,
        documentId: input.document.id,
        version,
        producerJobId: input.job.id,
        summary,
        revisionSummary: options.revision ? summary : undefined,
        revisionJobId: options.revision ? input.job.id : undefined,
        contentHash,
        createdAt: now
      }
    ],
    artifacts
  };
}

function markdownArtifactFor(input: {
  document: Document;
  documentVersionId: string;
  jobId: string;
  version: number;
  now: string;
  output: Record<string, unknown>;
  contentHash?: string;
}): Artifact {
  const uri =
    stringOrUndefined(input.output.artifactUrl) ??
    stringOrUndefined(input.output.markdownUrl) ??
    stringOrUndefined(input.output.markdownUri) ??
    `db://workflow-runs/${input.document.workflowRunId}/documents/${input.document.id}/versions/${input.version}/markdown`;

  return {
    id: `art_${input.document.id}__v${input.version}_markdown`,
    documentId: input.document.id,
    documentVersionId: input.documentVersionId,
    producerJobId: input.jobId,
    type: "document_markdown",
    location: artifactLocationForUri(uri),
    uri,
    contentHash: input.contentHash,
    metadata: {
      source: "repository_runner_result",
      hasInlineMarkdown: typeof input.output.markdown === "string" || typeof input.output.content === "string"
    },
    createdAt: input.now
  };
}

function wikiArtifactFor(input: {
  document: Document;
  documentVersionId: string;
  jobId: string;
  version: number;
  now: string;
  output: Record<string, unknown>;
}): Artifact | undefined {
  const uri =
    stringOrUndefined(input.output.wikiUrl) ??
    stringOrUndefined(input.output.confluencePageUrl) ??
    stringOrUndefined(input.output.pageUrl);

  if (!uri) {
    return undefined;
  }

  return {
    id: `art_${input.document.id}__v${input.version}_wiki`,
    documentId: input.document.id,
    documentVersionId: input.documentVersionId,
    producerJobId: input.jobId,
    type: "wiki_page",
    location: "wiki",
    uri,
    externalId: stringOrUndefined(input.output.wikiPageId) ?? stringOrUndefined(input.output.confluencePageId),
    externalVersion: stringOrUndefined(input.output.wikiPageVersion) ?? stringOrUndefined(input.output.confluencePageVersion),
    metadata: {
      source: "repository_runner_result"
    },
    createdAt: input.now
  };
}

function qualityResultFor(
  input: PlanRepositoryWorkflowTransitionInput,
  passed: boolean,
  now: string
): DocumentQualityResult {
  return {
    id: `qg_${input.result.id}`,
    documentId: input.document.id,
    documentVersionId: input.document.currentVersionId,
    evaluatorJobId: input.job.id,
    status: passed ? "passed" : "needs_revision",
    score: scoreOrUndefined(input.result.output.score),
    summary: stringOrUndefined(input.result.output.summary),
    missingInformation: stringArrayOrEmpty(input.result.output.missingInformation),
    clarificationQuestions: stringArrayOrEmpty(input.result.output.clarificationQuestions),
    riskItems: stringArrayOrEmpty(input.result.output.riskItems),
    qualityFailureAction: qualityFailureActionOrUndefined(input.result.output.qualityFailureAction),
    autoRevisionScheduled: Boolean(input.result.output.autoRevisionScheduled),
    createdAt: now
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
      pullRequestNumber: input.pullNumber,
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
    runnerJobTemplate: {
      runner: {
        sandbox: "workspace-write",
        workdir: "implementation"
      }
    }
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

function feedbackRecordedEventFor(
  feedback: WorkflowFeedbackItem,
  now: string
): WorkflowDocumentMutationEvent {
  return {
    documentId: feedback.documentId,
    jobId: feedback.revisionJobId,
    type: "workflow.feedback_recorded",
    message: `Feedback recorded: ${feedback.id}`,
    metadata: {
      feedbackId: feedback.id,
      documentId: feedback.documentId,
      workItemId: feedback.workItemId,
      source: feedback.source,
      author: feedback.author ?? null,
      revisionJobId: feedback.revisionJobId ?? null
    },
    createdAt: now
  };
}

function createFollowUpJob(
  input: PlanRepositoryWorkflowTransitionInput,
  jobType: string,
  jobInput: Record<string, unknown>,
  idGenerator: (prefix: string) => string = input.idGenerator ?? defaultIdGenerator
): WorkflowJob {
  const taskId = stringOrUndefined(jobInput.taskId) ?? input.job.taskId ?? input.document.workflowTaskId;

  return createWorkflowJobRecord({
    id: idGenerator("job"),
    runId: input.job.runId,
    taskId,
    jobType,
    input: jobInput,
    projectId: input.job.projectId,
    repositoryId: input.job.repositoryId,
    assignedUserId: input.job.assignedUserId,
    assignedTeamId: input.job.assignedTeamId,
    preferredEngine: input.job.preferredEngine,
    requiredEngine: input.job.requiredEngine,
    executionPolicy: input.job.executionPolicy,
    now: input.now
  });
}

function qualityTransitionTypeFor(jobType: string, passed: boolean): WorkflowEngineTransitionType {
  if (jobType === "prd.evaluate_quality") {
    return passed ? "prd_quality_passed" : "prd_quality_needs_revision";
  }

  return passed ? "document_quality_passed" : "document_quality_needs_revision";
}

function nextJobInputFor(document: Document, jobType: string): Record<string, unknown> {
  if (jobType === "prd.evaluate_quality" || jobType === "document.evaluate") {
    return {
      documentType: document.type,
      sourceDocumentId: document.id
    };
  }

  return {};
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

function resultStatusFor(result: WorkflowJobResult): string {
  return typeof result.output.status === "string" ? result.output.status : result.status;
}

function documentTypeOrUndefined(value: unknown): DocumentType | undefined {
  return value === "prd" || value === "hld" || value === "lld" || value === "adr" || value === "spec"
    ? value
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function scoreOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed <= 1 ? Math.round(parsed * 100) : Math.round(parsed);
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function qualityFailureActionOrUndefined(value: unknown): DocumentQualityResult["qualityFailureAction"] | undefined {
  return value === "human_clarification" || value === "auto_rewrite" || value === "manual_or_auto"
    ? value
    : undefined;
}

function nextDocumentVersion(document: Document): number {
  const currentVersionId = document.currentVersionId;

  if (!currentVersionId) {
    return 1;
  }

  const match = /__v(\d+)$/.exec(currentVersionId);

  if (!match) {
    return 2;
  }

  return Number(match[1]) + 1;
}

function workflowTaskForDocument(document: Document): WorkflowTask {
  return {
    id: document.workflowTaskId ?? taskIdForDocument(document.id),
    runId: document.workflowRunId,
    parentTaskId:
      !document.workflowTaskId && document.parentDocumentId ? taskIdForDocument(document.parentDocumentId) : undefined,
    taskType: document.type,
    sourceKey: document.sourceKey,
    title: document.title,
    status: documentStatusToTaskStatus(document.status),
    currentDocumentId: document.id,
    metadata: {
      documentId: document.id
    },
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
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

function documentStatusToTaskStatus(status: DocumentStatus): WorkflowTask["status"] {
  return status;
}

function taskIdForDocument(documentId: string): string {
  return documentId.startsWith("doc_") ? `task_${documentId.slice("doc_".length)}` : `task_${documentId}`;
}

function artifactLocationForUri(uri: string): ArtifactLocation {
  if (uri.startsWith("git://") || uri.includes("github.com")) {
    return "git";
  }

  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return "external";
  }

  if (uri.startsWith("file://")) {
    return "local_workspace";
  }

  return "database";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
