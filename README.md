# n8-ai-workflow

Local workspace for building AI-assisted n8n workflows.

## Goals

- Design reusable workflow patterns for AI automation.
- Keep workflow exports, notes, and supporting scripts organized.
- Document setup steps as the project grows.

## Structure

```text
n8-ai-workflow/
  workflows/   Exported n8n workflows
  docs/        Notes, prompts, and implementation decisions
  scripts/     Helper scripts
```

Current direction:

- n8n experiments are preserved in `workflows/experiments/n8n/`.
- Production direction is a custom metadata-driven workflow app.
- See `docs/development-requirements.md` for the current requirements summary.

## Run n8n locally

Start n8n with Postgres:

```powershell
docker compose up -d
```

Open n8n:

```text
http://localhost:5678
```

Stop the stack:

```powershell
docker compose down
```

Local data is stored in Docker volumes named `n8-ai-workflow_n8n_data` and
`n8-ai-workflow_postgres_data`.
