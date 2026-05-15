export type WorkState =
  | 'completed'
  | 'running'
  | 'failed'
  | 'waiting_approval'
  | 'pending'
  | 'blocked'

export type ArtifactType = 'PRD' | 'HLD' | 'BE LLD' | 'FE LLD' | 'BE Spec' | 'FE Spec'

export type WorkItem = {
  id: string
  parentId: string | null
  depth: number
  title: string
  artifactType: ArtifactType
  jiraKey: string
  state: WorkState
  agentJobId: string
  qualityScore: number | null
  qualityThreshold: number
  retryCount: number
  githubPr: string
  sourceArtifact: string
  targetRepo: string
  targetPath: string
  startedAt: string
  finishedAt?: string
  error?: string
  summary: string
  owner: string
  skill: string
  gateResult: 'passed' | 'failed' | 'waiting' | 'not_started'
  links: {
    jira: string
    github: string
    artifact: string
    quality: string
    logs: string
  }
}

export type ExecutionEvent = {
  id: string
  timestamp: string
  itemId: string
  event: string
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

export type FlowNodeKind =
  | 'trigger'
  | 'agent_job'
  | 'quality_gate'
  | 'approval'
  | 'fanout'
  | 'fanin'
  | 'child_workflow'

export type FlowNode = {
  id: string
  label: string
  subtitle: string
  kind: FlowNodeKind
  state: WorkState
  x: number
  y: number
  workItemId?: string
}

export type FlowEdge = {
  id: string
  from: string
  to: string
  label?: string
}

export type WorkflowRunSummary = {
  id: string
  name: string
  projectKey: string
  runId: string
  state: WorkState
  progress: number
  owner: string
  description: string
  itemIds: string[]
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export const projectSummary = {
  projectKey: 'OPS-123',
  runId: 'run_ops_123_20260515_1452',
  workflowVersion: 'hld_to_lld_spec_pipeline@0.3.0',
  startedAt: '2026-05-15 14:52:10',
  elapsed: '18m 42s',
}

export const workflowCatalog: WorkflowRunSummary[] = [
  {
    id: 'ops-123-hld-lld-spec',
    name: 'HLD to LLD/Spec Pipeline',
    projectKey: 'OPS-123',
    runId: 'run_ops_123_20260515_1452',
    state: 'running',
    progress: 40,
    owner: 'Architecture',
    description: 'Shows the full PRD -> HLD -> multiple LLDs -> multiple Specs tree in one execution view.',
    itemIds: [
      'prd-initiative',
      'hld-epic',
      'be-lld-001',
      'be-spec-001',
      'be-spec-002',
      'be-lld-002',
      'be-spec-003',
      'be-spec-004',
      'fe-lld-001',
      'fe-spec-001',
      'fe-spec-002',
    ],
    nodes: [
      flowNode('wf-prd', 'PRD', 'OPS-123', 'trigger', 'completed', 18, 132, 'prd-initiative'),
      flowNode('wf-hld', 'HLD', 'OPS-124', 'agent_job', 'completed', 130, 132, 'hld-epic'),
      flowNode('wf-split-lld', 'LLD fan-out', '3 child runs', 'fanout', 'completed', 242, 132),
      flowNode('wf-be-lld-001', 'BE-LLD-001', 'workflow model', 'child_workflow', 'completed', 365, 22, 'be-lld-001'),
      flowNode('wf-be-lld-002', 'BE-LLD-002', 'observability', 'child_workflow', 'failed', 365, 132, 'be-lld-002'),
      flowNode('wf-fe-lld-001', 'FE-LLD-001', 'dashboard', 'child_workflow', 'waiting_approval', 365, 232, 'fe-lld-001'),
      flowNode('wf-be-spec-001', 'BE-SPEC-001', 'ledger API', 'child_workflow', 'completed', 500, 22, 'be-spec-001'),
      flowNode('wf-be-spec-002', 'BE-SPEC-002', 'job claiming', 'child_workflow', 'running', 608, 22, 'be-spec-002'),
      flowNode('wf-be-spec-003', 'BE-SPEC-003', 'event files', 'child_workflow', 'blocked', 500, 132, 'be-spec-003'),
      flowNode('wf-be-spec-004', 'BE-SPEC-004', 'redaction', 'child_workflow', 'blocked', 608, 132, 'be-spec-004'),
      flowNode('wf-fe-spec-001', 'FE-SPEC-001', 'tree/detail', 'child_workflow', 'pending', 500, 232, 'fe-spec-001'),
      flowNode('wf-fe-spec-002', 'FE-SPEC-002', 'controls', 'child_workflow', 'pending', 608, 232, 'fe-spec-002'),
      flowNode('wf-fanin-spec', 'Spec fan-in', 'all children', 'fanin', 'running', 720, 132),
    ],
    edges: [
      edge('wf-prd', 'wf-hld'),
      edge('wf-hld', 'wf-split-lld'),
      edge('wf-split-lld', 'wf-be-lld-001', 'LLD'),
      edge('wf-split-lld', 'wf-be-lld-002', 'LLD'),
      edge('wf-split-lld', 'wf-fe-lld-001', 'LLD'),
      edge('wf-be-lld-001', 'wf-be-spec-001', 'Spec'),
      edge('wf-be-lld-001', 'wf-be-spec-002', 'Spec'),
      edge('wf-be-lld-002', 'wf-be-spec-003', 'Spec'),
      edge('wf-be-lld-002', 'wf-be-spec-004', 'Spec'),
      edge('wf-fe-lld-001', 'wf-fe-spec-001', 'Spec'),
      edge('wf-fe-lld-001', 'wf-fe-spec-002', 'Spec'),
      edge('wf-be-spec-001', 'wf-fanin-spec'),
      edge('wf-be-spec-002', 'wf-fanin-spec'),
      edge('wf-be-spec-003', 'wf-fanin-spec'),
      edge('wf-be-spec-004', 'wf-fanin-spec'),
      edge('wf-fe-spec-001', 'wf-fanin-spec'),
      edge('wf-fe-spec-002', 'wf-fanin-spec'),
    ],
  },
  {
    id: 'ops-123-runner-observability',
    name: 'Runner Observability Recovery',
    projectKey: 'OPS-123',
    runId: 'run_ops_123_retry_0202',
    state: 'failed',
    progress: 55,
    owner: 'Backend Platform',
    description: 'Focused retry path for failed observability LLD, gate scoring, feedback revision, and downstream unblock.',
    itemIds: ['be-lld-002', 'be-spec-003', 'be-spec-004'],
    nodes: [
      flowNode('retry-load', 'Load failed LLD', 'BE-LLD-002', 'trigger', 'completed', 36, 132, 'be-lld-002'),
      flowNode('retry-skill', 'Load skill', 'backend.lld', 'agent_job', 'completed', 190, 132, 'be-lld-002'),
      flowNode('retry-revise', 'Revise artifact', 'attempt 3', 'agent_job', 'running', 344, 132, 'be-lld-002'),
      flowNode('retry-score', 'Quality gate', 'threshold 85', 'quality_gate', 'failed', 498, 132, 'be-lld-002'),
      flowNode('retry-approval', 'Human review', 'blocked', 'approval', 'blocked', 652, 132, 'be-spec-003'),
    ],
    edges: [
      edge('retry-load', 'retry-skill'),
      edge('retry-skill', 'retry-revise'),
      edge('retry-revise', 'retry-score'),
      edge('retry-score', 'retry-approval'),
    ],
  },
  {
    id: 'ops-123-fe-approval',
    name: 'Frontend LLD Approval Gate',
    projectKey: 'OPS-123',
    runId: 'run_ops_123_fe_approval',
    state: 'waiting_approval',
    progress: 62,
    owner: 'Frontend Platform',
    description: 'Approval-focused workflow for FE LLD review before frontend spec fan-out begins.',
    itemIds: ['hld-epic', 'fe-lld-001', 'fe-spec-001', 'fe-spec-002'],
    nodes: [
      flowNode('fe-lld-source', 'Source HLD', 'system-hld.md', 'trigger', 'completed', 44, 132, 'hld-epic'),
      flowNode('fe-lld-write', 'Write FE LLD', 'FE-LLD-001', 'agent_job', 'completed', 188, 132, 'fe-lld-001'),
      flowNode('fe-lld-score', 'Quality score', '87/100', 'quality_gate', 'completed', 332, 132, 'fe-lld-001'),
      flowNode('fe-human-gate', 'Lead approval', 'waiting', 'approval', 'waiting_approval', 476, 132, 'fe-lld-001'),
      flowNode('fe-spec-fanout', 'Create specs', '2 child jobs', 'fanout', 'pending', 620, 132, 'fe-spec-001'),
    ],
    edges: [
      edge('fe-lld-source', 'fe-lld-write'),
      edge('fe-lld-write', 'fe-lld-score'),
      edge('fe-lld-score', 'fe-human-gate'),
      edge('fe-human-gate', 'fe-spec-fanout'),
    ],
  },
]

export const initialWorkItems: WorkItem[] = [
  {
    id: 'prd-initiative',
    parentId: null,
    depth: 0,
    title: 'PRD Initiative',
    artifactType: 'PRD',
    jiraKey: 'OPS-123',
    state: 'completed',
    agentJobId: 'job-prd-0007',
    qualityScore: 91,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'PRD-17',
    sourceArtifact: 'Jira intake: OPS-98, OPS-101, OPS-119',
    targetRepo: 'org/prd-repo',
    targetPath: 'docs/projects/OPS-123/prd.md',
    startedAt: '14:52:10',
    finishedAt: '14:55:38',
    summary: 'Groups operational requests into a reviewable product initiative with rationale, scope, and approval history.',
    owner: 'Product Ops',
    skill: 'prd.simple@0.1.0',
    gateResult: 'passed',
    links: linkSet('OPS-123', 'PRD-17', 'prd.md', 'qg-prd-0007', 'job-prd-0007'),
  },
  {
    id: 'hld-epic',
    parentId: 'prd-initiative',
    depth: 1,
    title: 'HLD Epic',
    artifactType: 'HLD',
    jiraKey: 'OPS-124',
    state: 'completed',
    agentJobId: 'job-hld-0011',
    qualityScore: 88,
    qualityThreshold: 85,
    retryCount: 1,
    githubPr: 'BE-42',
    sourceArtifact: 'org/prd-repo/docs/projects/OPS-123/prd.md@abc123',
    targetRepo: 'org/backend-repo',
    targetPath: 'docs/projects/OPS-123/system-hld.md',
    startedAt: '14:55:42',
    finishedAt: '15:02:19',
    summary: 'Canonical system HLD covering backend and frontend boundaries, flows, data model, API draft, and operations concerns.',
    owner: 'Architecture',
    skill: 'architecture.hld@0.2.1',
    gateResult: 'passed',
    links: linkSet('OPS-124', 'BE-42', 'system-hld.md', 'qg-hld-0011', 'job-hld-0011'),
  },
  {
    id: 'be-lld-001',
    parentId: 'hld-epic',
    depth: 2,
    title: 'BE-LLD-001 Workflow Run Model',
    artifactType: 'BE LLD',
    jiraKey: 'BE-LLD-001',
    state: 'completed',
    agentJobId: 'job-lld-be-0201',
    qualityScore: 90,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'BE-47',
    sourceArtifact: 'org/backend-repo/docs/projects/OPS-123/system-hld.md@def456',
    targetRepo: 'org/backend-repo',
    targetPath: 'docs/projects/OPS-123/lld/workflow-run-model.md',
    startedAt: '15:02:31',
    finishedAt: '15:07:45',
    summary: 'Defines workflow_runs, work_items, artifact_versions, and parent-child execution relationships.',
    owner: 'Backend Platform',
    skill: 'backend.lld@0.4.0',
    gateResult: 'passed',
    links: linkSet('BE-LLD-001', 'BE-47', 'workflow-run-model.md', 'qg-lld-be-0201', 'job-lld-be-0201'),
  },
  {
    id: 'be-spec-001',
    parentId: 'be-lld-001',
    depth: 3,
    title: 'BE-SPEC-001 Status Ledger API',
    artifactType: 'BE Spec',
    jiraKey: 'BE-SPEC-001',
    state: 'completed',
    agentJobId: 'job-spec-be-0310',
    qualityScore: 93,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'BE-51',
    sourceArtifact: 'docs/projects/OPS-123/lld/workflow-run-model.md@731ac0',
    targetRepo: 'org/backend-repo',
    targetPath: 'docs/projects/OPS-123/spec/status-ledger-api.md',
    startedAt: '15:08:02',
    finishedAt: '15:11:13',
    summary: 'Specifies append-only status_events ingestion and query contracts for the execution dashboard.',
    owner: 'Backend Platform',
    skill: 'backend.spec@0.3.2',
    gateResult: 'passed',
    links: linkSet('BE-SPEC-001', 'BE-51', 'status-ledger-api.md', 'qg-spec-be-0310', 'job-spec-be-0310'),
  },
  {
    id: 'be-spec-002',
    parentId: 'be-lld-001',
    depth: 3,
    title: 'BE-SPEC-002 Agent Job Claiming',
    artifactType: 'BE Spec',
    jiraKey: 'BE-SPEC-002',
    state: 'running',
    agentJobId: 'job-spec-be-0311',
    qualityScore: 82,
    qualityThreshold: 85,
    retryCount: 1,
    githubPr: 'BE-52',
    sourceArtifact: 'docs/projects/OPS-123/lld/workflow-run-model.md@731ac0',
    targetRepo: 'org/backend-repo',
    targetPath: 'docs/projects/OPS-123/spec/agent-job-claiming.md',
    startedAt: '15:11:30',
    summary: 'Details atomic job claim, heartbeat, timeout, retry scheduling, and cancellation semantics for runner schedulers.',
    owner: 'Backend Platform',
    skill: 'backend.spec@0.3.2',
    gateResult: 'waiting',
    links: linkSet('BE-SPEC-002', 'BE-52', 'agent-job-claiming.md', 'qg-spec-be-0311', 'job-spec-be-0311'),
  },
  {
    id: 'be-lld-002',
    parentId: 'hld-epic',
    depth: 2,
    title: 'BE-LLD-002 Runner Observability',
    artifactType: 'BE LLD',
    jiraKey: 'BE-LLD-002',
    state: 'failed',
    agentJobId: 'job-lld-be-0202',
    qualityScore: 64,
    qualityThreshold: 85,
    retryCount: 2,
    githubPr: 'BE-48',
    sourceArtifact: 'org/backend-repo/docs/projects/OPS-123/system-hld.md@def456',
    targetRepo: 'org/backend-repo',
    targetPath: 'docs/projects/OPS-123/lld/runner-observability.md',
    startedAt: '15:03:04',
    finishedAt: '15:13:18',
    error: 'Quality gate failed: event retention policy and secret redaction behavior are underspecified.',
    summary: 'Designs durable runner records, stdout/stderr capture, events.ndjson, result.json, and artifact output layout.',
    owner: 'Backend Platform',
    skill: 'backend.lld@0.4.0',
    gateResult: 'failed',
    links: linkSet('BE-LLD-002', 'BE-48', 'runner-observability.md', 'qg-lld-be-0202', 'job-lld-be-0202'),
  },
  {
    id: 'be-spec-003',
    parentId: 'be-lld-002',
    depth: 3,
    title: 'BE-SPEC-003 Runner Event Files',
    artifactType: 'BE Spec',
    jiraKey: 'BE-SPEC-003',
    state: 'blocked',
    agentJobId: 'job-spec-be-0312',
    qualityScore: null,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'BE-53',
    sourceArtifact: 'docs/projects/OPS-123/lld/runner-observability.md@pending',
    targetRepo: 'org/backend-repo',
    targetPath: 'docs/projects/OPS-123/spec/runner-event-files.md',
    startedAt: '--',
    summary: 'Blocked until the parent observability LLD passes its quality gate.',
    owner: 'Backend Platform',
    skill: 'backend.spec@0.3.2',
    gateResult: 'not_started',
    links: linkSet('BE-SPEC-003', 'BE-53', 'runner-event-files.md', 'qg-spec-be-0312', 'job-spec-be-0312'),
  },
  {
    id: 'be-spec-004',
    parentId: 'be-lld-002',
    depth: 3,
    title: 'BE-SPEC-004 Secret Redaction Rules',
    artifactType: 'BE Spec',
    jiraKey: 'BE-SPEC-004',
    state: 'blocked',
    agentJobId: 'job-spec-be-0313',
    qualityScore: null,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'BE-54',
    sourceArtifact: 'docs/projects/OPS-123/lld/runner-observability.md@pending',
    targetRepo: 'org/backend-repo',
    targetPath: 'docs/projects/OPS-123/spec/secret-redaction-rules.md',
    startedAt: '--',
    summary: 'Blocked until the failed observability LLD clarifies how runner logs redact secrets and credential scopes.',
    owner: 'Backend Platform',
    skill: 'backend.spec@0.3.2',
    gateResult: 'not_started',
    links: linkSet('BE-SPEC-004', 'BE-54', 'secret-redaction-rules.md', 'qg-spec-be-0313', 'job-spec-be-0313'),
  },
  {
    id: 'fe-lld-001',
    parentId: 'hld-epic',
    depth: 2,
    title: 'FE-LLD-001 Execution Dashboard',
    artifactType: 'FE LLD',
    jiraKey: 'FE-LLD-001',
    state: 'waiting_approval',
    agentJobId: 'job-lld-fe-0401',
    qualityScore: 87,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'FE-19',
    sourceArtifact: 'org/backend-repo/docs/projects/OPS-123/system-hld.md@def456',
    targetRepo: 'org/frontend-repo',
    targetPath: 'docs/projects/OPS-123/lld/execution-dashboard.md',
    startedAt: '15:05:22',
    finishedAt: '15:14:28',
    summary: 'Designs a dense dashboard for nested workflow visibility, work item details, linked systems, and status ledger review.',
    owner: 'Frontend Platform',
    skill: 'frontend.lld@0.2.0',
    gateResult: 'passed',
    links: linkSet('FE-LLD-001', 'FE-19', 'execution-dashboard.md', 'qg-lld-fe-0401', 'job-lld-fe-0401'),
  },
  {
    id: 'fe-spec-001',
    parentId: 'fe-lld-001',
    depth: 3,
    title: 'FE-SPEC-001 Tree and Details View',
    artifactType: 'FE Spec',
    jiraKey: 'FE-SPEC-001',
    state: 'pending',
    agentJobId: 'job-spec-fe-0501',
    qualityScore: null,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'FE-22',
    sourceArtifact: 'docs/projects/OPS-123/lld/execution-dashboard.md@9a1b22',
    targetRepo: 'org/frontend-repo',
    targetPath: 'docs/projects/OPS-123/spec/tree-details-view.md',
    startedAt: '--',
    summary: 'Specifies tree row metadata, nested execution state rollups, and selection-driven detail panel behavior.',
    owner: 'Frontend Platform',
    skill: 'frontend.spec@0.2.0',
    gateResult: 'not_started',
    links: linkSet('FE-SPEC-001', 'FE-22', 'tree-details-view.md', 'qg-spec-fe-0501', 'job-spec-fe-0501'),
  },
  {
    id: 'fe-spec-002',
    parentId: 'fe-lld-001',
    depth: 3,
    title: 'FE-SPEC-002 Control Surface',
    artifactType: 'FE Spec',
    jiraKey: 'FE-SPEC-002',
    state: 'pending',
    agentJobId: 'job-spec-fe-0502',
    qualityScore: null,
    qualityThreshold: 85,
    retryCount: 0,
    githubPr: 'FE-23',
    sourceArtifact: 'docs/projects/OPS-123/lld/execution-dashboard.md@9a1b22',
    targetRepo: 'org/frontend-repo',
    targetPath: 'docs/projects/OPS-123/spec/demo-controls.md',
    startedAt: '--',
    summary: 'Specifies pause, retry, fail, reset, and step advancement interactions for a mock-only demo state machine.',
    owner: 'Frontend Platform',
    skill: 'frontend.spec@0.2.0',
    gateResult: 'not_started',
    links: linkSet('FE-SPEC-002', 'FE-23', 'demo-controls.md', 'qg-spec-fe-0502', 'job-spec-fe-0502'),
  },
]

export const initialEvents: ExecutionEvent[] = [
  {
    id: 'evt-001',
    timestamp: '14:52:11',
    itemId: 'prd-initiative',
    event: 'job.started',
    level: 'info',
    message: 'prd.simple@0.1.0 accepted OPS-123 intake bundle.',
  },
  {
    id: 'evt-002',
    timestamp: '14:52:16',
    itemId: 'prd-initiative',
    event: 'skill.loaded',
    level: 'info',
    message: 'Loaded PRD generation skill with Jira and GitHub read scopes.',
  },
  {
    id: 'evt-003',
    timestamp: '14:55:21',
    itemId: 'prd-initiative',
    event: 'artifact.generated',
    level: 'success',
    message: 'Generated PRD artifact and opened PRD-17 placeholder PR.',
  },
  {
    id: 'evt-004',
    timestamp: '14:55:34',
    itemId: 'prd-initiative',
    event: 'quality_gate.scored',
    level: 'success',
    message: 'PRD quality gate scored 91/100 against threshold 85.',
  },
  {
    id: 'evt-005',
    timestamp: '15:02:18',
    itemId: 'hld-epic',
    event: 'job.completed',
    level: 'success',
    message: 'HLD passed after one retry and became source for LLD fan-out.',
  },
  {
    id: 'evt-006',
    timestamp: '15:03:04',
    itemId: 'be-lld-002',
    event: 'job.started',
    level: 'info',
    message: 'Runner started BE observability LLD child workflow.',
  },
  {
    id: 'evt-007',
    timestamp: '15:13:18',
    itemId: 'be-lld-002',
    event: 'job.failed',
    level: 'error',
    message: 'Quality gate failed because retention and redaction behavior were incomplete.',
  },
  {
    id: 'evt-008',
    timestamp: '15:13:35',
    itemId: 'be-lld-002',
    event: 'job.retrying',
    level: 'warning',
    message: 'Retry scheduled with reviewer feedback attached to runner context.',
  },
  {
    id: 'evt-009',
    timestamp: '15:14:28',
    itemId: 'fe-lld-001',
    event: 'quality_gate.scored',
    level: 'success',
    message: 'Frontend dashboard LLD scored 87/100 and is waiting for human approval.',
  },
  {
    id: 'evt-010',
    timestamp: '15:15:02',
    itemId: 'be-spec-002',
    event: 'skill.loaded',
    level: 'info',
    message: 'Loaded backend.spec@0.3.2 to produce agent job claiming spec.',
  },
]

function linkSet(jira: string, pr: string, artifact: string, quality: string, job: string) {
  return {
    jira: `https://jira.example/browse/${jira}`,
    github: `https://github.example/org/repo/pull/${pr}`,
    artifact: `https://github.example/org/repo/blob/main/${artifact}`,
    quality: `https://workflow.example/quality/${quality}`,
    logs: `https://workflow.example/runs/OPS-123/${job}/events`,
  }
}

function flowNode(
  id: string,
  label: string,
  subtitle: string,
  kind: FlowNodeKind,
  state: WorkState,
  x: number,
  y: number,
  workItemId?: string,
): FlowNode {
  return { id, label, subtitle, kind, state, x, y, workItemId }
}

function edge(from: string, to: string, label?: string): FlowEdge {
  return { id: `${from}-${to}`, from, to, label }
}
