# Session State - 2026-05-18

## Summary

This session moved the project from planning into a working PRD confirmation
vertical slice. The slice now supports manual Jira PRD intake, linked source
request loading, runner job orchestration, local PRD Git commits, Confluence
wiki publishing, stub quality evaluation, and API state inspection.

## Current Architecture

```text
Workflow API
  -> PRD intake / tick / state endpoints
Workflow Engine
  -> Creates and advances PRD jobs
Scheduler
  -> Claims pending agent jobs
Runner Worker
  -> Executes PRD skills
Runner Skill
  -> Reads Jira context through workflow store
  -> Commits PRD markdown to local Git repo
  -> Publishes PRD wiki page
  -> Runs stub quality gate
```

## Implemented Files

- `backend/src/workflow-api/server.ts`: HTTP API for PRD intake, feedback revision,
  ticks, state lookup, and quality test control.
- `backend/src/workflow-api/main.ts`: runtime entrypoint.
- `backend/src/runtime/create-runtime.ts`: creates stub or real integration runtime
  from environment variables.
- `backend/src/prd-confirmation/*`: in-memory workflow state, engine, scheduler,
  runner worker, stub skill, adapter-backed PRD skill, and ports.
- `backend/src/integrations/jira-client.ts`: Jira REST reader for PRD ticket plus linked
  source requests.
- `backend/src/integrations/local-git-prd-repository.ts`: commits PRD markdown directly
  to the configured local Git repo.
- `backend/src/integrations/confluence-wiki.ts`: publishes PRD markdown as a Confluence
  page under a configured parent page.
- `tests/*`: TDD coverage for workflow behavior, API behavior, and integration
  adapters.

## Real Integration Verified

Jira MCP was used to create two demo operational request tickets:

- `PAIR-3`: `[AI Workflow Demo] 운영 요청 1 - FAQ 반복 문의 감소`
- `PAIR-4`: `[AI Workflow Demo] 운영 요청 2 - 답변 기준/성과 지표 정리`

Both were linked to PRD container ticket:

- `PAIR-2`: `PRD 데모용`

Real mode was verified with:

```bash
curl -X POST http://127.0.0.1:3000/prd/intake \
  -H 'content-type: application/json' \
  -d '{"prdJiraKey":"PAIR-2"}'

curl -X POST http://127.0.0.1:3000/tick
curl -X POST http://127.0.0.1:3000/tick
curl http://127.0.0.1:3000/state/PAIR-2
```

Observed output:

- `prd.generate_draft`: succeeded
- `prd.evaluate_quality`: succeeded
- final status: `needs_revision`
- PRD markdown artifact:
  `file:///Users/kay.kim/works/ai-workflow-local-prd/prds/PAIR-2.md`
- Confluence page:
  `https://musinsa-oneteam.atlassian.net/spaces/LOGISSOL/pages/454266529/PAIR-2+Generated+PRD`

## Important Decisions

- Jira trigger remains manual for now.
- PRD Jira ticket is a planner-created container; linked request tickets provide
  the actual request content.
- Runner jobs share a primary Jira tracking context; each runner job does not
  create its own Jira issue.
- PRD repo commits go directly to the current branch; no PR/merge flow for PRD
  documents in v1.
- Wiki is the planner-facing review copy, not the canonical PRD source.
- Approval source of truth is Jira status transition.
- PRD quality gate failure does not auto-rewrite the PRD; it asks for human
  clarification/revision input.

## Known Limitations

- State is still in memory. Restarting the API loses workflow state.
- Quality gate is stubbed through `STUB_QUALITY_PASSES`.
- PRD markdown generation is template-based, not yet Claude/Codex generated.
- Confluence publishing creates pages; update/upsert behavior is not complete.
- Jira updates/comments/transitions are not yet written back by the workflow.
- MySQL schema and Docker Compose topology are not implemented yet.

## Verification

Latest full test run:

```bash
npm test
```

Result:

```text
Test Files  6 passed (6)
Tests       17 passed (17)
```
