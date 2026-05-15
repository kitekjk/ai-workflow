# Agent Runner Demo

This demo runs one local Agent Runner job:

```text
short requirement -> prd.simple skill -> Claude CLI -> PRD markdown
```

The runner does not call the Anthropic API directly. It executes the installed
Claude Code CLI in headless mode.

## Prerequisites

- Node.js
- Claude Code CLI installed as `claude`
- Claude Code already authenticated locally

Check Claude Code:

```powershell
claude --version
```

## Run

```powershell
node scripts/agent-runner-demo.mjs --requirement "운영팀이 반복 문의를 줄일 수 있도록 FAQ 자동 생성 기능이 필요하다"
```

Write the generated PRD to a chosen file:

```powershell
node scripts/agent-runner-demo.mjs `
  --requirement "운영팀이 반복 문의를 줄일 수 있도록 FAQ 자동 생성 기능이 필요하다" `
  --out outputs/prd.md
```

Use a requirement file:

```powershell
node scripts/agent-runner-demo.mjs --input requirements.txt --out outputs/prd.md
```

## Outputs

Each run writes local execution records under:

```text
runs/agent-runner-demo/{timestamp}/
  input.md
  prompt.md
  stdout.log
  stderr.log
  events.ndjson
  result.json
  outputs/prd.md
```

`runs/` is ignored by Git because these are local execution artifacts.
