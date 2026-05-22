import type { AgentJob, AgentJobResult, DocumentArtifactType, PrdConfirmationStore, WorkItem } from "./domain";

export async function runEngineOnce(store: PrdConfirmationStore): Promise<boolean> {
  return (await runEngineStep(store)).progressed;
}

export interface WorkflowEngineStepResult {
  progressed: boolean;
  transitionType?: WorkflowEngineTransitionType;
  processedResult?: AgentJobResult;
  updatedWorkItemId?: string;
  affectedWorkItemIds: string[];
  affectedDocumentIds: string[];
  workItemState?: WorkflowEngineWorkItemState;
  externalIssueStatus?: WorkflowEngineExternalIssueStatus;
  createdJobIds: string[];
  createdWorkItemIds: string[];
}

export interface WorkflowEngineWorkItemState {
  workItemId: string;
  before: string;
  after: string;
}

export interface WorkflowEngineExternalIssueStatus {
  issueKey: string;
  before?: string;
  after?: string;
}

export type WorkflowEngineTransitionType =
  | "job_failed"
  | "prd_draft_generated"
  | "prd_quality_passed"
  | "prd_quality_needs_revision"
  | "prd_feedback_revision_applied"
  | "prd_downstream_scope_confirmation_required"
  | "prd_downstream_documents_created"
  | "document_fan_out_created"
  | "document_generated"
  | "document_quality_passed"
  | "document_quality_needs_revision"
  | "document_revision_applied"
  | "implementation_pr_opened"
  | "implementation_pr_updated"
  | "implementation_pr_reviewed"
  | "implementation_pr_in_review"
  | "implementation_rework_requested"
  | "implementation_revision_requested";

export async function runEngineStep(store: PrdConfirmationStore): Promise<WorkflowEngineStepResult> {
  const result = store.agentJobResults.find((candidate) => !candidate.processed);

  if (!result) {
    return idleEngineStepResult();
  }

  const jobStartIndex = store.agentJobs.length;
  const workItemStartIndex = store.workItems.length;
  const workItem = findWorkItemForResult(store, result);
  const workItemStateBefore = workItem.state;
  const externalIssueStatusBefore = store.externalIssues.get(result.primaryJiraKey)?.status;
  let transitionType: WorkflowEngineTransitionType | undefined;

  if (result.output.status === "failed") {
    workItem.state = "failed";
    return completeEngineStep(
      store,
      result,
      workItem,
      jobStartIndex,
      workItemStartIndex,
      "job_failed",
      workItemStateBefore,
      externalIssueStatusBefore
    );
  }

  if (result.jobType === "prd.generate_draft") {
    store.agentJobs.push(createJob(store, workItem, "prd.evaluate_quality", {}));
    workItem.state = "evaluating";
    transitionType = "prd_draft_generated";
  }

  if (result.jobType === "prd.evaluate_quality") {
    const issue = store.externalIssues.get(result.primaryJiraKey);

    if (result.output.status === "passed") {
      workItem.state = "awaiting_approval";
      transitionType = "prd_quality_passed";
      if (issue) {
        issue.status = "awaiting_approval";
      }
    } else {
      workItem.state = "needs_revision";
      transitionType = "prd_quality_needs_revision";
      if (issue) {
        issue.status = "needs_revision";
      }
    }
  }

  if (result.jobType === "prd.apply_feedback_revision") {
    workItem.state = "evaluating";
    store.agentJobs.push(createJob(store, workItem, "prd.evaluate_quality", {}));
    transitionType = "prd_feedback_revision_applied";
  }

  if (result.jobType === "prd.route_downstream") {
    transitionType = applyDownstreamRoute(store, workItem, result);
  }

  if (result.jobType === "document.fan_out") {
    applyDocumentFanOut(store, workItem, result);
    transitionType = "document_fan_out_created";
  }

  if (result.jobType === "document.generate") {
    workItem.state = "evaluating";
    store.agentJobs.push(
      createJob(store, workItem, "document.evaluate", {
        documentType: workItem.artifactType,
        sourceDocumentId: documentIdForWorkItem(workItem)
      })
    );
    transitionType = "document_generated";
  }

  if (result.jobType === "document.evaluate") {
    if (result.output.status === "passed") {
      workItem.state = "awaiting_approval";
      transitionType = "document_quality_passed";
    } else {
      workItem.state = "needs_revision";
      transitionType = "document_quality_needs_revision";
    }
  }

  if (result.jobType === "document.revise") {
    workItem.state = "evaluating";
    store.agentJobs.push(
      createJob(store, workItem, "document.evaluate", {
        documentType: workItem.artifactType,
        sourceDocumentId: documentIdForWorkItem(workItem)
      })
    );
    transitionType = "document_revision_applied";
  }

  if (result.jobType === "implementation.open_pr") {
    workItem.state = "implementation_pr_open";
    const pullNumber = positiveIntegerOrUndefined(result.output.pullRequestNumber);
    transitionType = "implementation_pr_opened";

    if (pullNumber) {
      store.agentJobs.push(
        createJob(store, workItem, "implementation.collect_pr_status", {
          documentType: workItem.artifactType,
          documentId: documentIdForWorkItem(workItem),
          documentVersionId: stringOrUndefined(result.output.documentVersionId) ?? stringOrUndefined(jobInputForResult(store, result).documentVersionId),
          pullNumber,
          pullRequestUrl: stringOrUndefined(result.output.pullRequestUrl)
        })
      );
    }
  }

  if (result.jobType === "implementation.update_pr") {
    workItem.state = "implementation_pr_open";
    const pullNumber =
      positiveIntegerOrUndefined(result.output.pullRequestNumber) ??
      positiveIntegerOrUndefined(jobInputForResult(store, result).pullNumber);
    transitionType = "implementation_pr_updated";

    if (pullNumber) {
      store.agentJobs.push(
        createJob(store, workItem, "implementation.collect_pr_status", {
          documentType: workItem.artifactType,
          documentId: documentIdForWorkItem(workItem),
          documentVersionId:
            stringOrUndefined(result.output.documentVersionId) ??
            stringOrUndefined(jobInputForResult(store, result).documentVersionId),
          pullNumber,
          pullRequestUrl:
            stringOrUndefined(result.output.pullRequestUrl) ??
            stringOrUndefined(jobInputForResult(store, result).pullRequestUrl)
        })
      );
    }
  }

  if (result.jobType === "implementation.collect_pr_status") {
    const reviewStatus = stringOrUndefined(result.output.reviewStatus);
    const ciStatus = stringOrUndefined(result.output.ciStatus);
    const reviewed = reviewStatus === "approved" && ciStatus === "success";
    workItem.state = reviewed ? "implementation_reviewed" : "implementation_in_review";
    transitionType = reviewed ? "implementation_pr_reviewed" : "implementation_pr_in_review";
  }

  if (!transitionType) {
    throw new Error(`No workflow engine transition mapped for job type: ${result.jobType}`);
  }

  return completeEngineStep(
    store,
    result,
    workItem,
    jobStartIndex,
    workItemStartIndex,
    transitionType,
    workItemStateBefore,
    externalIssueStatusBefore
  );
}

function idleEngineStepResult(): WorkflowEngineStepResult {
  return {
    progressed: false,
    affectedWorkItemIds: [],
    affectedDocumentIds: [],
    createdJobIds: [],
    createdWorkItemIds: []
  };
}

function completeEngineStep(
  store: PrdConfirmationStore,
  result: AgentJobResult,
  workItem: WorkItem,
  jobStartIndex: number,
  workItemStartIndex: number,
  transitionType: WorkflowEngineTransitionType,
  workItemStateBefore: string,
  externalIssueStatusBefore: string | undefined
): WorkflowEngineStepResult {
  result.processed = true;
  const externalIssueStatusAfter = store.externalIssues.get(result.primaryJiraKey)?.status;
  const createdWorkItemIds = store.workItems.slice(workItemStartIndex).map((item) => item.id);
  const affectedWorkItemIds = uniqueStrings([workItem.id, ...createdWorkItemIds]);

  return {
    progressed: true,
    transitionType,
    processedResult: result,
    updatedWorkItemId: workItem.id,
    affectedWorkItemIds,
    affectedDocumentIds: affectedWorkItemIds.map(documentIdForWorkItemId),
    workItemState: {
      workItemId: workItem.id,
      before: workItemStateBefore,
      after: workItem.state
    },
    externalIssueStatus: {
      issueKey: result.primaryJiraKey,
      before: externalIssueStatusBefore,
      after: externalIssueStatusAfter
    },
    createdJobIds: store.agentJobs.slice(jobStartIndex).map((job) => job.id),
    createdWorkItemIds
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function findWorkItemForResult(store: PrdConfirmationStore, result: AgentJobResult): WorkItem {
  const job = store.agentJobs.find((candidate) => candidate.id === result.jobId);
  const workItem = job ? store.workItems.find((candidate) => candidate.id === job.workItemId) : undefined;

  if (!workItem) {
    throw new Error(`No work item found for job result: ${result.jobId}`);
  }

  return workItem;
}

function createJob(
  store: PrdConfirmationStore,
  workItem: WorkItem,
  jobType: AgentJob["jobType"],
  input: Record<string, unknown>
): AgentJob {
  return {
    id: `job_${store.agentJobs.length + 1}`,
    workItemId: workItem.id,
    jobType,
    primaryJiraKey: workItem.primaryJiraKey,
    status: "pending",
    input
  };
}

function jobInputForResult(store: PrdConfirmationStore, result: AgentJobResult): Record<string, unknown> {
  return store.agentJobs.find((candidate) => candidate.id === result.jobId)?.input ?? {};
}

function applyDownstreamRoute(
  store: PrdConfirmationStore,
  prdWorkItem: WorkItem,
  result: AgentJobResult
): WorkflowEngineTransitionType {
  const issue = store.externalIssues.get(result.primaryJiraKey);

  if (result.output.status === "needs_scope_confirmation") {
    prdWorkItem.state = "scope_confirmation_required";
    if (issue) {
      issue.status = "scope_confirmation_required";
    }
    return "prd_downstream_scope_confirmation_required";
  }

  createDownstreamDocuments(store, prdWorkItem, downstreamDocumentsFor(result), {
    route: result.output.route,
    routeRationale: result.output.rationale
  });
  return "prd_downstream_documents_created";
}

function applyDocumentFanOut(store: PrdConfirmationStore, parentWorkItem: WorkItem, result: AgentJobResult): void {
  createDownstreamDocuments(store, parentWorkItem, downstreamDocumentsForFanOut(parentWorkItem, result), {
    fanOutRationale: result.output.rationale,
    parentDocumentType: parentWorkItem.artifactType
  });
}

function createDownstreamDocuments(
  store: PrdConfirmationStore,
  parentWorkItem: WorkItem,
  downstreamDocuments: Array<{ type: DocumentArtifactType; title?: string }>,
  metadata: Record<string, unknown>
): void {
  for (const downstreamDocument of downstreamDocuments) {
    const childWorkItem = createDownstreamWorkItem(store, parentWorkItem, downstreamDocument.type, {
      title: downstreamDocument.title
    });

    store.workItems.push(childWorkItem);
    store.agentJobs.push(
      createJob(store, childWorkItem, "document.generate", {
        ...metadata,
        documentType: childWorkItem.artifactType,
        sourceDocumentId: documentIdForWorkItem(childWorkItem),
        parentDocumentId: documentIdForWorkItem(parentWorkItem),
        title: childWorkItem.title
      })
    );
  }
}

function downstreamDocumentsFor(result: AgentJobResult): Array<{ type: DocumentArtifactType; title?: string }> {
  const fromOutput = explicitDownstreamDocumentsFor(result);

  if (fromOutput.length > 0) {
    return fromOutput;
  }

  const route = documentTypeOrUndefined(result.output.route);
  return route ? [{ type: route }] : [{ type: "hld" }];
}

function downstreamDocumentsForFanOut(
  parentWorkItem: WorkItem,
  result: AgentJobResult
): Array<{ type: DocumentArtifactType; title?: string }> {
  const explicit = explicitDownstreamDocumentsFor(result).filter(
    (document) => document.type !== parentWorkItem.artifactType
  );

  if (explicit.length > 0) {
    return explicit;
  }

  if (parentWorkItem.artifactType === "hld") {
    return [
      {
        type: "lld",
        title: `Backend LLD for ${parentWorkItem.primaryJiraKey}`
      },
      {
        type: "lld",
        title: `Frontend LLD for ${parentWorkItem.primaryJiraKey}`
      }
    ];
  }

  if (parentWorkItem.artifactType === "lld") {
    return [
      {
        type: "spec",
        title: `Implementation Spec 1 for ${parentWorkItem.primaryJiraKey}`
      },
      {
        type: "spec",
        title: `Implementation Spec 2 for ${parentWorkItem.primaryJiraKey}`
      }
    ];
  }

  return [];
}

function explicitDownstreamDocumentsFor(result: AgentJobResult): Array<{ type: DocumentArtifactType; title?: string }> {
  if (!Array.isArray(result.output.downstreamDocuments)) {
    return [];
  }

  return result.output.downstreamDocuments.flatMap((document) => {
    if (!isRecord(document)) {
      return [];
    }

    const type = documentTypeOrUndefined(document.type);

    if (!type) {
      return [];
    }

    return [
      {
        type,
        title: typeof document.title === "string" ? document.title : undefined
      }
    ];
  });
}

function createDownstreamWorkItem(
  store: PrdConfirmationStore,
  prdWorkItem: WorkItem,
  artifactType: DocumentArtifactType,
  options: { title?: string }
): WorkItem {
  const sequence = store.workItems.filter(
    (item) => item.parentWorkItemId === prdWorkItem.id && item.artifactType === artifactType
  ).length;
  const suffix = `${artifactType.toUpperCase()}-${sequence + 1}`;

  return {
    id: `wi_${store.workItems.length + 1}`,
    runId: prdWorkItem.runId,
    artifactType,
    parentWorkItemId: prdWorkItem.id,
    primaryJiraKey: `${prdWorkItem.primaryJiraKey}-${suffix}`,
    title: options.title ?? `${artifactType.toUpperCase()} for ${prdWorkItem.primaryJiraKey}`,
    state: "draft_requested"
  };
}

function documentIdForWorkItem(workItem: WorkItem): string {
  return documentIdForWorkItemId(workItem.id);
}

function documentIdForWorkItemId(workItemId: string): string {
  return `doc_${workItemId}`;
}

function documentTypeOrUndefined(value: unknown): DocumentArtifactType | undefined {
  return value === "prd" || value === "hld" || value === "lld" || value === "adr" || value === "spec"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
