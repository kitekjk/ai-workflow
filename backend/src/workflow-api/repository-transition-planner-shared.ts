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
import type {
  WorkflowEngineTransitionType,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun,
  WorkflowTask
} from "../workflow-core/domain";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import type {
  WorkflowDocumentMutationEvent,
  WorkflowFeedbackItem
} from "./workflow-mutation-applier";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";

export interface RepositoryTransition {
  transitionType: WorkflowEngineTransitionType;
  documentStatus: DocumentStatus;
  documentFields?: Partial<Pick<Document, "currentVersionId" | "currentMarkdownArtifactId" | "currentWikiArtifactId">>;
  workflowRuns?: WorkflowRun[];
  documents: Document[];
  workflowTasks: WorkflowTask[];
  workflowJobs: WorkflowJob[];
  documentVersions?: DocumentVersion[];
  artifacts?: Artifact[];
  qualityResults?: DocumentQualityResult[];
  feedbackItems?: WorkflowFeedbackItem[];
  documentEvents?: WorkflowDocumentMutationEvent[];
  qualityStatus?: string;
  stageTransitions?: Array<{ fromStageId: string; toStageId: string; reason: string }>;
}

export function documentOutputProjection(
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

export function markdownArtifactFor(input: {
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

export function wikiArtifactFor(input: {
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

export function qualityResultFor(
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

export function feedbackRecordedEventFor(
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

export function createFollowUpJob(
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

export function qualityTransitionTypeFor(jobType: string, passed: boolean): WorkflowEngineTransitionType {
  if (jobType === "prd.evaluate_quality") {
    return passed ? "prd_quality_passed" : "prd_quality_needs_revision";
  }

  return passed ? "document_quality_passed" : "document_quality_needs_revision";
}

export function nextJobInputFor(document: Document, jobType: string): Record<string, unknown> {
  if (jobType === "prd.evaluate_quality" || jobType === "document.evaluate") {
    return {
      documentType: document.type,
      sourceDocumentId: document.id
    };
  }

  return {};
}

export function nextRevisionEvaluationInputFor(
  input: PlanRepositoryWorkflowTransitionInput,
  jobType: string
): Record<string, unknown> {
  const nextInput = nextJobInputFor(input.document, jobType);
  const resumeInput = revisionResumeInputFor(input.job);

  return {
    ...nextInput,
    ...resumeInput
  };
}

export function revisionResumeInputFor(job: WorkflowJob): Record<string, unknown> {
  const sourceTaskId = stringOrUndefined(job.input.sourceTaskId);
  const targetTaskId = stringOrUndefined(job.input.targetTaskId) ?? job.taskId;

  if (!sourceTaskId || !targetTaskId) {
    return {};
  }

  return {
    revisionSource: stringOrUndefined(job.input.revisionSource),
    sourceTaskId,
    targetTaskId
  };
}

export function revisionResumeForQualityPass(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): Pick<RepositoryTransition, "workflowTasks" | "workflowJobs"> | undefined {
  const sourceTaskId = stringOrUndefined(input.job.input.sourceTaskId);
  const targetTaskId = stringOrUndefined(input.job.input.targetTaskId) ?? input.document.workflowTaskId;

  if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId) {
    return undefined;
  }

  const tasks = input.workflowTasks ?? [];
  const sourceTask = tasks.find((task) => task.id === sourceTaskId);
  const nextTask = sourceTask ? nextTaskAfterTargetOnPath(sourceTask, targetTaskId, tasks) : undefined;

  if (!sourceTask || !nextTask) {
    return undefined;
  }

  const resumedTask: WorkflowTask = {
    ...nextTask,
    status: "in_progress",
    updatedAt: now
  };
  const resumeJob = createResumeJobForTask(input, resumedTask, sourceTask, idGenerator, now);

  return {
    workflowTasks: [resumedTask],
    workflowJobs: resumeJob ? [resumeJob] : []
  };
}

export function nextTaskAfterTargetOnPath(
  sourceTask: WorkflowTask,
  targetTaskId: string,
  tasks: WorkflowTask[]
): WorkflowTask | undefined {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const path: WorkflowTask[] = [];
  const seen = new Set<string>();
  let current: WorkflowTask | undefined = sourceTask;

  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);

    if (current.id === targetTaskId) {
      return path.at(-2);
    }

    current = current.parentTaskId ? tasksById.get(current.parentTaskId) : undefined;
  }

  return undefined;
}

export function createResumeJobForTask(
  input: PlanRepositoryWorkflowTransitionInput,
  task: WorkflowTask,
  sourceTask: WorkflowTask,
  idGenerator: (prefix: string) => string,
  now: string
): WorkflowJob | undefined {
  if (task.taskType === "code") {
    return createImplementationResumeJob(input, task, idGenerator);
  }

  if (!isRevisableTask(task) || !task.currentDocumentId) {
    return undefined;
  }

  return createFollowUpJob(
    input,
    task.taskType === "prd" ? "prd.apply_feedback_revision" : "document.revise",
    {
      taskId: task.id,
      requestedBy: "workflow.task_revision_resume",
      documentType: task.taskType,
      sourceDocumentId: task.currentDocumentId,
      currentDocumentVersionId: stringOrUndefined(task.metadata.currentDocumentVersionId),
      feedback: `Upstream ${input.document.type.toUpperCase()} task ${input.document.sourceKey} was revised; refresh ${task.title}.`,
      revisionSource: "workflow.task_revision_resume",
      sourceTaskId: sourceTask.id,
      targetTaskId: task.id,
      upstreamTaskId: input.document.workflowTaskId,
      upstreamDocumentId: input.document.id,
      upstreamEvaluationJobId: input.job.id,
      upstreamEvaluationResultId: input.result.id
    },
    idGenerator
  );
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

function implementationPrUpdaterSkill(): Record<string, string> {
  return {
    id: "implementation.pr-updater",
    version: "0.1.0"
  };
}

export function latestWorkflowJobForTask(jobs: WorkflowJob[], taskId: string): WorkflowJob | undefined {
  return jobs
    .filter((job) => (job.taskId ?? stringOrUndefined(job.input.taskId)) === taskId)
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id)
    )[0];
}

export function isRevisableTask(task: WorkflowTask): boolean {
  return (
    task.taskType === "prd" ||
    task.taskType === "hld" ||
    task.taskType === "lld" ||
    task.taskType === "adr" ||
    task.taskType === "spec"
  );
}

export function resultStatusFor(result: WorkflowJobResult): string {
  return typeof result.output.status === "string" ? result.output.status : result.status;
}

export function documentTypeOrUndefined(value: unknown): DocumentType | undefined {
  return value === "prd" || value === "hld" || value === "lld" || value === "adr" || value === "spec"
    ? value
    : undefined;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function positiveIntegerOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function scoreOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed <= 1 ? Math.round(parsed * 100) : Math.round(parsed);
}

export function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function qualityFailureActionOrUndefined(value: unknown): DocumentQualityResult["qualityFailureAction"] | undefined {
  return value === "human_clarification" || value === "auto_rewrite" || value === "manual_or_auto"
    ? value
    : undefined;
}

export function nextDocumentVersion(document: Document): number {
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

export function workflowTaskForDocument(document: Document): WorkflowTask {
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

export function documentStatusToTaskStatus(status: DocumentStatus): WorkflowTask["status"] {
  return status;
}

export function taskIdForDocument(documentId: string): string {
  return documentId.startsWith("doc_") ? `task_${documentId.slice("doc_".length)}` : `task_${documentId}`;
}

export function artifactLocationForUri(uri: string): ArtifactLocation {
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

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function explicitDownstreamDocumentsFor(result: WorkflowJobResult): Array<{ type: DocumentType; title?: string }> {
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

export function createDownstreamDocuments(
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
