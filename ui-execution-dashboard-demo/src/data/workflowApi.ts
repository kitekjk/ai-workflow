import type {
  ExecutionEvent,
  FlowEdge,
  FlowNode,
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
  jobType: string
  primaryJiraKey?: string
  status: WorkflowJobStatus
  input: Record<string, unknown>
  requiredRole?: string
  requiredCapabilities?: string[]
  createdAt: string
  updatedAt: string
}

type WorkflowDocument = {
  id: string
  workflowRunId: string
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
}

const apiBaseUrl = (import.meta.env.VITE_WORKFLOW_API_BASE_URL ?? '/api').replace(/\/$/, '')
const seededPrdKey = import.meta.env.VITE_WORKFLOW_SEED_PRD_KEY ?? 'PRD-100'
const defaultRunId = import.meta.env.VITE_WORKFLOW_RUN_ID ?? 'run_1'

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

  return mapApiDashboard(runResponse, currentViews, histories)
}

export async function seedApiRun(): Promise<void> {
  await apiPost('/prd/intake', { prdJiraKey: seededPrdKey })
}

export async function tickApiRun(): Promise<void> {
  await apiPost('/tick', {})
}

export async function setApiQualityPasses(qualityPasses: boolean): Promise<void> {
  await apiPost('/test-controls/quality', { qualityPasses })
}

export async function recordApiFeedback(documentId: string): Promise<void> {
  await apiPost(`/documents/${encodeURIComponent(documentId)}/feedback`, {
    source: 'app',
    author: 'dashboard@example.com',
    body: 'Add success metric: reduce repeated FAQ handling time by 30%.',
  })
}

export async function requestApiRevision(documentId: string): Promise<void> {
  await apiPost(`/documents/${encodeURIComponent(documentId)}/revisions`, {
    requestedBy: 'dashboard@example.com',
  })
}

export async function approveApiGate(approvalGateId: string): Promise<void> {
  await apiPost(`/approval-gates/${encodeURIComponent(approvalGateId)}/approve`, {
    requestedBy: 'dashboard@example.com',
  })
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
): ApiDashboardData {
  const documentDepths = createDocumentDepths(runResponse.documents)
  const documentItems = currentViews.map((current, index) =>
    mapDocumentItem(current, histories[index], index, documentDepths),
  )
  const primaryDocumentId = documentItems[0]?.id ?? null
  const jobItems = runResponse.jobs.map((job, index) =>
    mapJobItem(job, jobParentDocumentId(job, documentItems, primaryDocumentId), index),
  )
  const items = [...documentItems, ...jobItems]
  const events = createEvents(runResponse, currentViews, histories)
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
    nodes: createNodes(documentItems, jobItems),
    edges: createEdges(documentItems, jobItems),
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
  }
}

function mapDocumentItem(
  current: DocumentCurrentResponse,
  history: DocumentHistoryResponse,
  index: number,
  documentDepths: Map<string, number>,
): WorkItem {
  const document = current.document
  const latestArtifact = current.currentArtifacts[0] ?? history.artifacts.at(-1)
  const latestQualityResult = current.latestQualityResult ?? history.qualityResults?.at(-1)
  const versionSummary = current.currentVersion?.summary ?? `${document.type.toUpperCase()} document`

  return {
    id: document.id,
    itemKind: 'document',
    documentId: document.id,
    approvalGateId: current.approvalGate?.id,
    parentId: document.parentDocumentId ?? null,
    depth: documentDepths.get(document.id) ?? 0,
    title: document.title || document.sourceKey,
    artifactType: toArtifactType(document.type),
    jiraKey: document.sourceKey,
    state: mapDocumentState(document.status, current.approvalGate?.status),
    agentJobId: current.currentVersion?.producerJobId ?? 'not-started',
    qualityScore: latestQualityResult?.score ?? null,
    qualityThreshold: 85,
    retryCount: Math.max(0, history.versions.length - 1),
    githubPr: latestArtifact?.location === 'git' ? 'artifact' : '--',
    sourceArtifact: current.currentVersion?.id ?? 'source snapshot',
    targetRepo: latestArtifact?.location ?? 'workflow-api',
    targetPath: latestArtifact?.uri ?? `documents/${document.id}`,
    startedAt: formatTime(current.currentVersion?.createdAt),
    finishedAt: document.status === 'approval_pending' || document.status === 'approved'
      ? formatTime(current.currentVersion?.createdAt)
      : undefined,
    summary: versionSummary,
    owner: index === 0 ? 'Product Ops' : 'Workflow API',
    skill: `${document.type}.document`,
    gateResult: mapGateResult(current.approvalGate?.status, document.status),
    links: apiLinks(document.sourceKey, document.id, latestArtifact?.uri),
  }
}

function mapJobItem(job: WorkflowJob, parentDocumentId: string | null, index: number): WorkItem {
  const documentType = typeof job.input.documentType === 'string' ? job.input.documentType : undefined

  return {
    id: job.id,
    itemKind: 'job',
    documentId: parentDocumentId ?? undefined,
    parentId: parentDocumentId,
    depth: parentDocumentId ? 1 : 0,
    title: job.jobType,
    artifactType: documentType ? toArtifactType(documentType) : 'PRD',
    jiraKey: job.primaryJiraKey ?? job.runId,
    state: mapJobState(job.status),
    agentJobId: job.id,
    qualityScore: job.jobType.includes('evaluate') && job.status === 'succeeded' ? 85 : null,
    qualityThreshold: 85,
    retryCount: job.status === 'retrying' ? 1 : 0,
    githubPr: '--',
    sourceArtifact: `run ${job.runId}`,
    targetRepo: 'workflow-api',
    targetPath: job.jobType,
    startedAt: formatTime(job.createdAt),
    finishedAt: isTerminalJob(job.status) ? formatTime(job.updatedAt) : undefined,
    summary: summarizeJob(job, index),
    owner: job.requiredRole ?? 'Workflow API',
    skill: job.requiredCapabilities?.join(', ') || 'document',
    gateResult: job.jobType.includes('evaluate') ? mapJobGateResult(job.status) : 'not_started',
    links: apiLinks(job.runId, parentDocumentId ?? job.id),
  }
}

function createEvents(
  runResponse: WorkflowRunResponse,
  currentViews: DocumentCurrentResponse[],
  histories: DocumentHistoryResponse[],
): ExecutionEvent[] {
  const jobEvents = runResponse.jobs.map((job, index) => ({
    id: `api-job-${job.id}`,
    timestamp: formatTime(job.updatedAt),
    itemId: job.id,
    event: `job.${job.status}`,
    level: eventLevelForState(mapJobState(job.status)),
    message: `${job.jobType} is ${job.status}.`,
    order: index,
  }))
  const artifactEvents = histories.flatMap((history, historyIndex) =>
    history.artifacts.map((artifact, index) => ({
      id: `api-artifact-${artifact.id}`,
      timestamp: formatTime(artifact.createdAt),
      itemId: artifact.documentId ?? currentViews[historyIndex]?.document.id ?? history.documentId,
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
      itemId: feedback.documentId ?? currentViews[historyIndex]?.document.id ?? history.documentId,
      event: feedback.revisionJobId ? 'feedback.applied' : 'feedback.recorded',
      level: feedback.revisionJobId ? ('success' as const) : ('warning' as const),
      message: `${feedback.source} feedback ${feedback.revisionJobId ? 'attached to revision' : 'stored'}.`,
      order: 200 + historyIndex * 10 + index,
    })),
  )
  const qualityEvents = histories.flatMap((history, historyIndex) =>
    (history.qualityResults ?? []).map((qualityResult, index) => ({
      id: `api-quality-${qualityResult.id}`,
      timestamp: formatTime(qualityResult.createdAt),
      itemId: qualityResult.documentId ?? currentViews[historyIndex]?.document.id ?? history.documentId,
      event: `quality.${qualityResult.status}`,
      level: qualityResult.status === 'passed' ? ('success' as const) : ('warning' as const),
      message: `Quality gate ${qualityResult.status}${qualityResult.score !== undefined ? ` at ${qualityResult.score}/100` : ''}.`,
      order: 300 + historyIndex * 10 + index,
    })),
  )

  return [...jobEvents, ...artifactEvents, ...feedbackEvents, ...qualityEvents]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...event }) => event)
}

function createNodes(documentItems: WorkItem[], jobItems: WorkItem[]): FlowNode[] {
  const rowByDocumentId = new Map(documentItems.map((item, index) => [item.id, index]))
  const jobsByDocumentId = groupJobsByDocument(jobItems)
  const documentNodes = documentItems.map((item, index) => {
    const x = 24 + item.depth * 138
    const y = 48 + index * 128

    return flowNodeFromItem(item, x, y, documentNodeKind(item))
  })
  const jobNodes = documentItems.flatMap((document) => {
    const row = rowByDocumentId.get(document.id) ?? 0
    const y = 48 + row * 128
    const startX = Math.max(188, 24 + document.depth * 138 + 148)

    return (jobsByDocumentId.get(document.id) ?? []).map((item, index) =>
      flowNodeFromItem(item, startX + index * 138, y, nodeKindForJob(item.title)),
    )
  })

  return [...documentNodes, ...jobNodes]
}

function createEdges(documentItems: WorkItem[], jobItems: WorkItem[]): FlowEdge[] {
  if (!documentItems.length || !jobItems.length) {
    return []
  }

  const jobsByDocumentId = groupJobsByDocument(jobItems)
  const documentEdges = documentItems
    .filter((document) => document.parentId)
    .map((document) => ({
      id: `api-edge-${document.parentId}-${document.id}`,
      from: nodeIdForItem(String(document.parentId)),
      to: nodeIdForItem(document.id),
    }))
  const jobEdges = documentItems.flatMap((document) => {
    const jobs = jobsByDocumentId.get(document.id) ?? []

    if (!jobs.length) {
      return []
    }

    return [
      {
        id: `api-edge-${document.id}-${jobs[0].id}`,
        from: nodeIdForItem(document.id),
        to: nodeIdForItem(jobs[0].id),
      },
      ...jobs.slice(1).map((job, index) => ({
        id: `api-edge-${jobs[index].id}-${job.id}`,
        from: nodeIdForItem(jobs[index].id),
        to: nodeIdForItem(job.id),
      })),
    ]
  })

  return [...documentEdges, ...jobEdges]
}

function groupJobsByDocument(jobItems: WorkItem[]): Map<string, WorkItem[]> {
  const jobsByDocumentId = new Map<string, WorkItem[]>()

  for (const job of jobItems) {
    if (!job.parentId) {
      continue
    }

    const jobs = jobsByDocumentId.get(job.parentId) ?? []

    jobs.push(job)
    jobsByDocumentId.set(job.parentId, jobs)
  }

  return jobsByDocumentId
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

function mapJobGateResult(status: WorkflowJobStatus): WorkItem['gateResult'] {
  if (status === 'succeeded') {
    return 'passed'
  }

  if (status === 'failed') {
    return 'failed'
  }

  return status === 'running' || status === 'claimed' ? 'waiting' : 'not_started'
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

function nodeKindForJob(jobType: string): FlowNode['kind'] {
  if (jobType.includes('evaluate')) {
    return 'quality_gate'
  }

  if (jobType.includes('revision') || jobType.includes('revise')) {
    return 'agent_job'
  }

  return 'agent_job'
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

function jobParentDocumentId(
  job: WorkflowJob,
  documentItems: WorkItem[],
  fallbackDocumentId: string | null,
): string | null {
  const sourceDocumentId = typeof job.input.sourceDocumentId === 'string' ? job.input.sourceDocumentId : undefined
  const parentDocumentId = typeof job.input.parentDocumentId === 'string' ? job.input.parentDocumentId : undefined
  const sourceKey = typeof job.input.sourceKey === 'string' ? job.input.sourceKey : job.primaryJiraKey
  const title = typeof job.input.title === 'string' ? job.input.title : undefined
  const directDocument = sourceDocumentId

  if (directDocument && documentItems.some((item) => item.id === directDocument)) {
    return directDocument
  }

  const sourceKeyMatch = sourceKey ? documentItems.find((item) => item.jiraKey === sourceKey) : undefined

  if (sourceKeyMatch) {
    return sourceKeyMatch.id
  }

  const titleMatch = title ? documentItems.find((item) => item.title === title) : undefined

  if (titleMatch) {
    return titleMatch.id
  }

  if (parentDocumentId && documentItems.some((item) => item.id === parentDocumentId)) {
    return parentDocumentId
  }

  return fallbackDocumentId
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

function apiLinks(sourceKey: string, documentId: string, artifactUri?: string) {
  return {
    jira: `https://jira.example/browse/${sourceKey}`,
    github: artifactUri?.startsWith('http') ? artifactUri : '#',
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
