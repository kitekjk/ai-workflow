import type { AgentJob, FeedbackItem, FeedbackSource, PrdConfirmationStore, WorkItem } from "./domain";
import type { JiraIssueReader } from "./ports";

export interface FeedbackRevisionRequest {
  requestedBy: string;
  feedback: string;
  now?: Date;
}

export interface RecordFeedbackRequest {
  source?: FeedbackSource;
  author?: string;
  body: string;
  now?: Date;
  externalId?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentRevisionRequest {
  requestedBy: string;
  feedbackItemIds?: string[];
  now?: Date;
}

export interface DownstreamRoutingRequest {
  requestedBy?: string;
  now?: Date;
}

export interface DocumentFanOutRequest {
  requestedBy?: string;
  includeAdr?: boolean;
  adrTitle?: string;
  now?: Date;
}

export interface ImplementationStartRequest {
  requestedBy?: string;
  baseBranch?: string;
  branchName?: string;
  draft?: boolean;
  now?: Date;
}

export class PrdConfirmationWorkflow {
  constructor(
    private readonly store: PrdConfirmationStore,
    private readonly options: { jiraReader?: JiraIssueReader } = {}
  ) {}

  async intakePrdTicket(prdJiraKey: string): Promise<{ status: "accepted" }> {
    let issue = this.store.externalIssues.get(prdJiraKey);

    if (!issue && this.options.jiraReader) {
      const loaded = await this.options.jiraReader.loadPrdWithSources(prdJiraKey);
      this.store.externalIssues.set(loaded.prd.key, loaded.prd);
      for (const source of loaded.sources) {
        this.store.externalIssues.set(source.key, source);
      }
      issue = loaded.prd;
    }

    if (this.store.workItems.some((item) => item.primaryJiraKey === prdJiraKey)) {
      return { status: "accepted" };
    }

    if (!issue || issue.issueType !== "prd") {
      throw new Error(`PRD Jira ticket is not readable: ${prdJiraKey}`);
    }

    if (!isPrdIntakeRequestedStatus(issue.status)) {
      throw new Error(`PRD Jira ticket is not ready for intake: ${prdJiraKey}`);
    }

    if (!issue.linkedSourceKeys?.length) {
      throw new Error(`PRD Jira ticket has no linked source requests: ${prdJiraKey}`);
    }

    for (const sourceKey of issue.linkedSourceKeys) {
      if (!this.store.externalIssues.has(sourceKey)) {
        throw new Error(`Linked source request is not readable: ${sourceKey}`);
      }
    }

    const workItem: WorkItem = {
      id: this.nextWorkItemId(),
      runId: this.nextRunId(),
      artifactType: "prd",
      primaryJiraKey: prdJiraKey,
      state: "draft_requested"
    };

    this.store.workItems.push(workItem);
    this.store.workItemJiraLinks.push({ workItemId: workItem.id, jiraKey: prdJiraKey, role: "primary" });

    for (const sourceKey of issue.linkedSourceKeys) {
      this.store.workItemJiraLinks.push({
        workItemId: workItem.id,
        jiraKey: sourceKey,
        role: "source_request"
      });
    }

    this.store.agentJobs.push(this.createJob(workItem, "prd.generate_draft", {}));
    issue.status = "drafting";

    return { status: "accepted" };
  }

  async requestFeedbackRevision(
    prdJiraKey: string,
    request: FeedbackRevisionRequest
  ): Promise<{ status: "accepted"; jobId: string; feedbackItemIds: string[] }> {
    const workItem = this.findWorkItem(prdJiraKey);
    const issue = this.store.externalIssues.get(prdJiraKey);
    const feedbackItem = this.createFeedbackItem(workItem, {
      source: "app",
      author: request.requestedBy,
      body: request.feedback,
      now: request.now
    });
    const revisionContext = this.currentRevisionContext(workItem);
    const job = this.createJob(workItem, "prd.apply_feedback_revision", {
      requestedBy: request.requestedBy,
      feedback: request.feedback,
      feedbackItemIds: [feedbackItem.id],
      ...revisionContext
    });

    this.store.agentJobs.push(job);
    feedbackItem.revisionJobId = job.id;

    if (issue) {
      issue.status = "revision_requested";
    }

    return { status: "accepted", jobId: job.id, feedbackItemIds: [feedbackItem.id] };
  }

  recordFeedback(prdJiraKey: string, request: RecordFeedbackRequest): FeedbackItem {
    const workItem = this.findWorkItem(prdJiraKey);

    return this.createFeedbackItem(workItem, request);
  }

  async requestDocumentRevision(
    prdJiraKey: string,
    request: DocumentRevisionRequest
  ): Promise<{ status: "accepted"; jobId: string; feedbackItemIds: string[] }> {
    const workItem = this.findWorkItem(prdJiraKey);
    const issue = this.store.externalIssues.get(prdJiraKey);
    const feedbackItems = this.selectRevisionFeedback(workItem, request.feedbackItemIds);

    if (feedbackItems.length === 0) {
      throw new Error(`No new feedback found for PRD Jira ticket: ${prdJiraKey}`);
    }

    const revisionContext = this.currentRevisionContext(workItem);
    const job = this.createJob(workItem, revisionJobTypeFor(workItem), {
      requestedBy: request.requestedBy,
      documentType: workItem.artifactType,
      feedback: feedbackItems.map(formatFeedbackForRevision).join("\n"),
      feedbackItemIds: feedbackItems.map((feedback) => feedback.id),
      ...revisionContext
    });

    this.store.agentJobs.push(job);

    for (const feedback of feedbackItems) {
      feedback.revisionJobId = job.id;
    }

    if (issue) {
      issue.status = "revision_requested";
    }

    return {
      status: "accepted",
      jobId: job.id,
      feedbackItemIds: feedbackItems.map((feedback) => feedback.id)
    };
  }

  requestDownstreamRouting(
    prdJiraKey: string,
    request: DownstreamRoutingRequest = {}
  ): { status: "accepted" | "already_scheduled"; jobId: string } {
    const workItem = this.findWorkItem(prdJiraKey);

    if (workItem.artifactType !== "prd") {
      throw new Error(`Downstream routing can only start from a PRD document: ${prdJiraKey}`);
    }

    if (workItem.state !== "approved") {
      throw new Error(`PRD must be approved before downstream routing starts: ${prdJiraKey}`);
    }

    const existing = this.store.agentJobs.find(
      (job) => job.workItemId === workItem.id && job.jobType === "prd.route_downstream"
    );

    if (existing) {
      return { status: "already_scheduled", jobId: existing.id };
    }

    const job = this.createJob(workItem, "prd.route_downstream", {
      requestedBy: request.requestedBy,
      approvedAt: (request.now ?? new Date()).toISOString(),
      sourceDocumentId: documentIdForWorkItem(workItem)
    });

    this.store.agentJobs.push(job);
    return { status: "accepted", jobId: job.id };
  }

  requestDocumentFanOut(
    documentSourceKey: string,
    request: DocumentFanOutRequest = {}
  ): { status: "accepted" | "already_scheduled"; jobId: string } {
    const workItem = this.findWorkItem(documentSourceKey);
    const targetDocumentType = fanOutTargetFor(workItem);

    if (!targetDocumentType) {
      throw new Error(`Document cannot fan out to downstream documents: ${documentSourceKey}`);
    }

    if (workItem.state !== "approved") {
      throw new Error(`Document must be approved before fan-out starts: ${documentSourceKey}`);
    }

    const standardFanOut = this.store.agentJobs.find(
      (job) => job.workItemId === workItem.id && job.jobType === "document.fan_out" && job.input.adrOnly !== true
    );
    const hasAdrChild = this.store.workItems.some(
      (item) => item.parentWorkItemId === workItem.id && item.artifactType === "adr"
    );
    const needsAdrOnlyFanOut =
      request.includeAdr === true && standardFanOut !== undefined && standardFanOut.input.includeAdr !== true && !hasAdrChild;
    const existing = this.store.agentJobs.find(
      (job) =>
        job.workItemId === workItem.id &&
        job.jobType === "document.fan_out" &&
        (needsAdrOnlyFanOut ? job.input.adrOnly === true : job.input.adrOnly !== true)
    );

    if (existing) {
      return { status: "already_scheduled", jobId: existing.id };
    }

    const job = this.createJob(workItem, "document.fan_out", {
      requestedBy: request.requestedBy,
      approvedAt: (request.now ?? new Date()).toISOString(),
      sourceDocumentId: documentIdForWorkItem(workItem),
      parentDocumentType: workItem.artifactType,
      targetDocumentType,
      includeAdr: request.includeAdr === true,
      adrTitle: request.adrTitle,
      adrOnly: needsAdrOnlyFanOut
    });

    this.store.agentJobs.push(job);
    return { status: "accepted", jobId: job.id };
  }

  requestImplementationStart(
    documentSourceKey: string,
    request: ImplementationStartRequest = {}
  ): { status: "accepted" | "already_scheduled"; jobId: string } {
    const workItem = this.findWorkItem(documentSourceKey);

    if (workItem.artifactType !== "spec") {
      throw new Error(`Implementation can only start from an approved Spec document: ${documentSourceKey}`);
    }

    if (workItem.state !== "approved") {
      throw new Error(`Spec must be approved before implementation starts: ${documentSourceKey}`);
    }

    const existing = this.store.agentJobs.find(
      (job) => job.workItemId === workItem.id && job.jobType === "implementation.open_pr"
    );

    if (existing) {
      return { status: "already_scheduled", jobId: existing.id };
    }

    const currentVersion = currentDocumentVersionForWorkItem(this.store, workItem);
    const branchName = request.branchName ?? implementationBranchNameFor(workItem.primaryJiraKey);
    const baseBranch = request.baseBranch ?? "main";
    const job = this.createJob(workItem, "implementation.open_pr", {
      requestedBy: request.requestedBy,
      approvedAt: (request.now ?? new Date()).toISOString(),
      documentType: workItem.artifactType,
      documentId: documentIdForWorkItem(workItem),
      documentVersionId: currentVersion?.id,
      documentVersionProducerJobId: currentVersion?.producerJobId,
      sourceDocumentId: documentIdForWorkItem(workItem),
      currentDocumentArtifactUrl: currentVersion?.artifactUrl,
      runnerSkill: implementationPrAuthorSkill(),
      branchName,
      baseBranch,
      title: `Implement ${workItem.primaryJiraKey}: ${workItem.title ?? workItem.primaryJiraKey}`,
      body: implementationPullRequestBodyFor(workItem, {
        requestedBy: request.requestedBy,
        artifactUrl: currentVersion?.artifactUrl
      }),
      draft: request.draft ?? true
    });

    this.store.agentJobs.push(job);
    return { status: "accepted", jobId: job.id };
  }

  private findWorkItem(primaryJiraKey: string): WorkItem {
    const workItem = this.store.workItems.find((item) => item.primaryJiraKey === primaryJiraKey);

    if (!workItem) {
      throw new Error(`No work item found for PRD Jira ticket: ${primaryJiraKey}`);
    }

    return workItem;
  }

  private createJob(workItem: WorkItem, jobType: AgentJob["jobType"], input: Record<string, unknown>): AgentJob {
    return {
      id: this.nextJobId(),
      workItemId: workItem.id,
      jobType,
      primaryJiraKey: workItem.primaryJiraKey,
      status: "pending",
      input
    };
  }

  private nextWorkItemId(): string {
    return `wi_${this.store.workItems.length + 1}`;
  }

  private nextRunId(): string {
    return `run_${this.store.workItems.length + 1}`;
  }

  private nextJobId(): string {
    return `job_${this.store.agentJobs.length + 1}`;
  }

  private createFeedbackItem(workItem: WorkItem, request: RecordFeedbackRequest): FeedbackItem {
    const body = request.body.trim();

    if (!body) {
      throw new Error("Feedback body is required");
    }

    if (request.externalId) {
      const existing = this.store.feedbackItems.find(
        (feedback) =>
          feedback.workItemId === workItem.id &&
          feedback.source === (request.source ?? "app") &&
          feedback.externalId === request.externalId
      );

      if (existing) {
        return existing;
      }
    }

    const feedback: FeedbackItem = {
      id: this.nextFeedbackId(),
      workItemId: workItem.id,
      documentId: documentIdForWorkItem(workItem),
      source: request.source ?? "app",
      author: request.author,
      body,
      createdAt: (request.now ?? new Date()).toISOString(),
      externalId: request.externalId,
      externalUrl: request.externalUrl,
      metadata: request.metadata
    };

    this.store.feedbackItems.push(feedback);
    return feedback;
  }

  private selectRevisionFeedback(workItem: WorkItem, feedbackItemIds: string[] | undefined): FeedbackItem[] {
    const candidates = this.store.feedbackItems.filter((feedback) => feedback.workItemId === workItem.id);

    if (feedbackItemIds && feedbackItemIds.length > 0) {
      const selected = feedbackItemIds.map((feedbackId) => {
        const feedback = candidates.find((candidate) => candidate.id === feedbackId);

        if (!feedback) {
          throw new Error(`Feedback item not found for document: ${feedbackId}`);
        }

        if (feedback.revisionJobId) {
          throw new Error(`Feedback item already used in revision: ${feedbackId}`);
        }

        return feedback;
      });

      return selected;
    }

    return candidates.filter((feedback) => !feedback.revisionJobId);
  }

  private nextFeedbackId(): string {
    return `fb_${this.store.feedbackItems.length + 1}`;
  }

  private currentRevisionContext(workItem: WorkItem): Record<string, unknown> {
    const currentVersion = currentDocumentVersionForWorkItem(this.store, workItem);

    return {
      sourceDocumentId: documentIdForWorkItem(workItem),
      currentDocumentVersionId: currentVersion?.id,
      currentDocumentVersionProducerJobId: currentVersion?.producerJobId,
      currentDocumentArtifactUrl: currentVersion?.artifactUrl
    };
  }
}

function documentIdForWorkItem(workItem: WorkItem): string {
  return `doc_${workItem.id}`;
}

function isPrdIntakeRequestedStatus(status: string): boolean {
  return status === "prd_requested" || status === "PRD 요청";
}

function implementationBranchNameFor(sourceKey: string): string {
  return `workflow/${sourceKey.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function implementationPrAuthorSkill(): Record<string, string> {
  return {
    id: "implementation.pr-author",
    version: "0.1.0"
  };
}

function implementationPullRequestBodyFor(
  workItem: WorkItem,
  context: { requestedBy?: string; artifactUrl?: string }
): string {
  const lines = [
    `Generated from approved Spec ${workItem.primaryJiraKey}.`,
    context.artifactUrl ? `Spec artifact: ${context.artifactUrl}` : undefined,
    context.requestedBy ? `Requested by: ${context.requestedBy}` : undefined
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function formatFeedbackForRevision(feedback: FeedbackItem): string {
  const author = feedback.author ? ` by ${feedback.author}` : "";

  return `- [${feedback.source}${author}] ${feedback.body}`;
}

function fanOutTargetFor(workItem: WorkItem): "lld" | "spec" | undefined {
  if (workItem.artifactType === "hld") {
    return "lld";
  }

  if (workItem.artifactType === "lld") {
    return "spec";
  }

  return undefined;
}

function revisionJobTypeFor(workItem: WorkItem): AgentJob["jobType"] {
  return workItem.artifactType === "prd" ? "prd.apply_feedback_revision" : "document.revise";
}

function currentDocumentVersionForWorkItem(
  store: PrdConfirmationStore,
  workItem: WorkItem
): { id: string; producerJobId: string; artifactUrl: string } | undefined {
  let versionIndex = 0;
  let currentVersion: { id: string; producerJobId: string; artifactUrl: string } | undefined;

  for (const artifact of store.artifacts) {
    if (artifact.type !== "prd_markdown" && artifact.type !== "document_markdown") {
      continue;
    }

    versionIndex += 1;
    const job = store.agentJobs.find((candidate) => candidate.id === artifact.jobId);

    if (job?.workItemId === workItem.id) {
      currentVersion = {
        id: `docv_${versionIndex}`,
        producerJobId: artifact.jobId,
        artifactUrl: artifact.url
      };
    }
  }

  return currentVersion;
}
