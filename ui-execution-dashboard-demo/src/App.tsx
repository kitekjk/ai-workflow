import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clipboard,
  Cpu,
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
  Terminal,
  Timer,
  UserRound,
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
  defaultRunId,
  defaultActorEmail,
  fetchApiDashboard,
  fetchApiRunnerOnboarding,
  pauseApiRunner,
  recordApiFeedback,
  requestApiRevision,
  resumeApiRunner,
  runApiFullSlice,
  runApiLocalRunnerDrain,
  seedApiRun,
  setApiQualityPasses,
  tickApiRun,
  type ApiActionResult,
  type DashboardProjectSummary,
  type RunnerOnboardingSummary,
  type RunnerStatusSummary,
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
const actorEmailStorageKey = 'workflow-dashboard-actor-email'
const initialRunnerStatuses: RunnerStatusSummary[] = [
  {
    id: 'runner-planner-laptop',
    owner: 'planner@example.com',
    mode: 'local',
    status: 'busy',
    capacity: '1/1 slots',
    claim: 'runner capacity full',
    capabilities: 'document.generate, document.evaluate',
    engines: 'codex',
    heartbeat: '09:00:00',
  },
  {
    id: 'managed-router-a',
    owner: 'Workflow API',
    mode: 'managed',
    status: 'online',
    capacity: '0/1 slots',
    claim: 'no available job',
    capabilities: 'workflow.route, workflow.fanout',
    engines: 'claude',
    heartbeat: '09:00:04',
  },
]
const initialRunnerOnboarding: RunnerOnboardingSummary = {
  runnerId: 'runner-dashboard-example-com-pc',
  ownerEmail: defaultActorEmail,
  apiBaseUrl: '/api',
  mode: 'local',
  defaultEngine: 'codex',
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
  environment: {
    WORKFLOW_API_BASE_URL: '/api',
    LOCAL_RUNNER_ID: 'runner-dashboard-example-com-pc',
    LOCAL_RUNNER_OWNER_EMAIL: defaultActorEmail,
    LOCAL_RUNNER_MODE: 'local',
    LOCAL_RUNNER_CAPABILITIES: 'document.generate,document.evaluate,document.revise,workflow.route,workflow.fanout,implementation.open_pr,implementation.update_pr,implementation.collect_pr_status',
    LOCAL_RUNNER_ENGINES: 'codex,claude',
    RUNNER_ENGINE: 'codex',
    LOCAL_RUNNER_WORKSPACE_ROOT: '.runner-workspaces',
    LOCAL_RUNNER_MAX_JOBS: '6',
    GITHUB_CLONE_URL: 'https://github.com/org/service-repo.git',
  },
  powershellSetup: [
    '$env:WORKFLOW_API_BASE_URL="/api"',
    `$env:LOCAL_RUNNER_OWNER_EMAIL="${defaultActorEmail}"`,
    '$env:LOCAL_RUNNER_WORKSPACE_ROOT=".runner-workspaces"',
    '$env:LOCAL_RUNNER_MAX_JOBS="6"',
  ],
  commands: [
    { label: 'Install', command: 'npm install' },
    { label: 'Doctor', command: 'npm run doctor:local-runner' },
    { label: 'Drain', command: 'npm run start:local-runner' },
  ],
  requirements: ['Codex or Claude CLI available on this PC.'],
}

function initialActorEmail() {
  try {
    return window.localStorage.getItem(actorEmailStorageKey) || defaultActorEmail
  } catch {
    return defaultActorEmail
  }
}

function App() {
  const [items, setItems] = useState<WorkItem[]>(() => structuredClone(initialWorkItems))
  const [events, setEvents] = useState<ExecutionEvent[]>(() => structuredClone(initialEvents))
  const [workflows, setWorkflows] = useState<WorkflowRunSummary[]>(() => structuredClone(mockWorkflowCatalog))
  const [summary, setSummary] = useState<DashboardProjectSummary>(() => ({ ...mockProjectSummary }))
  const [runners, setRunners] = useState<RunnerStatusSummary[]>(() => structuredClone(initialRunnerStatuses))
  const [runnerOnboarding, setRunnerOnboarding] = useState<RunnerOnboardingSummary>(() => structuredClone(initialRunnerOnboarding))
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(mockWorkflowCatalog[0].id)
  const [selectedId, setSelectedId] = useState(initialWorkItems[4].id)
  const [paused, setPaused] = useState(false)
  const [demoStarted, setDemoStarted] = useState(false)
  const [apiMode, setApiMode] = useState(false)
  const [apiBusy, setApiBusy] = useState(false)
  const [apiStatus, setApiStatus] = useState('Mock snapshot loaded')
  const [apiRunId, setApiRunId] = useState(defaultRunId)
  const [actorEmail, setActorEmail] = useState(initialActorEmail)

  const selectedWorkflow =
    workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? workflows[0] ?? mockWorkflowCatalog[0]
  const visibleItemIds = useMemo(() => new Set(selectedWorkflow.itemIds), [selectedWorkflow])
  const visibleItems = useMemo(() => items.filter((item) => visibleItemIds.has(item.id)), [items, visibleItemIds])
  const visibleEvents = useMemo(() => events.filter((event) => visibleItemIds.has(event.itemId)), [events, visibleItemIds])
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? items[0]
  const counts = useMemo(() => summarize(visibleItems), [visibleItems])
  const progress = visibleItems.length > 0 ? Math.round((counts.completed / visibleItems.length) * 100) : 0
  const selectedEvents = visibleEvents.filter((event) => event.itemId === selected.id)
  const selectedDocumentId = selected.documentId ?? (selected.itemKind !== 'job' ? selected.id : undefined)
  const selectedApprovalGateId = selected.approvalGateId ?? (selectedDocumentId ? `gate_${selectedDocumentId}` : undefined)
  const runnerDetail = useMemo(() => summarizeRunners(runners), [runners])
  const visibleTasks = useMemo(() => visibleItems.filter((item) => item.itemKind !== 'job'), [visibleItems])
  const deliveryDetail = useMemo(() => summarizeDelivery(visibleTasks), [visibleTasks])
  const selectedJobCount = selected.jobHistory?.length ?? 0
  const currentActorEmail = actorEmail.trim() || defaultActorEmail

  function updateActorEmail(value: string) {
    setActorEmail(value)
    setRunnerOnboarding((current) => ({
      ...current,
      ownerEmail: value || defaultActorEmail,
    }))

    try {
      window.localStorage.setItem(actorEmailStorageKey, value)
    } catch {
      // Ignore storage errors; the input state is still enough for this session.
    }
  }

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
    setRunners(structuredClone(initialRunnerStatuses))
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
    setRunners(structuredClone(initialRunnerStatuses))
    setSelectedWorkflowId(mockWorkflowCatalog[0].id)
    setSelectedId(initialWorkItems[4].id)
    setPaused(false)
    setDemoStarted(false)
    setApiMode(false)
    setApiRunId(defaultRunId)
    setApiStatus('Mock snapshot loaded')
  }

  async function runApiAction(label: string, action: () => Promise<ApiActionResult | void>) {
    setApiBusy(true)
    setApiStatus(`${label}...`)

    try {
      const actionResult = await action()
      const nextRunId = actionResult?.runId ?? apiRunId
      const data = await fetchApiDashboard(nextRunId)
      const onboarding = await fetchApiRunnerOnboarding(currentActorEmail)
      setItems(data.items)
      setEvents(data.events)
      setWorkflows(data.workflows)
      setSummary(data.summary)
      setRunners(data.runners)
      setRunnerOnboarding(onboarding)
      setApiRunId(data.summary.runId)
      setSelectedWorkflowId(data.workflows[0]?.id ?? '')
      setSelectedId((current) => data.items.find((item) => item.id === current)?.id ?? data.items[0]?.id ?? '')
      setApiMode(true)
      setDemoStarted(false)
      setPaused(false)
      setApiStatus(actionResult?.message ?? `${label} complete`)
    } catch (error) {
      setApiStatus(error instanceof Error ? error.message : 'API request failed')
    } finally {
      setApiBusy(false)
    }
  }

  function loadApiRun() {
    void runApiAction('Refresh API', async () => ({ runId: apiRunId }))
  }

  function seedFromApi() {
    void runApiAction('Seed API', () => seedApiRun(currentActorEmail))
  }

  function tickFromApi() {
    void runApiAction('Tick API', async () => {
      await tickApiRun()
      return { runId: apiRunId }
    })
  }

  function feedbackToApi() {
    if (!selectedDocumentId) return
    void runApiAction('Feedback', async () => {
      await recordApiFeedback(selectedDocumentId, currentActorEmail)
      return { runId: apiRunId }
    })
  }

  function reviseFromApi() {
    if (!selectedDocumentId) return
    void runApiAction('Revision', async () => {
      await requestApiRevision(selectedDocumentId, currentActorEmail)
      return { runId: apiRunId }
    })
  }

  function approveFromApi() {
    if (!selectedApprovalGateId) return
    void runApiAction('Approve', async () => {
      await approveApiGate(selectedApprovalGateId, currentActorEmail)
      return { runId: apiRunId }
    })
  }

  function passQualityFromApi() {
    void runApiAction('Quality Pass', async () => {
      await setApiQualityPasses(true)
      return { runId: apiRunId }
    })
  }

  function runLocalRunnerFromApi() {
    void runApiAction('Local Runner Drain', async () => {
      await runApiLocalRunnerDrain(currentActorEmail)
      return { runId: apiRunId }
    })
  }

  function runFullSliceFromApi() {
    void runApiAction('Full API Slice', () => runApiFullSlice(currentActorEmail))
  }

  function pauseRunnerFromApi(runnerId: string) {
    void runApiAction('Pause Runner', async () => {
      await pauseApiRunner(runnerId)
      return { runId: apiRunId }
    })
  }

  function resumeRunnerFromApi(runnerId: string) {
    void runApiAction('Resume Runner', async () => {
      await resumeApiRunner(runnerId)
      return { runId: apiRunId }
    })
  }

  function copyOnboardingText(value: string) {
    void navigator.clipboard?.writeText(value)
    setApiStatus('Copied runner setup')
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
        <label className="actor-field">
          <UserRound size={15} />
          <span>Actor</span>
          <input
            type="email"
            value={actorEmail}
            onChange={(event) => updateActorEmail(event.target.value)}
            aria-label="Actor email"
            spellCheck={false}
          />
        </label>
        <span className="control-divider" />
        <button type="button" onClick={seedFromApi} disabled={apiBusy}>
          <Play size={16} /> Seed API
        </button>
        <button type="button" onClick={runFullSliceFromApi} disabled={apiBusy}>
          <GitPullRequest size={16} /> Full API Slice
        </button>
        <button type="button" onClick={loadApiRun} disabled={apiBusy}>
          <RefreshCcw size={16} /> Refresh API
        </button>
        <button type="button" onClick={tickFromApi} disabled={apiBusy}>
          <StepForward size={16} /> Tick API
        </button>
        <button type="button" onClick={runLocalRunnerFromApi} disabled={apiBusy || !apiMode}>
          <Cpu size={16} /> Run Local Runner
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

      <section className="panel runner-panel" aria-label="Runner status">
        <PanelTitle icon={<Cpu size={18} />} title="Runner Status" detail={runnerDetail} />
        <div className="runner-list">
          {runners.length > 0 ? (
            runners.map((runner) => (
              <div className={`runner-row ${runner.status}`} key={runner.id}>
                <span className="runner-status-cell">
                  <span className="runner-dot" />
                  <strong>{runner.id}</strong>
                </span>
                <span>{runner.owner}</span>
                <code>{runner.mode}</code>
                <span>{runner.status}</span>
                <span>{runner.capacity}</span>
                <span title={runner.claim}>{runner.claim}</span>
                <span>{runner.engines}</span>
                <span>{runner.capabilities}</span>
                <time>{runner.heartbeat}</time>
                <span className="runner-actions">
                  <button
                    type="button"
                    onClick={() => pauseRunnerFromApi(runner.id)}
                    disabled={apiBusy || !apiMode || runner.status === 'disabled'}
                    title="Pause runner claims"
                    aria-label={`Pause ${runner.id}`}
                  >
                    <Pause size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => resumeRunnerFromApi(runner.id)}
                    disabled={apiBusy || !apiMode || runner.status !== 'disabled'}
                    title="Resume runner claims"
                    aria-label={`Resume ${runner.id}`}
                  >
                    <Play size={14} />
                  </button>
                </span>
              </div>
            ))
          ) : (
            <p className="runner-empty">No runners registered.</p>
          )}
        </div>
      </section>

      <section className="panel runner-onboarding-panel" aria-label="Local runner onboarding">
        <PanelTitle icon={<Terminal size={18} />} title="Local Runner Onboarding" detail={runnerOnboarding.runnerId} />
        <div className="onboarding-grid">
          <div className="onboarding-env">
            {Object.entries(runnerOnboarding.environment).slice(0, 8).map(([key, value]) => (
              <button
                type="button"
                className="env-row"
                key={key}
                onClick={() => copyOnboardingText(`$env:${key}=${JSON.stringify(value)}`)}
                title={`Copy ${key}`}
              >
                <span>{key}</span>
                <code>{value}</code>
                <Clipboard size={14} />
              </button>
            ))}
          </div>
          <div className="onboarding-commands">
            <button
              type="button"
              className="setup-command"
              onClick={() => copyOnboardingText(runnerOnboarding.powershellSetup.join('\n'))}
              title="Copy PowerShell setup"
            >
              <span>PowerShell</span>
              <code>{runnerOnboarding.powershellSetup.slice(0, 3).join('  ')}</code>
              <Clipboard size={14} />
            </button>
            {runnerOnboarding.commands.map((command) => (
              <button
                type="button"
                className="command-row"
                key={`${command.label}-${command.command}`}
                onClick={() => copyOnboardingText(command.command)}
                title={`Copy ${command.label}`}
              >
                <span>{command.label}</span>
                <code>{command.command}</code>
                <Clipboard size={14} />
              </button>
            ))}
          </div>
        </div>
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

      <section className="panel delivery-map-panel" aria-label="Task delivery map">
        <PanelTitle
          icon={<GitBranch size={18} />}
          title="Task Delivery Map"
          detail={deliveryDetail}
        />
        <DocumentDeliveryMap
          documents={visibleTasks}
          selectedId={selected.id}
          onSelect={setSelectedId}
        />
      </section>

      <section className="content-grid">
        <section className="panel tree-panel" aria-label="Workflow execution tree">
          <PanelTitle
            icon={<GitBranch size={18} />}
            title="Workflow Execution Tree"
            detail="PRD -> HLD -> LLD -> Spec -> Code tasks"
          />
          <div className="tree-table" role="table">
            <div className="tree-header" role="row">
              <span>Work item</span>
              <span>State</span>
              <span>Latest job</span>
              <span>Score</span>
              <span>Jobs</span>
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
                  <span>{item.jobHistory?.length ?? item.retryCount + 1}</span>
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
              <span className="section-label">Task job summary</span>
              <div className="agent-grid">
                <span>Latest job</span>
                <code>{selected.agentJobId}</code>
                <span>Skill</span>
                <code>{selected.skill}</code>
                <span>Jobs</span>
                <strong>{selectedJobCount || selected.retryCount + 1}</strong>
              </div>
            </div>
            {selected.jobHistory?.length ? (
              <div className="job-history-card">
                <span className="section-label">Job history</span>
                {selected.jobHistory.map((job) => (
                  <div className="job-history-row" key={job.id}>
                    <span className={`branch-dot ${job.state}`} />
                    <div>
                      <strong>{job.jobType}</strong>
                      <small>{job.summary}</small>
                    </div>
                    <code>{job.id}</code>
                    <span>{job.status}</span>
                    <time>
                      {job.startedAt} / {job.finishedAt ?? '--'}
                    </time>
                  </div>
                ))}
              </div>
            ) : null}
            {selected.pullRequests?.length ? (
              <div className="implementation-card">
                <span className="section-label">Implementation PR</span>
                {selected.pullRequests.map((pullRequest) => (
                  <a href={pullRequest.url} target="_blank" rel="noreferrer" key={pullRequest.id}>
                    <GitPullRequest size={16} />
                    <strong>{pullRequest.label}</strong>
                    <span>{pullRequest.merged ? 'merged' : pullRequest.reviewStatus ?? pullRequest.pullRequestState ?? 'review pending'}</span>
                    <span>{pullRequest.ciStatus ?? 'ci pending'}</span>
                  </a>
                ))}
              </div>
            ) : null}
            {selected.artifactLinks?.length ? (
              <div className="artifact-history-card">
                <span className="section-label">Artifact history</span>
                {selected.artifactLinks.slice(-5).map((artifact) => (
                  <a href={artifact.uri} target="_blank" rel="noreferrer" key={artifact.id}>
                    <span>{artifact.type}</span>
                    <code>{artifact.location}</code>
                  </a>
                ))}
              </div>
            ) : null}
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
  const stageWidth = Math.max(835, ...workflow.nodes.map((node) => node.x + 146))
  const stageHeight = Math.max(340, ...workflow.nodes.map((node) => node.y + 154))

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
            <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" />
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

function DocumentDeliveryMap({
  documents,
  selectedId,
  onSelect,
}: {
  documents: WorkItem[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const orderedDocuments = useMemo(() => orderDocumentItems(documents), [documents])

  if (!orderedDocuments.length) {
    return <p className="delivery-empty">No task artifacts are available for this workflow yet.</p>
  }

  return (
    <div className="delivery-map">
      <div className="delivery-header">
        <span>Task</span>
        <span>Status</span>
        <span>Quality</span>
        <span>Jobs</span>
        <span>Implementation</span>
      </div>
      <div className="delivery-body">
        {orderedDocuments.map((document) => (
          <button
            type="button"
            key={document.id}
            className={`delivery-row ${document.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(document.id)}
          >
            <span className="delivery-document" style={{ paddingLeft: `${document.depth * 22 + 10}px` }}>
              <span className={`branch-dot ${document.state}`} />
              <span>
                <strong>{document.artifactType}</strong>
                <small>{document.title}</small>
              </span>
            </span>
            <StatusBadge state={document.state} />
            <span className="delivery-quality">
              <strong>{formatScore(document.qualityScore)}</strong>
              <small>{document.qualityRiskCount ?? 0} risks</small>
            </span>
            <span className="delivery-artifacts">
              <strong>{document.jobHistory?.length ?? document.versionCount ?? 0} jobs</strong>
              <small>{document.artifactCount ?? 0} artifacts</small>
            </span>
            <span className="delivery-prs">
              {document.pullRequests?.length ? (
                document.pullRequests.map((pullRequest) => (
                  <span className="pr-chip" key={pullRequest.id}>
                    <GitPullRequest size={13} />
                    {pullRequest.label}
                    <small>{pullRequest.ciStatus ?? 'ci pending'}</small>
                  </span>
                ))
              ) : (
                <span className="pr-chip muted">No PR</span>
              )}
            </span>
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

function summarizeDelivery(documents: WorkItem[]): string {
  if (!documents.length) {
    return '0 tasks'
  }

  const pullRequestCount = documents.reduce((total, document) => total + (document.pullRequests?.length ?? 0), 0)
  const completedCount = documents.filter((document) => document.state === 'completed').length

  return `${completedCount}/${documents.length} done / ${pullRequestCount} PR artifacts`
}

function orderDocumentItems(documents: WorkItem[]): WorkItem[] {
  const byId = new Map(documents.map((document) => [document.id, document]))
  const childrenByParent = new Map<string, WorkItem[]>()
  const roots: WorkItem[] = []

  for (const document of documents) {
    if (document.parentId && byId.has(document.parentId)) {
      const children = childrenByParent.get(document.parentId) ?? []
      children.push(document)
      childrenByParent.set(document.parentId, children)
    } else {
      roots.push(document)
    }
  }

  const sortByTypeAndTitle = (left: WorkItem, right: WorkItem) =>
    documentTypeRank(left) - documentTypeRank(right) || left.title.localeCompare(right.title)
  const ordered: WorkItem[] = []
  const visit = (document: WorkItem) => {
    ordered.push(document)
    ;(childrenByParent.get(document.id) ?? []).sort(sortByTypeAndTitle).forEach(visit)
  }

  roots.sort(sortByTypeAndTitle).forEach(visit)
  return ordered
}

function documentTypeRank(document: WorkItem): number {
  const artifactType = document.artifactType.toLowerCase()

  if (document.taskKind === 'code') return 5
  if (artifactType === 'prd') return 0
  if (artifactType === 'hld') return 1
  if (artifactType.includes('lld')) return 2
  if (artifactType.includes('spec')) return 3
  if (artifactType === 'adr') return 4

  return 6
}

function summarizeRunners(runners: RunnerStatusSummary[]): string {
  if (runners.length === 0) {
    return '0 connected'
  }

  const counts = runners.reduce<Record<string, number>>((accumulator, runner) => {
    accumulator[runner.status] = (accumulator[runner.status] ?? 0) + 1
    return accumulator
  }, {})
  const orderedStatuses = ['busy', 'offline', 'disabled', 'online']
  const knownParts = orderedStatuses
    .filter((status) => counts[status])
    .map((status) => `${counts[status]} ${status}`)
  const otherParts = Object.keys(counts)
    .filter((status) => !orderedStatuses.includes(status))
    .sort()
    .map((status) => `${counts[status]} ${status}`)

  return `${runners.length} connected / ${[...knownParts, ...otherParts].join(' / ')}`
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
  const nodeHeight = 86
  const rawStartX = from.x + nodeWidth
  const rawEndX = to.x
  const horizontalGap = rawEndX - rawStartX
  const startClearance = horizontalGap > 20 ? 6 : 0
  const endClearance = horizontalGap > 20 ? 10 : Math.max(2, horizontalGap / 4)
  const startX = rawStartX + startClearance
  const startY = from.y + nodeHeight / 2
  const endX = rawEndX - endClearance
  const endY = to.y + nodeHeight / 2
  const curve = Math.max(24, Math.min(96, Math.abs(endX - startX) * 0.55))

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
