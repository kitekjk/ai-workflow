import type { Document } from "../document-core/domain";
import type {
  WorkflowEngineTransitionType,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun,
  WorkflowTask
} from "../workflow-core/domain";
import type { WorkflowMutation } from "./workflow-mutation-applier";
import {
  defaultIdGenerator,
  resultStatusFor,
  workflowTaskForDocument,
  type RepositoryTransition
} from "./repository-transition-planner-shared";
import { planImplementationTransition } from "./implementation-transition-planner";
import { planDocumentTransition } from "./document-transition-planner";
import { planPrdTransition } from "./prd-transition-planner";

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

  if (input.job.jobType.startsWith("prd."))            return planPrdTransition(input, idGenerator, now);
  if (input.job.jobType.startsWith("document."))       return planDocumentTransition(input, idGenerator, now);
  if (input.job.jobType.startsWith("implementation.")) return planImplementationTransition(input, idGenerator, now);

  throw new Error(`No repository workflow transition mapped for job type: ${input.job.jobType}`);
}
