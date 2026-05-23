import type {
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
  WorkflowMutation
} from "./workflow-mutation-applier";
import {
  documentOutputProjection,
  qualityResultFor,
  createFollowUpJob,
  qualityTransitionTypeFor,
  nextJobInputFor,
  nextRevisionEvaluationInputFor,
  revisionResumeForQualityPass,
  resultStatusFor,
  documentTypeOrUndefined,
  stringOrUndefined,
  workflowTaskForDocument,
  taskIdForDocument,
  isRecord,
  defaultIdGenerator,
  type RepositoryTransition
} from "./repository-transition-planner-shared";
import { planImplementationTransition } from "./implementation-transition-planner";

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

  if (input.job.jobType.startsWith("implementation.")) {
    return planImplementationTransition(input, idGenerator, now);
  }

  throw new Error(`No repository workflow transition mapped for job type: ${input.job.jobType}`);
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


