import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { createPrdConfirmationFixture } from "../prd-confirmation/fixture";
import { runRunnerWorkerOnce } from "../prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../prd-confirmation/scheduler";
import { runEngineStep, type WorkflowEngineStepResult } from "../prd-confirmation/workflow-engine";
import { createGenericPrdSnapshot, type GenericPrdSnapshot } from "../prd-confirmation/generic-adapter";
import type { PrdSnapshotMirror } from "../prd-confirmation/mysql-snapshot-mirror";
import type { ArtifactLocation, ArtifactType, Document } from "../document-core/domain";
import type { DocumentRepository } from "../document-core/repository";
import {
  prdConfirmationWorkflowPolicy,
  type AgentJob,
  type ExternalIssue,
  type FeedbackItem,
  type FeedbackSource
} from "../prd-confirmation/domain";
import type { JiraIssueReader, WikiCollectedFeedback, WikiFeedbackCollector } from "../prd-confirmation/ports";
import { redactSecrets } from "../runtime/secrets";
import type { RunnerMode, WorkflowJob } from "../workflow-core/domain";
import type { WorkflowScheduler } from "../workflow-core/scheduler";
import {
  createEngineTransitionCommandInput,
  workflowJobCommandInputForFixtureJob
} from "./engine-transition-projection";
import type { DocumentCurrentReadModel, WorkflowApiReadModel } from "./mysql-read-model";
import type { PrdIntakeCommand } from "./prd-intake-command";
import type { FeedbackRevisionCommand } from "./feedback-revision-command";
import type { WorkflowResultCommand } from "./workflow-result-command";
import type { WorkflowTransitionCommand } from "./workflow-transition-command";

type Fixture = ReturnType<typeof createPrdConfirmationFixture>;

export interface WorkflowApiServer {
  url: string;
  listen(port: number): Promise<WorkflowApiServer>;
  close(): Promise<void>;
}

export interface CreateWorkflowApiServerInput {
  fixture?: Fixture;
  scheduler?: WorkflowScheduler;
  documentRepository?: DocumentRepository;
  jiraIssueReader?: JiraIssueReader;
  wikiFeedbackCollector?: WikiFeedbackCollector;
  snapshotMirror?: PrdSnapshotMirror;
  readModel?: WorkflowApiReadModel;
  prdIntakeCommand?: PrdIntakeCommand;
  feedbackRevisionCommand?: FeedbackRevisionCommand;
  workflowResultCommand?: WorkflowResultCommand;
  workflowTransitionCommand?: WorkflowTransitionCommand;
  internalTickIntervalMs?: number;
  enableTestControls?: boolean;
  now?: () => Date;
}

export function createWorkflowApiServer({
  fixture,
  scheduler,
  documentRepository,
  jiraIssueReader,
  wikiFeedbackCollector,
  snapshotMirror,
  readModel,
  prdIntakeCommand,
  feedbackRevisionCommand,
  workflowResultCommand,
  workflowTransitionCommand,
  internalTickIntervalMs,
  enableTestControls = false,
  now = () => new Date()
}: CreateWorkflowApiServerInput): WorkflowApiServer {
  let baseUrl = "";
  let internalTickTimer: ReturnType<typeof setInterval> | undefined;
  let internalTickPromise: Promise<unknown> | undefined;

  const context: WorkflowApiRequestContext = {
    fixture,
    scheduler,
    documentRepository,
    jiraIssueReader,
    wikiFeedbackCollector,
    snapshotMirror,
    readModel,
    prdIntakeCommand,
    feedbackRevisionCommand,
    workflowResultCommand,
    workflowTransitionCommand,
    enableTestControls,
    now
  };

  const server = createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      await routeRequest(context, request, response);
    } catch (error) {
      const statusCode = statusCodeForError(error);
      const message = error instanceof Error ? error.message : "Unknown server error";
      writeJson(response, statusCode, { error: message });
    }
  });

  const runInternalTick = () => {
    if (internalTickPromise) {
      return;
    }

    internalTickPromise = runCompatibilityWorkflowTick(context)
      .catch(() => undefined)
      .finally(() => {
        internalTickPromise = undefined;
      });
  };

  const startInternalTickLoop = () => {
    if (
      !context.fixture ||
      internalTickIntervalMs === undefined ||
      internalTickIntervalMs < 1 ||
      internalTickTimer
    ) {
      return;
    }

    internalTickTimer = setInterval(runInternalTick, internalTickIntervalMs);
    internalTickTimer.unref?.();
    runInternalTick();
  };

  const stopInternalTickLoop = () => {
    if (!internalTickTimer) {
      return;
    }

    clearInterval(internalTickTimer);
    internalTickTimer = undefined;
  };

  return {
    get url() {
      return baseUrl;
    },

    async listen(port: number) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await listenServer(server, port);

        const address = server.address() as AddressInfo;

        if (port !== 0 || !isFetchBlockedPort(address.port)) {
          baseUrl = `http://127.0.0.1:${address.port}`;
          startInternalTickLoop();
          return this;
        }

        await closeServer(server);
      }

      throw new Error("Could not allocate a fetch-compatible local port");
    },

    async close() {
      stopInternalTickLoop();
      await internalTickPromise;
      await closeServer(server);
    }
  };
}

interface WorkflowApiRequestContext {
  fixture?: Fixture;
  scheduler?: WorkflowScheduler;
  documentRepository?: DocumentRepository;
  jiraIssueReader?: JiraIssueReader;
  wikiFeedbackCollector?: WikiFeedbackCollector;
  snapshotMirror?: PrdSnapshotMirror;
  readModel?: WorkflowApiReadModel;
  prdIntakeCommand?: PrdIntakeCommand;
  feedbackRevisionCommand?: FeedbackRevisionCommand;
  workflowResultCommand?: WorkflowResultCommand;
  workflowTransitionCommand?: WorkflowTransitionCommand;
  enableTestControls: boolean;
  now: () => Date;
}

async function routeRequest(
  context: WorkflowApiRequestContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (method === "POST" && path === "/prd/intake") {
    const body = await readJsonBody<{ prdJiraKey?: string }>(request);
    const prdJiraKey = requireString(body.prdJiraKey, "prdJiraKey");

    if (!context.fixture && context.jiraIssueReader && context.prdIntakeCommand) {
      const result = await intakePrdTicketWithoutFixture(context, prdJiraKey);
      writeJson(response, 202, result);
      return;
    }

    const fixture = requireCompatibilityFixture(context);
    const result = await fixture.workflow.intakePrdTicket(prdJiraKey);
    await recordPrdIntakeCommand(context, prdJiraKey);
    await persistFixtureSnapshot(context);

    writeJson(response, 202, result);
    return;
  }

  if (method === "POST" && path === "/prd/feedback-revision") {
    const fixture = requireCompatibilityFixture(context);
    const body = await readJsonBody<{
      prdJiraKey?: string;
      requestedBy?: string;
      feedback?: string;
      now?: unknown;
    }>(request);
    const requestedAt = parseNow(body.now, context.now);
    const result = await fixture.workflow.requestFeedbackRevision(requireString(body.prdJiraKey, "prdJiraKey"), {
      requestedBy: requireString(body.requestedBy, "requestedBy"),
      feedback: requireString(body.feedback, "feedback"),
      now: requestedAt
    });
    await recordRevisionJobCommand(context, result.jobId, result.feedbackItemIds, requestedAt);
    await persistFixtureSnapshot(context);

    writeJson(response, 202, result);
    return;
  }

  if (method === "POST" && path === "/tick") {
    writeJson(response, 200, await runCompatibilityWorkflowTick(context));
    return;
  }

  if (context.enableTestControls && method === "POST" && path === "/test-controls/quality") {
    const fixture = requireCompatibilityFixture(context);
    const body = await readJsonBody<{ qualityPasses?: boolean }>(request);
    fixture.skills.qualityPasses = Boolean(body.qualityPasses);
    writeJson(response, 200, { qualityPasses: fixture.skills.qualityPasses });
    return;
  }

  if (method === "POST" && path === "/runners/register") {
    const scheduler = requireScheduler(context);
    const body = await readJsonBody<RunnerRegistrationBody>(request);
    const runner = await scheduler.registerRunner({
      id: requireString(body.id, "id"),
      ownerUserId: optionalString(body.ownerUserId, "ownerUserId"),
      mode: requireRunnerMode(body.mode),
      teamIds: optionalStringArray(body.teamIds, "teamIds"),
      allowedProjectIds: optionalStringArray(body.allowedProjectIds, "allowedProjectIds"),
      allowedRepositoryIds: optionalStringArray(body.allowedRepositoryIds, "allowedRepositoryIds"),
      capabilities: optionalStringArray(body.capabilities, "capabilities"),
      engines: optionalStringArray(body.engines, "engines"),
      defaultEngine: optionalString(body.defaultEngine, "defaultEngine"),
      concurrency: optionalPositiveInteger(body.concurrency, "concurrency"),
      now: parseNow(body.now, context.now)
    });

    writeJson(response, 201, { runner });
    return;
  }

  if (method === "POST" && path.startsWith("/runners/")) {
    const scheduler = requireScheduler(context);
    const [runnerId, action] = path.slice("/runners/".length).split("/");
    const decodedRunnerId = decodeURIComponent(runnerId);

    if (action === "heartbeat") {
      const body = await readJsonBody<RunnerHeartbeatBody>(request);
      const runner =
        body.mode === undefined
          ? await scheduler.heartbeat(decodedRunnerId, parseNow(body.now, context.now))
          : await scheduler.registerRunner({
              id: decodedRunnerId,
              ownerUserId: optionalString(body.ownerUserId, "ownerUserId"),
              mode: requireRunnerMode(body.mode),
              teamIds: optionalStringArray(body.teamIds, "teamIds"),
              allowedProjectIds: optionalStringArray(body.allowedProjectIds, "allowedProjectIds"),
              allowedRepositoryIds: optionalStringArray(body.allowedRepositoryIds, "allowedRepositoryIds"),
              capabilities: optionalStringArray(body.capabilities, "capabilities"),
              engines: optionalStringArray(body.engines, "engines"),
              defaultEngine: optionalString(body.defaultEngine, "defaultEngine"),
              concurrency: optionalPositiveInteger(body.concurrency, "concurrency"),
              now: parseNow(body.now, context.now)
            });

      writeJson(response, 200, { runner });
      return;
    }

    if (action === "claim") {
      const body = await readJsonBody<RunnerClaimBody>(request);
      const claim = await scheduler.claim(decodedRunnerId, parseNow(body.now, context.now));

      writeJson(response, 200, { claim: claim ?? null });
      return;
    }
  }

  if (path.startsWith("/runner-jobs/")) {
    const scheduler = requireScheduler(context);
    const [jobId, action] = path.slice("/runner-jobs/".length).split("/");
    const decodedJobId = decodeURIComponent(jobId);

    if (method === "GET" && action === undefined) {
      const job = await scheduler.getJob(decodedJobId);

      writeJson(response, job ? 200 : 404, job ? { job } : { error: "Job not found" });
      return;
    }

    if (method === "POST" && action === "start") {
      const body = await readJsonBody<RunnerJobActionBody>(request);
      const job = await scheduler.startJob(
        decodedJobId,
        requireString(body.runnerId, "runnerId"),
        parseNow(body.now, context.now)
      );

      writeJson(response, 200, { job });
      return;
    }

    if (method === "POST" && action === "cancel") {
      const body = await readJsonBody<RunnerJobCancelBody>(request);
      const job = await scheduler.requestJobCancellation({
        jobId: decodedJobId,
        requestedBy: optionalString(body.requestedBy, "requestedBy"),
        reason: optionalString(body.reason, "reason"),
        now: parseNow(body.now, context.now)
      });

      writeJson(response, 202, { job });
      return;
    }

    if (method === "POST" && action === "canceled") {
      const body = await readJsonBody<RunnerJobResultBody>(request);
      const result = await scheduler.acknowledgeJobCancellation({
        jobId: decodedJobId,
        runnerId: requireString(body.runnerId, "runnerId"),
        output: redactSecrets(optionalRecord(body.output, "output")),
        now: parseNow(body.now, context.now)
      });

      writeJson(response, 200, { result });
      return;
    }

    if (method === "POST" && action === "results") {
      const body = await readJsonBody<RunnerJobResultBody>(request);
      const result = await scheduler.completeJob({
        jobId: decodedJobId,
        runnerId: requireString(body.runnerId, "runnerId"),
        output: redactSecrets(optionalRecord(body.output, "output")),
        now: parseNow(body.now, context.now)
      });

      writeJson(response, 200, { result });
      return;
    }

    if (method === "POST" && action === "fail") {
      const body = await readJsonBody<RunnerJobFailureBody>(request);
      const result = await scheduler.failJob({
        jobId: decodedJobId,
        runnerId: requireString(body.runnerId, "runnerId"),
        output: redactSecrets(optionalRecord(body.output, "output")),
        errorCode: requireString(body.errorCode, "errorCode"),
        errorMessage: redactSecrets(requireString(body.errorMessage, "errorMessage")),
        retryable: Boolean(body.retryable),
        now: parseNow(body.now, context.now)
      });

      writeJson(response, 200, { result });
      return;
    }

    if (method === "POST" && action === "logs") {
      const body = await readJsonBody<RunnerJobLogBody>(request);
      const event = await scheduler.recordJobLog({
        jobId: decodedJobId,
        runnerId: requireString(body.runnerId, "runnerId"),
        level: optionalString(body.level, "level"),
        message: redactSecrets(requireString(body.message, "message")),
        metadata: redactSecrets(optionalRecord(body.metadata, "metadata")),
        now: parseNow(body.now, context.now)
      });

      writeJson(response, 201, { event });
      return;
    }

    if (method === "POST" && action === "artifacts") {
      const scheduler = requireScheduler(context);
      const documentRepository = requireDocumentRepository(context);
      const body = await readJsonBody<RunnerJobArtifactBody>(request);
      const job = await scheduler.requireClaimedJob(decodedJobId, requireString(body.runnerId, "runnerId"));
      const artifact = await documentRepository.registerArtifact({
        documentId: optionalString(body.documentId, "documentId"),
        documentVersionId: optionalString(body.documentVersionId, "documentVersionId"),
        producerJobId: job.id,
        type: requireArtifactType(body.type),
        location: requireArtifactLocation(body.location),
        uri: redactSecrets(requireString(body.uri, "uri")),
        externalId: optionalString(body.externalId, "externalId"),
        externalVersion: optionalString(body.externalVersion, "externalVersion"),
        contentHash: optionalString(body.contentHash, "contentHash"),
        metadata: redactSecrets(optionalRecord(body.metadata, "metadata")),
        now: parseNow(body.now, context.now)
      });

      writeJson(response, 201, { artifact });
      return;
    }

    if (method === "GET" && action === "logs") {
      const logs = await scheduler.listJobLogs({
        jobId: decodedJobId,
        limit: optionalLimit(url.searchParams.get("limit")),
        cursor: optionalQueryString(url.searchParams.get("cursor"), "cursor")
      });

      writeJson(response, 200, {
        events: logs.events,
        nextCursor: logs.nextCursor
      });
      return;
    }
  }

  if (method === "GET" && path.startsWith("/state/")) {
    const prdJiraKey = decodeURIComponent(path.slice("/state/".length));

    if (context.readModel) {
      const state = await context.readModel.summarizeState(prdJiraKey);
      writeJson(response, state ? 200 : 404, state ?? { error: "PRD state not found" });
      return;
    }

    const state = summarizeState(requireCompatibilityFixture(context), prdJiraKey);
    writeJson(response, state ? 200 : 404, state ?? { error: "PRD state not found" });
    return;
  }

  if (method === "GET" && path.startsWith("/workflow-runs/")) {
    const [runId, child] = path.slice("/workflow-runs/".length).split("/");
    const decodedRunId = decodeURIComponent(runId);

    if (child === "tree") {
      const tree = context.readModel
        ? await context.readModel.summarizeWorkflowRunTree(decodedRunId)
        : summarizeWorkflowRunTree(
            createGenericPrdSnapshot(requireCompatibilityFixture(context).store),
            decodedRunId
          );
      writeJson(response, tree ? 200 : 404, tree ?? { error: "Workflow run not found" });
      return;
    }

    if (child === "events") {
      const scheduler = requireScheduler(context);
      const events = await scheduler.listRunEvents({
        runId: decodedRunId,
        type: optionalQueryString(url.searchParams.get("type"), "type"),
        limit: optionalLimit(url.searchParams.get("limit")),
        cursor: optionalQueryString(url.searchParams.get("cursor"), "cursor")
      });

      writeJson(response, 200, events);
      return;
    }

    const run = context.readModel
      ? await context.readModel.summarizeWorkflowRun(decodedRunId)
      : summarizeWorkflowRun(createGenericPrdSnapshot(requireCompatibilityFixture(context).store), decodedRunId);
    writeJson(response, run ? 200 : 404, run ?? { error: "Workflow run not found" });
    return;
  }

  if (path.startsWith("/documents/")) {
    const [documentId, child] = path.slice("/documents/".length).split("/");
    const decodedDocumentId = decodeURIComponent(documentId);

    if (method === "GET" && child === "current") {
      if (context.readModel) {
        const current = await context.readModel.summarizeDocumentCurrent(decodedDocumentId);
        writeJson(
          response,
          current ? 200 : 404,
          current
            ? { ...current, approvalGate: approvalGateForReadModelDocument(current.document) }
            : { error: "Document not found" }
        );
        return;
      }

      const fixture = requireCompatibilityFixture(context);
      const current = summarizeDocumentCurrent(fixture, createGenericPrdSnapshot(fixture.store), decodedDocumentId);
      writeJson(response, current ? 200 : 404, current ?? { error: "Document not found" });
      return;
    }

    if (method === "GET" && child === "versions") {
      const history = context.readModel
        ? await context.readModel.summarizeDocumentHistory(decodedDocumentId)
        : summarizeDocumentHistory(
            createGenericPrdSnapshot(requireCompatibilityFixture(context).store),
            decodedDocumentId
          );
      writeJson(response, history ? 200 : 404, history ?? { error: "Document not found" });
      return;
    }

    if (method === "POST" && child === "feedback" && context.readModel && !context.fixture) {
      const current = await context.readModel.summarizeDocumentCurrent(decodedDocumentId);

      if (!current) {
        writeJson(response, 404, { error: "Document not found" });
        return;
      }

      const body = await readJsonBody<DocumentFeedbackBody>(request);
      const feedback = feedbackItemForReadModelDocument(
        current.document,
        body,
        parseNow(body.now, context.now)
      );
      await requireFeedbackRevisionCommand(context).recordFeedback({ feedback });

      writeJson(response, 201, { feedback });
      return;
    }

    if (method === "POST" && child === "revisions" && context.readModel && !context.fixture) {
      const current = await context.readModel.summarizeDocumentCurrent(decodedDocumentId);

      if (!current) {
        writeJson(response, 404, { error: "Document not found" });
        return;
      }

      const body = await readJsonBody<DocumentRevisionBody>(request);
      const requestedAt = parseNow(body.now, context.now);
      const feedbackItems = selectReadModelRevisionFeedback(
        current.document.id,
        current.pendingFeedback,
        optionalStringArrayOrUndefined(body.feedbackItemIds, "feedbackItemIds")
      );
      const revisionJob = revisionJobForReadModelDocument(current, body, feedbackItems);
      const feedbackItemsForCommand = feedbackItems.map((feedback) => ({
        ...feedback,
        revisionJobId: revisionJob.id
      }));

      await requireFeedbackRevisionCommand(context).recordRevisionJob({
        runId: current.document.workflowRunId,
        job: revisionJob,
        feedbackItems: feedbackItemsForCommand,
        now: requestedAt
      });

      writeJson(response, 202, {
        status: "accepted",
        revisionJob,
        feedbackItemIds: feedbackItems.map((feedback) => feedback.id)
      });
      return;
    }

    if (method === "POST" && child === "wiki-feedback" && context.readModel && !context.fixture) {
      const collector = requireWikiFeedbackCollector(context);
      const current = await context.readModel.summarizeDocumentCurrent(decodedDocumentId);

      if (!current) {
        writeJson(response, 404, { error: "Document not found" });
        return;
      }

      const body = await readJsonBody<DocumentWikiFeedbackBody>(request);
      const currentWikiArtifact = currentWikiArtifactForReadModelDocument(current);
      const fallbackNow = parseNow(body.now, context.now);
      const collected = await collector.collectPageFeedback({
        pageId: optionalString(body.pageId, "pageId"),
        pageUrl: optionalString(body.pageUrl, "pageUrl") ?? currentWikiArtifact?.uri,
        limit: optionalPositiveInteger(body.limit, "limit"),
        includeResolved: optionalBoolean(body.includeResolved, "includeResolved")
      });
      const history = await context.readModel.summarizeDocumentHistory(decodedDocumentId);
      const knownFeedback = readModelFeedbackItems(history);
      const feedbackItems: FeedbackItem[] = [];
      let importedCount = 0;
      let duplicateCount = 0;

      for (const comment of collected.comments) {
        const existing = knownFeedback.find(
          (feedback) =>
            feedback.documentId === current.document.id &&
            feedback.source === "wiki" &&
            feedback.externalId === comment.externalId
        );
        const feedback =
          existing ??
          wikiFeedbackItemForReadModelDocument(current.document, comment, collected.pageId, fallbackNow);

        if (existing) {
          duplicateCount += 1;
        } else {
          importedCount += 1;
          knownFeedback.push(feedback);
        }

        feedbackItems.push(feedback);
      }

      const command = requireFeedbackRevisionCommand(context);

      for (const feedback of feedbackItems) {
        await command.recordFeedback({ feedback });
      }

      writeJson(response, 201, {
        pageId: collected.pageId,
        importedCount,
        duplicateCount,
        feedbackItems
      });
      return;
    }

    const fixture = requireCompatibilityFixture(context);
    const snapshot = createGenericPrdSnapshot(fixture.store);

    if (method === "POST" && child === "feedback") {
      const document = requireGenericDocument(snapshot, decodedDocumentId);
      const body = await readJsonBody<DocumentFeedbackBody>(request);
      const feedbackCreatedAt = parseNow(body.now, context.now);
      const feedback = fixture.workflow.recordFeedback(document.sourceKey, {
        source: optionalFeedbackSource(body.source),
        author: optionalString(body.author ?? body.requestedBy, "author"),
        body: requireString(body.body ?? body.feedback, "body"),
        now: feedbackCreatedAt
      });
      await recordFeedbackCommand(context, [feedback]);
      await persistFixtureSnapshot(context);

      writeJson(response, 201, { feedback });
      return;
    }

    if (method === "POST" && child === "wiki-feedback") {
      const collector = requireWikiFeedbackCollector(context);
      const document = requireGenericDocument(snapshot, decodedDocumentId);
      const body = await readJsonBody<DocumentWikiFeedbackBody>(request);
      const currentWikiArtifact = document.currentWikiArtifactId
        ? snapshot.artifacts.find((artifact) => artifact.id === document.currentWikiArtifactId)
        : undefined;
      const fallbackNow = parseNow(body.now, context.now);
      const collected = await collector.collectPageFeedback({
        pageId: optionalString(body.pageId, "pageId"),
        pageUrl: optionalString(body.pageUrl, "pageUrl") ?? currentWikiArtifact?.uri,
        limit: optionalPositiveInteger(body.limit, "limit"),
        includeResolved: optionalBoolean(body.includeResolved, "includeResolved")
      });
      const knownFeedbackIds = new Set(fixture.store.feedbackItems.map((feedback) => feedback.id));
      const feedbackItems: FeedbackItem[] = [];
      let importedCount = 0;
      let duplicateCount = 0;

      for (const comment of collected.comments) {
        const feedback = fixture.workflow.recordFeedback(document.sourceKey, {
          source: "wiki",
          author: comment.author,
          body: comment.body,
          now: dateFromIso(comment.createdAt) ?? fallbackNow,
          externalId: comment.externalId,
          externalUrl: comment.url,
          metadata: {
            ...(comment.metadata ?? {}),
            confluencePageId: collected.pageId
          }
        });

        if (knownFeedbackIds.has(feedback.id)) {
          duplicateCount += 1;
        } else {
          importedCount += 1;
          knownFeedbackIds.add(feedback.id);
        }

        feedbackItems.push(feedback);
      }
      await recordFeedbackCommand(context, feedbackItems);
      await persistFixtureSnapshot(context);

      writeJson(response, 201, {
        pageId: collected.pageId,
        importedCount,
        duplicateCount,
        feedbackItems
      });
      return;
    }

    if (method === "POST" && child === "revisions") {
      const document = requireGenericDocument(snapshot, decodedDocumentId);
      const body = await readJsonBody<DocumentRevisionBody>(request);
      const requestedAt = parseNow(body.now, context.now);
      const result = await fixture.workflow.requestDocumentRevision(document.sourceKey, {
        requestedBy: requireString(body.requestedBy, "requestedBy"),
        feedbackItemIds: optionalStringArrayOrUndefined(body.feedbackItemIds, "feedbackItemIds"),
        now: requestedAt
      });
      await recordRevisionJobCommand(context, result.jobId, result.feedbackItemIds, requestedAt);
      await persistFixtureSnapshot(context);

      writeJson(response, 202, {
        status: result.status,
        revisionJob: snapshotJobAfterAction(fixture, result.jobId),
        feedbackItemIds: result.feedbackItemIds
      });
      return;
    }

    if (method === "POST" && child === "fan-out") {
      const document = requireGenericDocument(snapshot, decodedDocumentId);
      const body = await readJsonBody<DocumentFanOutBody>(request);
      const requestedAt = parseNow(body.now, context.now);
      const result = await fixture.workflow.requestDocumentFanOut(document.sourceKey, {
        requestedBy: optionalString(body.requestedBy, "requestedBy"),
        includeAdr: optionalBoolean(body.includeAdr, "includeAdr") === true,
        adrTitle: optionalString(body.adrTitle, "adrTitle"),
        now: requestedAt
      });
      await recordWorkflowJobCommand(context, result.jobId, requestedAt);
      await persistFixtureSnapshot(context);

      writeJson(response, 202, {
        status: result.status,
        fanOutJob: snapshotJobAfterAction(fixture, result.jobId),
        fanOutStatus: result.status
      });
      return;
    }
  }

  if (path.startsWith("/approval-gates/")) {
    const [gateId, action] = path.slice("/approval-gates/".length).split("/");
    const decodedGateId = decodeURIComponent(gateId);
    const documentId = documentIdForApprovalGateId(decodedGateId);

    if (method === "GET" && action === undefined && context.readModel) {
      const current = await context.readModel.summarizeDocumentCurrent(documentId);
      writeJson(
        response,
        current ? 200 : 404,
        current
          ? { approvalGate: approvalGateForReadModelDocument(current.document) }
          : { error: "Approval gate not found" }
      );
      return;
    }

    if ((method === "POST" && (action === "refresh" || action === "approve" || action === "reject")) && context.readModel && !context.fixture) {
      const current = await context.readModel.summarizeDocumentCurrent(documentId);

      if (!current) {
        writeJson(response, 404, { error: "Approval gate not found" });
        return;
      }

      if (action === "refresh") {
        writeJson(response, 200, { approvalGate: approvalGateForReadModelDocument(current.document) });
        return;
      }

      const body = await readJsonBody<ApprovalActionBody>(request);
      const actedAt = parseNow(body.now, context.now);
      const targetStatus = action === "approve" ? "approved" : "needs_revision";
      const updatedDocument = readModelDocumentWithStatus(current.document, targetStatus, actedAt);
      const command = requireWorkflowTransitionCommand(context);

      await command.recordDocumentState({
        document: updatedDocument,
        now: actedAt
      });

      const downstreamJob =
        action === "approve" ? downstreamJobForApprovedReadModelDocument(current, body, actedAt) : undefined;

      if (downstreamJob) {
        await command.recordWorkflowJob({
          runId: updatedDocument.workflowRunId,
          job: downstreamJob,
          now: actedAt
        });
      }

      writeJson(response, 200, {
        approvalGate: approvalGateForReadModelAction(current.document, updatedDocument, body),
        routingJob: downstreamJob,
        routingStatus: downstreamJob ? "accepted" : undefined
      });
      return;
    }

    const fixture = requireCompatibilityFixture(context);
    const snapshot = createGenericPrdSnapshot(fixture.store);
    const document = requireGenericDocument(snapshot, documentId);

    if (method === "GET" && action === undefined) {
      writeJson(response, 200, { approvalGate: approvalGateForDocument(fixture, document) });
      return;
    }

    if (method === "POST" && action === "refresh") {
      const refreshedAt = context.now();
      const { approvalGate, downstreamJob } = refreshApprovalGate(fixture, document);
      await recordDocumentStateCommand(context, documentId, refreshedAt);
      await recordWorkflowJobCommand(context, downstreamJob?.jobId, refreshedAt);
      await persistFixtureSnapshot(context);
      writeJson(response, 200, { approvalGate });
      return;
    }

    if (method === "POST" && action === "approve") {
      const body = await readJsonBody<ApprovalActionBody>(request);
      const approvedAt = parseNow(body.now, context.now);
      const approvalGate = transitionApprovalGate(fixture, document, "approved", {
        actor: optionalString(body.requestedBy ?? body.actor, "requestedBy"),
        reason: optionalString(body.reason, "reason")
      });
      const downstreamJob = scheduleDownstreamAfterApproval(fixture, document, {
        requestedBy: optionalString(body.requestedBy ?? body.actor, "requestedBy"),
        includeAdr: optionalBoolean(body.includeAdr, "includeAdr") === true,
        adrTitle: optionalString(body.adrTitle, "adrTitle"),
        now: approvedAt
      });
      await recordDocumentStateCommand(context, documentId, approvedAt);
      await recordWorkflowJobCommand(context, downstreamJob?.jobId, approvedAt);
      await persistFixtureSnapshot(context);

      writeJson(response, 200, {
        approvalGate,
        routingJob: downstreamJob ? snapshotJobAfterAction(fixture, downstreamJob.jobId) : undefined,
        routingStatus: downstreamJob?.status
      });
      return;
    }

    if (method === "POST" && action === "reject") {
      const body = await readJsonBody<ApprovalActionBody>(request);
      const rejectedAt = parseNow(body.now, context.now);
      const approvalGate = transitionApprovalGate(fixture, document, "needs_revision", {
        actor: optionalString(body.requestedBy ?? body.actor, "requestedBy"),
        reason: optionalString(body.reason, "reason")
      });
      await recordDocumentStateCommand(context, documentId, rejectedAt);
      await persistFixtureSnapshot(context);
      writeJson(response, 200, { approvalGate });
      return;
    }
  }

  writeJson(response, 404, { error: "Not found" });
}

async function runCompatibilityWorkflowTick(
  context: WorkflowApiRequestContext
): Promise<{ progressed: boolean }> {
  const fixture = requireCompatibilityFixture(context);
  const schedulerProgressed = await runSchedulerOnce(fixture.store);
  const runnerProgressed = await runRunnerWorkerOnce(fixture.store, fixture.skills);
  const engineStep = await runEngineStep(fixture.store);
  const progressed = schedulerProgressed || runnerProgressed || engineStep.progressed;
  await recordEngineTransitionCommands(context, engineStep, context.now());
  await recordWorkflowResultProjectionCommand(context, engineStep);
  if (progressed) {
    await persistFixtureSnapshot(context);
  }

  return { progressed };
}

async function recordPrdIntakeCommand(context: WorkflowApiRequestContext, prdJiraKey: string): Promise<void> {
  if (!context.prdIntakeCommand) {
    return;
  }

  const fixture = requireCompatibilityFixture(context);
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
    now: context.now()
  });
}

async function intakePrdTicketWithoutFixture(
  context: WorkflowApiRequestContext,
  prdJiraKey: string
): Promise<{ status: "accepted" }> {
  const existingState = await context.readModel?.summarizeState(prdJiraKey);

  if (existingState) {
    return { status: "accepted" };
  }

  const jiraIssueReader = requireJiraIssueReader(context);
  const command = requirePrdIntakeCommand(context);
  const loaded = await jiraIssueReader.loadPrdWithSources(prdJiraKey);

  validatePrdIntakeIssue(loaded.prd, prdJiraKey, loaded.sources);

  const workItemId = `wi_${randomUUID()}`;

  await command.recordIntake({
    runId: `run_${randomUUID()}`,
    workItemId,
    jobId: `job_${randomUUID()}`,
    prdJiraKey,
    title: loaded.prd.summary,
    now: context.now()
  });

  return { status: "accepted" };
}

function validatePrdIntakeIssue(prd: ExternalIssue, prdJiraKey: string, sources: ExternalIssue[]): void {
  if (prd.key !== prdJiraKey || prd.issueType !== "prd") {
    throw new Error(`PRD Jira ticket is not readable: ${prdJiraKey}`);
  }

  if (!isPrdIntakeRequestedStatus(prd.status)) {
    throw new Error(`PRD Jira ticket is not ready for intake: ${prdJiraKey}`);
  }

  if (!prd.linkedSourceKeys?.length) {
    throw new Error(`PRD Jira ticket has no linked source requests: ${prdJiraKey}`);
  }

  const sourceKeys = new Set(sources.map((source) => source.key));

  for (const sourceKey of prd.linkedSourceKeys) {
    if (!sourceKeys.has(sourceKey)) {
      throw new Error(`Linked source request is not readable: ${sourceKey}`);
    }
  }
}

function isPrdIntakeRequestedStatus(status: string): boolean {
  return status === "prd_requested" || status === "PRD 요청";
}

async function recordFeedbackCommand(
  context: WorkflowApiRequestContext,
  feedbackItems: FeedbackItem[]
): Promise<void> {
  if (!context.feedbackRevisionCommand) {
    return;
  }

  for (const feedback of feedbackItems) {
    await context.feedbackRevisionCommand.recordFeedback({ feedback });
  }
}

async function recordRevisionJobCommand(
  context: WorkflowApiRequestContext,
  jobId: string,
  feedbackItemIds: string[],
  now: Date
): Promise<void> {
  if (!context.feedbackRevisionCommand) {
    return;
  }

  const fixture = requireCompatibilityFixture(context);
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
    feedbackItems: feedbackItemsForRevision(context, feedbackItemIds),
    now
  });
}

function feedbackItemsForRevision(context: WorkflowApiRequestContext, feedbackItemIds: string[]): FeedbackItem[] {
  const fixture = requireCompatibilityFixture(context);
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

async function recordDocumentStateCommand(
  context: WorkflowApiRequestContext,
  documentId: string,
  now: Date
): Promise<void> {
  if (!context.workflowTransitionCommand) {
    return;
  }

  const fixture = requireCompatibilityFixture(context);
  const document = createGenericPrdSnapshot(fixture.store).documents.find(
    (candidate) => candidate.id === documentId
  );

  if (!document) {
    throw new Error(`Workflow transition command could not find fixture document state: ${documentId}`);
  }

  await context.workflowTransitionCommand.recordDocumentState({ document, now });
}

async function recordWorkflowJobCommand(
  context: WorkflowApiRequestContext,
  jobId: string | undefined,
  now: Date
): Promise<void> {
  if (!context.workflowTransitionCommand || !jobId) {
    return;
  }

  await context.workflowTransitionCommand.recordWorkflowJob({
    ...workflowJobCommandInputForFixtureJob(requireCompatibilityFixture(context).store, jobId),
    now
  });
}

async function recordEngineTransitionCommands(
  context: WorkflowApiRequestContext,
  engineStep: WorkflowEngineStepResult,
  now: Date
): Promise<void> {
  if (!context.workflowTransitionCommand || !engineStep.progressed) {
    return;
  }

  const commandInput = createEngineTransitionCommandInput(requireCompatibilityFixture(context).store, engineStep, now);

  if (!commandInput) {
    return;
  }

  if (context.workflowTransitionCommand.recordEngineTransition) {
    await context.workflowTransitionCommand.recordEngineTransition(commandInput);
    return;
  }

  for (const document of commandInput.documents) {
    await context.workflowTransitionCommand.recordDocumentState({ document, now });
  }

  for (const job of commandInput.jobs) {
    await context.workflowTransitionCommand.recordWorkflowJob({ ...job, now });
  }
}

async function recordWorkflowResultProjectionCommand(
  context: WorkflowApiRequestContext,
  engineStep: WorkflowEngineStepResult
): Promise<void> {
  if (!context.workflowResultCommand) {
    return;
  }

  if (!engineStep.processedResult) {
    return;
  }

  const snapshot = createGenericPrdSnapshot(requireCompatibilityFixture(context).store);
  const jobsById = new Map(snapshot.workflowJobs.map((job) => [job.id, job]));
  const job = jobsById.get(engineStep.processedResult.jobId);

  if (!job) {
    throw new Error(`Workflow result command could not find fixture job state: ${engineStep.processedResult.jobId}`);
  }

  await context.workflowResultCommand.recordResultProjection({
    jobId: engineStep.processedResult.jobId,
    ...resultProjectionForRun(snapshot, job.runId)
  });
}

function resultProjectionForRun(snapshot: GenericPrdSnapshot, runId: string) {
  const jobs = snapshot.workflowJobs.filter((job) => job.runId === runId);
  const jobIds = new Set(jobs.map((job) => job.id));
  const documents = snapshot.documents.filter((document) => document.workflowRunId === runId);
  const documentIds = new Set(documents.map((document) => document.id));

  return {
    jobs,
    jobResults: snapshot.workflowJobResults.filter((result) => jobIds.has(result.jobId)),
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

async function persistFixtureSnapshot(context: WorkflowApiRequestContext): Promise<void> {
  if (!context.snapshotMirror) {
    return;
  }

  await context.snapshotMirror.persist(createGenericPrdSnapshot(requireCompatibilityFixture(context).store));
}

interface RunnerRegistrationBody {
  id?: unknown;
  ownerUserId?: unknown;
  mode?: unknown;
  teamIds?: unknown;
  allowedProjectIds?: unknown;
  allowedRepositoryIds?: unknown;
  capabilities?: unknown;
  engines?: unknown;
  defaultEngine?: unknown;
  concurrency?: unknown;
  now?: unknown;
}

type RunnerHeartbeatBody = Omit<RunnerRegistrationBody, "id">;

interface RunnerClaimBody {
  now?: unknown;
}

interface RunnerJobActionBody {
  runnerId?: unknown;
  now?: unknown;
}

interface RunnerJobResultBody extends RunnerJobActionBody {
  output?: unknown;
}

interface RunnerJobFailureBody extends RunnerJobResultBody {
  errorCode?: unknown;
  errorMessage?: unknown;
  retryable?: unknown;
}

interface RunnerJobCancelBody {
  requestedBy?: unknown;
  reason?: unknown;
  now?: unknown;
}

interface RunnerJobLogBody extends RunnerJobActionBody {
  level?: unknown;
  message?: unknown;
  metadata?: unknown;
}

interface RunnerJobArtifactBody extends RunnerJobActionBody {
  documentId?: unknown;
  documentVersionId?: unknown;
  type?: unknown;
  location?: unknown;
  uri?: unknown;
  externalId?: unknown;
  externalVersion?: unknown;
  contentHash?: unknown;
  metadata?: unknown;
}

interface DocumentFeedbackBody {
  source?: unknown;
  author?: unknown;
  requestedBy?: unknown;
  body?: unknown;
  feedback?: unknown;
  now?: unknown;
}

interface DocumentWikiFeedbackBody {
  pageId?: unknown;
  pageUrl?: unknown;
  limit?: unknown;
  includeResolved?: unknown;
  now?: unknown;
}

interface DocumentRevisionBody {
  requestedBy?: unknown;
  feedbackItemIds?: unknown;
  now?: unknown;
}

interface DocumentFanOutBody {
  requestedBy?: unknown;
  includeAdr?: unknown;
  adrTitle?: unknown;
  now?: unknown;
}

interface ApprovalActionBody {
  requestedBy?: unknown;
  actor?: unknown;
  reason?: unknown;
  includeAdr?: unknown;
  adrTitle?: unknown;
  now?: unknown;
}

function summarizeState(fixture: Fixture, prdJiraKey: string): Record<string, unknown> | undefined {
  const workItemIds = fixture.store.workItems
    .filter((workItem) => workItem.primaryJiraKey === prdJiraKey)
    .map((workItem) => workItem.id);
  const snapshot = createGenericPrdSnapshot(fixture.store);
  const document = snapshot.documents.find((candidate) => candidate.sourceKey === prdJiraKey);
  const externalIssue = fixture.store.externalIssues.get(prdJiraKey);

  if (workItemIds.length === 0 && !document && !externalIssue) {
    return undefined;
  }

  const currentVersion = document
    ? snapshot.documentVersions.find((version) => version.id === document.currentVersionId)
    : undefined;

  const jobs = fixture.store.agentJobs
    .filter((job) => workItemIds.includes(job.workItemId))
    .map((job) => ({
      id: job.id,
      type: job.jobType,
      jira: job.primaryJiraKey,
      status: job.status
    }));

  return {
    prdJiraKey,
    prdStatus: externalIssue?.status,
    policy: snapshot.policy,
    jobs,
    artifacts: latestArtifacts(fixture.store.artifacts).map((artifact) => ({
      type: artifact.type,
      location: artifact.location,
      url: artifact.url
    })),
    latestQualityResult: document
      ? snapshot.qualityResults
          .filter((qualityResult) => qualityResult.documentId === document.id)
          .at(-1) ?? null
      : null,
    latestRevisionSummary: currentVersion?.revisionSummary ?? null,
    latestResult: fixture.store.agentJobResults.at(-1)?.output ?? null
  };
}

function latestArtifacts<T extends { type: string; location: string; url?: string }>(artifacts: T[]): T[] {
  const byTypeAndLocation = new Map<string, T>();

  for (const artifact of artifacts) {
    byTypeAndLocation.set(`${artifact.type}:${artifact.location}`, artifact);
  }

  return Array.from(byTypeAndLocation.values());
}

function summarizeWorkflowRun(snapshot: GenericPrdSnapshot, runId: string): Record<string, unknown> | undefined {
  const run = snapshot.workflowRuns.find((candidate) => candidate.id === runId);

  if (!run) {
    return undefined;
  }

  return {
    run,
    policy: snapshot.policy,
    jobs: snapshot.workflowJobs.filter((job) => job.runId === runId),
    documents: snapshot.documents.filter((document) => document.workflowRunId === runId)
  };
}

function summarizeWorkflowRunTree(snapshot: GenericPrdSnapshot, runId: string): Record<string, unknown> | undefined {
  const summary = summarizeWorkflowRun(snapshot, runId);

  if (!summary) {
    return undefined;
  }

  const jobs = snapshot.workflowJobs.filter((job) => job.runId === runId);
  const documents = snapshot.documents.filter((document) => document.workflowRunId === runId);

  return {
    run: summary.run,
    policy: snapshot.policy,
    nodes: jobs.map((job) => ({
      id: job.id,
      type: "workflow_job",
      jobType: job.jobType,
      status: job.status,
      primaryDocumentId: primaryDocumentIdForJob(job, documents)
    })),
    documents
  };
}

function summarizeDocumentCurrent(
  fixture: Fixture,
  snapshot: GenericPrdSnapshot,
  documentId: string
): Record<string, unknown> | undefined {
  const document = snapshot.documents.find((candidate) => candidate.id === documentId);

  if (!document) {
    return undefined;
  }

  const currentArtifactIds = [document.currentMarkdownArtifactId, document.currentWikiArtifactId].filter(
    (id): id is string => Boolean(id)
  );

  return {
    document,
    policy: snapshot.policy,
    currentVersion:
      snapshot.documentVersions.find((version) => version.id === document.currentVersionId) ?? null,
    latestQualityResult:
      snapshot.qualityResults
        .filter((qualityResult) => qualityResult.documentId === documentId)
        .at(-1) ?? null,
    currentArtifacts: currentArtifactIds
      .map((artifactId) => snapshot.artifacts.find((artifact) => artifact.id === artifactId))
      .filter(Boolean),
    approvalGate: approvalGateForDocument(fixture, document),
    pendingFeedback: snapshot.feedbackItems.filter(
      (feedback) => feedback.documentId === documentId && !feedback.revisionJobId
    )
  };
}

function summarizeDocumentHistory(
  snapshot: GenericPrdSnapshot,
  documentId: string
): Record<string, unknown> | undefined {
  const document = snapshot.documents.find((candidate) => candidate.id === documentId);

  if (!document) {
    return undefined;
  }

  return {
    documentId,
    policy: snapshot.policy,
    versions: snapshot.documentVersions.filter((version) => version.documentId === documentId),
    qualityResults: snapshot.qualityResults.filter((qualityResult) => qualityResult.documentId === documentId),
    artifacts: snapshot.artifacts.filter((artifact) => artifact.documentId === documentId),
    feedbackItems: snapshot.feedbackItems.filter((feedback) => feedback.documentId === documentId)
  };
}

function requireGenericDocument(snapshot: GenericPrdSnapshot, documentId: string): Document {
  const document = snapshot.documents.find((candidate) => candidate.id === documentId);

  if (!document) {
    throw new HttpError(404, `Document not found: ${documentId}`);
  }

  return document;
}

function snapshotJobAfterAction(fixture: Fixture, jobId: string): WorkflowJob | undefined {
  return createGenericPrdSnapshot(fixture.store).workflowJobs.find((job) => job.id === jobId);
}

function documentIdForApprovalGateId(gateId: string): string {
  if (!gateId.startsWith("gate_")) {
    throw new HttpError(404, `Approval gate not found: ${gateId}`);
  }

  return gateId.slice("gate_".length);
}

function approvalGateForDocument(fixture: Fixture, document: Document): Record<string, unknown> {
  const workItem = workItemForDocument(fixture, document);
  const issue = fixture.store.externalIssues.get(document.sourceKey);

  return approvalGateForDocumentState(
    document,
    issue?.status ?? null,
    approvalStatusFor(workItem?.state, issue?.status)
  );
}

function approvalGateForReadModelDocument(document: Document): Record<string, unknown> {
  const externalStatus = externalApprovalStatusForDocumentStatus(document.status);

  return approvalGateForDocumentState(
    document,
    externalStatus,
    approvalStatusFor(undefined, externalStatus ?? undefined)
  );
}

function approvalGateForDocumentState(
  document: Document,
  externalStatus: string | null,
  status: string
): Record<string, unknown> {
  return {
    id: `gate_${document.id}`,
    documentId: document.id,
    source: "jira",
    sourceOfTruth: prdConfirmationWorkflowPolicy.approvalSource,
    action: prdConfirmationWorkflowPolicy.approvalAction,
    approvalRole: prdConfirmationWorkflowPolicy.approvalRoles[document.type],
    transition: prdConfirmationWorkflowPolicy.approvalTransition,
    downstreamStart: prdConfirmationWorkflowPolicy.downstreamStart,
    externalIssueKey: document.sourceKey,
    externalStatus,
    status
  };
}

function externalApprovalStatusForDocumentStatus(status: Document["status"]): string | null {
  if (status === "approval_pending") {
    return prdConfirmationWorkflowPolicy.approvalTransition.pendingStatus;
  }

  if (status === "approved" || status === "needs_revision") {
    return status;
  }

  return null;
}

function readModelDocumentWithStatus(
  document: Document,
  status: Extract<Document["status"], "approved" | "needs_revision">,
  now: Date
): Document {
  return {
    ...document,
    status,
    updatedAt: now.toISOString()
  };
}

function approvalGateForReadModelAction(
  originalDocument: Document,
  updatedDocument: Document,
  body: ApprovalActionBody
): Record<string, unknown> {
  const toExternalStatus = externalApprovalStatusForDocumentStatus(updatedDocument.status);

  return {
    ...approvalGateForReadModelDocument(updatedDocument),
    lastAction: {
      type: prdConfirmationWorkflowPolicy.approvalAction,
      sourceOfTruth: prdConfirmationWorkflowPolicy.approvalSource,
      actor: optionalString(body.requestedBy ?? body.actor, "requestedBy"),
      reason: optionalString(body.reason, "reason"),
      fromExternalStatus: externalApprovalStatusForDocumentStatus(originalDocument.status),
      toExternalStatus
    }
  };
}

function refreshApprovalGate(
  fixture: Fixture,
  document: Document
): {
  approvalGate: Record<string, unknown>;
  downstreamJob?: { status: "accepted" | "already_scheduled"; jobId: string };
} {
  const workItem = workItemForDocument(fixture, document);
  const issue = fixture.store.externalIssues.get(document.sourceKey);
  let downstreamJob: { status: "accepted" | "already_scheduled"; jobId: string } | undefined;

  if (workItem && issue?.status === "approved") {
    workItem.state = "approved";
    downstreamJob = scheduleDownstreamAfterApproval(fixture, document);
  }

  if (workItem && (issue?.status === "rejected" || issue?.status === "needs_revision")) {
    workItem.state = "needs_revision";
  }

  return {
    approvalGate: approvalGateForDocument(fixture, document),
    downstreamJob
  };
}

function transitionApprovalGate(
  fixture: Fixture,
  document: Document,
  targetStatus: "approved" | "needs_revision",
  metadata: { actor?: string; reason?: string }
): Record<string, unknown> {
  const workItem = workItemForDocument(fixture, document);
  const issue = fixture.store.externalIssues.get(document.sourceKey);
  const fromExternalStatus = issue?.status ?? null;

  if (workItem) {
    workItem.state = targetStatus === "approved" ? "approved" : "needs_revision";
  }

  if (issue) {
    issue.status = targetStatus;
  }

  return {
    ...approvalGateForDocument(fixture, document),
    lastAction: {
      type: prdConfirmationWorkflowPolicy.approvalAction,
      sourceOfTruth: prdConfirmationWorkflowPolicy.approvalSource,
      actor: metadata.actor,
      reason: metadata.reason,
      fromExternalStatus,
      toExternalStatus: issue?.status ?? targetStatus
    }
  };
}

function scheduleDownstreamAfterApproval(
  fixture: Fixture,
  document: Document,
  request: { requestedBy?: string; includeAdr?: boolean; adrTitle?: string; now?: Date } = {}
): { status: "accepted" | "already_scheduled"; jobId: string } | undefined {
  if (document.type === "prd") {
    return fixture.workflow.requestDownstreamRouting(document.sourceKey, request);
  }

  if (document.type === "hld" || document.type === "lld") {
    return fixture.workflow.requestDocumentFanOut(document.sourceKey, request);
  }

  if (document.type === "spec") {
    return fixture.workflow.requestImplementationStart(document.sourceKey, request);
  }

  return undefined;
}

function workItemForDocument(fixture: Fixture, document: Document) {
  const workItemId = document.id.startsWith("doc_") ? document.id.slice("doc_".length) : undefined;

  return fixture.store.workItems.find((candidate) => candidate.id === workItemId);
}

function primaryDocumentIdForJob(job: { id: string; input: Record<string, unknown> }, documents: Document[]): string | undefined {
  const sourceDocumentId = stringOrUndefined(job.input.sourceDocumentId);

  if (sourceDocumentId && documents.some((document) => document.id === sourceDocumentId)) {
    return sourceDocumentId;
  }

  const producedDocument = documents.find((document) => document.currentVersionId && document.currentVersionId.endsWith(job.id));

  if (producedDocument) {
    return producedDocument.id;
  }

  const parentDocumentId = stringOrUndefined(job.input.parentDocumentId);

  if (parentDocumentId && documents.some((document) => document.id === parentDocumentId)) {
    return parentDocumentId;
  }

  return documents[0]?.id;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function approvalStatusFor(workItemState: string | undefined, externalStatus: string | undefined): string {
  if (workItemState === "approved" || externalStatus === "approved") {
    return "approved";
  }

  if (workItemState === "needs_revision" || externalStatus === "needs_revision" || externalStatus === "rejected") {
    return "needs_revision";
  }

  if (workItemState === "awaiting_approval" || externalStatus === "awaiting_approval") {
    return "pending";
  }

  return "not_ready";
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function requireScheduler(context: WorkflowApiRequestContext): WorkflowScheduler {
  if (!context.scheduler) {
    throw new HttpError(503, "Workflow scheduler is not configured");
  }

  return context.scheduler;
}

function requireJiraIssueReader(context: WorkflowApiRequestContext): JiraIssueReader {
  if (!context.jiraIssueReader) {
    throw new HttpError(503, "Jira issue reader is not configured");
  }

  return context.jiraIssueReader;
}

function requirePrdIntakeCommand(context: WorkflowApiRequestContext): PrdIntakeCommand {
  if (!context.prdIntakeCommand) {
    throw new HttpError(503, "PRD intake command is not configured");
  }

  return context.prdIntakeCommand;
}

function requireCompatibilityFixture(context: WorkflowApiRequestContext): Fixture {
  if (!context.fixture) {
    throw new HttpError(501, "Compatibility fixture workflow is not configured");
  }

  return context.fixture;
}

function requireDocumentRepository(context: WorkflowApiRequestContext): DocumentRepository {
  if (!context.documentRepository) {
    throw new HttpError(503, "Document repository is not configured");
  }

  return context.documentRepository;
}

function requireWikiFeedbackCollector(context: WorkflowApiRequestContext): WikiFeedbackCollector {
  if (!context.wikiFeedbackCollector) {
    throw new HttpError(503, "Wiki feedback collector is not configured");
  }

  return context.wikiFeedbackCollector;
}

function requireFeedbackRevisionCommand(context: WorkflowApiRequestContext): FeedbackRevisionCommand {
  if (!context.feedbackRevisionCommand) {
    throw new HttpError(503, "Feedback revision command is not configured");
  }

  return context.feedbackRevisionCommand;
}

function requireWorkflowTransitionCommand(context: WorkflowApiRequestContext): WorkflowTransitionCommand {
  if (!context.workflowTransitionCommand) {
    throw new HttpError(503, "Workflow transition command is not configured");
  }

  return context.workflowTransitionCommand;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${name} is required`);
  }

  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, `${name} must be a string`);
  }

  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new HttpError(400, `${name} must be a boolean`);
  }

  return value;
}

function optionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, `${name} must be an array of strings`);
  }

  return value;
}

function optionalStringArrayOrUndefined(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return optionalStringArray(value, name);
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }

  return value;
}

function optionalLimit(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new HttpError(400, "limit must be a positive integer");
  }

  return Math.min(limit, 500);
}

function optionalQueryString(value: string | null, name: string): string | undefined {
  if (value === null) {
    return undefined;
  }

  if (value.length === 0) {
    throw new HttpError(400, `${name} must be non-empty`);
  }

  return value;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${name} must be an object`);
  }

  return value as Record<string, unknown>;
}

function optionalFeedbackSource(value: unknown): FeedbackSource | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "app" || value === "jira" || value === "wiki" || value === "github") {
    return value;
  }

  throw new HttpError(400, "source must be app, jira, wiki, or github");
}

function feedbackItemForReadModelDocument(document: Document, body: DocumentFeedbackBody, now: Date): FeedbackItem {
  const feedbackBody = requireString(body.body ?? body.feedback, "body").trim();

  if (!feedbackBody) {
    throw new HttpError(400, "body is required");
  }

  return {
    id: `fb_${randomUUID()}`,
    workItemId: workItemIdForDocumentId(document.id),
    documentId: document.id,
    source: optionalFeedbackSource(body.source) ?? "app",
    author: optionalString(body.author ?? body.requestedBy, "author"),
    body: feedbackBody,
    createdAt: now.toISOString()
  };
}

function wikiFeedbackItemForReadModelDocument(
  document: Document,
  comment: WikiCollectedFeedback,
  pageId: string,
  fallbackNow: Date
): FeedbackItem {
  return {
    id: `fb_${randomUUID()}`,
    workItemId: workItemIdForDocumentId(document.id),
    documentId: document.id,
    source: "wiki",
    author: comment.author,
    body: comment.body,
    createdAt: (dateFromIso(comment.createdAt) ?? fallbackNow).toISOString(),
    externalId: comment.externalId,
    externalUrl: comment.url,
    metadata: {
      ...(comment.metadata ?? {}),
      confluencePageId: pageId
    }
  };
}

function currentWikiArtifactForReadModelDocument(current: DocumentCurrentReadModel) {
  return (
    current.currentArtifacts.find((artifact) => artifact.id === current.document.currentWikiArtifactId) ??
    current.currentArtifacts.find((artifact) => artifact.type === "wiki_page")
  );
}

function readModelFeedbackItems(history: Record<string, unknown> | undefined): FeedbackItem[] {
  const feedbackItems = history?.feedbackItems;

  return Array.isArray(feedbackItems) ? [...(feedbackItems as FeedbackItem[])] : [];
}

function selectReadModelRevisionFeedback(
  documentId: string,
  pendingFeedback: FeedbackItem[],
  feedbackItemIds: string[] | undefined
): FeedbackItem[] {
  if (feedbackItemIds && feedbackItemIds.length > 0) {
    return feedbackItemIds.map((feedbackId) => {
      const feedback = pendingFeedback.find((candidate) => candidate.id === feedbackId);

      if (!feedback) {
        throw new HttpError(404, `Feedback not found: ${feedbackId}`);
      }

      return feedback;
    });
  }

  if (pendingFeedback.length === 0) {
    throw new HttpError(400, `No pending feedback found for document: ${documentId}`);
  }

  return pendingFeedback;
}

function revisionJobForReadModelDocument(
  current: DocumentCurrentReadModel,
  body: DocumentRevisionBody,
  feedbackItems: FeedbackItem[]
): AgentJob {
  return {
    id: `job_${randomUUID()}`,
    workItemId: workItemIdForDocumentId(current.document.id),
    jobType: revisionJobTypeForDocument(current.document),
    primaryJiraKey: current.document.sourceKey,
    status: "pending",
    input: {
      requestedBy: requireString(body.requestedBy, "requestedBy"),
      documentType: current.document.type,
      feedback: feedbackItems.map(formatFeedbackForRevision).join("\n"),
      feedbackItemIds: feedbackItems.map((feedback) => feedback.id),
      sourceDocumentId: current.document.id,
      currentDocumentVersionId: current.currentVersion?.id,
      currentDocumentVersionProducerJobId: current.currentVersion?.producerJobId,
      currentDocumentArtifactUrl: currentArtifactUrlForRevision(current)
    }
  };
}

function downstreamJobForApprovedReadModelDocument(
  current: DocumentCurrentReadModel,
  body: ApprovalActionBody,
  approvedAt: Date
): AgentJob | undefined {
  const document = current.document;
  const requestedBy = optionalString(body.requestedBy ?? body.actor, "requestedBy");
  const common = {
    id: `job_${randomUUID()}`,
    workItemId: workItemIdForDocumentId(document.id),
    primaryJiraKey: document.sourceKey,
    status: "pending" as const
  };

  if (document.type === "prd") {
    return {
      ...common,
      jobType: "prd.route_downstream",
      input: {
        requestedBy,
        approvedAt: approvedAt.toISOString(),
        sourceDocumentId: document.id
      }
    };
  }

  if (document.type === "hld" || document.type === "lld") {
    return {
      ...common,
      jobType: "document.fan_out",
      input: {
        requestedBy,
        approvedAt: approvedAt.toISOString(),
        sourceDocumentId: document.id,
        parentDocumentType: document.type,
        targetDocumentType: document.type === "hld" ? "lld" : "spec",
        includeAdr: optionalBoolean(body.includeAdr, "includeAdr") === true,
        adrTitle: optionalString(body.adrTitle, "adrTitle"),
        adrOnly: false
      }
    };
  }

  if (document.type === "spec") {
    return {
      ...common,
      jobType: "implementation.open_pr",
      input: {
        requestedBy,
        approvedAt: approvedAt.toISOString(),
        documentType: document.type,
        documentId: document.id,
        documentVersionId: current.currentVersion?.id,
        documentVersionProducerJobId: current.currentVersion?.producerJobId,
        sourceDocumentId: document.id,
        currentDocumentArtifactUrl: currentArtifactUrlForRevision(current),
        branchName: implementationBranchNameFor(document.sourceKey),
        baseBranch: "main",
        title: `Implement ${document.sourceKey}: ${document.title ?? document.sourceKey}`,
        body: implementationPullRequestBodyFor(document, {
          requestedBy,
          artifactUrl: currentArtifactUrlForRevision(current)
        }),
        draft: true
      }
    };
  }

  return undefined;
}

function revisionJobTypeForDocument(document: Document): AgentJob["jobType"] {
  return document.type === "prd" ? "prd.apply_feedback_revision" : "document.revise";
}

function currentArtifactUrlForRevision(current: DocumentCurrentReadModel): string | undefined {
  return (
    current.currentArtifacts.find((artifact) => artifact.id === current.document.currentMarkdownArtifactId)?.uri ??
    current.currentArtifacts.find((artifact) => artifact.type === "document_markdown")?.uri ??
    current.currentArtifacts[0]?.uri
  );
}

function formatFeedbackForRevision(feedback: FeedbackItem): string {
  const author = feedback.author ? ` by ${feedback.author}` : "";

  return `- [${feedback.source}${author}] ${feedback.body}`;
}

function implementationBranchNameFor(sourceKey: string): string {
  return `workflow/${sourceKey.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function implementationPullRequestBodyFor(
  document: Document,
  context: { requestedBy?: string; artifactUrl?: string }
): string {
  const lines = [
    `Generated from approved Spec ${document.sourceKey}.`,
    context.artifactUrl ? `Spec artifact: ${context.artifactUrl}` : undefined,
    context.requestedBy ? `Requested by: ${context.requestedBy}` : undefined
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function workItemIdForDocumentId(documentId: string): string {
  return documentId.startsWith("doc_") ? documentId.slice("doc_".length) : documentId;
}

function requireRunnerMode(value: unknown): RunnerMode {
  if (value === "managed" || value === "local") {
    return value;
  }

  throw new HttpError(400, "mode must be managed or local");
}

function requireArtifactType(value: unknown): ArtifactType {
  if (
    value === "document_markdown" ||
    value === "wiki_page" ||
    value === "runner_log" ||
    value === "generated_file" ||
    value === "pull_request"
  ) {
    return value;
  }

  throw new HttpError(400, "type must be a supported artifact type");
}

function requireArtifactLocation(value: unknown): ArtifactLocation {
  if (
    value === "git" ||
    value === "wiki" ||
    value === "database" ||
    value === "local_workspace" ||
    value === "external"
  ) {
    return value;
  }

  throw new HttpError(400, "location must be a supported artifact location");
}

function parseNow(value: unknown, fallback: () => Date): Date {
  if (value === undefined || value === null) {
    return fallback();
  }

  if (typeof value !== "string") {
    throw new HttpError(400, "now must be an ISO timestamp");
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "now must be an ISO timestamp");
  }

  return date;
}

function dateFromIso(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function statusCodeForError(error: unknown): number {
  if (error instanceof HttpError) {
    return error.statusCode;
  }

  if (!(error instanceof Error)) {
    return 500;
  }

  if (error.message.startsWith("Job not found:") || error.message.startsWith("Runner not found:")) {
    return 404;
  }

  if (error.message.includes("is not claimed by runner")) {
    return 409;
  }

  if (
    error.message.startsWith("PRD Jira ticket is not readable:") ||
    error.message.startsWith("Linked source request is not readable:")
  ) {
    return 404;
  }

  if (error.message.startsWith("PRD Jira ticket is not ready for intake:")) {
    return 409;
  }

  if (error.message.startsWith("PRD Jira ticket has no linked source requests:")) {
    return 400;
  }

  if (error.message === "Invalid event cursor") {
    return 400;
  }

  if (
    error.message.startsWith("Job cancellation requested:") ||
    error.message.startsWith("Job cancellation not requested:")
  ) {
    return 409;
  }

  if (error.message.startsWith("Document not found:")) {
    return 404;
  }

  if (error.message.startsWith("No new feedback found") || error.message === "Feedback body is required") {
    return 400;
  }

  if (error.message.startsWith("Feedback item already used")) {
    return 409;
  }

  if (error.message.startsWith("Feedback item not found")) {
    return 404;
  }

  if (error.message.startsWith("Confluence pageId or pageUrl is required")) {
    return 400;
  }

  return 500;
}

async function listenServer(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function isFetchBlockedPort(port: number): boolean {
  return fetchBlockedPorts.has(port);
}

const fetchBlockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080
]);

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
