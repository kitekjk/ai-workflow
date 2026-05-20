import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  StepForward,
  Timer,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import './App.css'
import {
  initialEvents,
  initialWorkItems,
  projectSummary as mockProjectSummary,
  workflowCatalog as mockWorkflowCatalog,
  type ExecutionEvent,
  type FlowNode,
  type WorkflowRunSummary,
  type WorkItem,
  type WorkState,
} from './data/mockWorkflow'
import {
  approveApiGate,
  fetchApiDashboard,
  recordApiFeedback,
  requestApiRevision,
  seedApiRun,
  setApiQualityPasses,
  tickApiRun,
  type DashboardProjectSummary,
} from './data/workflowApi'

const stateLabels: Record<WorkState, string> = {
  completed: 'completed',
  running: 'running',
  failed: 'failed',
  waiting_approval: 'waiting approval',
  pending: 'pending',
  blocked: 'blocked',
}

const visibleStates: WorkState[] = ['running', 'failed', 'waiting_approval', 'completed']

function App() {
  const [items, setItems] = useState<WorkItem[]>(() => structuredClone(initialWorkItems))
  const [events, setEvents] = useState<ExecutionEvent[]>(() => structuredClone(initialEvents))
  const [workflows, setWorkflows] = useState<WorkflowRunSummary[]>(() => structuredClone(mockWorkflowCatalog))
  const [summary, setSummary] = useState<DashboardProjectSummary>(() => ({ ...mockProjectSummary }))
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(mockWorkflowCatalog[0].id)
  const [selectedId, setSelectedId] = useState(initialWorkItems[4].id)
  const [paused, setPaused] = useState(false)
  const [demoStarted, setDemoStarted] = useState(false)
  const [apiMode, setApiMode] = useState(false)
  const [apiBusy, setApiBusy] = useState(false)
  const [apiStatus, setApiStatus] = useState('Mock snapshot loaded')

  const selectedWorkflow =
    workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? workflows[0] ?? mockWorkflowCatalog[0]
  const visibleItemIds = useMemo(() => new Set(selectedWorkflow.itemIds), [selectedWorkflow])
  const visibleItems = useMemo(() => items.filter((item) => visibleItemIds.has(item.id)), [items, visibleItemIds])
  const visibleEvents = useMemo(() => events.filter((event) => visibleItemIds.has(event.itemId)), [events, visibleItemIds])
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? items[0]
  const counts = useMemo(() => summarize(visibleItems), [visibleItems])
  const progress = visibleItems.length > 0 ? Math.round((counts.completed / visibleItems.length) * 100) : 0
  const selectedEvents = visibleEvents.filter((event) => event.itemId === selected.id)
  const selectedDocumentId = selected.documentId ?? (selected.itemKind === 'document' ? selected.id : undefined)
  const selectedApprovalGateId = selected.approvalGateId ?? (selectedDocumentId ? `gate_${selectedDocumentId}` : undefined)

  function appendEvent(item: WorkItem, event: string, level: ExecutionEvent['level'], message: string) {
    setEvents((current) => [
      ...current,
      {
        id: `evt-${Date.now()}-${current.length}`,
        timestamp: currentTime(),
        itemId: item.id,
        event,
        level,
        message,
      },
    ])
  }

  function startDemoRun() {
    setItems(structuredClone(initialWorkItems))
    setEvents(structuredClone(initialEvents))
    setWorkflows(structuredClone(mockWorkflowCatalog))
    setSummary({ ...mockProjectSummary })
    setSelectedWorkflowId(mockWorkflowCatalog[0].id)
    setSelectedId('be-spec-002')
    setPaused(false)
    setDemoStarted(true)
    setApiMode(false)
    setApiStatus('Mock run active')
  }

  function selectWorkflow(workflow: WorkflowRunSummary) {
    setSelectedWorkflowId(workflow.id)
    setSelectedId(workflow.itemIds[0])
  }

  function advanceStep() {
    if (paused) return

    setItems((current) => {
      const next = structuredClone(current)
      const running = next.find((item) => visibleItemIds.has(item.id) && item.state === 'running')
      const waiting = next.find((item) => visibleItemIds.has(item.id) && (item.state === 'pending' || item.state === 'blocked'))

      if (running) {
        running.state = 'completed'
        running.qualityScore = Math.max(running.qualityScore ?? 86, running.qualityThreshold + 3)
        running.gateResult = 'passed'
        running.finishedAt = currentTime()
        appendEvent(running, 'artifact.generated', 'success', `${running.jiraKey} generated artifact draft and linked placeholder PR.`)
        appendEvent(running, 'quality_gate.scored', 'success', `${running.jiraKey} scored ${running.qualityScore}/100 and passed quality gate.`)
        appendEvent(running, 'job.completed', 'success', `${running.agentJobId} completed and updated the status ledger.`)
      }

      if (waiting) {
        waiting.state = 'running'
        waiting.startedAt = currentTime()
        waiting.gateResult = 'waiting'
        setSelectedId(waiting.id)
        appendEvent(waiting, 'job.started', 'info', `${waiting.agentJobId} started from parent child workflow fan-out.`)
      }

      return next
    })
  }

  function failSelected() {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== selected.id) return item
        const failed = {
          ...item,
          state: 'failed' as const,
          gateResult: 'failed' as const,
          finishedAt: currentTime(),
          qualityScore: Math.min(item.qualityScore ?? 72, item.qualityThreshold - 9),
          error: 'Demo failure injected: reviewer feedback requires stronger acceptance criteria and clearer rollback handling.',
        }
        appendEvent(failed, 'job.failed', 'error', `${failed.jiraKey} failed in demo mode and awaits retry or manual review.`)
        return failed
      }),
    )
  }

  function retrySelected() {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== selected.id) return item
        const retried = {
          ...item,
          state: 'running' as const,
          gateResult: 'waiting' as const,
          retryCount: item.retryCount + 1,
          startedAt: currentTime(),
          finishedAt: undefined,
          error: undefined,
        }
        appendEvent(retried, 'job.retrying', 'warning', `${retried.jiraKey} retry requested with prior feedback included in runner context.`)
        appendEvent(retried, 'job.started', 'info', `${retried.agentJobId} restarted attempt ${retried.retryCount + 1}.`)
        return retried
      }),
    )
    setPaused(false)
  }

  function resetDemo() {
    setItems(structuredClone(initialWorkItems))
    setEvents(structuredClone(initialEvents))
    setWorkflows(structuredClone(mockWorkflowCatalog))
    setSummary({ ...mockProjectSummary })
    setSelectedWorkflowId(mockWorkflowCatalog[0].id)
    setSelectedId(initialWorkItems[4].id)
    setPaused(false)
    setDemoStarted(false)
    setApiMode(false)
    setApiStatus('Mock snapshot loaded')
  }

  async function runApiAction(label: string, action: () => Promise<void>) {
    setApiBusy(true)
    setApiStatus(`${label}...`)

    try {
      await action()
      const data = await fetchApiDashboard()
      setItems(data.items)
      setEvents(data.events)
      setWorkflows(data.workflows)
      setSummary(data.summary)
      setSelectedWorkflowId(data.workflows[0]?.id ?? '')
      setSelectedId((current) => data.items.find((item) => item.id === current)?.id ?? data.items[0]?.id ?? '')
      setApiMode(true)
      setDemoStarted(false)
      setPaused(false)
      setApiStatus(`${label} complete`)
    } catch (error) {
      setApiStatus(error instanceof Error ? error.message : 'API request failed')
    } finally {
      setApiBusy(false)
    }
  }

  function loadApiRun() {
    void runApiAction('Refresh API', async () => {})
  }

  function seedFromApi() {
    void runApiAction('Seed API', seedApiRun)
  }

  function tickFromApi() {
    void runApiAction('Tick API', tickApiRun)
  }

  function feedbackToApi() {
    if (!selectedDocumentId) return
    void runApiAction('Feedback', () => recordApiFeedback(selectedDocumentId))
  }

  function reviseFromApi() {
    if (!selectedDocumentId) return
    void runApiAction('Revision', () => requestApiRevision(selectedDocumentId))
  }

  function approveFromApi() {
    if (!selectedApprovalGateId) return
    void runApiAction('Approve', () => approveApiGate(selectedApprovalGateId))
  }

  function passQualityFromApi() {
    void runApiAction('Quality Pass', () => setApiQualityPasses(true))
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Workflow execution dashboard demo</div>
          <h1>{summary.projectKey} parent-child execution</h1>
        </div>
        <div className="run-meta">
          <span>{summary.workflowVersion}</span>
          <span>{summary.runId}</span>
        </div>
      </header>

      <section className="summary-bar" aria-label="Execution summary">
        <Metric label="Project key" value={summary.projectKey} />
        <div className="metric progress-metric">
          <div className="metric-label">Overall progress</div>
          <div className="progress-row">
            <strong>{progress}%</strong>
            <div className="progress-track" aria-label={`${progress}% complete`}>
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
        {visibleStates.map((state) => (
          <Metric key={state} label={stateLabels[state]} value={counts[state]} accent={state} />
        ))}
        <Metric label="Started" value={summary.startedAt} />
        <Metric label="Elapsed" value={summary.elapsed} icon={<Timer size={15} />} />
      </section>

      <section className="control-strip" aria-label="Demo controls">
        <button type="button" onClick={startDemoRun}>
          <Play size={16} /> Start Demo Run
        </button>
        <button type="button" onClick={advanceStep} disabled={paused}>
          <StepForward size={16} /> Advance Step
        </button>
        <button type="button" onClick={failSelected}>
          <AlertTriangle size={16} /> Fail Selected
        </button>
        <button type="button" onClick={retrySelected}>
          <RefreshCcw size={16} /> Retry Selected
        </button>
        <button type="button" onClick={() => setPaused((value) => !value)} className={paused ? 'is-paused' : ''}>
          {paused ? <Play size={16} /> : <Pause size={16} />} Toggle Pause
        </button>
        <button type="button" onClick={resetDemo}>
          <RotateCcw size={16} /> Reset Demo
        </button>
        <span className="control-divider" />
        <button type="button" onClick={seedFromApi} disabled={apiBusy}>
          <Play size={16} /> Seed API
        </button>
        <button type="button" onClick={loadApiRun} disabled={apiBusy}>
          <RefreshCcw size={16} /> Refresh API
        </button>
        <button type="button" onClick={tickFromApi} disabled={apiBusy}>
          <StepForward size={16} /> Tick API
        </button>
        <button type="button" onClick={passQualityFromApi} disabled={apiBusy || !apiMode}>
          <ShieldCheck size={16} /> Quality Pass
        </button>
        <button type="button" onClick={feedbackToApi} disabled={apiBusy || !apiMode || !selectedDocumentId}>
          <FileText size={16} /> Feedback
        </button>
        <button type="button" onClick={reviseFromApi} disabled={apiBusy || !apiMode || !selectedDocumentId}>
          <RefreshCcw size={16} /> Revise
        </button>
        <button type="button" onClick={approveFromApi} disabled={apiBusy || !apiMode || !selectedApprovalGateId}>
          <CheckCircle2 size={16} /> Approve
        </button>
        <span className="control-status">
          {apiBusy ? 'API request running' : apiMode ? apiStatus : paused ? 'Paused' : demoStarted ? 'Demo run active' : apiStatus}
        </span>
      </section>

      <section className="workflow-browser" aria-label="Workflow list and connected execution map">
        <aside className="panel workflow-list-panel">
          <PanelTitle icon={<GitBranch size={18} />} title="Workflow List" detail={`${workflows.length} ${apiMode ? 'API' : 'mock'} runs`} />
          <div className="workflow-list">
            {workflows.map((workflow) => (
              <button
                type="button"
                key={workflow.id}
                className={`workflow-list-item ${workflow.id === selectedWorkflow.id ? 'selected' : ''}`}
                onClick={() => selectWorkflow(workflow)}
              >
                <span className="workflow-list-top">
                  <strong>{workflow.name}</strong>
                  <StatusBadge state={workflow.state} />
                </span>
                <span className="workflow-list-description">{workflow.description}</span>
                <span className="workflow-list-meta">
                  <code>{workflow.projectKey}</code>
                  <span>{workflow.owner}</span>
                  <span>{workflow.progress}%</span>
                </span>
                <span className="workflow-list-progress">
                  <span style={{ width: `${workflow.progress}%` }} />
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel flow-panel">
          <PanelTitle
            icon={<CircleDot size={18} />}
            title="Connected Workflow View"
            detail={`${selectedWorkflow.projectKey} / ${selectedWorkflow.runId}`}
          />
          <WorkflowCanvas workflow={selectedWorkflow} selectedWorkItemId={selected.id} onSelectWorkItem={setSelectedId} />
        </section>
      </section>

      <section className="content-grid">
        <section className="panel tree-panel" aria-label="Workflow execution tree">
          <PanelTitle
            icon={<GitBranch size={18} />}
            title="Workflow Execution Tree"
            detail="PRD -> HLD -> LLD fan-out -> Spec fan-in"
          />
          <div className="tree-table" role="table">
            <div className="tree-header" role="row">
              <span>Work item</span>
              <span>State</span>
              <span>Agent job</span>
              <span>Score</span>
              <span>Retry</span>
              <span>PR</span>
              <span>Time</span>
            </div>
            <div className="tree-body">
              {visibleItems.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`tree-row ${item.id === selected.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                  role="row"
                >
                  <span className="tree-title" style={{ paddingLeft: `${item.depth * 22 + 8}px` }}>
                    <span className={`branch-dot ${item.state}`} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.artifactType} / {item.jiraKey} / {item.owner}
                      </small>
                    </span>
                  </span>
                  <StatusBadge state={item.state} />
                  <code>{item.agentJobId}</code>
                  <span className="score">{formatScore(item.qualityScore)}</span>
                  <span>{item.retryCount}</span>
                  <span className="link-pill">
                    <GitPullRequest size={14} /> {item.githubPr}
                  </span>
                  <span className="time-cell">
                    {item.startedAt} / {item.finishedAt ?? '--'}
                  </span>
                  {item.error ? <span className="row-error">{item.error}</span> : null}
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="panel detail-panel" aria-label="Selected work item details">
          <PanelTitle icon={<FileText size={18} />} title="Selected Item" detail={selected.jiraKey} />
          <div className="detail-heading">
            <div>
              <h2>{selected.title}</h2>
              <p>{selected.summary}</p>
            </div>
            <StatusBadge state={selected.state} />
          </div>

          <div className="detail-stack">
            <InfoBlock label="Source artifact" value={selected.sourceArtifact} />
            <InfoBlock label="Target repo/path" value={`${selected.targetRepo} / ${selected.targetPath}`} />
            <div className="quality-card">
              <div>
                <span className="section-label">Quality gate result</span>
                <strong>{selected.gateResult.replace('_', ' ')}</strong>
              </div>
              <div className="quality-score">
                <ShieldCheck size={18} />
                {formatScore(selected.qualityScore)}
                <small>threshold {selected.qualityThreshold}</small>
              </div>
            </div>
            <div className="agent-card">
              <span className="section-label">Agent job info</span>
              <div className="agent-grid">
                <span>Job ID</span>
                <code>{selected.agentJobId}</code>
                <span>Skill</span>
                <code>{selected.skill}</code>
                <span>Attempts</span>
                <strong>{selected.retryCount + 1}</strong>
              </div>
            </div>
            {selected.error ? (
              <div className="error-box">
                <AlertTriangle size={16} />
                <span>{selected.error}</span>
              </div>
            ) : null}
            <div className="related-links">
              <span className="section-label">Related links</span>
              <LinkButton label="Jira" href={selected.links.jira} />
              <LinkButton label="GitHub PR" href={selected.links.github} />
              <LinkButton label="Artifact" href={selected.links.artifact} />
              <LinkButton label="Quality score" href={selected.links.quality} />
              <LinkButton label="Logs" href={selected.links.logs} />
            </div>
          </div>
        </aside>

        <section className="panel log-panel" aria-label="Status events and execution log">
          <PanelTitle
            icon={<CircleDot size={18} />}
            title="Status Events / Execution Log"
            detail="Append-only ledger ordered by time"
          />
          <div className="ledger-layout">
            <div className="event-list">
              {visibleEvents.map((event) => {
                const item = items.find((candidate) => candidate.id === event.itemId)
                return (
                  <div className={`event-row ${event.level}`} key={event.id}>
                    <time>{event.timestamp}</time>
                    <span className="event-name">{event.event}</span>
                    <span className="event-item">{item?.jiraKey ?? event.itemId}</span>
                    <p>{event.message}</p>
                  </div>
                )
              })}
            </div>
            <div className="selected-events">
              <span className="section-label">Selected item ledger</span>
              {selectedEvents.length > 0 ? (
                selectedEvents.map((event) => (
                  <div className={`mini-event ${event.level}`} key={event.id}>
                    <strong>{event.event}</strong>
                    <span>{event.timestamp}</span>
                  </div>
                ))
              ) : (
                <p>No events yet for this selected work item.</p>
              )}
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}

function WorkflowCanvas({
  workflow,
  selectedWorkItemId,
  onSelectWorkItem,
}: {
  workflow: WorkflowRunSummary
  selectedWorkItemId: string
  onSelectWorkItem: (id: string) => void
}) {
  const stageWidth = Math.max(835, ...workflow.nodes.map((node) => node.x + 132))
  const stageHeight = Math.max(340, ...workflow.nodes.map((node) => node.y + 122))

  return (
    <div className="flow-canvas">
      <div
        className="flow-stage"
        role="img"
        aria-label={`${workflow.name} connected workflow diagram`}
        style={{ width: stageWidth, height: stageHeight }}
      >
        <svg
          className="flow-lines"
          viewBox={`0 0 ${stageWidth} ${stageHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" />
            </marker>
          </defs>
          {workflow.edges.map((edgeItem) => {
            const from = workflow.nodes.find((node) => node.id === edgeItem.from)
            const to = workflow.nodes.find((node) => node.id === edgeItem.to)
            if (!from || !to) return null

            return (
              <g key={edgeItem.id}>
                <path d={edgePath(from, to)} />
                {edgeItem.label ? (
                  <text x={(from.x + to.x) / 2 + 72} y={(from.y + to.y) / 2 + 4}>
                    {edgeItem.label}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>

        {workflow.nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            className={`flow-node ${node.state} ${node.workItemId === selectedWorkItemId ? 'active' : ''}`}
            style={{ left: node.x, top: node.y }}
            onClick={() => node.workItemId && onSelectWorkItem(node.workItemId)}
            disabled={!node.workItemId}
          >
            <span className="flow-kind">{node.kind.replace('_', ' ')}</span>
            <strong>{node.label}</strong>
            <small>{node.subtitle}</small>
            <StatusBadge state={node.state} />
          </button>
        ))}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  accent,
  icon,
}: {
  label: string
  value: string | number
  accent?: WorkState
  icon?: ReactNode
}) {
  return (
    <div className={`metric ${accent ? `metric-${accent}` : ''}`}>
      <div className="metric-label">
        {icon}
        {label}
      </div>
      <strong>{value}</strong>
    </div>
  )
}

function PanelTitle({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="panel-title">
      <div>
        {icon}
        <h2>{title}</h2>
      </div>
      <span>{detail}</span>
    </div>
  )
}

function StatusBadge({ state }: { state: WorkState }) {
  return (
    <span className={`status-badge ${state}`}>
      {state === 'completed' ? <CheckCircle2 size={14} /> : null}
      {state === 'failed' ? <AlertTriangle size={14} /> : null}
      {stateLabels[state]}
    </span>
  )
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-block">
      <span className="section-label">{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function LinkButton({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
      <ExternalLink size={13} />
    </a>
  )
}

function edgePath(from: FlowNode, to: FlowNode) {
  const nodeWidth = 104
  const nodeHeight = 58
  const startX = from.x + nodeWidth
  const startY = from.y + nodeHeight / 2
  const endX = to.x
  const endY = to.y + nodeHeight / 2
  const curve = Math.max(55, Math.min(120, (endX - startX) * 0.55))

  return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`
}

function summarize(items: WorkItem[]) {
  return items.reduce(
    (acc, item) => {
      acc[item.state] += 1
      return acc
    },
    {
      completed: 0,
      running: 0,
      failed: 0,
      waiting_approval: 0,
      pending: 0,
      blocked: 0,
    } satisfies Record<WorkState, number>,
  )
}

function currentTime() {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date())
}

function formatScore(score: number | null) {
  return score === null ? '--' : `${score}/100`
}

export default App
