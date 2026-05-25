# AI Workflow 재개발 아이디어 정리 (PRD form)

> 본 문서는 새 코드를 쓰기 위한 spec 이 아니다. **흩어져 있던 의도와 학습된 교훈을 한 곳에 모은 PRD 초안**이다.
> 기존 코드는 "아이디어 출처"로만 본다. 구조는 처음부터 다시 결정한다.
> grilling 세션 (`docs/superpowers/grilling/*`) 에서 항목별로 확정/폐기를 결정한다.

- 작성: 2026-05-25
- 작성자: kitekjk
- 출처 문서: `docs/development-plan.md`, `docs/superpowers/specs/2026-05-23-runnable-end-to-end-priority-design.md`, `docs/superpowers/dogfooding/2026-05-24-prd-cycle-1-findings.md`, `README.md`

---

## 0. 한 문장 요약

**기획 요청에서 출발해 PRD → 설계 문서 → 코드 PR 까지를 AI agent 와 사람이 함께 진행할 수 있는, 메타데이터·이벤트 기반의 자기설명적 워크플로우 플랫폼.**

---

## 1. 배경과 문제 정의

### 1.1 현재 상태

- 1차 코드베이스는 PRD vertical slice 에서 출발해 generic workflow/document/job 모델, MySQL repository, 중앙 scheduler, local runner, CLI engine bridge 까지 확장됨.
- M1~M6 까지의 milestone 은 코드/문서 레벨에서 거의 완료된 것으로 표시됨.
- 그러나 cycle 1 dogfooding (PAIR-6, real Jira + real Confluence + real Claude CLI) 에서 **PRD draft 가 끝까지 통과하지 못함**.

### 1.2 cycle 1 이 드러낸 구조적 문제 (왜 재개발인가)

cycle 1 findings 가 단순 버그가 아니라 구조 수준 누락을 가리킨다.

| Finding | 표면 증상 | 구조적 의미 |
| --- | --- | --- |
| F5 | datetime ISO 8601 'Z' 가 MySQL DATETIME 에 직접 insert 실패 | **공통 persistence boundary 부재**. repository 마다 변환 규약이 다름. |
| F6 | `GET /workflow-runs?limit=5` 가 prepared statement LIMIT 에러로 500 | DB layer 추상화/변환 layer 부재. mysql2 quirk 가 application 전체로 leak. |
| F7 | intake 가 `"PRD 요청"` / `"prd_requested"` 두 값만 허용 | metadata-driven 이라 했지만 **정책이 코드에 hardcode**. workflow definition 이 source 가 아님. |
| F8 | intake 가 unsatisfiable `requestedBy` 를 silent 수락, job 영원히 pending | **identity / scope validation 부재**. intake 와 runner registry 사이에 cross-check 없음. |
| F9 | `RUNNER_CLI_MAX_TURNS=3` 으로 Claude CLI 가 PRD 못 마침 + 에러는 stdout 으로 출력되는데 bridge 는 stderr 만 capture | **runner 진단 가시성 부재**. error_message 가 DB row 안에 갇혀 있음. |
| F10 | 같은 jobId 가 max_jobs (20회) 까지 retry, workspace cleanup 좀비 cascade | **runner 가 자기 lifecycle 을 안 가짐**. retry budget 과 distinct job budget 분리 부재. process isolation 미정의. |
| F11 (BLOCKER) | PRD draft markdown 본문이 **시스템 어디에도 영구 저장 안 됨**. artifact URI `db://...` + metadata `hasInlineMarkdown: true` 는 **거짓 약속** | **artifact ≠ document 의 모델 분리가 미완성**. write/read/inject 3 layer 의 contract 가 끊겨 있음. |

### 1.3 진단

> "기능을 다 만들었다고 표시되어 있지만, **각 기능이 다른 기능과 어떤 contract 로 연결되는지가 코드에 명시되어 있지 않다.** 그래서 first real dogfooding 에서 무너졌다."

따라서 새 시도는:
- **모델/책임/contract** 를 코드보다 먼저 명시한다.
- **legacy 보존을 일단 포기**한다 (기존 코드는 idea source only).
- **실제 run 가능성을 acceptance** 로 둔다.

---

## 2. 비전과 목표

### 2.1 비전

> "기획 요청을 던지면, 그 요청이 PR 까지 진행되는 동안 AI 가 무엇을 했고 사람이 어디서 결정을 내렸는지 모두 추적 가능한 시스템."

### 2.2 목표 (M0)

cycle 1 의 happy path 를 **한 시스템 안에서 끝까지** 통과시킨다:

1. 기획자가 Jira PRD ticket 을 만들고 워크플로우를 시작한다.
2. AI 가 PRD draft 를 만든다.
3. AI 가 PRD 품질을 평가한다.
4. 기획자가 PRD 를 승인한다 (Jira transition).
5. AI 가 routing decision (HLD / LLD / Spec / 규모 확인) 을 내린다.
6. 그 결과가 Jira / DB / 화면에 일관되게 기록된다.

### 2.3 목표 (M1+)

- HLD / LLD / Spec / Code / PR status 까지 동일 패턴 확장.
- feedback / revision loop, approval gate, retry/cancel 등 운영 동작.
- 운영용 dashboard 및 audit log.

---

## 3. 비목표 (지금은 안 함)

- workflow editor (graphic editor) — 추후.
- 복잡한 RBAC, 다중 테넌트 — M5+ 이후.
- 자동 wiki 폴링 / webhook feedback 수집 — explicit trigger 만.
- spec 으로부터 자동 code generation 의 완전 자동화 — 사람 개입 가능 hybrid 까지만.
- N8N 호환성 — historical reference 만, runtime 책임 없음.
- ADR 자동 생성/관리 자동화 — review 중심.
- managed runner 우선 배포 — 초기엔 local runner 만으로도 사이클이 돌아야 한다.

---

## 4. 이해관계자 / 역할

워크플로우 관점의 역할은 **4개로만** 모델링한다. 조직 내 다른 호칭 (Tech Lead, Architect, Domain Owner 등) 은 워크플로우 내부 role 로 표현하지 않고 오프라인 처리한다.

| Role | 책임 |
| --- | --- |
| 운영자 | runner 등록/정지, 시스템 헬스 모니터링, claim 정책 운영. |
| 기획자 | PRD intake, PRD AC 작성/승인, feedback 제공. |
| 개발자 | HLD / LLD / Spec 승인, 구현 (AI hybrid), 코드 리뷰. |
| QA | Spec 의 TC draft 보강, Dev 완료 후 TC finalize, QA 검증 승인. |

---

## 5. 핵심 시나리오 (요약)

1. **신규 PRD intake**: Jira `PAIR-X` (status: 요청형) → 시스템이 PRD draft → quality → 기획자 승인 → routing.
2. **품질 실패 후 clarification**: gate 실패 → 시스템이 Jira comment 로 missing info / clarification questions 기록 → 기획자가 feedback → explicit revision 요청 → revise job → 재평가.
3. **routing 분기**: domain_impact=1, usecase=2 → LLD 부터. domain_impact≥2 → HLD 부터. usecase=1 단일 API → Spec 부터. 불명확 → `규모 확인 필요` 로 멈춤.
4. **fan-out**: HLD → 여러 LLD. LLD → 여러 Spec. Spec → 하나의 PR.
5. **PR feedback loop**: CI/리뷰 실패 → 분류 → code-only update 또는 Spec/LLD/HLD revision 으로 되돌림.
6. **취소/보류**: 보류는 in-flight 완료 후 정지, 취소는 terminal. external side effect (Git/Wiki) 는 흔적만 표시.

---

## 6. 도메인 모델 / 용어 (glossary)

**Workflow Run**
- 한 source request (Jira PRD ticket 등) 가 트리거한 1회 진행 단위.
- terminal: completed / canceled / failed.

**Task** *(UI primary node)*
- workflow 의 stable stage. `prd.draft`, `prd.quality`, `prd.approval`, `prd.routing`, `hld.draft` ...
- 같은 task 가 여러 job attempt 를 가진다.
- task 상태는 하위 job + gate 결과의 roll-up.

**Job** *(execution attempt)*
- runner 가 claim 해서 실행하는 단위.
- 결과: succeeded / failed (errorCategory) / canceled.
- job 은 workflow state 를 **직접 바꾸지 않는다**. `workflow_job_result` 만 남긴다.

**Document** *(first-class)*
- type ∈ {prd, hld, lld, adr, spec}.
- `current_version_id` pointer + immutable `document_version` history.
- markdown 본문은 document 의 핵심 데이터. **artifact metadata 가 아니라 document 의 1급 컬럼/스토리지.**

**Artifact**
- document version 에서 파생된 외부 표현 (Git commit 의 markdown, Confluence page).
- markdown 본문 자체는 artifact 가 아니라 **document 의 storage**.
- artifact 는 외부 location + content_hash + 외부 version 을 기록.

**Quality Gate Result**
- AI rubric + deterministic check 결과. document_version 에 연결.

**Approval Gate**
- 사람의 결정 경계. v1 source of truth = Jira status transition.

**Feedback Item**
- Jira comment / App input / Wiki (explicit) 에서 수집된 단일 피드백.
- revision job 의 input 에 `appliedFeedbackIds[]` 로 연결.

**Runner**
- mode = managed | local.
- owner_email + allowed_projects + allowed_repos + capabilities[] + engines[].
- 자기 lifecycle 을 가진다 (claim → execute → renew lease → report → release).

**Scheduler (중앙)**
- atomic claim, lease, heartbeat, retry budget, cancellation, stale recovery.
- runner 가 직접 job 을 고르지 않는다. scheduler 가 발급.

**Engine Adapter**
- Claude CLI / Codex CLI 차이 추상화. interface = `runJson(input, options) → JSON`.
- 표준 JSON output contract 강제. 비호환 출력은 normalized failure.

**Skill / Plugin Package**
- 특정 job type 에 필요한 prompt / 산출물 schema / 도구 목록 패키지.
- 실행 전 local 에 존재 여부 검증. 없으면 install 시도 또는 actionable 실패.

---

## 7. 기능 요구사항 (FR)

### 7.1 Intake

- FR-INT-1: source = Jira / App / GitHub issue 중 선택.
- FR-INT-2: intake 시 허용 status 목록은 **workflow definition** 이 결정한다 (코드 hardcode 금지).
- FR-INT-3: 같은 source request 는 active 또는 보류 상태인 한 다른 PRD 에 동시에 묶일 수 없다.
- FR-INT-4: `requestedBy` 가 등록된 runner owner 와 매칭되지 않으면 최소 경고를 반환한다 (F8 회귀 방지).
- FR-INT-5: source snapshot 을 저장한다 (summary, description, status, links).

### 7.2 Document Pipeline (PRD / HLD / LLD / ADR / Spec 공통)

- FR-DOC-1: 모든 document type 은 `generate → quality eval → (optional revise) → approval` 패턴을 공유.
- FR-DOC-2: generate / revise job 의 산출물에서 **markdown 본문은 document_version 의 1급 storage 에 저장**된다 (F11 회귀 방지).
- FR-DOC-3: quality job 은 시스템이 자동으로 `currentDocumentMarkdown` 을 inject 한다 (job input 누락 금지).
- FR-DOC-4: 평가 결과는 한국어 structured JSON 으로 저장.
- FR-DOC-5: quality 실패 기본 동작은 human clarification (auto rewrite 아님).
- FR-DOC-6: revision 은 새 feedback 없으면 실행되지 않는다.
- FR-DOC-7: artifact (Git markdown commit, Confluence page) 는 generate/revise job 의 side effect.
- FR-DOC-8: 동일 content_hash 의 publish 는 새 document_version 을 만들지 않고 publish event 만 갱신.

### 7.3 Routing (PRD approval 후)

- FR-RT-1: routing decision = AI recommendation + deterministic guard.
- FR-RT-2: low confidence → Jira 상태 `규모 확인 필요`, 사람이 결정 / 추가 설명 / 재실행 선택 가능.
- FR-RT-3: routing 결과는 PRD ticket 의 structured field/comment + workflow_job_result 양쪽에 저장.

### 7.4 Approval Gate

- FR-APP-1: v1 final approval = Jira transition (workflow App approve action 은 Jira 호출 또는 Jira refresh).
- FR-APP-2: PRD = 기획자, HLD/LLD/Spec = 개발자, ADR = decision owner accept.

### 7.5 Runner / Scheduler

- FR-RUN-1: runner 는 owner_email, scope (project/repo), capabilities, engines 와 일치하는 job 만 claim.
- FR-RUN-2: lease 는 long-running 작업 중 renew 가능. healthy runner 의 lease 는 만료되지 않는다.
- FR-RUN-3: 같은 jobId 의 연속 실패는 **per-jobId retry budget** 으로 제한. drain budget 은 distinct job 수 (F10 회귀 방지).
- FR-RUN-4: workspace 는 job 당 격리. cleanup 실패 시 sibling fallback (F10 partial fix 유지).
- FR-RUN-5: runner 가 spawn 한 자식 프로세스는 종료 시 cwd lock 을 release.
- FR-RUN-6: runner 실패는 normalized errorCategory + stdout/stderr 둘 다 capture (F9 회귀 방지).
- FR-RUN-7: 모든 runner job 결과는 structured JSON schema 검증 통과해야 한다.

### 7.6 Skill / Plugin Resolution

- FR-SKL-1: job 은 `requiredSkills[]`, `requiredPlugins[]` 를 명시할 수 있다.
- FR-SKL-2: 실행 전 local 존재 검증, 없으면 install 시도 (allow) 또는 actionable 실패.
- FR-SKL-3: install source = local path / file:// / git / GitHub shorthand.

### 7.7 Feedback / Revision

- FR-FB-1: feedback 저장과 revision 실행은 분리된 API.
- FR-FB-2: revision 은 최신 document_version 을 기준으로 patch / rewrite.
- FR-FB-3: revision 결과가 동일 content_hash 이면 새 version 만들지 않고 skip.

### 7.8 API (current vs history)

- FR-API-1: current view 는 최신 artifact / current document / latest gate result 만 반환.
- FR-API-2: history 는 별도 endpoint + pagination.
- FR-API-3: runner stdout/stderr 는 default state response 에 포함하지 않는다. log endpoint 별도.

### 7.9 Audit / Event

- FR-AUD-1: 모든 state transition + external side effect 는 event 로 기록.
- FR-AUD-2: secret-like 값 (token, Authorization header) 은 storage 전 redaction.

---

## 8. 비기능 요구사항 (NFR)

- NFR-1 **명시성**: contract (in/out schema) 를 코드보다 먼저 명시한다. 코드는 그 contract 의 구현.
- NFR-2 **재현성**: 같은 input + 같은 prompt contract version → 같은 결과 expected (CLI nondeterminism 은 schema validation 으로 차단).
- NFR-3 **진단성**: 모든 실패는 (a) errorCategory, (b) actionable message, (c) raw stdout/stderr 보존.
- NFR-4 **분리**: write path 는 단일 mutation applier 통과 (F5 회귀 방지 + idempotency).
- NFR-5 **언어**: 사용자 노출 텍스트 기본 한국어, 내부 식별자 영문.
- NFR-6 **로컬-퍼스트 운영**: 개발자 PC 한 대 + Docker MySQL 만으로 cycle 1 happy path 가 통과해야 한다.
- NFR-7 **외부 의존성 제한**: Jira / GitHub / Confluence 중 하나가 outage 일 때 시스템이 멈추지 않는다 (snapshot + retry event).

---

## 9. 패러다임 후보 (다음 grilling 의 분기점)

| 후보 | 핵심 아이디어 | 장점 | 비용 / 위험 |
| --- | --- | --- | --- |
| **A. Agent-as-Orchestrator** | 워크플로우 정의를 코드 그래프에서 제거. agent 가 다음 step / handoff 를 결정. 시스템은 ledger + gate + artifact 관리. | 코드 분량 급감. F7 (status hardcode) / 라우팅 룰이 prompt 로 이동. AI workflow 의 본질에 가장 부합. | agent failure mode 가 곧 시스템 failure mode. 결정 가시성/재현성 design 필요. |
| **B. Event-Sourced + Document-First** | event log 가 source of truth. 현재 상태는 projection. document 는 1급 versioned entity. | F11/F8 같은 누락이 model 차원에서 차단. 강한 audit/replay. | event schema 진화 cost. projector 복잡도. |
| **C. Declarative DAG, 순수 함수 stage** | 각 stage = (input artifacts) → (output artifacts) 순수 함수. mutable workflow state 없음. lineage 자동. | 재현성/병렬성 우수. 부분 재실행 자연스러움. | AI nondeterminism 과의 충돌. feedback loop / human gate 의 표현이 부자연. |
| **D. Local-First / Inverted Federation** | local runner 가 authoritative. 중앙 API 는 sync 계층. | 운영 비용/배포 단순. owner 가 자기 PC 에서 모든 것을 본다. | 다중 사용자 collaboration / Jira/GitHub 일관성 어려움. |

> 현재 grilling 에서 사용자는 "Paradigm shift" 를 선택했으나 어느 후보인지는 아직 미정.

---

## 10. 재사용 vs 폐기 (현 코드 기준)

### 아이디어/패턴으로 차용
- CLI engine 추상화 (`runner-engines/cli-engine.ts`).
- Confluence generic publisher (`integrations/confluence-wiki.ts`).
- Jira reader pattern (`integrations/jira-client.ts`).
- workflow → task → job 3 단 모델.
- 한국어 prompt contract + structured JSON 강제.
- skill/plugin pre-flight check.
- local runner doctor.

### 폐기 / 격리
- `backend/src/legacy/prd-confirmation/*` 전체 (참고만).
- `db://...` 가짜 artifact URI scheme.
- in-memory workflow runtime as production path.
- PRD-only naming (`prdJiraKey`, `prdStatus`, `current PRD markdown map`).
- workflow definition 을 YAML 로 두고 코드에서도 hardcode 하는 이중 path.
- mysql2 quirk 가 application layer 로 leak 된 모든 지점.

### 새로 결정해야 함
- markdown body 의 storage 위치 (F11 옵션 3 종 중 택1 또는 새 옵션).
- workflow definition 의 source (code DSL? YAML? agent prompt?).
- event log 모델 (혹은 미사용).
- scheduler 와 agent loop 의 경계.

---

## 11. 성공 지표

- M0: cycle 1 의 happy path (intake → draft → quality → approval → routing) 가 새 시스템에서 한 번 통과한다.
- M0+: F5, F7, F8, F9, F10, F11 이 새 모델에서 **구조적으로 재발 불가능**해야 한다 (단순 patch 가 아니라 model 차원 차단).
- M1: HLD / LLD / Spec / Code / PR status 까지 happy path 통과.
- M2: revision / cancel / retry / send-back 동작 검증.
- 운영성: 신규 개발자 한 명이 onboarding 후 1 시간 내 첫 PRD cycle 을 돌릴 수 있다.

---

## 12. 가정과 위험

### 가정
- Jira 가 final approval source 라는 정책은 유지된다.
- 1차 사용자는 본인 (kitekjk / kay.kim@musinsa.com) 1 명. 여러 사용자 동시 운영은 M3+.
- local Codex / Claude CLI 가 안정적으로 설치되어 있다.

### 위험
- **패러다임 선택의 reversibility**: 9 절 4 후보 중 잘못 고르면 또 한 번 reset 비용. → grilling 으로 결정 근거를 명시화.
- **agent 의 비결정성**: A 후보 채택 시 디버깅 / 재현 비용 증가. → ledger + replay 설계 필수.
- **MySQL persistence layer 누수**: 새 모델에서도 datetime / LIMIT / connection 처리 표준이 없으면 F5/F6 재발. → 단일 persistence boundary 강제.
- **legacy 코드의 중력**: 기존 코드를 reference 로 두면 무의식 복사 위험. → 새 디렉토리에서 시작.
- **dogfood 사용자의 인내심**: 재개발 중 cycle 1 happy path 가 더 길게 막힘. → 가능한 한 빨리 M0 통과.

---

## 13. 결정해야 할 사항 (Open Questions)

> 이 PRD 의 다음 작업은 이 13.x 를 grilling 으로 하나씩 닫는 것이다.

- Q1. 패러다임 — 9 절 A/B/C/D 중 어느 것? 혹은 hybrid?
- Q2. workflow definition 의 표현 — code DSL / YAML / agent prompt?
- Q3. markdown body 의 storage — DB inline column / 분리 테이블 / Git first / event-sourced log?
- Q4. event log 의 위치 — 있다면 source of truth, 없다면 audit only?
- Q5. scheduler 의 책임 범위 — agent-as-orchestrator 에서도 lease/claim 이 필요한가? 아니면 agent loop 가 처리?
- Q6. 새 코드 위치 — 현 repo 안의 새 디렉토리? 별도 repo? worktree?
- Q7. legacy 와의 co-existence 기간 — 새 시스템이 cycle 1 통과할 때까지 legacy 유지? 즉시 폐기?
- Q8. 1차 검증 슬라이스 — PRD draft only? PRD draft + quality? full PRD cycle?
- Q9. tech stack — TS 유지? 다른 언어/runtime 후보?
- Q10. UI 의 역할 변화 — Agent-as-Orchestrator 라면 UI 가 무엇을 보여줘야 하나?
- Q11. local runner 의 위치 — D 후보 (local-first) 와 다른 후보의 hybrid 가능한가?
- Q12. naming — 새 시스템의 이름 / namespace (ai-workflow 유지? 새 이름?).
- Q13. 한 번에 갈지, parallel run 후 cutover 인지.

---

## 14. 부록: cycle 1 이 남긴 의미

- **F5, F6** → "공통 persistence boundary 만들기" 가 코딩 시작 첫째 날 작업.
- **F7** → "policy is data, not code." workflow definition 이 진짜 데이터여야 한다.
- **F8** → "intake 는 단순 record 가 아니라 validation gate."
- **F9, F10** → "runner 는 자기 lifecycle 을 own 한다."
- **F11** → "**artifact 와 document 는 같은 것이 아니다.** markdown 본문은 document 의 1급 storage."

이 다섯 문장이 새 architecture 의 시작점이다.
