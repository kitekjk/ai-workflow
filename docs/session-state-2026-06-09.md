# Session State — 2026-06-09

## 한 줄 요약

**M0(스텁 기반 PRD 리액터) 빌드 완료 → main 머지(PR #3).** 다음 작업 = **M0+ "실제 스킬 엔진"**(stub → 실제 Claude CLI). 그 brainstorming 진행 중 — 스코프 확정, 프롬프트 소스 질문(Q2)에서 중단.

## 이번 세션에 한 일

1. `worktree-rebuild-prd` 최신화(ff pull).
2. **M0 spec 리뷰 + 수정** — F11 정직성(거짓약속 표면 제거 vs bare-claim 구분), routing 종료(후보 기록+Run completed, task spawn 없음), quality 실패(Task/Run failed), 트리거 status 데이터화, refs[] shape 검증, Runner F9/F10 명시. (commit `71e8ef3`)
3. **빌드 계획 작성** — `docs/superpowers/plans/2026-06-09-workflow-app-m0.md` (14-task TDD).
4. **M0 앱 구현** — subagent-driven, 16 commits, `app/` 디렉토리. TS+vitest+mysql2+yaml+ajv.
5. **최종 코드 리뷰**(opus) — Critical 0, "sound M0 foundation". 발견 항목 중 F9 진단성 로깅 / claim 캐비엇 문서화 / README §6.3 정직성 반영.
6. **PR #3 생성 → 사용자가 머지** → main에 반영. 현재 main 작업 디렉토리로 이동 완료.

## M0 현재 상태 (main에 머지됨, `app/`)

- 앱 = Jira-reactor + 스케줄러 + 러너. 외부 쓰기는 스킬 소유, 앱은 불투명 ref만 보관.
- 루프: `intake(webhook) → generate → quality →(score≥85) 승인대기/await_human → 승인 → routing → Run completed`. quality<threshold → Task/Run failed(M0 revise 없음).
- **F7 구조적 차단**: dispatch에 type 분기 0, 정책은 `app/workflows/definitions/*.yaml`(trigger/outbound/inbound/threshold). 유일한 jobType 분기 = `prd-handler.ts`.
- **F5/F6 구조적 차단**: 단일 `app/src/db.ts` 경계(UTC datetime 변환, inlined safeLimit). 게이트 통합테스트(`RUN_DB_TESTS=1`).
- **F11 정직**: 앱은 문서 내용 무보유, envelope는 shape-only 검증(ajv), ref 진위 미검증(bare-claim D4).
- **스텁 2개**: `stubSkill`(고정 envelope 반환), `RecordingOutbound`(Jira 실물 아님).
- 테스트: in-memory 35 pass + MySQL 통합 2 gated-skip. `npm run typecheck:app` clean.
- 실행: `npm install` → `docker compose --profile workflow-db up -d workflow-mysql` → `npm run db:migrate:app` → `npm run start:app` (POST /jira/webhook). 상세 `app/README.md`.

### M0 핵심 파일 (app/src)
domain · clock · strategy(loader) · envelope(ajv shape) · handler-types · **prd-handler**(유일 로직) · registry · repos(포트 + InMemory) · **runner**(claim→skill→validate→store) · **stub-skill**(`Skill` 타입 + 교체 지점) · jira(inbound normalize + RecordingOutbound) · **reactor**(배선) · db(F5/F6 경계) · mysql-repos · migrate · app(http shell)

## 다음 작업: M0+ "실제 스킬 엔진" (진행 중인 brainstorming)

목표: `stubSkill`을 **실제 Claude CLI를 호출하는 `Skill` 구현**으로 교체. 교체 지점은 이미 명확 — `app/src/stub-skill.ts`의 `Skill` 타입 `(jobType, input) => Promise<Envelope>`. runner/reactor는 그대로.

### 확정된 결정 (이번 brainstorming)
- **Q1 스코프 = 전체 PRD 사이클**: generate→quality→routing 3개 모두 실제 claude CLI로 end-to-end. 도메인 출력은 진짜 AI 생성. **Jira는 RecordingOutbound 유지**(실물 아님), **git/wiki 실제 쓰기는 보류**(bare ref — D4 덕분에 앱은 ref 진위 검증 안 하므로 분리 가능).

### 미해결 질문 (여기서 중단 — 다음 세션에서 이어서)
- **Q2 (중단 지점) 프롬프트 소스**: 엔진이 Claude에 줄 프롬프트(도메인 지시 + "envelope JSON을 stdout으로 반환" 계약)를 어디서?
  - 후보: **(A, 추천) 앱 내 프롬프트 파일** `app/skills/<skill>.md` — 엔진이 job 입력 + 출력 계약 주입해 `claude -p` 호출, generic(템플릿 로드→채움→호출→파싱). / (B) 실제 CC 스킬 패키지(무거움, JSON 결정성↓). / (C) 코드·YAML 인라인(프롬프트 섞임).
- **Q3 호출 메커니즘**: 직접 `claude -p --output-format ...` vs legacy식 bridge `.mjs`(claude/codex 차이 흡수). max-turns/timeout/model/sandbox 설정. **F9**: stdout+stderr 둘 다 캡처 + 실패 사유 surface. **F10**: job당 workspace 디렉토리 격리 + 정리.
- **Q4 envelope 반환 경로**: stdout JSON(legacy 검증된 패턴) vs 스킬이 파일로 기록. (추천: stdout JSON)
- **Q5 엔진 추상화**: claude 전용 vs adapter 인터페이스(claude/codex). (추천: `Skill` 함수 자체가 이미 seam; claude만 구현, codex 문 열어둠)
- **Q6 빌드 위치**: main에서 새 브랜치/worktree.

### 강한 참조 자료 (legacy backend/src — F9/F10 이미 학습됨)
- `backend/src/runner-engines/cli-engine.ts` — spawn + stdin(JSON)→stdout(JSON), stdout/stderr 둘 다 캡처, timeout/abort, Windows shebang 우회. **새 엔진의 기반 패턴.**
- `backend/src/local-runner/cli-engine-adapter.ts` — 에러 redaction, stderr 로그화.
- `backend/src/runner-engines/engine-config.ts` — bridge 스크립트(`scripts/document-runner-engine.mjs`) 호출 인자 구성(`--engine --bin --timeout-ms --model --max-turns --sandbox --workdir`), env 기반(CLAUDE_CLI_PATH 등).
- `backend/src/local-runner/workspace.ts` — `prepareJobWorkspace`(job당 격리 디렉토리, sanitize, clean, realpath, path-inside 검증) = **F10 참조**.
- 단, 새 앱은 **얇게** 유지. legacy 복잡도(runnerJobTemplate, capability 매칭 등) 복사 금지.

## 다음 세션 시작 프롬프트 (사용자용)

```text
docs/session-state-2026-06-09.md 이어서.
M0(app/) 는 main 에 머지됨. 다음 = M0+ "실제 스킬 엔진" (stub → 실제 Claude CLI).
brainstorming 진행 중: 스코프=전체 PRD 사이클(generate/quality/routing 실제 CLI,
Jira는 RecordingOutbound 유지, git/wiki 보류=bare ref) 까지 확정.
Q2(프롬프트 소스: 추천=app/skills/<skill>.md 파일)부터 이어서 brainstorming 계속 →
design 문서 → writing-plans → subagent-driven 구현.
교체 지점 = app/src/stub-skill.ts 의 Skill 타입. 참조 = backend/src/runner-engines/cli-engine.ts (F9/F10).
```

## 다른 컴퓨터에서 시작 전 체크리스트
1. `git pull` (main — 이 세션 push 완료).
2. `npm install` (M0 앱 의존성: ajv 포함).
3. (선택) M0 동작 확인: `npm run typecheck:app && npm run test:app` → 35 pass + 2 skip.
4. 위 시작 프롬프트로 brainstorming 이어서.

## 정리 대기 (housekeeping, 급하지 않음)
- 머지된 worktree `.claude/worktrees/rebuild-prd` + 브랜치 `worktree-rebuild-prd` — `git worktree remove` + 브랜치 삭제 가능. (단 그 worktree에 미커밋 `architecture.md` 수정이 있음 — 보류 항목, §3/§4 본문 개정 작업. 정리 전 확인.)
- 로컬 브랜치 `dogfooding-prd-cycle-1` — 이전 작업, 유지/삭제 미정.
- (보류) ADR 0001 strategy-data-code 경계, architecture.md §3/§4 본문을 boundary-design과 정합되게 개정.
