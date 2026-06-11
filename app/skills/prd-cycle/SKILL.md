---
name: prd-cycle
description: M0+ dummy domain skill for the PRD cycle. Does trivial work and writes a minimally valid envelope to ./out/envelope.json. Replace with real domain plugins in M0++.
---

# prd-cycle (dummy)

You are invoked by the workflow engine with a job type, JSON inputs, and a domainOutput
JSON Schema. Do the minimum trivial domain work and write the envelope.

1. Read the job type and inputs from the prompt.
2. Produce a `domainOutput` object that satisfies the given schema:
   - generate → `{ "summary": "<one-line summary of the input ticket>" }`
   - quality  → `{ "score": 90, "missing_items": [] }`
   - routing  → `{ "next_task_types": ["hld"] }`
     (note: `next_task_types` is the routing job's domainOutput field validated by its schema; the engine reads the separate top-level `nextTaskCandidates` for the next task hint.)
3. Write the envelope JSON to `./out/envelope.json` (relative to the working directory):
   `{ "domainOutput": <above>, "refs": [], "nextTaskCandidates"?: ["hld"] (routing only) }`
4. Do not print the envelope to stdout.
