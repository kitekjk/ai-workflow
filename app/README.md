# Workflow App (M0)

Jira-reactor that drives one PRD cycle with a **stub skill** (real Claude CLI is M0+).
See [the M0 spec](../docs/superpowers/specs/2026-06-02-workflow-app-m0-minimal-spec.md).

## Run

```bash
npm install
docker compose --profile workflow-db up -d workflow-mysql
npm run db:migrate:app
npm run start:app
```

POST a Jira webhook to `localhost:8787/jira/webhook`:
- `{"issue":{"key":"PAIR-1"},"status":"PRD 요청"}` → starts a run (→ 승인대기)
- `{"issue":{"key":"PAIR-1"},"status":"승인"}` → routing → completed

By default the app uses the **stub skill**. To drive jobs with the real Claude CLI:

    SKILL_ENGINE=claude npm run start:app

The engine isolates each job in a workspace under `SKILL_WORKSPACE_BASE`, injects the
envelope I/O contract as a wrapper prompt, and reads the result from `./out/envelope.json`
(F9: stdout+stderr are surfaced on failure; F10: the workspace is cleaned up).
Run the gated real-CLI integration test with `RUN_CLI_TESTS=1 npm run test:app`.

## Test

```bash
npm run test:app                       # unit + e2e (in-memory)
RUN_DB_TESTS=1 npm run test:app        # also runs MySQL F5/F6 integration
```

## M0 acceptance (spec §6)

1. ✅ PRD 티켓 생성 → generate → quality → 승인대기 자동 진행 (e2e test).
2. ✅ 승인 → routing → Run completed, Jira+DB 일관 (e2e + smoke).
3. ◐ 스킬 ref 가 Task 메타로 저장 (e2e asserts git+wiki refs). **클릭-이동 링크 렌더는 미구현** —
   refs 의 `url` 은 저장되지만 outbound 코멘트 템플릿이 아직 렌더하지 않음. 실제 Jira 클라이언트(M0+)와 함께 완성 예정.
4. ✅ F7: 정책은 데이터(YAML), 코드에 type 분기 없음 (registry + strategy).
5. ⚠️ F11: 앱이 문서 내용 무보유(ref만) — 거짓 약속 표면 제거. ref 진위는 미검증(bare claim, D4).
   F5/F6: 단일 Db boundary 로 구조적 차단 (db.test + 통합 테스트).

## Architecture (M0)

```
POST /jira/webhook → normalize → Reactor
  startRun → Task(prd) → Job(generate) ─┐
  drain: Runner.runOnce → stubSkill → validateEnvelope(shape) → store
  EventHandler(prd): generate→quality→(score≥85) 승인대기/await_human
  external "승인" → Job(routing) → terminate succeeded → Run completed
Outbound: Jira only (RecordingOutbound in M0). git/wiki/PR owned by skill (opaque refs).
Persistence: single Db boundary (MySQL) — F5 datetime / F6 LIMIT structurally blocked.
```

Out of scope (M0++): revise loop, fan-out, HLD/LLD/…
task types, dashboard/UI, ref reachability verification.
