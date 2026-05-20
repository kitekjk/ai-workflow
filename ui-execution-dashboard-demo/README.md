# Workflow Execution Dashboard UI Demo

Frontend demo for the future custom workflow app execution dashboard.

The dashboard still ships with a mock execution tree, and it can also connect to the local Workflow API through the Vite `/api` proxy.

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
- Mock controls:
  - Start Demo Run
  - Advance Step
  - Fail Selected
  - Retry Selected
  - Toggle Pause
  - Reset Demo
- API controls:
  - Seed API
  - Refresh API
  - Tick API
  - Quality Pass
  - Feedback
  - Revise
  - Approve

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

To connect the API controls, run the Workflow API in another terminal:

```powershell
cd ..
npm run start:api
```

The Vite dev server proxies `/api` to `http://127.0.0.1:3000` by default. Override with:

```powershell
$env:VITE_WORKFLOW_API_PROXY_TARGET="http://127.0.0.1:3001"
npm run dev
```

## Build Check

```powershell
npm run build
```

## Data

Mock and API mapping data are separated from the UI in:

```text
src/data/mockWorkflow.ts
src/data/workflowApi.ts
```
