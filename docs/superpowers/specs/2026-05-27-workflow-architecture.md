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
| `type` | string | `prd` / `hld` / `lld` / `spec` / `code` / `tc` / `qa` / `deploy`. **유일한 discriminator** (handler registry 키). |
| `jira_key` | string | 외부 Jira issue key (SSOT for human transitions) |
| `github_pr_ref` | string? | P2 (Code) 의 GitHub PR identifier (I-18) |
| `document_pointer` | git_ref? | 현재 Document version (commit hash). P1/P3 (보고서) 에 존재. |
| `assignee_email` | email | Jira assignee 와 동기화 (I-9). Job owner 결정. |
| `status` | enum | `pending` / `in_progress` / `awaiting_human` / `succeeded` / `failed` / `canceled` |
| `created_at` / `terminated_at` | timestamp | |

**Invariants**
- task type → handler 클래스는 **registry lookup** 으로 결정 (`Task.type` 이 유일한 discriminator). 별도 `pattern` enum 없음 (단순화 A). 4 axis 는 데이터 필드가 아니라 (handler 클래스) + (L4) + (lookup) 으로 흡수 — §4.1. 데이터는 type-agnostic dispatcher 가 보지 않음 (P-1).
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

**책임**: handler / orchestrator 가 **이미 결정 + 문자열까지 resolve 한** outbound action 을 외부 시스템 (Jira / GitHub / Wiki) 에 apply. status명/comment 문자열은 **handler 가** 자기 lookup (또는 base 가 `_common`) 에서 채워 **리터럴**로 넘긴다 — Dispatcher 는 채우지 않음 (D1, §4.3). I-19 같은 schema 강제는 apply 단계에서. **결정·templating 은 handler/orchestrator, Dispatcher 는 실행만** (§3.7 참조).

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
  // 이미 채워진 리터럴 action 을 apply 만. 결정·templating 안 함 (D1).
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

**책임**: 외부 event 를 source-agnostic normalize 후 **ref(ExternalRef)→소유 task/run 라우팅** 으로 dispatch. (외부 transition명 → event) **의미 해석은 Dispatcher 가 하지 않는다** — raw transition명을 payload 로 실어 handler 에 forward 하고, handler 가 자기 inbound lookup 으로 해석 (D1, §4.3).

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

  // ref → 소유 task/run 으로 라우팅하여 forward. transition명의 의미는 안 봄 (handler 가 해석).
  dispatch(event: NormalizedEvent): Promise<void>;
  // 내부적으로 (라우팅 기준 = ExternalRef + 구조적 event kind, type-agnostic):
  //  - task-scoped event → TaskStateMachine (→ EventHandler.onEvent, external_event; raw transition명 포함)
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

> 단순화 (C) 후 **데이터로 남는 부분만** 정의한다. 로직 (job sequence / branch / transition / spawn rule) 은 handler·orchestrator **코드** (§3). 여기 YAML 은 코드가 참조하는 **값** (schema · 문자열 · 식별자) 일 뿐이다.
>
> - **L4 Job spec**: 각 Job 의 I/O JSON schema (Type B, runtime validation) + Type A skill 이름
> - **메타**: task type 별 approver role / 산출물 위치 template / 4 axis 값 / schema version (I-23)
> - **lookup tables**: Outbound 의 status명/comment template, Inbound 의 (외부 transition명 → event type) 매핑
> - (L1/L2/L3 로직 + L5 spawn rules 는 데이터가 아니라 handler/orchestrator 코드 — §3 참조)

### 4.0 조직 원칙 + 파일 레이아웃

**(Q1 결정) per-task-type 파일.** task type 1 개 = YAML 파일 1 개. 그 파일은 해당 type 의 **meta + 그 type job 들의 L4 + 그 type 의 outbound/inbound lookup 문자열** 을 담는다. handler registry 가 task type 으로 키되므로 코드(`handlers/<type>.ts`)와 데이터(`<type>.yaml`)가 1:1 로 짝지어진다. 한 type 의 동작을 바꾸려면 정확히 두 파일만 건드린다.

**(Q2 결정) 공유는 코드에서.** 5 Document type (PRD/HLD/LLD/Spec/TC) 이 공유하는 표준 quality/approval 흐름 문자열은 `_common.yaml` 한 파일에 둔다. 이 파일은 **공유 Document base handler 가 직접 읽는다** — per-type YAML 로 merge·extends 되지 않는다. per-type YAML 은 cross-file 참조 없는 **flat** 파일. 공유는 TS 클래스 계층 (`PrdHandler extends DocumentTaskHandler`) 에서 일어나고, 데이터 레이어엔 merge 의미가 0 이다. (YAML cross-file 상속은 네이티브 기능이 아니라 자작 merge 엔진이 필요 — 단순화 C 가 피하려는 accidental complexity 라 배제.)

```
workflows/definitions/
├── _common.yaml          ← Document 공통 흐름 문자열 (base handler 가 읽음)
├── prd.yaml
├── hld.yaml
├── lld.yaml
├── spec.yaml
├── tc.yaml               ← analyze_change 분기 포함 (분기 *결정* 은 handler 코드, output schema 는 L4)
├── qa.yaml
├── code.yaml             ← Document 공통 미참조 (GitHub event 기반, I-18)
└── deploy.yaml           ← action-only (I-17)
```

- 현재 workflow 종류 = 1 (PRD→…→Deploy) 이므로 `definitions/` 바로 아래 평면 배치. 미래에 분기 workflow 도입 시 `definitions/<workflow>/` 하위 디렉토리로 확장 (§2.1 의 `definition_id` 도입 결정과 함께).
- **`definition_version`** = `workflows/` 디렉토리 전체의 git commit hash (§2.1). 파일 분할·개수와 무관하게 재현성 보장.
- 파일명에 version 을 넣지 않는다 — schema version 은 파일 안 `version:` field (I-23), run version 은 git commit hash. 둘 다 파일명 밖. (legacy `prd-confirmation.v1.yaml` 의 `.v1` 중복은 폐기.)
- 기존 `prd-confirmation.v1.yaml` = state-graph-as-data 모델 (단순화 C 가 폐기한 형태). 새 schema 와 구조가 근본적으로 달라 **superseded** — 새 파일로 대체한다 (이전 파일의 물리적 정리는 별도 액션).

**코드 ↔ 데이터 바인딩** (누가 어느 파일을 읽는가):

| 코드 | 읽는 데이터 |
| --- | --- |
| `DocumentTaskHandler` (base) | `_common.yaml` (공통 outbound status · inbound transition) |
| `PrdHandler` / `HldHandler` / `LldHandler` / `SpecHandler` / `TcHandler` (leaf, base 상속) | 자기 `<type>.yaml` (meta + L4 + type 고유 lookup) |
| `CodeHandler` / `QaHandler` / `DeployHandler` (base 미상속) | 자기 `<type>.yaml` 만 |
| Outbound / Inbound Dispatcher | (파일 직접 안 읽음) handler 가 resolve 한 결과를 Action 으로 받아 실행만 (§3.7) |

> handler 가 문자열까지 resolve 해 Action 으로 넘기는지, 아니면 Dispatcher 가 semantic action 을 받아 메타 template 을 채우는지 — 그 경계는 §4.3 (lookup table) 에서 확정한다. (§3.3 의 서술과 `ExternalAction` 타입이 약간 어긋나 있어 거기서 정리.)

### 4.1 meta 블록 (per task type)

단순화 A 결정 (Q3): **별도 `pattern` / `axes` enum 없음.** 4 axis 는 (handler 클래스) + (L4) + (lookup) 으로 흡수되고, 데이터에 남는 type-레벨 메타는 아래뿐이다.

```yaml
# axis (non-load-bearing 주석, 사람 가독용): gen=ai_generate, quality=score@85, revise=jira_transition, approve=jira_event
version: 1                          # I-23 — schema version (structural, top-level)
type: prd                           # task type. 파일명과 일치(loader validation). registry 키.

meta:
  approver_role: planner            # operator | planner | developer | qa
  output_location: "prd-repo:{prd_key}.md"   # Q4 템플릿. Deploy = null.

# jobs:            ← L4 (§4.2)
# outbound/inbound: ← lookup table (§4.3)
```

| field | level | type | 비고 |
| --- | --- | --- | --- |
| `version` | top | int | I-23. M0 = `1` only. Inbound/Outbound dispatcher 가 version 별 분기 (현재 1 가지). |
| `type` | top | string | task type. **파일명과 일치해야 함** (loader 가 validation). handler registry 의 키. |
| `meta.approver_role` | meta | enum | `operator` / `planner` / `developer` / `qa`. **advisory** — 시스템은 실제 transition 을 일으킨 사람에 react (I-5), role 을 강제하지 않는다. workflow 가 다음 Jira 티켓 생성 시 assignee 힌트 + 사람-가독 comment 용. |
| `meta.output_location` | meta | string\|null | Q4 의 `{}` 템플릿. 변수 resolve = handler/orchestrator 코드 (`{repo}` 는 service registry 에서 be/fe 선택). 해석 (path vs branch) = handler. Deploy = `null` (git 산출물 없음). |

- **`approver_role` 는 enforcement 아님.** 4 axis 의 "사람 승인 source" 가 *누가* 가 아니라 *어디서* (Jira vs GitHub) 를 가르는 것과 별개로, role 은 "기대 승인자" 표시일 뿐. TC 처럼 분기에 따라 approver 가 갈리는 경우 (`qa_required=true`→qa / `false`→developer) 는 handler 가 결정 (§5 예시). meta 는 primary 만 둔다.
- **axis 주석** (`# axis: ...`) 은 load-bearing 아님 — loader 가 읽지 않는다. 사람이 파일 열었을 때 "이 type 이 1패턴 4축 중 어디" 를 한눈에 보게 하는 보조용. 원치 않으면 제거 가능.

### 4.2 L4 Job spec (`jobs:` 맵)

`jobs:` 는 그 task type 이 spawn 할 수 있는 **모든 job type → L4** 의 맵이다. handler 가 *어느 job 을 언제* spawn 할지 결정 (sequence/분기 = 코드), 데이터는 각 job 의 **skill 이름 + I/O schema (+ job param)** 만 제공한다 (단순화 C / P-1).

```yaml
jobs:
  <job_type>:
    skill: <type-a-skill-name>      # Type A 도메인 skill 이름 (버전 없음 — 항상 latest)
    output_schema: <JSON Schema>    # 필수. Runner 결과를 검증 (위반 = Job 실패, P-5)
    input_schema: <JSON Schema>     # 선택. JobSpecBuilder 가 input 조립 시 참조 + Runner instruction
    <param>: <value>                # 선택. job 고유 tuning (예: quality 의 threshold)
```

| field | 필수 | 의미 |
| --- | --- | --- |
| `skill` | ✅ | Type A 도메인 skill 이름. **버전 핀 없음** — Runner 가 Job 시작 시 latest install. 실제 쓰인 version 은 사후 `Job.skill_versions` 에 audit 기록 (CONTEXT Skill 절). |
| `output_schema` | ✅ | JSON Schema. `JobOutputValidator` 가 Runner 의 AI 결과를 검증. 실패 = Job 실패 (P-5, §3.5). 인라인 작성, schema 가 커지면 `{ $ref: "./schemas/<type>.<job>.output.json" }` 로 분리 (non-breaking 성장 경로). |
| `input_schema` | — | JSON Schema, **비강제**. input 은 신뢰된 workflow 코드(`JobSpecBuilder`)가 구성하므로 검증 대상 아님 — 이 job 이 무엇을 소비하는지의 계약/문서. |
| job param | — | job 고유 tuning 값. 예: `quality.threshold`. axis 값 중 유일하게 진짜 데이터로 남는 숫자 (Q3). |

**제거된 legacy 필드** (이 schema 에 두지 않음):
- `runner.requiredCapability` — Runner 매칭은 Task assignee 로 (I-9), skill 은 on-demand install. capability 매칭 = YAGNI.
- `retry: { maxAttempts }` — Job atomic, 재시도 = 새 인스턴스 (I-6). retry 개념이 모델에 없음.
- `requiredSkill.versionRange` — Type A 는 always-latest (버전 핀 금지, CONTEXT Skill 절).

**예시 — PRD 의 `jobs:`** (4 job type):

```yaml
jobs:
  generate:
    skill: prd.generate
    output_schema:
      type: object
      required: [summary]
      properties:
        summary: { type: string }            # 사람-가독 요약 (Jira comment 재료)
    # input_schema 생략: source request ticket 본문 + 첨부 (JobSpecBuilder 가 조립)

  quality:
    skill: prd.quality
    threshold: 85                            # ≥ 면 승인대기, < 면 수정요청 (판정 = handler)
    output_schema:
      type: object
      required: [score, missing_items]
      properties:
        score: { type: integer, minimum: 0, maximum: 100 }
        missing_items: { type: array, items: { type: string } }

  revise:
    skill: prd.revise
    input_schema:                            # revise 는 feedback 을 반드시 소비 (문서용)
      type: object
      required: [feedback]
      properties:
        feedback: { type: string }
    output_schema:
      type: object
      required: [summary, addressed]
      properties:
        summary: { type: string }
        addressed: { type: array, items: { type: string } }   # 반영한 feedback 항목

  routing:
    skill: prd.routing
    output_schema:
      type: object
      required: [next_task_types]
      properties:
        next_task_types:
          type: array
          items: { enum: [hld, lld, spec] }   # PRD 하위 진입점 (보통 [hld])
        rationale: { type: string }
```

> `git_commit_ref` (I-7) 는 `output_schema` 에 넣지 않는다 — Runner 가 push 완료 후 Job result 의 **봉투(envelope) 필드**로 보고하며 시스템이 직접 검증 (verify-on-write, I-8). `output_schema` 는 AI 가 생성하는 **본문 구조**만 검증한다.

### 4.3 lookup table (outbound / inbound)

D1 (Q6 결정): 두 lookup 모두 **handler 가 읽는다**. Document 공통은 `_common.yaml` (base handler), type 고유는 그 type YAML (leaf handler). Dispatcher 는 안 읽고 리터럴 action 을 실행만.

**Outbound** — semantic outcome → 외부 action 들 (status 문자열 + comment 템플릿). handler 가 job 결과로 outcome 판정 → 해당 항목 템플릿을 job output 으로 채워 리터럴 `ExternalAction[]` emit.

```yaml
outbound:
  <outcome_key>:
    - { action: jira_status,  status: "<리터럴 status명>" }
    - { action: jira_comment, template: "<{var} 보간 문자열>" }
```

**Inbound** — 외부 신호명 → semantic event. handler 가 `external_event` 받을 때 raw transition명/event kind 를 이 표로 해석 → 다음 action 결정.

```yaml
inbound:
  "<외부 transition명 / event kind>": <semantic_event>
```

**`_common.yaml` (Document 공통 — 5 type 공유, `DocumentTaskHandler` base 가 읽음):**

```yaml
outbound:
  quality_passed:
    - { action: jira_status,  status: "승인대기" }
    - { action: jira_comment, template: "품질 {score}점 — 승인 대기. 요약: {summary}" }
  quality_failed:
    - { action: jira_status,  status: "수정요청" }
    - { action: jira_comment, template: "품질 {score}점 (기준 {threshold}). 보완 필요:\n{missing_items}" }
inbound:
  "승인":       approved     # → handler 가 type 별로 처리: PRD=routing job spawn / LLD=terminate→Spec hand-off
  "재시도요청":  revise       # → handler: revise job spawn (직전 feedback 을 input 으로). 무제한 (I-5')
```

**type 고유 (override / 추가) 예시:**

```yaml
# code.yaml — GitHub event 기반 (I-18), Document 공통 미참조.
inbound:
  pr_merged:          merged           # → handler: task terminate(succeeded)
  pr_review_comment:  review_feedback  # → handler: address_review job spawn (또는 back-edge)
# Code 는 system 이 Jira status 를 set 하지 않음 (I-18) → outbound status 없음.

# deploy.yaml — action-only (I-17).
outbound:
  on_spawn:
    - { action: jira_ticket_create, ticket_type: "Deploy", status: "배포대기", template: "{prd_key} 배포 대기" }
inbound:
  "완료": done        # → handler: terminate → Orchestrator completeRun
```

**규약:**

| 항목 | 결정 |
| --- | --- |
| 템플릿 보간 | `{var}` 치환. `{score}` `{summary}` `{threshold}` 등은 job output / job param / context 에서 채움. |
| 배열 변수 (`{missing_items}`) | handler 가 bullet list (markdown `- ` 줄) 로 렌더. |
| status / transition 문자열 | **실제 Jira 프로젝트 config 와 일치해야 하는 환경 의존 값.** schema 가 보관, 값은 실제 Jira 설정에서 옴. 변경 시 코드가 아니라 이 데이터만 수정 (F7 회귀 방지). |
| comment 의 정확한 wording/format 규약 | CONTEXT.md "미정" 항목 — 데이터라 나중에 채움. schema(=템플릿 문자열) 자체는 막지 않음. |

**lookup 에 안 들어가는 standing outbound** (특정 outcome 이 아니라 handler/orchestrator 가 상시 emit):
- **skill version audit** — 모든 Job 종료 후 `Job.skill_versions` 를 Jira comment + DB ledger 에 기록 (CONTEXT Skill 절). outcome 무관.
- **wiki publish** — generate/revise version 마다 (I-11). 실패해도 task 진행 안 막음 (I-13).
- **Bug 생성 · auto-close** — Orchestrator 가 `handleBackEdgeTrigger` 에서 emit (I-15/I-22). 티켓 템플릿은 `qa.yaml`.

> **§4 닫힘**: per-type 파일 = `version`/`type` + `meta` (§4.1) + `jobs` L4 (§4.2) + `outbound`/`inbound` lookup (§4.3); Document 공통은 `_common.yaml`. 로직 (job sequence / branch / spawn / back-edge) 은 전부 handler·orchestrator **코드** (§3). 데이터엔 state graph 도 pattern enum 도 없다.

---

## 5. 6 task type 별 Strategy YAML 예시

> *§5 는 Step B 에서 작성. 현재는 placeholder.*

---

## 6. 적합성 검토

> *§6 은 Step C 에서 작성. 현재는 placeholder.*
