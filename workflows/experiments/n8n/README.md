# n8n Workflow Experiments

These workflows are retained as exploratory prototypes.

They are not the target production architecture. They document what was learned while testing n8n as a possible workflow orchestrator.

## Why Keep Them

- n8n can model parent-child workflows.
- n8n can run HLD to LLD to Spec fan-out/fan-in demos.
- Child workflows must be published before parent workflows can execute them.
- n8n's default execution UI does not provide a full parent-child tree view.
- Execution viewing showed temporary instability in the tested Docker image.

## Key Demos

- `demo-20-hld-to-lld-spec-fanout.json`: One HLD creates three LLD items.
- `demo-21-child-lld-creates-specs.json`: One LLD creates multiple Spec items.
- `demo-22-child-spec-generate-gate.json`: One Spec is generated and gated.

## Decision

The current direction is to build a custom metadata-driven workflow app with:

- Editable workflow definitions
- A workflow canvas
- A dedicated execution engine
- A parent-child execution dashboard
- Agent runner integration

n8n may still be useful for experiments, adapters, notifications, or peripheral automation.

