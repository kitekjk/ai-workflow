import type {
  ArtifactLinkSummary,
  ExecutionEvent,
  FlowEdge,
  FlowNode,
  JobHistorySummary,
  PullRequestSummary,
  WorkflowRunSummary,
  WorkItem,
  WorkState,
} from './mockWorkflow'

type WorkflowJobStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'canceled'
  | 'skipped'
  | 'retrying'

type DocumentStatus =
  | 'draft'
  | 'quality_review'
  | 'needs_revision'
  | 'approval_pending'
  | 'approved'
  | 'canceled'

type WorkflowRun = {
  id: string
  workflowDefinitionId: string
  status: string
  sourceType?: string
  sourceKey: string
  createdAt: string
  updatedAt: string
}

type WorkflowJob = {
  id: string
  runId: string
  taskId?: string
  jobType: string
  primaryJiraKey?: string
  status: WorkflowJobStatus
  input: Record<string, unknown>
  requiredRole?: string
  requiredCapabilities?: string[]
  createdAt: string
  updatedAt: string
}

type WorkflowTask = {
  id: string
  runId: string
  parentTaskId?: string
  taskType: string
  sourceKey: string
  title: string
  status: string
  currentDocumentId?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type WorkflowJobResult = {
  id: string
  jobId: string
  runnerId?: string
  attemptNo: number
  status: 'succeeded' | 'failed' | 'canceled'
  output: Record<string, unknown>
  createdAt: string
}

type WorkflowDocument = {
  id: string
  workflowRunId: string
  workflowTaskId?: string
  parentDocumentId?: string
  type: string
  sourceKey: string
  title: string
  status: DocumentStatus
  currentVersionId?: string
  currentMarkdownArtifactId?: string
  currentWikiArtifactId?: string
}

type DocumentVersion = {
  id: string
  documentId: string
  version: number
  producerJobId: string
  summary?: string
  revisionSummary?: string
  revisionJobId?: string
  createdAt: string
}

type DocumentQualityResult = {
  id: string
  documentId: string
  documentVersionId?: string
  evaluatorJobId: string
  status: 'passed' | 'needs_revision'
  score?: number
  summary?: string
  missingInformation: string[]
  clarificationQuestions: string[]
  riskItems: string[]
  createdAt: string
}

type Artifact = {
  id: string
  documentId?: string
  documentVersionId?: string
  producerJobId: string
  type: string
  location: string
  uri: string
  externalId?: string
  externalVersion?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

type FeedbackItem = {
  id: string
  documentId: string
  source: string
  author?: string
  body: string
  createdAt: string
  revisionJobId?: string
}

type WorkflowEvent = {
  id: string
  runId: string
  jobId?: string
  type: string
  message: string
  metadata: Record<string, unknown>
  createdAt: string
}

type WorkflowRunner = {
  id: string
  ownerUserId?: string
  mode: 'managed' | 'local'
  status: string
  teamIds: string[]
  allowedProjectIds: string[]
  allowedRepositoryIds: string[]
  capabilities: string[]
  engines: string[]
  defaultEngine?: string
  concurrency: number
  lastHeartbeatAt?: string
  claimDiagnostics?: RunnerClaimDiagnostics
}

type RunnerClaimDiagnostics = {
  reason: string
  message: string
  runnerStatus: string
  activeJobCount?: number
  concurrency?: number
  candidateJobCount?: number
  nearestJobId?: string
  nearestBlocker?: string
}

type WorkflowEventsResponse = {
  events: WorkflowEvent[]
  nextCursor?: string
}

type WorkflowRunnersResponse = {
  runners: WorkflowRunner[]
}

type RunnerClaimResponse = {
  claim: {
    job: WorkflowJob
    runner: WorkflowRunner
  } | null
  diagnostics?: RunnerClaimDiagnostics
}

type ApprovalGate = {
  id: string
  documentId: string
  status: string
  source: string
  externalIssueKey: string
  externalStatus: string | null
}

type WorkflowRunResponse = {
  run: WorkflowRun
  tasks?: WorkflowTask[]
  jobs: WorkflowJob[]
  documents: WorkflowDocument[]
}

type DocumentCurrentResponse = {
  document: WorkflowDocument
  currentVersion: DocumentVersion | null
  latestQualityResult?: DocumentQualityResult | null
  currentArtifacts: Artifact[]
  approvalGate?: ApprovalGate
  pendingFeedback?: FeedbackItem[]
}

type DocumentHistoryResponse = {
  documentId: string
  versions: DocumentVersion[]
  qualityResults?: DocumentQualityResult[]
  artifacts: Artifact[]
  feedbackItems?: FeedbackItem[]
}

export type DashboardProjectSummary = {
  projectKey: string
  runId: string
  workflowVersion: string
  startedAt: string
  elapsed: string
}

export type ApiDashboardData = {
  summary: DashboardProjectSummary
  workflows: WorkflowRunSummary[]
  items: WorkItem[]
  events: ExecutionEvent[]
  runners: RunnerStatusSummary[]
}

export type RunnerStatusSummary = {
  id: string
  owner: string
  mode: string
  status: string
  capacity: string
  claim: string
  capabilities: string
  engines: string
  heartbeat: string
}

export type RunnerOnboardingCommand = {
  label: string
  command: string
}

export type RunnerOnboardingSummary = {
  runnerId: string
  ownerEmail: string
  apiBaseUrl: string
  mode: string
  defaultEngine: string
  capabilities: string[]
  engines: string[]
  environment: Record<string, string>
  powershellSetup: string[]
  commands: RunnerOnboardingCommand[]
  requirements: string[]
}

const apiBaseUrl = (import.meta.env.VITE_WORKFLOW_API_BASE_URL ?? '/api').replace(/\/$/, '')
const seededPrdKey = import.meta.env.VITE_WORKFLOW_SEED_PRD_KEY ?? 'PRD-100'
export const defaultRunId = import.meta.env.VITE_WORKFLOW_RUN_ID ?? 'run_1'
export const defaultActorEmail = import.meta.env.VITE_WORKFLOW_ACTOR_EMAIL ?? 'dashboard@example.com'

export type ApiActionResult = {
  runId?: string
  message?: string
}

export type LocalRunnerDrainSummary = {
  runnerId: string
  processedJobs: number
  stoppedReason: 'idle' | 'max_jobs'
  claims: Array<{
    jobId: string
    jobType: string
    resultStatus: string
  }>
}

export async function fetchApiDashboard(runId = defaultRunId): Promise<ApiDashboardData> {
  const runResponse = await apiGet<WorkflowRunResponse>(`/workflow-runs/${encodeURIComponent(runId)}`)
  const currentViews = await Promise.all(
    runResponse.documents.map((document) =>
      apiGet<DocumentCurrentResponse>(`/documents/${encodeURIComponent(document.id)}/current`),
    ),
  )
  const histories = await Promise.all(
    runResponse.documents.map((document) =>
      apiGet<DocumentHistoryResponse>(`/documents/${encodeURIComponent(document.id)}/versions`),
    ),
  )
  const ledgerEvents = await fetchApiRunEvents(runResponse.run.id)
  const runners = await fetchApiRunners()

  return mapApiDashboard(runResponse, currentViews, histories, ledgerEvents, runners)
}

export async function seedApiRun(
  actorEmail = defaultActorEmail,
  prdJiraKey = seededPrdKey,
): Promise<ApiActionResult> {
  const response = await apiPost<{ status: string; runId?: string }>('/prd/intake', {
    prdJiraKey,
    requestedBy: actorEmail,
  })

  return { runId: response.runId }
}

export async function tickApiRun(): Promise<void> {
  await apiPost('/tick', {})
}

export async function setApiQualityPasses(qualityPasses: boolean): Promise<void> {
  await apiPost('/test-controls/quality', { qualityPasses })
}

export async function recordApiFeedback(documentId: string, actorEmail = defaultActorEmail): Promise<void> {
  await apiPost(`/documents/${encodeURIComponent(documentId)}/feedback`, {
    source: 'app',
    author: actorEmail,
    body: 'Add success metric: reduce repeated FAQ handling time by 30%.',
  })
}

export async function requestApiRevision(documentId: string, actorEmail = defaultActorEmail): Promise<void> {
  await apiPost(`/documents/${encodeURIComponent(documentId)}/revisions`, {
    requestedBy: actorEmail,
  })
}

export async function approveApiGate(approvalGateId: string, actorEmail = defaultActorEmail): Promise<void> {
  await apiPost(`/approval-gates/${encodeURIComponent(approvalGateId)}/approve`, {
    requestedBy: actorEmail,
  })
}

export async function pauseApiRunner(runnerId: string): Promise<void> {
  await apiPost(`/runners/${encodeURIComponent(runnerId)}/pause`, {})
}

export async function resumeApiRunner(runnerId: string): Promise<void> {
  await apiPost(`/runners/${encodeURIComponent(runnerId)}/resume`, {})
}

export async function fetchApiRunnerOnboarding(
  ownerEmail = defaultActorEmail,
): Promise<RunnerOnboardingSummary> {
  return apiGet<RunnerOnboardingSummary>(`/runner-onboarding?ownerEmail=${encodeURIComponent(ownerEmail)}`)
}

export async function runApiFullSlice(actorEmail = defaultActorEmail): Promise<ApiActionResult> {
  const seed = await seedApiRun(actorEmail, fullSlicePrdKey())
  const runId = seed.runId ?? defaultRunId
  let processedJobs = 0
  let approvedDocuments = 0

  for (let cycle = 0; cycle < 10; cycle += 1) {
    const drain = await runApiLocalRunnerDrain(actorEmail, 40)
    const approvalCount = await approvePendingApiDocuments(runId, actorEmail)

    processedJobs += drain.processedJobs
    approvedDocuments += approvalCount

    if (drain.processedJobs === 0 && approvalCount === 0) {
      break
    }
  }

  return {
    runId,
    message: `Full API Slice complete: ${processedJobs} jobs processed, ${approvedDocuments} documents approved`,
  }
}

function fullSlicePrdKey(): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)

  return `PRD-SMOKE-DASH-${stamp}`
}

export async function runApiLocalRunnerDrain(
  actorEmail = defaultActorEmail,
  maxJobs = 6,
): Promise<LocalRunnerDrainSummary> {
  const runnerId = localRunnerIdForActor(actorEmail)
  const claims: LocalRunnerDrainSummary['claims'] = []

  await apiPost('/runners/register', {
    id: runnerId,
    ownerEmail: actorEmail,
    mode: 'local',
    allowedProjectIds: ['prd-confirmation'],
    allowedRepositoryIds: ['prd-docs'],
    capabilities: [
      'document.generate',
      'document.evaluate',
      'document.revise',
      'workflow.route',
      'workflow.fanout',
      'implementation.open_pr',
      'implementation.update_pr',
      'implementation.collect_pr_status',
    ],
    engines: ['codex', 'claude'],
    defaultEngine: 'codex',
    concurrency: 1,
  })

  for (let attempt = 0; attempt < maxJobs; attempt += 1) {
    const claimResponse = await apiPost<RunnerClaimResponse>(`/runners/${encodeURIComponent(runnerId)}/claim`, {})

    if (!claimResponse.claim) {
      return {
        runnerId,
        processedJobs: claims.length,
        stoppedReason: 'idle',
        claims,
      }
    }

    const job = claimResponse.claim.job

    await apiPost(`/runner-jobs/${encodeURIComponent(job.id)}/start`, { runnerId })
    await apiPost(`/runner-jobs/${encodeURIComponent(job.id)}/logs`, {
      runnerId,
      level: 'info',
      message: `Dashboard local runner started ${job.jobType}.`,
      metadata: {
        source: 'dashboard_local_runner',
      },
    })

    const result = await apiPost<{ result: WorkflowJobResult }>(
      `/runner-jobs/${encodeURIComponent(job.id)}/results`,
      {
        runnerId,
        output: dashboardRunnerOutputFor(job),
      },
    )
    await processRepositoryTransitionsUntilIdle()

    claims.push({
      jobId: job.id,
      jobType: job.jobType,
      resultStatus: result.result.status,
    })
  }

  return {
    runnerId,
    processedJobs: claims.length,
    stoppedReason: 'max_jobs',
    claims,
  }
}

async function approvePendingApiDocuments(runId: string, actorEmail: string): Promise<number> {
  const runResponse = await apiGet<WorkflowRunResponse>(`/workflow-runs/${encodeURIComponent(runId)}`)
  const currentViews = await Promise.all(
    runResponse.documents.map((document) =>
      apiGet<DocumentCurrentResponse>(`/documents/${encodeURIComponent(document.id)}/current`),
    ),
  )
  const pendingGates = currentViews
    .map((current) => current.approvalGate)
    .filter((gate): gate is ApprovalGate => gate !== undefined && gate.status === 'pending')

  for (const gate of pendingGates) {
    await approveApiGate(gate.id, actorEmail)
  }

  return pendingGates.length
}

async function processRepositoryTransitionsUntilIdle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    const result = await apiPost<{ processed: boolean }>('/repository-transitions/process-next', {})

    if (!result.processed) {
      return
    }
  }
}

function localRunnerIdForActor(actorEmail: string): string {
  const slug = actorEmail
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return `dashboard-local-${slug || 'actor'}`
}

function dashboardRunnerOutputFor(job: WorkflowJob): Record<string, unknown> {
  if (job.jobType === 'prd.generate_draft' || job.jobType === 'prd.apply_feedback_revision') {
    return {
      status: 'succeeded',
      summary: 'Dashboard local runner generated a PRD draft.',
      markdown: `# ${job.runId}\n\nGenerated by the dashboard local runner stub.`,
    }
  }

  if (job.jobType === 'prd.evaluate_quality' || job.jobType === 'document.evaluate') {
    return {
      status: 'passed',
      score: 0.93,
      summary: 'Dashboard local runner quality gate passed.',
    }
  }

  if (job.jobType === 'prd.route_downstream') {
    return {
      status: 'routed',
      route: 'hld',
      rationale: 'Approved PRD needs an HLD before detailed design.',
      downstreamDocuments: [
        {
          type: 'hld',
          title: 'HLD from approved PRD',
        },
      ],
    }
  }

  if (job.jobType === 'document.generate' || job.jobType === 'document.revise') {
    const documentType = stringInput(job, 'documentType') ?? 'document'
    const title = stringInput(job, 'title') ?? `${documentType.toUpperCase()} draft`

    return {
      status: 'succeeded',
      summary: `${title} generated by dashboard local runner.`,
      markdown: `# ${title}\n\nGenerated by the dashboard local runner stub.`,
    }
  }

  if (job.jobType === 'document.fan_out') {
    const targetDocumentType = stringInput(job, 'targetDocumentType') ?? 'spec'

    return {
      status: 'fanout_ready',
      targetDocumentType,
      rationale: 'Approved parent document is ready for downstream decomposition.',
    }
  }

  if (job.jobType === 'implementation.open_pr') {
    const pullRequestNumber = deterministicPullRequestNumber(job.id)

    return {
      status: 'succeeded',
      pullRequestNumber,
      pullRequestUrl: `https://github.example.com/workflow/demo/pull/${pullRequestNumber}`,
      reviewStatus: 'approved',
      ciStatus: 'success',
      documentVersionId: stringInput(job, 'documentVersionId'),
    }
  }

  if (job.jobType === 'implementation.update_pr') {
    const pullRequestNumber = numberInput(job, 'pullNumber') ?? deterministicPullRequestNumber(job.id)
    const pullRequestUrl = stringInput(job, 'pullRequestUrl') ?? `https://github.example.com/workflow/demo/pull/${pullRequestNumber}`

    return {
      status: 'succeeded',
      pullRequestNumber,
      pullRequestUrl,
      latestCommitSha: `stub-update-${job.id}`,
      summary: 'Dashboard local runner applied implementation rework.',
    }
  }

  if (job.jobType === 'implementation.collect_pr_status') {
    return {
      status: 'succeeded',
      reviewStatus: 'approved',
      ciStatus: 'success',
    }
  }

  return {
    status: 'succeeded',
    summary: `${job.jobType} completed by dashboard local runner.`,
  }
}

function stringInput(job: WorkflowJob, key: string): string | undefined {
  const value = job.input[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberInput(job: WorkflowJob, key: string): number | undefined {
  const value = job.input[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function deterministicPullRequestNumber(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 900
  }

  return 100 + hash
}

async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: 'GET' })
}

async function apiPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function fetchApiRunEvents(runId: string): Promise<WorkflowEvent[]> {
  try {
    const response = await apiGet<WorkflowEventsResponse>(`/workflow-runs/${encodeURIComponent(runId)}/events?limit=80`)
    return response.events
  } catch {
    return []
  }
}

async function fetchApiRunners(): Promise<WorkflowRunner[]> {
  try {
    const response = await apiGet<WorkflowRunnersResponse>('/runners')
    return response.runners
  } catch {
    return []
  }
}

async function apiRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init)

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined)
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `${response.status} ${response.statusText}`

    throw new Error(message)
  }

  return response.json() as Promise<T>
}

function mapApiDashboard(
  runResponse: WorkflowRunResponse,
  currentViews: DocumentCurrentResponse[],
  histories: DocumentHistoryResponse[],
  ledgerEvents: WorkflowEvent[],
  runners: WorkflowRunner[],
): ApiDashboardData {
  const apiTasks = runResponse.tasks ?? []
  const items = apiTasks.length
    ? orderTaskItems(mapWorkflowTaskItems(apiTasks, runResponse.jobs, currentViews, histories))
    : orderTaskItems(mapProjectedDocumentTaskItems(runResponse, currentViews, histories))
  const jobToTaskId = createJobToTaskIdMap(items)
  const documentToItemId = createDocumentToItemIdMap(items)
  const events = createEvents(runResponse, currentViews, histories, ledgerEvents, jobToTaskId, documentToItemId)
  const progress = calculateProgress(items)
  const workflow: WorkflowRunSummary = {
    id: `api-${runResponse.run.id}`,
    name: runResponse.run.workflowDefinitionId,
    projectKey: runResponse.run.sourceKey,
    runId: runResponse.run.id,
    state: mapRunState(runResponse.run.status, items),
    progress,
    owner: 'Workflow API',
    description: `${runResponse.run.sourceType ?? 'source'} ${runResponse.run.sourceKey}`,
    itemIds: items.map((item) => item.id),
    nodes: createNodes(items),
    edges: createEdges(items),
  }

  return {
    summary: {
      projectKey: runResponse.run.sourceKey,
      runId: runResponse.run.id,
      workflowVersion: runResponse.run.workflowDefinitionId,
      startedAt: formatDateTime(runResponse.run.createdAt),
      elapsed: formatElapsed(runResponse.run.createdAt, runResponse.run.updatedAt),
    },
    workflows: [workflow],
    items,
    events,
    runners: runners.map(mapRunnerSummary),
  }
}

function mapRunnerSummary(runner: WorkflowRunner): RunnerStatusSummary {
  return {
    id: runner.id,
    owner: runner.ownerUserId ?? 'Workflow API',
    mode: runner.mode,
    status: runner.status,
    capacity: formatRunnerCapacity(runner),
    claim: formatClaimDiagnostics(runner.claimDiagnostics),
    capabilities: compactList(runner.capabilities),
    engines: compactList(runner.defaultEngine ? [runner.defaultEngine, ...runner.engines] : runner.engines),
    heartbeat: formatTime(runner.lastHeartbeatAt),
  }
}

function formatRunnerCapacity(runner: WorkflowRunner): string {
  const activeJobCount = runner.claimDiagnostics?.activeJobCount
  const concurrency = runner.claimDiagnostics?.concurrency ?? runner.concurrency

  if (typeof activeJobCount === 'number' && Number.isFinite(activeJobCount)) {
    return `${activeJobCount}/${concurrency} slots`
  }

  return `${runner.concurrency} slot${runner.concurrency === 1 ? '' : 's'}`
}

function formatClaimDiagnostics(diagnostics?: RunnerClaimDiagnostics): string {
  if (!diagnostics) {
    return '--'
  }

  const reason = formatDiagnosticToken(diagnostics.reason)

  if (diagnostics.reason === 'claim_available') {
    return diagnostics.nearestJobId ? `ready: ${diagnostics.nearestJobId}` : reason
  }

  if (diagnostics.reason === 'no_matching_job' && diagnostics.nearestBlocker) {
    return `${reason}: ${formatDiagnosticToken(diagnostics.nearestBlocker)}`
  }

  return reason
}

function formatDiagnosticToken(value: string): string {
  return value.replaceAll('_', ' ')
}

function compactList(values: string[]): string {
  const uniqueValues = [...new Set(values.filter(Boolean))]

  if (!uniqueValues.length) {
    return '--'
  }

  return uniqueValues.slice(0, 3).join(', ')
}

function artifactLinksFor(
  current: DocumentCurrentResponse,
  history: DocumentHistoryResponse,
): ArtifactLinkSummary[] {
  const artifactsById = new Map<string, Artifact>()

  for (const artifact of [...history.artifacts, ...current.currentArtifacts]) {
    artifactsById.set(artifact.id, artifact)
  }

  return [...artifactsById.values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      location: artifact.location,
      uri: artifact.uri,
      createdAt: artifact.createdAt,
    }))
}

function pullRequestsFor(artifacts: Artifact[]): PullRequestSummary[] {
  return artifacts
    .filter((artifact) => artifact.type === 'pull_request')
    .map((artifact) => {
      const pullRequestNumber =
        metadataToken(artifact.metadata?.pullRequestNumber) ?? metadataToken(artifact.externalId)
      const reviewStatus = metadataToken(artifact.metadata?.reviewStatus)
      const ciStatus = metadataToken(artifact.metadata?.ciStatus)
      const pullRequestState =
        metadataToken(artifact.metadata?.pullRequestState) ?? metadataToken(artifact.metadata?.state)
      const merged = metadataBoolean(artifact.metadata?.merged)

      return {
        id: artifact.id,
        label: pullRequestNumber ? `#${pullRequestNumber}` : 'PR',
        url: artifact.uri,
        reviewStatus,
        ciStatus,
        pullRequestState,
        merged,
        source: metadataToken(artifact.metadata?.source),
        createdAt: artifact.createdAt,
      }
    })
}

function latestDocumentArtifactFor(currentArtifacts: Artifact[], historyArtifacts: Artifact[]): Artifact | undefined {
  return (
    currentArtifacts.find((artifact) => artifact.type === 'document_markdown') ??
    currentArtifacts.find((artifact) => artifact.type === 'wiki_page') ??
    [...historyArtifacts].reverse().find((artifact) => artifact.type !== 'pull_request') ??
    historyArtifacts.at(-1)
  )
}

function metadataToken(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  return undefined
}

function metadataBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }

  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  return undefined
}

function mapProjectedDocumentTaskItems(
  runResponse: WorkflowRunResponse,
  currentViews: DocumentCurrentResponse[],
  histories: DocumentHistoryResponse[],
): WorkItem[] {
  const documentDepths = createDocumentDepths(runResponse.documents)
  const jobsByDocumentId = groupWorkflowJobsByDocument(runResponse.jobs, runResponse.documents)
  const mappedDocumentItems = currentViews.map((current, index) =>
    mapDocumentItem(
      current,
      histories[index],
      index,
      documentDepths,
      documentTaskJobsFor(jobsByDocumentId.get(current.document.id) ?? []),
    ),
  )
  const implementationItems = createImplementationTaskItems(mappedDocumentItems, jobsByDocumentId)
  const documentItems = stripImplementationPrsFromDocumentTasks(mappedDocumentItems, implementationItems)

  return [...documentItems, ...implementationItems]
}

function mapWorkflowTaskItems(
  tasks: WorkflowTask[],
  jobs: WorkflowJob[],
  currentViews: DocumentCurrentResponse[],
  histories: DocumentHistoryResponse[],
): WorkItem[] {
  const documents = currentViews.map((current) => current.document)
  const currentByDocumentId = new Map(currentViews.map((current) => [current.document.id, current]))
  const historyByDocumentId = new Map(histories.map((history) => [history.documentId, history]))
  const taskDepths = createWorkflowTaskDepths(tasks)
  const jobsByTaskId = groupWorkflowJobsByTask(jobs, tasks, documents)

  return tasks.map((task, index) => {
    const current = currentByDocumentId.get(task.currentDocumentId ?? '') ??
      currentViews.find((candidate) => candidate.document.workflowTaskId === task.id)
    const history = current ? historyByDocumentId.get(current.document.id) : undefined
    const taskJobs = jobsByTaskId.get(task.id) ?? []

    if (task.taskType === 'code') {
      return mapCodeTaskItem(task, taskDepths, taskJobs, current, history)
    }

    if (current && history) {
      return mapDocumentItem(current, history, index, taskDepths, taskJobs, task)
    }

    return mapBareTaskItem(task, index, taskDepths, taskJobs)
  })
}

function mapBareTaskItem(
  task: WorkflowTask,
  index: number,
  taskDepths: Map<string, number>,
  jobs: WorkflowJob[],
): WorkItem {
  const latestJob = jobs.at(-1)
  const firstJob = jobs[0]
  const state = mapTaskState(task.status, jobs)

  return {
    id: task.id,
    itemKind: 'task',
    taskKind: taskKindForDocument(task.taskType),
    parentId: task.parentTaskId ?? null,
    depth: taskDepths.get(task.id) ?? 0,
    title: task.title || task.sourceKey,
    artifactType: toArtifactType(task.taskType),
    jiraKey: task.sourceKey,
    state,
    agentJobId: latestJob?.id ?? 'not-started',
    qualityScore: null,
    qualityThreshold: 85,
    retryCount: retryCountForJobs(jobs, 0),
    githubPr: '--',
    sourceArtifact: task.currentDocumentId ?? 'source snapshot',
    targetRepo: 'workflow-api',
    targetPath: task.currentDocumentId ? `documents/${task.currentDocumentId}` : `tasks/${task.id}`,
    startedAt: formatTime(firstJob?.createdAt ?? task.createdAt),
    finishedAt: state === 'completed' ? formatTime(latestJob?.updatedAt ?? task.updatedAt) : undefined,
    summary: `${task.taskType.toUpperCase()} task from the live Workflow API snapshot.`,
    owner: index === 0 ? 'Product Ops' : 'Workflow API',
    skill: `${task.taskType}.task`,
    versionCount: 0,
    artifactCount: 0,
    qualityRiskCount: 0,
    artifactLinks: [],
    pullRequests: [],
    jobHistory: jobHistoryFor(jobs),
    gateResult: taskGateResult(state),
    links: apiLinks(task.sourceKey, task.currentDocumentId ?? task.id),
  }
}

function mapCodeTaskItem(
  task: WorkflowTask,
  taskDepths: Map<string, number>,
  jobs: WorkflowJob[],
  current?: DocumentCurrentResponse,
  history?: DocumentHistoryResponse,
): WorkItem {
  const artifacts = history?.artifacts ?? []
  const pullRequests = pullRequestsFor(artifacts)
  const latestJob = jobs.at(-1)
  const firstJob = jobs[0]
  const latestPullRequest = pullRequests.at(-1)
  const state = implementationTaskState(task.status, jobs, pullRequests)
  const documentId = current?.document.id ?? task.currentDocumentId
  const sourceKey = current?.document.sourceKey ?? task.sourceKey

  return {
    id: task.id,
    itemKind: 'task',
    taskKind: 'code',
    documentId,
    documentType: current?.document.type,
    parentId: task.parentTaskId ?? null,
    depth: taskDepths.get(task.id) ?? 0,
    title: task.title || `Code Implementation for ${sourceKey}`,
    artifactType: toArtifactType(current?.document.type ?? 'spec'),
    jiraKey: `${sourceKey}-CODE`,
    state,
    agentJobId: latestJob?.id ?? 'not-started',
    qualityScore: null,
    qualityThreshold: 85,
    retryCount: Math.max(0, jobs.length - 1),
    githubPr: latestPullRequest?.label ?? '--',
    sourceArtifact: current?.currentVersion?.id ?? task.currentDocumentId ?? 'source snapshot',
    targetRepo: latestPullRequest ? 'implementation PR' : 'workflow-api',
    targetPath: latestPullRequest?.url ?? `implementation/${sourceKey}`,
    startedAt: formatTime(firstJob?.createdAt ?? task.createdAt),
    finishedAt: state === 'completed' ? formatTime(latestJob?.updatedAt ?? latestPullRequest?.createdAt) : undefined,
    summary: `Tracks code execution jobs and pull request status for ${current?.document.title ?? sourceKey}.`,
    owner: 'Developer',
    skill: 'implementation',
    versionCount: 0,
    artifactCount: pullRequests.length,
    qualityRiskCount: 0,
    artifactLinks: artifacts
      .filter((artifact) => artifact.type === 'pull_request')
      .map((artifact) => ({
        id: artifact.id,
        type: artifact.type,
        location: artifact.location,
        uri: artifact.uri,
        createdAt: artifact.createdAt,
      })),
    pullRequests,
    jobHistory: jobHistoryFor(jobs),
    gateResult: implementationGateResult(state),
    links: apiLinks(sourceKey, documentId ?? task.id, latestPullRequest?.url, latestPullRequest?.url),
  }
}

function mapDocumentItem(
  current: DocumentCurrentResponse,
  history: DocumentHistoryResponse,
  index: number,
  documentDepths: Map<string, number>,
  jobs: WorkflowJob[],
  task?: WorkflowTask,
): WorkItem {
  const document = current.document
  const artifactLinks = artifactLinksFor(current, history)
  const pullRequests = pullRequestsFor(history.artifacts)
  const latestPullRequest = pullRequests.at(-1)
  const latestDocumentArtifact = latestDocumentArtifactFor(current.currentArtifacts, history.artifacts)
  const latestQualityResult = current.latestQualityResult ?? history.qualityResults?.at(-1)
  const versionSummary = current.currentVersion?.summary ?? `${document.type.toUpperCase()} document`
  const latestJob = jobs.at(-1)
  const firstJob = jobs[0]
  const documentState = mapDocumentState(document.status, current.approvalGate?.status)
  const state = task && documentState === 'pending' ? mapTaskState(task.status, jobs) : documentState

  return {
    id: task?.id ?? document.workflowTaskId ?? document.id,
    itemKind: 'task',
    taskKind: taskKindForDocument(task?.taskType ?? document.type),
    documentId: document.id,
    documentType: document.type,
    approvalGateId: current.approvalGate?.id,
    parentId: task?.parentTaskId ?? document.parentDocumentId ?? null,
    depth: documentDepths.get(task?.id ?? document.id) ?? documentDepths.get(document.id) ?? 0,
    title: task?.title || document.title || document.sourceKey,
    artifactType: toArtifactType(task?.taskType ?? document.type),
    jiraKey: task?.sourceKey ?? document.sourceKey,
    state,
    agentJobId: latestJob?.id ?? current.currentVersion?.producerJobId ?? 'not-started',
    qualityScore: latestQualityResult?.score ?? null,
    qualityThreshold: 85,
    retryCount: retryCountForJobs(jobs, history.versions.length),
    githubPr: latestPullRequest?.label ?? (latestDocumentArtifact?.location === 'git' ? 'artifact' : '--'),
    sourceArtifact: current.currentVersion?.id ?? 'source snapshot',
    targetRepo: latestPullRequest ? 'implementation PR' : latestDocumentArtifact?.location ?? 'workflow-api',
    targetPath: latestPullRequest?.url ?? latestDocumentArtifact?.uri ?? `documents/${document.id}`,
    startedAt: formatTime(firstJob?.createdAt ?? current.currentVersion?.createdAt),
    finishedAt: state === 'completed' || state === 'waiting_approval' ? formatTime(latestJob?.updatedAt ?? current.currentVersion?.createdAt) : undefined,
    summary: versionSummary,
    owner: index === 0 ? 'Product Ops' : 'Workflow API',
    skill: task?.taskType === 'code' ? 'implementation' : `${document.type}.document`,
    versionCount: history.versions.length,
    artifactCount: history.artifacts.length,
    qualityRiskCount: latestQualityResult?.riskItems.length ?? 0,
    artifactLinks,
    pullRequests,
    jobHistory: jobHistoryFor(jobs),
    gateResult: mapGateResult(current.approvalGate?.status, document.status),
    links: apiLinks(document.sourceKey, document.id, latestDocumentArtifact?.uri, latestPullRequest?.url),
  }
}

function createEvents(
  runResponse: WorkflowRunResponse,
  currentViews: DocumentCurrentResponse[],
  histories: DocumentHistoryResponse[],
  ledgerEvents: WorkflowEvent[],
  jobToTaskId: Map<string, string>,
  documentToItemId: Map<string, string>,
): ExecutionEvent[] {
  const documentIds = new Set(currentViews.map((current) => current.document.id))
  const apiLedgerEvents = ledgerEvents.map((event, index) => ({
    id: `api-ledger-${event.id}`,
    timestamp: formatTime(event.createdAt),
    itemId: itemIdForLedgerEvent(
      event,
      documentIds,
      jobToTaskId,
      documentToItemId,
      documentToItemId.get(currentViews[0]?.document.id ?? '') ?? currentViews[0]?.document.id ?? runResponse.run.id,
    ),
    event: event.type,
    level: levelForLedgerEvent(event),
    message: formatLedgerEventMessage(event),
    order: -100 + index,
  }))
  const jobEvents = runResponse.jobs.map((job, index) => ({
    id: `api-job-${job.id}`,
    timestamp: formatTime(job.updatedAt),
    itemId:
      jobToTaskId.get(job.id) ??
      documentToItemId.get(currentViews[0]?.document.id ?? '') ??
      currentViews[0]?.document.id ??
      runResponse.run.id,
    event: `job.${job.status}`,
    level: eventLevelForState(mapJobState(job.status)),
    message: `${job.jobType} is ${job.status}.`,
    order: index,
  }))
  const artifactEvents = histories.flatMap((history, historyIndex) =>
    history.artifacts.map((artifact, index) => ({
      id: `api-artifact-${artifact.id}`,
      timestamp: formatTime(artifact.createdAt),
      itemId:
        (artifact.type === 'pull_request' ? jobToTaskId.get(artifact.producerJobId) : undefined) ??
        documentToItemId.get(artifact.documentId ?? '') ??
        artifact.documentId ??
        currentViews[historyIndex]?.document.id ??
        history.documentId,
      event: 'artifact.registered',
      level: 'success' as const,
      message: `${artifact.type} registered at ${artifact.location}.`,
      order: 100 + historyIndex * 10 + index,
    })),
  )
  const feedbackEvents = histories.flatMap((history, historyIndex) =>
    (history.feedbackItems ?? []).map((feedback, index) => ({
      id: `api-feedback-${feedback.id}`,
      timestamp: formatTime(feedback.createdAt),
      itemId:
        documentToItemId.get(feedback.documentId ?? '') ??
        feedback.documentId ??
        currentViews[historyIndex]?.document.id ??
        history.documentId,
      event: feedback.revisionJobId ? 'feedback.applied' : 'feedback.recorded',
      level: feedback.revisionJobId ? ('success' as const) : ('warning' as const),
      message: `${feedback.source} feedback${feedback.author ? ` from ${feedback.author}` : ''} ${
        feedback.revisionJobId ? 'attached to revision' : 'stored'
      }.`,
      order: 200 + historyIndex * 10 + index,
    })),
  )
  const qualityEvents = histories.flatMap((history, historyIndex) =>
    (history.qualityResults ?? []).map((qualityResult, index) => ({
      id: `api-quality-${qualityResult.id}`,
      timestamp: formatTime(qualityResult.createdAt),
      itemId:
        documentToItemId.get(qualityResult.documentId ?? '') ??
        qualityResult.documentId ??
        currentViews[historyIndex]?.document.id ??
        history.documentId,
      event: `quality.${qualityResult.status}`,
      level: qualityResult.status === 'passed' ? ('success' as const) : ('warning' as const),
      message: `Quality gate ${qualityResult.status}${qualityResult.score !== undefined ? ` at ${qualityResult.score}/100` : ''}.`,
      order: 300 + historyIndex * 10 + index,
    })),
  )

  return [...apiLedgerEvents, ...jobEvents, ...artifactEvents, ...feedbackEvents, ...qualityEvents]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...event }) => event)
}

function itemIdForLedgerEvent(
  event: WorkflowEvent,
  documentIds: Set<string>,
  jobToTaskId: Map<string, string>,
  documentToItemId: Map<string, string>,
  fallbackId: string,
): string {
  if (event.jobId) {
    const taskId = jobToTaskId.get(event.jobId)

    if (taskId) {
      return taskId
    }
  }

  const jobId = stringMetadata(event.metadata.jobId)

  if (jobId) {
    const taskId = jobToTaskId.get(jobId)

    if (taskId) {
      return taskId
    }
  }

  const documentId = stringMetadata(event.metadata.documentId)

  if (documentId && documentIds.has(documentId)) {
    return documentToItemId.get(documentId) ?? documentId
  }

  return fallbackId
}

function formatLedgerEventMessage(event: WorkflowEvent): string {
  const actor = actorForLedgerEvent(event)
  return actor ? `${event.message} by ${actor}.` : event.message
}

function actorForLedgerEvent(event: WorkflowEvent): string | undefined {
  return (
    stringMetadata(event.metadata.actor) ??
    stringMetadata(event.metadata.requestedBy) ??
    stringMetadata(event.metadata.author) ??
    stringMetadata(event.metadata.runnerId)
  )
}

function levelForLedgerEvent(event: WorkflowEvent): ExecutionEvent['level'] {
  if (event.type.includes('failed') || event.type.includes('failure')) {
    return 'error'
  }

  if (event.type.includes('feedback') || event.type.includes('revision') || event.type.includes('cancel')) {
    return 'warning'
  }

  if (event.type.includes('approved') || event.type.includes('transition') || event.type.includes('recorded')) {
    return 'success'
  }

  return 'info'
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

const apiFlowColumnStep = 164
const apiFlowRowStep = 150

function createNodes(taskItems: WorkItem[]): FlowNode[] {
  const taskRows = createTaskRows(taskItems)

  return taskItems.map((item, index) => {
    const x = 24 + item.depth * apiFlowColumnStep
    const y = 48 + (taskRows.get(item.id) ?? index) * apiFlowRowStep

    return flowNodeFromItem(item, x, y, documentNodeKind(item))
  })
}

function createTaskRows(taskItems: WorkItem[]): Map<string, number> {
  const byId = new Map(taskItems.map((task) => [task.id, task]))
  const childrenByParent = new Map<string, WorkItem[]>()
  const roots: WorkItem[] = []

  for (const task of taskItems) {
    if (task.parentId && byId.has(task.parentId)) {
      const children = childrenByParent.get(task.parentId) ?? []
      children.push(task)
      childrenByParent.set(task.parentId, children)
    } else {
      roots.push(task)
    }
  }

  const rows = new Map<string, number>()
  let nextRow = 0
  const visit = (task: WorkItem, inheritedRow?: number) => {
    const row = inheritedRow ?? nextRow

    if (inheritedRow === undefined) {
      nextRow += 1
    }

    rows.set(task.id, row)

    ;(childrenByParent.get(task.id) ?? []).sort(compareTaskItems).forEach((child, index) => {
      visit(child, index === 0 ? row : undefined)
    })
  }

  roots.sort(compareTaskItems).forEach((root) => visit(root))
  return rows
}

function createEdges(taskItems: WorkItem[]): FlowEdge[] {
  if (!taskItems.length) {
    return []
  }

  return taskItems
    .filter((task) => task.parentId)
    .map((task) => ({
      id: `api-edge-${task.parentId}-${task.id}`,
      from: nodeIdForItem(String(task.parentId)),
      to: nodeIdForItem(task.id),
    }))
}

function documentNodeKind(item: WorkItem): FlowNode['kind'] {
  if (item.parentId) {
    return 'child_workflow'
  }

  return 'trigger'
}

function flowNodeFromItem(item: WorkItem, x: number, y: number, kind: FlowNode['kind']): FlowNode {
  return {
    id: nodeIdForItem(item.id),
    label: compactLabel(item.title),
    subtitle: item.jiraKey,
    kind,
    state: item.state,
    x,
    y,
    workItemId: item.id,
  }
}

function nodeIdForItem(itemId: string): string {
  return `api-node-${itemId}`
}

function mapRunState(status: string, items: WorkItem[]): WorkState {
  if (status === 'failed' || items.some((item) => item.state === 'failed')) {
    return 'failed'
  }

  if (status === 'completed' || items.every((item) => item.state === 'completed')) {
    return 'completed'
  }

  if (items.some((item) => item.state === 'waiting_approval')) {
    return 'waiting_approval'
  }

  return items.some((item) => item.state === 'running') ? 'running' : 'pending'
}

function mapDocumentState(status: DocumentStatus, approvalStatus?: string): WorkState {
  if (status === 'approved' || approvalStatus === 'approved') {
    return 'completed'
  }

  if (status === 'approval_pending' || approvalStatus === 'pending') {
    return 'waiting_approval'
  }

  if (status === 'needs_revision' || approvalStatus === 'needs_revision') {
    return 'failed'
  }

  if (status === 'quality_review') {
    return 'running'
  }

  if (status === 'canceled') {
    return 'blocked'
  }

  return 'pending'
}

function mapJobState(status: WorkflowJobStatus): WorkState {
  if (status === 'succeeded' || status === 'skipped') {
    return 'completed'
  }

  if (status === 'failed' || status === 'canceled') {
    return 'failed'
  }

  if (status === 'running' || status === 'claimed' || status === 'retrying') {
    return 'running'
  }

  if (status === 'cancel_requested') {
    return 'blocked'
  }

  return 'pending'
}

function mapTaskState(status: string, jobs: WorkflowJob[]): WorkState {
  if (status === 'approved' || status === 'completed') {
    return 'completed'
  }

  if (status === 'failed' || status === 'needs_revision') {
    return 'failed'
  }

  if (status === 'canceled' || status === 'blocked') {
    return 'blocked'
  }

  if (status === 'approval_pending') {
    return 'waiting_approval'
  }

  if (status === 'quality_review' || status === 'in_progress') {
    return 'running'
  }

  if (jobs.some((job) => job.status === 'claimed' || job.status === 'running' || job.status === 'retrying')) {
    return 'running'
  }

  if (jobs.length > 0 && jobs.every((job) => isTerminalJob(job.status))) {
    return jobs.some((job) => job.status === 'failed' || job.status === 'canceled') ? 'failed' : 'completed'
  }

  return 'pending'
}

function taskGateResult(state: WorkState): WorkItem['gateResult'] {
  if (state === 'completed' || state === 'waiting_approval') {
    return 'passed'
  }

  if (state === 'failed') {
    return 'failed'
  }

  return state === 'running' || state === 'blocked' ? 'waiting' : 'not_started'
}

function mapGateResult(
  approvalStatus: string | undefined,
  documentStatus: DocumentStatus,
): WorkItem['gateResult'] {
  if (approvalStatus === 'approved' || documentStatus === 'approved') {
    return 'passed'
  }

  if (approvalStatus === 'needs_revision' || documentStatus === 'needs_revision') {
    return 'failed'
  }

  if (approvalStatus === 'pending' || documentStatus === 'approval_pending') {
    return 'passed'
  }

  return documentStatus === 'quality_review' ? 'waiting' : 'not_started'
}

function eventLevelForState(state: WorkState): ExecutionEvent['level'] {
  if (state === 'completed') {
    return 'success'
  }

  if (state === 'failed') {
    return 'error'
  }

  if (state === 'blocked' || state === 'waiting_approval') {
    return 'warning'
  }

  return 'info'
}

function toArtifactType(type: string): WorkItem['artifactType'] {
  if (type.toLowerCase() === 'hld') {
    return 'HLD'
  }

  if (type.toLowerCase() === 'lld') {
    return 'BE LLD'
  }

  if (type.toLowerCase() === 'adr') {
    return 'ADR'
  }

  if (type.toLowerCase().includes('spec')) {
    return 'BE Spec'
  }

  return 'PRD'
}

function taskKindForDocument(type: string): WorkItem['taskKind'] {
  const normalized = type.toLowerCase()

  if (normalized === 'prd' || normalized === 'hld' || normalized === 'lld' || normalized === 'adr' || normalized === 'spec') {
    return normalized
  }

  return undefined
}

function createImplementationTaskItems(
  documentItems: WorkItem[],
  jobsByDocumentId: Map<string, WorkflowJob[]>,
): WorkItem[] {
  return documentItems
    .filter((document) => document.taskKind === 'spec')
    .flatMap((spec) => {
      const implementationJobs = implementationJobsFor(jobsByDocumentId.get(spec.documentId ?? spec.id) ?? [])
      const pullRequests = spec.pullRequests ?? []

      if (!implementationJobs.length && !pullRequests.length) {
        return []
      }

      const latestJob = implementationJobs.at(-1)
      const firstJob = implementationJobs[0]
      const latestPullRequest = pullRequests.at(-1)
      const state = implementationTaskState(undefined, implementationJobs, pullRequests)

      const task: WorkItem = {
        id: `code_${spec.id}`,
        itemKind: 'task',
        taskKind: 'code',
        documentId: spec.documentId,
        documentType: spec.documentType,
        parentId: spec.id,
        depth: spec.depth + 1,
        title: `Code Implementation for ${spec.jiraKey}`,
        artifactType: spec.artifactType,
        jiraKey: `${spec.jiraKey}-CODE`,
        state,
        agentJobId: latestJob?.id ?? 'not-started',
        qualityScore: null,
        qualityThreshold: spec.qualityThreshold,
        retryCount: Math.max(0, implementationJobs.length - 1),
        githubPr: latestPullRequest?.label ?? '--',
        sourceArtifact: spec.sourceArtifact,
        targetRepo: latestPullRequest ? 'implementation PR' : 'workflow-api',
        targetPath: latestPullRequest?.url ?? `implementation/${spec.jiraKey}`,
        startedAt: formatTime(firstJob?.createdAt),
        finishedAt: state === 'completed' ? formatTime(latestJob?.updatedAt ?? latestPullRequest?.createdAt) : undefined,
        summary: `Tracks code execution jobs and pull request status for ${spec.title}.`,
        owner: 'Developer',
        skill: 'implementation',
        versionCount: 0,
        artifactCount: pullRequests.length,
        qualityRiskCount: 0,
        artifactLinks: spec.artifactLinks?.filter((artifact) => artifact.type === 'pull_request') ?? [],
        pullRequests,
        jobHistory: jobHistoryFor(implementationJobs),
        gateResult: implementationGateResult(state),
        links: apiLinks(spec.jiraKey, spec.documentId ?? spec.id, latestPullRequest?.url, latestPullRequest?.url),
      }

      return [task]
    })
}

function stripImplementationPrsFromDocumentTasks(
  documentItems: WorkItem[],
  implementationItems: WorkItem[],
): WorkItem[] {
  const implementationDocumentIds = new Set(
    implementationItems.map((item) => item.documentId).filter((documentId): documentId is string => Boolean(documentId)),
  )

  return documentItems.map((item) => {
    if (!item.documentId || !implementationDocumentIds.has(item.documentId)) {
      return item
    }

    const artifactLinks = item.artifactLinks?.filter((artifact) => artifact.type !== 'pull_request') ?? []
    const latestArtifact = artifactLinks.at(-1)

    return {
      ...item,
      artifactLinks,
      artifactCount: artifactLinks.length,
      githubPr: latestArtifact?.location === 'git' ? 'artifact' : '--',
      pullRequests: [],
      targetRepo: latestArtifact?.location ?? 'workflow-api',
      targetPath: latestArtifact?.uri ?? item.targetPath,
    }
  })
}

function implementationTaskState(
  taskStatus: string | undefined,
  jobs: WorkflowJob[],
  pullRequests: PullRequestSummary[],
): WorkState {
  if (taskStatus && taskStatus !== 'draft') {
    return mapTaskState(taskStatus, jobs)
  }

  if (jobs.some((job) => job.status === 'failed' || job.status === 'canceled')) {
    return 'failed'
  }

  if (jobs.some((job) => job.status === 'cancel_requested')) {
    return 'blocked'
  }

  if (jobs.some((job) => job.status === 'claimed' || job.status === 'running' || job.status === 'retrying')) {
    return 'running'
  }

  const latestPullRequest = pullRequests.at(-1)

  if (
    latestPullRequest?.merged ||
    (latestPullRequest?.reviewStatus === 'approved' && latestPullRequest?.ciStatus === 'success')
  ) {
    return 'completed'
  }

  if (pullRequests.length > 0 && (jobs.length === 0 || jobs.every((job) => isTerminalJob(job.status)))) {
    return 'running'
  }

  if (jobs.some((job) => job.status === 'succeeded')) {
    return 'running'
  }

  return 'pending'
}

function implementationGateResult(state: WorkState): WorkItem['gateResult'] {
  if (state === 'completed') {
    return 'passed'
  }

  if (state === 'failed') {
    return 'failed'
  }

  return state === 'running' || state === 'blocked' ? 'waiting' : 'not_started'
}

function retryCountForJobs(jobs: WorkflowJob[], versionCount: number): number {
  const revisionJobs = jobs.filter((job) => job.jobType.includes('revise') || job.jobType.includes('revision')).length

  return Math.max(revisionJobs, Math.max(0, versionCount - 1))
}

function orderTaskItems(tasks: WorkItem[]): WorkItem[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParent = new Map<string, WorkItem[]>()
  const roots: WorkItem[] = []

  for (const task of tasks) {
    if (task.parentId && byId.has(task.parentId)) {
      const children = childrenByParent.get(task.parentId) ?? []
      children.push(task)
      childrenByParent.set(task.parentId, children)
    } else {
      roots.push(task)
    }
  }

  const ordered: WorkItem[] = []
  const visit = (task: WorkItem) => {
    ordered.push(task)
    ;(childrenByParent.get(task.id) ?? []).sort(compareTaskItems).forEach(visit)
  }

  roots.sort(compareTaskItems).forEach(visit)
  return ordered
}

function compareTaskItems(left: WorkItem, right: WorkItem): number {
  return taskRank(left) - taskRank(right) || left.title.localeCompare(right.title)
}

function taskRank(task: WorkItem): number {
  if (task.taskKind === 'prd') return 0
  if (task.taskKind === 'hld') return 1
  if (task.taskKind === 'lld') return 2
  if (task.taskKind === 'adr') return 3
  if (task.taskKind === 'spec') return 4
  if (task.taskKind === 'code') return 5

  return 6
}

function createDocumentDepths(documents: WorkflowDocument[]): Map<string, number> {
  const byId = new Map(documents.map((document) => [document.id, document]))
  const depths = new Map<string, number>()

  const depthFor = (document: WorkflowDocument): number => {
    const cached = depths.get(document.id)

    if (cached !== undefined) {
      return cached
    }

    const parent = document.parentDocumentId ? byId.get(document.parentDocumentId) : undefined
    const depth = parent ? depthFor(parent) + 1 : 0

    depths.set(document.id, depth)
    return depth
  }

  documents.forEach(depthFor)
  return depths
}

function createWorkflowTaskDepths(tasks: WorkflowTask[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depths = new Map<string, number>()

  const depthFor = (task: WorkflowTask): number => {
    const cached = depths.get(task.id)

    if (cached !== undefined) {
      return cached
    }

    const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined
    const depth = parent ? depthFor(parent) + 1 : 0

    depths.set(task.id, depth)
    return depth
  }

  tasks.forEach(depthFor)
  return depths
}

function groupWorkflowJobsByDocument(
  jobs: WorkflowJob[],
  documents: WorkflowDocument[],
): Map<string, WorkflowJob[]> {
  const fallbackDocumentId = documents[0]?.id ?? null
  const jobsByDocumentId = new Map<string, WorkflowJob[]>()

  for (const job of jobs) {
    const documentId = jobDocumentId(job, documents, fallbackDocumentId)

    if (!documentId) {
      continue
    }

    const documentJobs = jobsByDocumentId.get(documentId) ?? []
    documentJobs.push(job)
    jobsByDocumentId.set(documentId, documentJobs)
  }

  for (const documentJobs of jobsByDocumentId.values()) {
    documentJobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  }

  return jobsByDocumentId
}

function groupWorkflowJobsByTask(
  jobs: WorkflowJob[],
  tasks: WorkflowTask[],
  documents: WorkflowDocument[],
): Map<string, WorkflowJob[]> {
  const jobsByDocumentId = groupWorkflowJobsByDocument(jobs, documents)
  const documentToTaskId = new Map<string, string>()

  for (const task of tasks) {
    if (task.currentDocumentId) {
      documentToTaskId.set(task.currentDocumentId, task.id)
    }
  }

  for (const document of documents) {
    if (document.workflowTaskId) {
      documentToTaskId.set(document.id, document.workflowTaskId)
    }
  }

  const jobsByTaskId = new Map<string, WorkflowJob[]>()

  for (const job of jobs) {
    const taskId = job.taskId ?? documentToTaskId.get(jobDocumentId(job, documents, null) ?? '')

    if (!taskId) {
      continue
    }

    const taskJobs = jobsByTaskId.get(taskId) ?? []
    taskJobs.push(job)
    jobsByTaskId.set(taskId, taskJobs)
  }

  for (const [documentId, documentJobs] of jobsByDocumentId) {
    const taskId = documentToTaskId.get(documentId)

    if (!taskId || jobsByTaskId.has(taskId)) {
      continue
    }

    jobsByTaskId.set(taskId, documentJobs)
  }

  for (const taskJobs of jobsByTaskId.values()) {
    taskJobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  }

  return jobsByTaskId
}

function jobDocumentId(
  job: WorkflowJob,
  documents: WorkflowDocument[],
  fallbackDocumentId: string | null,
): string | null {
  const sourceDocumentId = typeof job.input.sourceDocumentId === 'string' ? job.input.sourceDocumentId : undefined
  const inputDocumentId = typeof job.input.documentId === 'string' ? job.input.documentId : undefined
  const parentDocumentId = typeof job.input.parentDocumentId === 'string' ? job.input.parentDocumentId : undefined
  const sourceKey = typeof job.input.sourceKey === 'string' ? job.input.sourceKey : job.primaryJiraKey
  const title = typeof job.input.title === 'string' ? job.input.title : undefined
  const directDocument = inputDocumentId ?? sourceDocumentId

  if (directDocument && documents.some((document) => document.id === directDocument)) {
    return directDocument
  }

  const sourceKeyMatch = sourceKey ? documents.find((document) => document.sourceKey === sourceKey) : undefined

  if (sourceKeyMatch) {
    return sourceKeyMatch.id
  }

  const titleMatch = title ? documents.find((document) => document.title === title) : undefined

  if (titleMatch) {
    return titleMatch.id
  }

  if (parentDocumentId && documents.some((document) => document.id === parentDocumentId)) {
    return parentDocumentId
  }

  return fallbackDocumentId
}

function documentTaskJobsFor(jobs: WorkflowJob[]): WorkflowJob[] {
  return jobs.filter((job) => !isImplementationJob(job))
}

function implementationJobsFor(jobs: WorkflowJob[]): WorkflowJob[] {
  return jobs.filter(isImplementationJob)
}

function isImplementationJob(job: WorkflowJob): boolean {
  return job.jobType.startsWith('implementation.')
}

function jobHistoryFor(jobs: WorkflowJob[]): JobHistorySummary[] {
  return jobs.map((job, index) => ({
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    state: mapJobState(job.status),
    startedAt: formatTime(job.createdAt),
    finishedAt: isTerminalJob(job.status) ? formatTime(job.updatedAt) : undefined,
    summary: summarizeJob(job, index),
  }))
}

function createJobToTaskIdMap(items: WorkItem[]): Map<string, string> {
  const jobToTaskId = new Map<string, string>()

  for (const item of items) {
    for (const job of item.jobHistory ?? []) {
      jobToTaskId.set(job.id, item.id)
    }
  }

  return jobToTaskId
}

function createDocumentToItemIdMap(items: WorkItem[]): Map<string, string> {
  const documentToItemId = new Map<string, string>()

  for (const item of items) {
    if (item.documentId && item.taskKind !== 'code') {
      documentToItemId.set(item.documentId, item.id)
    }
  }

  for (const item of items) {
    if (item.documentId && !documentToItemId.has(item.documentId)) {
      documentToItemId.set(item.documentId, item.id)
    }
  }

  return documentToItemId
}

function summarizeJob(job: WorkflowJob, index: number): string {
  const capability = job.requiredCapabilities?.[0] ?? 'workflow job'

  return `${capability} job ${index + 1} from the live Workflow API snapshot.`
}

function compactLabel(value: string): string {
  return value
    .replace('prd.', '')
    .replace('document.', '')
    .replace(/_/g, ' ')
    .slice(0, 18)
}

function calculateProgress(items: WorkItem[]): number {
  if (!items.length) {
    return 0
  }

  return Math.round((items.filter((item) => item.state === 'completed').length / items.length) * 100)
}

function isTerminalJob(status: WorkflowJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'skipped'
}

function apiLinks(sourceKey: string, documentId: string, artifactUri?: string, pullRequestUri?: string) {
  return {
    jira: `https://jira.example/browse/${sourceKey}`,
    github: pullRequestUri ?? (artifactUri?.startsWith('http') ? artifactUri : '#'),
    artifact: artifactUri ?? '#',
    quality: '#',
    logs: '#',
    documentId,
  }
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function formatTime(value: string | undefined): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value.slice(11, 19) || value
  }

  return date.toISOString().slice(11, 19)
}

function formatElapsed(start: string, end: string): string {
  const startTime = Date.parse(start)
  const endTime = Date.parse(end)

  if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
    return '--'
  }

  const seconds = Math.max(0, Math.round((endTime - startTime) / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60

  return `${minutes}m ${remainder}s`
}
