# Workflow Execution Dashboard UI Demo

Pure frontend mock/demo for the future custom workflow app execution dashboard.

This is not a backend, runner, scheduler, database, or API implementation. It uses only local mock data to show how the future dashboard can expose nested parent-child workflow execution state better than a generic n8n execution view.

## What It Shows

- Project summary for `OPS-123`
- Overall execution progress and state counts
- Workflow list with selectable mock workflow runs
- Connected box-and-line workflow view similar to an execution canvas
- Inline contrast between n8n-style separated child executions and the custom one-screen parent/child visibility target
- Workflow selection also changes the tree, selected detail panel, and status ledger scope
- Parent-child execution tree:
  - PRD Initiative
  - HLD Epic
  - BE/FE LLD fan-out
  - BE/FE Spec child work items
- Row-level metadata:
  - artifact type
  - Jira key
  - state
  - agent job ID
  - quality score
  - retry count
  - GitHub PR placeholder
  - started and finished time
  - failed error message
- Selected item detail panel:
  - summary
  - source artifact
  - target repo/path
  - quality gate result
  - agent job info
  - related Jira, GitHub, artifact, quality, and log links
- Status events ledger:
  - `job.started`
  - `skill.loaded`
  - `artifact.generated`
  - `quality_gate.scored`
  - `job.failed`
  - `job.retrying`
  - `job.completed`
- Mock-only controls:
  - Start Demo Run
  - Advance Step
  - Fail Selected
  - Retry Selected
  - Toggle Pause
  - Reset Demo

## Run Locally

```powershell
cd ui-execution-dashboard-demo
npm install
npm run dev
```

Open the Vite URL printed in the terminal, usually:

```text
http://localhost:5173/
```

## Build Check

```powershell
npm run build
```

## Mock Data

The dashboard data is intentionally separated from the UI in:

```text
src/data/mockWorkflow.ts
```

The app does not make network requests. External Jira, GitHub, artifact, quality, and log links are placeholders for visual traceability only.
