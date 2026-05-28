# AI Workflow — 범용 컴포넌트 + 전략 패턴 설계

> **목적**: Workflow / Task / Job 의 **범용 컴포넌트** 와 task type / job type 별 차이를 캡슐화하는 **전략 패턴 (데이터 기반)** 을 설계한다.
> 범용 설계가 PRD / HLD / LLD / Spec / Code / QA 6 개 task type 에 적합한지 적용 검증한다.
>
> **전제 (CONTEXT.md 참조)**:
> - 4 task pattern (P1 Document / P2 Code / P3 QA / P4 Action-only) — 골격이 모두 cover 해야 함
> - Strategy YAML 의 5 layer (L1~L5) — task type 별 차이의 캡슐화 location
> - I-1 ~ I-23 invariants — 설계의 제약 조건
>
> **작성**: 2026-05-27 (grilling 세션, e1ca842/7691a7e/9a4b469 이후)

---

## 0. 문서 구조 (작업 단계)

이 문서는 다음 4 단계로 진행한다. 각 단계가 끝나면 commit 한다.

| Step | 절 | 산출물 |
| --- | --- | --- |
| **A. 범용 설계** | §1~§4 | 도메인 모델 + 4 골격 컴포넌트 인터페이스 + Strategy YAML schema |
| **B. 적용 예시** | §5 | 6 task type (PRD/HLD/LLD/Spec/Code/QA) 의 Strategy YAML 예시 + TC/Deploy 보너스 |
| **C. 적합성 검토** | §6 | 각 type 의 요구사항 (stages-task-job-analysis.md 표) 이 §4 schema 안에서 100% 표현 가능한지 줄별 점검 |
| **D. (별도 grilling)** | — | M0 acceptance bar 결정 |

---

## 1. Scope

### 1.1 In-scope (이 문서가 결정)

- Workflow Run / Task / Job 의 **entity 모델** (핵심 필드 + 관계 + invariant)
- 4 골격 컴포넌트의 **인터페이스** (입/출력 contract)
- **Strategy YAML schema** (L1~L5 + 메타)
- 6 task type 의 Strategy YAML **예시**
- 적합성 검증 결과

### 1.2 Out-of-scope (별도 문서)

- 코드 구현 detail (디렉토리 구조, 언어 선택, framework)
- 데이터베이스 schema (별도 spec 으로)
- HTTP API surface (별도 spec)
- M0 acceptance bar (별도 grilling)
- 사설 marketplace 구체 형태 (CONTEXT.md 미정 항목)

### 1.3 설계 원칙

다음 원칙이 모든 결정의 가이드라인이다.

- **(P-1) Data over Code**: task type 별 차이는 **데이터 (Strategy YAML)** 로 캡슐화. 코드에 type 별 분기 hardcode 금지 (F7 회귀 방지). 4 골격 컴포넌트는 type-agnostic.
- **(P-2) External SSOT**: Workflow App 의 DB 는 cache. 모든 영속 데이터의 SSOT 는 외부 (git / Jira / GitHub). restart 후 외부 시스템 만으로 100% catch-up 가능 (I-3, I-21).
- **(P-3) Source-agnostic event**: Inbound event 는 normalization layer 통과 후 dispatch. Jira / GitHub / 미래 다른 source 동일 model (I-5 일반화).
- **(P-4) Atomic Job, Stateless Reactor**: Job 은 atomic, 재시도 = 새 인스턴스 (I-6). Workflow App 은 stateless reactor — 자체 transition 정책 없음 (I-5).
- **(P-5) Schema 강제**: Type B integration skill schema 가 모든 Job output 을 validation. 위반 = Job 실패. PR title contract (I-19) 같은 외부 contract 도 동일.

---

## 2. 도메인 모델

> entity / value object / relationship 의 핵심 필드와 invariant 만 정의.
> DB schema 는 이로부터 derive (별도 spec).

### 2.1 Aggregate roots

**`WorkflowRun`** — Workflow 실행 1 회의 root aggregate

| 필드 | type | 비고 |
| --- | --- | --- |
| `id` | UUID | system 발급 |
| `definition_version` | string | run 시작 시점의 `ai-workflow/workflows/` 디렉토리 commit hash. 재현성 + restart 일관성 (NFR-2). |
| `source_request_ref` | external_ref | 운영 요청 티켓 ref (Jira issue key) |
| `status` | enum | `running` / `completed` / `canceled` / `failed` |
| `created_at` / `completed_at` | timestamp | |
| `sync_gate_state` | derived | child task 들의 terminal 여부 집계 (휘발 가능, I-14) |

**Invariants**
- run 안의 모든 task 의 SSOT 합집합으로 status 재계산 가능 (I-3, I-21).
- definition_version 은 immutable — 같은 run 안에서 definition 이 바뀌면 새 run.
- 현재 시점 workflow 종류 = 1 가지 (PRD → HLD → LLD → Spec → Code → TC → QA → Deploy). 따라서 `definition_id` 같은 식별자 field 는 두지 않는다. 미래에 분기 (예: spike workflow / bug-fix-only) 가 도입되면 그 시점에 (i) `definition_id` field 추가 + (ii) 선택 메커니즘 (Jira label / AI classification / 사람 선택) 결정 + (iii) Strategy 디렉토리 구조 확장 + (iv) repo 분리 여부 를 한 번에 결정한다.

---

**`Task`** — workflow 안의 stage 1 회 (PRD draft, HLD 작성, ...)

| 필드 | type | 비고 |
| --- | --- | --- |
| `id` | UUID | system 발급 |
| `run_id` | UUID | parent WorkflowRun |
| `parent_task_id` | UUID? | hand-off 의 부모 (fan-out tree) |
| `type` | string | `prd` / `hld` / `lld` / `spec` / `code` / `tc` / `qa` / `deploy` |
| `pattern` | enum | `P1` / `P2` / `P3` / `P4` (Strategy YAML 의 메타) |
| `jira_key` | string | 외부 Jira issue key (SSOT for human transitions) |
| `github_pr_ref` | string? | P2 (Code) 의 GitHub PR identifier (I-18) |
| `document_pointer` | git_ref? | 현재 Document version (commit hash). P1/P3 (보고서) 에 존재. |
| `assignee_email` | email | Jira assignee 와 동기화 (I-9). Job owner 결정. |
| `status` | enum | `pending` / `in_progress` / `awaiting_human` / `succeeded` / `failed` / `canceled` |
| `created_at` / `terminated_at` | timestamp | |

**Invariants**
- task type ↔ pattern 매핑은 Strategy YAML 의 메타 (`pattern: P1`) 가 결정. 코드 hardcode 금지 (P-1).
- assignee 와 매칭되는 Runner 가 없으면 status = `pending` + Jira comment 표시 (I-9).
- document_pointer 의 git push 흔적 없으면 task 가 succeeded 될 수 없음 (I-7).

---

**`Job`** — Runner 가 1 회 실행하는 atomic 단위

| 필드 | type | 비고 |
| --- | --- | --- |
| `id` | UUID | system 발급 |
| `task_id` | UUID | parent Task |
| `type` | string | `generate` / `quality` / `revise` / `routing` / `split` / `open_pr` / `analyze_change` / `run_qa` / `create_deploy_ticket` / ... |
| `dedupe_key` | string | `sha(input_spec_hash + git_base_commit + jira_issue_key)` — I-21 |
| `input_spec` | JSON | Strategy L4 + 실제 input (직전 Document, feedback, ...) |
| `output` | JSON? | Type B schema validated. 미실행 시 null. |
| `status` | enum | `pending` / `claimed` / `in_progress` / `succeeded` / `failed` / `canceled` |
| `runner_id` | string? | claim 한 Runner 식별자 |
| `git_commit_ref` | git_ref? | I-7 — succeeded 시 필수 (push 완료) |
| `started_at` / `ended_at` | timestamp | |
| `skill_versions` | JSON | 실행 시 사용된 Type A skill 의 version 들 (audit, CONTEXT.md Skill 절) |

**Invariants**
- atomic (I-6): 1 회 실행 후 terminal. 재시도 = 새 Job 인스턴스 (다른 id).
- succeeded 의 조건 = git push 완료 (I-7).
- 같은 task 의 N revise Job 은 순차 실행 (I-20).
- dedupe_key 가 이미 succeeded 인 동일 key 와 매칭되면 skip (I-21).

---

### 2.2 Value Objects / 외부 ref

**`ExternalRef`** — 외부 시스템 객체 reference

| 필드 | type | 비고 |
| --- | --- | --- |
| `system` | enum | `jira` / `github` / `git` / `wiki` |
| `key` | string | jira issue key / github PR id / git commit hash / wiki page id |
| `url` | URL? | human-readable link |

**`Feedback`** — revise Job 의 input

| 필드 | type | 비고 |
| --- | --- | --- |
| `source` | enum | `jira_comment` / `pr_review_comment` / `bug_ticket` |
| `external_ref` | ExternalRef | |
| `body` | text | 사람-가독 |
| `structured` | JSON? | AI 가 parsing 한 구조화 결과 (선택적) |

**`BugTicket`** — back-edge 의 매개 (I-15, I-22)

| 필드 | type | 비고 |
| --- | --- | --- |
| `jira_key` | string | Jira "Bug" issue key |
| `linked_tasks` | Task[] | AI 자동 + 사람 confirm (Jira issue link) |
| `linked_tc` | TestCase | 발견된 TC (auto-close 의 key, I-22) |
| `status` | enum | `open` / `closed` |
| `fix_comment` | Feedback | 사람의 수정 방안 코멘트 |

---

### 2.3 Relationships

```
WorkflowRun (1) ──< (N) Task ──< (N) Job
                         │
                         ├── (1) ExternalRef (jira)
                         ├── (0..1) ExternalRef (github PR)  ← P2 only
                         └── (0..1) git_ref (document)        ← P1/P3 only

Task ──[parent_task_id]──> Task    (fan-out tree)
Task ──[BugTicket.linked_tasks]──< BugTicket   (back-edge, I-15)
BugTicket ──[linked_tc]──> Task (tc)            (auto-close, I-22)

Job ──[git_commit_ref]──> external git commit  (SSOT for document)
Job ──[skill_versions[]]──> Skill (Type A) at version (audit)
```

---

## 3. 골격 컴포넌트의 책임 + 인터페이스

> 컴포넌트 + 단일 EventHandler + Skill 합성의 method signature (TS 의사 코드) 와 호출 관계.
> 2026-05-27 단순화 (A/B/C, NOT D) 반영:
> - **A**: 1 패턴 + 4 axis (별도 pattern enum 없음)
> - **B**: 3 handler → **단일 `EventHandler`**
> - **C**: task-internal 로직 (과거 L1/L2/L3) → handler 코드. 데이터로 남는 것 = L4 (Job I/O schema) + 메타.
> - **NOT D**: cross-task 오케스트레이션 (fan-out/fan-in/back-edge) 은 Workflow Run Orchestrator 의 first-class 메커니즘으로 **명시 유지**.
> - 컴포넌트는 type-agnostic — task type 별 분기는 **handler registry lookup** (P-1).

### 3.1 단일 EventHandler (task-internal 로직)

**책임**: 한 task 안에서 일어나는 모든 trigger 를 처리. task type 별 구현체가 registry 에 등록. 과거 L1/L2/L3 의 로직 흡수 (조건 분기를 코드로).

```ts
type Event =
  | { kind: 'task_spawned'; taskId: TaskId }
  | { kind: 'job_finished'; taskId: TaskId; jobResult: JobResult }
  | { kind: 'external_event'; taskId: TaskId; event: NormalizedEvent };

type Action =
  | { kind: 'spawnJob'; spec: JobSpec }                 // 다음 Job (과거 L1)
  | { kind: 'outbound'; actions: ExternalAction[] }     // 외부 mirror (과거 L2)
  | { kind: 'awaitExternal'; criteria: ExternalEventCriteria }
  | { kind: 'terminate'; outcome: TaskOutcome };        // → Orchestrator 로

interface EventHandler {
  // task type 마다 1 구현체. axis 값 (generate/quality/revise/승인 source) 은
  // 이 구현체 안의 코드 + 메타로 표현.
  onEvent(event: Event, ctx: TaskContext): Action[];
}

// registry: task type → handler
type HandlerRegistry = Map<TaskType, EventHandler>;
```

**호출 시점** (Task State Machine 이 registry lookup 후 호출):
- `task_spawned`: Orchestrator 가 새 task spawn 직후 (→ 보통 첫 `spawnJob`)
- `job_finished`: Runner 가 Job 종료 보고 시 (→ 다음 `spawnJob` / `outbound` / `awaitExternal` / `terminate`)
- `external_event`: Inbound Dispatcher 가 task-scoped event 판정 시 (예: Jira "재시도요청" → revise `spawnJob`)

**Task State Machine 의 역할**: registry lookup + handler 호출 + return Action 적용 (Job dispatch / Outbound Dispatcher 호출 / terminate 시 Orchestrator 통지). 자체 type 분기 없음.

**전제 invariants**: I-6 (Job atomic), I-7 (push 까지 = success), I-9 (assignee), I-20 (revise 순차).

---

### 3.2 Workflow Run Orchestrator

**책임**: cross-task / workflow-level state machine. fan-out / fan-in / back-edge / restart recovery. **first-class 메커니즘으로 명시 유지** (NOT D — handler 가 흡수하지 않음). spawn rules 는 Orchestrator 자체 코드 (과거 L5 는 데이터가 아니라 여기 로직).

```ts
type OrchestratorAction =
  | { kind: 'spawnTasks'; specs: TaskSpec[] }              // 순방향 fan-out
  | { kind: 'syncGateAdvance'; nextTaskSpec: TaskSpec }    // N→1 fan-in 통과
  | { kind: 'backEdge'; targetTaskId: TaskId; feedback: Feedback }  // 역방향
  | { kind: 'completeRun'; outcome: RunOutcome }
  | { kind: 'noop' };

interface WorkflowRunOrchestrator {
  // task terminal 도달 시 → spawn 또는 sync gate 평가 또는 run completion.
  // spawn rules = Orchestrator 자체 코드 (type 별 hand-off 는 메타 + 코드).
  handleTaskTerminal(
    runId: RunId,
    taskId: TaskId,
    outcome: TaskOutcome
  ): OrchestratorAction[];

  // back-edge: Bug 티켓 생성 / PR review 코멘트 → 영향 task 의 새 revise Job 트리거
  handleBackEdgeTrigger(
    runId: RunId,
    bug: BugTicket,
    confirmedTargets: TaskId[]
  ): OrchestratorAction[];

  // startup: 모든 in-flight task 의 SSOT 재확인, DB cache 정합
  // I-21 verify-on-startup.
  recoverOnStartup(): Promise<void>;
}
```

**호출 시점**:
- `handleTaskTerminal`: Task State Machine 이 `{kind: 'terminate'}` 반환 시
- `handleBackEdgeTrigger`: Inbound Dispatcher 가 사람 confirm 된 Bug 영향 event 받았을 때
- `recoverOnStartup`: workflow App 부팅

**전제 invariants**: I-3 (catch-up), I-14 (sync gate owner), I-15 (back-edge 모델), I-21 (recovery), I-22 (auto-close trigger).

---

### 3.3 Outbound Dispatcher

**책임**: handler / orchestrator 가 **이미 결정한** outbound action 을 외부 시스템 (Jira / GitHub / Wiki) 에 apply. status명/comment template 은 메타 데이터로 채움. I-19 같은 schema 강제. **결정 로직은 handler/orchestrator 에 있고, Dispatcher 는 실행만** (§3.7 참조).

```ts
type ExternalAction =
  | { kind: 'jiraStatusSet'; issueKey: string; status: string }
  | { kind: 'jiraComment'; issueKey: string; body: string }
  | { kind: 'jiraTicketCreate'; type: 'Bug' | 'Deploy' | ...; fields: {...} }
  | { kind: 'jiraIssueLink'; from: string; to: string; linkType: string }
  | { kind: 'wikiPublish'; pageRef: string; markdown: string }
  | { kind: 'noop' };

interface OutboundDispatcher {
  // handler 의 'outbound' Action 또는 orchestrator action 안의 ExternalAction[] 을 받아
  // 메타 template 으로 최종 payload 채운 뒤 apply. 결정은 안 함.
  apply(action: ExternalAction): Promise<void>;
}
```

**Idempotency**: 같은 (target ref + action kind + content hash) 은 dedupe. I-13 (wiki publish 실패 = task 진행 안 막음) 도 여기서.

**호출 시점**:
- EventHandler 가 `{kind:'outbound'}` Action return 시 (Job result → 외부 mirror)
- Workflow Run Orchestrator 의 `handleTaskTerminal` 안 (task 종료 → Jira status 등)
- Workflow Run Orchestrator 의 `handleBackEdgeTrigger` 안 (Bug 자동 close, I-22)

---

### 3.4 Inbound Dispatcher

**책임**: 외부 event 를 source-agnostic normalize 후 (외부 transition명 → event type) lookup table 로 dispatch.

```ts
type NormalizedEvent = {
  source: 'jira' | 'github' | 'wiki' | ...;
  type: string;       // 'transition' / 'pr_merged' / 'pr_reviewed' / ...
  refs: ExternalRef[];
  payload: unknown;   // source 별 원본 (audit)
};

interface InboundDispatcher {
  // 외부 webhook payload → normalize
  normalize(source: string, rawPayload: unknown): NormalizedEvent;

  // 메타의 lookup table (외부 transition명 → event type) → 적절한 컴포넌트로 forward
  dispatch(event: NormalizedEvent): Promise<void>;
  // 내부적으로:
  //  - task-scoped event → TaskStateMachine (→ EventHandler.onEvent, external_event)
  //  - workflow-scoped event (e.g., Bug confirm) → WorkflowRunOrchestrator.handleBackEdgeTrigger
  //  - source request 신규 ticket → WorkflowRunOrchestrator (new run 시작)
}
```

**전제 invariants**: I-5 일반화 (외부 사람-판단 event), I-18 (Code task SSOT = GitHub PR state).

---

### 3.5 Skill 합성 (Runner interface)

**책임**: Job spec 생성 시 Type A (도메인 skill) + Type B (integration schema) 합성. Runner 가 받는 단일 JSON contract.

```ts
interface JobSpecBuilder {
  // Strategy L4 + 현재 input → Runner 로 전달할 단일 spec
  compose(
    taskId: TaskId,
    jobType: string,
    inputs: JobInputs,
    strategyL4: L4Spec
  ): JobSpec;
}

interface JobOutputValidator {
  // Runner 가 보고한 output 을 Type B schema 로 검증
  // 실패 = Job 실패 (P-5 enforcement)
  validate(jobOutput: unknown, typeBSchema: JSONSchema): OK | ValidationError;
}
```

**Skill audit**: Runner 가 실행 시 사용한 Type A skill version 들을 Job result 에 포함. Outbound Dispatcher 가 Jira comment + DB ledger 에 기록 (CONTEXT.md Skill 절).

---

### 3.6 호출 관계 다이어그램

```
                        ┌─────────────────┐
External webhook ──────▶│ Inbound         │
(Jira/GitHub/Wiki)      │ Dispatcher      │
                        └────────┬────────┘
                                 │ normalize + lookup table
                ┌────────────────┼────────────────┐
                ▼                                  ▼
   ┌──────────────────┐              ┌─────────────────────────┐
   │ Task State       │  registry    │ Workflow Run            │
   │ Machine          │  lookup      │ Orchestrator            │
   │                  │              │                         │
   │ → EventHandler   │ task         │ handleTaskTerminal      │
   │   .onEvent(...)  │ terminal     │ handleBackEdgeTrigger   │
   │                  │─────────────▶│ recoverOnStartup        │
   └────────┬─────────┘              └────────────┬────────────┘
            │ Action[]:                           │ spawnTasks / syncGateAdvance
            │  spawnJob / outbound /              │ backEdge / completeRun
            │  awaitExternal / terminate          │
            ▼                                     │
   ┌──────────────────┐                          │
   │ JobSpecBuilder   │  (spawnJob 일 때)        │
   │ (Type A + B)     │                          │
   └────────┬─────────┘                          │
            │ JobSpec                            │
            ▼                                     │
   ┌──────────────────┐                          │
   │ Runner (local)   │                          │
   │ - AI 호출        │                          │
   │ - schema validate│                          │
   │ - git commit+push│                          │
   └────────┬─────────┘                          │
            │ JobResult → job_finished event     │
            ▼                                     │
   ┌──────────────────┐    ┌─────────────────────▼──────┐
   │ JobOutput        │    │ Outbound Dispatcher        │
   │ Validator        │    │  apply(ExternalAction)     │
   └────────┬─────────┘    │  (handler/orch 가 결정한    │
            │ OK / fail    │   action 을 실행만)         │
            └─────────────▶│                            │
                           └──────────────┬─────────────┘
                                          │ ExternalAction
                                          ▼
                              Jira / GitHub / Wiki API
```

(`outbound` Action 은 EventHandler 가 return → Task State Machine 이 Outbound Dispatcher 로 전달)

### 3.7 컴포넌트 책임 분리 — 무엇이 무엇을 책임지지 않는가

- **EventHandler 는 cross-task 정보를 모른다.** sibling task 상태나 sync gate 는 Orchestrator 책임. handler 는 `terminate` Action 만 내고 빠짐.
- **Task State Machine 은 type 정책을 모른다.** registry lookup + handler 호출 + Action 적용만. task type 별 분기 없음.
- **Workflow Run Orchestrator 는 Job 의 내부 모른다.** Job spec 모양은 EventHandler + JobSpecBuilder 책임. Orchestrator 는 task 단위로만 본다.
- **Outbound Dispatcher 는 정책을 모른다.** "이 결과 시 어떤 Jira status 로" 의 결정은 handler/orchestrator 코드; Dispatcher 는 받은 action 을 메타 template 으로 채워 실행만.
- **Inbound Dispatcher 는 의미를 모른다.** "PR merge = Code task 종료" 매핑은 메타 lookup table; Dispatcher 는 normalize + lookup + forward 만.
- **Runner 는 workflow 의미를 모른다.** Job spec 안의 prompt + schema + 도구만 실행. workflow state / 다음 step / 다른 task 인식 없음.

이 분리가 P-1 (Data over Code) + 단순화 (B/C) 의 코드 측 보장이다. **결정 로직은 handler/orchestrator (코드), 데이터는 L4 schema + 메타 (YAML), dispatcher 들은 type-agnostic 실행기.**

---

## 4. Strategy 데이터 schema (L4 + 메타)

> *§4 는 다음 grilling 라운드에서 작성. 현재는 placeholder.*
>
> 단순화 (C) 후 데이터로 남는 부분만 정의:
> - **L4 Job spec**: 각 Job 의 I/O JSON schema (Type B, runtime validation) + Type A skill 이름
> - **메타**: task type 별 approver role / 산출물 위치 template / 4 axis 값 / schema version (I-23)
> - **lookup tables**: Outbound 의 status명/comment template, Inbound 의 (외부 transition명 → event type) 매핑
> - (L1/L2/L3 로직 + L5 spawn rules 는 데이터가 아니라 handler/orchestrator 코드 — §3 참조)

---

## 5. 6 task type 별 Strategy YAML 예시

> *§5 는 Step B 에서 작성. 현재는 placeholder.*

---

## 6. 적합성 검토

> *§6 은 Step C 에서 작성. 현재는 placeholder.*
