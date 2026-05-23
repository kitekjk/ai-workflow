# Legacy Compatibility Code

This folder contains compatibility slices that are no longer part of the
default product runtime.

## PRD Confirmation

`prd-confirmation/` is the old in-memory PRD confirmation vertical slice. It is
kept for fixture-backed tests, historical demos, snapshot migration helpers,
and comparison while the repository-backed workflow runtime finishes replacing
the remaining compatibility paths.

Shared contracts such as Jira issue shape, feedback items, workflow policy, and
transition event types live in non-legacy `integrations`, `document-core`, and
`workflow-core` modules. Legacy code may re-export those contracts for old
tests, but should not redefine them.

Runtime wiring is split the same way: default product integration settings live
in `backend/src/runtime/integration-config.ts`, while the old fixture runtime
factory lives in `backend/src/runtime/legacy-prd-runtime.ts`. The historical
`backend/src/runtime/create-runtime.ts` compatibility re-export has been
removed.

Do not add new product behavior here. New workflow behavior should live in the
repository-backed API, workflow-core, document-core, scheduler, or runner
modules.

Before deleting `prd-confirmation/`, replace or remove:

- fixture-only tests and historical demos
- MySQL snapshot mirror/loader compatibility tests
- legacy `/tick` workflow engine paths
- runtime opt-ins using `WORKFLOW_COMPATIBILITY_FIXTURE=enabled` or
  `WORKFLOW_RUNTIME_STORE=memory`
