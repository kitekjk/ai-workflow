# AI Workflow — 도메인 어휘 (Domain Glossary)

> 이 파일은 **새 시스템 (rebuild)** 의 도메인 glossary 다.
> 구현 디테일·storage 결정·알고리즘은 여기 들어가지 않는다.
> 그것들은 spec / docs/adr/ 에.
> Legacy 코드와 용어가 충돌하면 이 파일이 우선한다.

**마지막 갱신**: 2026-05-25 (grilling 세션 진행 중)

---

## 핵심 어휘

### Workflow Run
- 한 **source request** (운영 요청 티켓 등) 가 트리거한 **1회 진행 단위**.
- 자체 transition 권한 **없음**. Jira event 와 시스템 내부 결정의 **reactor** 역할.
- terminal: `completed`, `canceled`, `failed`.

### Task
- Workflow 안의 한 종류의 **단계** (예: PRD 작성 단계, HLD 작성 단계).
- `type` 을 가진다 (`prd`, `hld`, `lld`, `spec`, `code`, `deploy`, ...).
- **주요 Document 1개를 1급 속성으로 가진다** (이 Task 의 산출물).
- Task 안에서 여러 Job 이 **순차적 또는 결과에 따라 동적으로** 추가된다.
- 같은 `type` 의 Task 는 같은 구조 (같은 [Strategy](#strategy)) 를 따른다.

### Job
- Runner 가 **1회 실행**하는 단위.
- **Atomic** — 1번 실행되고 끝. **재시도 개념이 모델에 없다.**
- 같은 일을 다시 하려면 **새 Job 인스턴스** 를 만든다. (예: 실패한 generate 의 재실행 = 새 generate Job)
- Job 의 결과는 위로 전달 (Task → Workflow) 되며, **Job 스스로는 다음 step 을 결정하지 않는다.**
- terminal: `succeeded`, `failed`, `canceled`.

### Document
- Task 의 **주요 산출물** (markdown 본문).
- **Task 의 1급 속성** (Job 의 산출물이 아니다).
- `generate` / `revise` Job 이 Document 의 **새 version** 을 만들고, `quality` / `routing` Job 은 **read-only** 로 본다.
- Task 1개 ↔ "current Document" 1개. version history 는 별도.
- **본문의 SSOT 는 Git repo 의 commit**. DB 는 commit hash + metadata 만 가진 휘발성 cache.
- Document version id = git commit hash (또는 그것을 포함).

### Strategy
- Task type 별로 다른 부분을 **데이터 (workflow definition YAML)** 로 캡슐화한 정책.
- 캡슐화 영역:
  - **L1 Job sequence skeleton** — 이 type 의 default Job 순서
  - **L2 Outbound mapping** — Job 결과 → Jira 갱신 (status / comment)
  - **L3 Inbound mapping** — Jira event → 다음 Job 추가
  - **L4 Job spec** — 각 Job 의 prompt / skill / I/O schema
  - **L5 Spawn rules** — 이 Task 종료 시 어떤 child Task(들) 을 만드는가
- **코드 클래스가 아니다.** 전통적 GoF Strategy 가 아니라 데이터-driven 패턴.

### Skill
Skill 은 **두 type** 으로 분리된다. 책임 / SSOT / version 정책이 다르다.

#### Type A — 도메인 Skill (Domain Skill)
- Job 의 목적에 맞는 prompt + tools 패키지.
- **포함 skill 예**: PRD 작성, PRD quality, **Routing** (어떤 Service 영향 판단), HLD 작성, LLD 쪼개기, ...
- **SSOT**: **사설 marketplace** (회사 내부 운영). 공개 Claude marketplace 는 사용하지 않는다.
- **배포**: Runner 가 Job 시작 시 install/update.
- **Version 정책**: 항상 latest (재현성보다 **개선 가능성** 우선).
- **개선 모델**: 결과 이상 → Skill 수정 → 사설 marketplace 에 새 version publish → 다음 Job 이 자동 update 후 사용.
- **Audit**: Job 수행 시 사용된 skill version 을 Jira comment + DB 에 ledger 용으로 기록.

#### Type B — 통합 Skill (Integration Skill)
- Job ↔ Workflow 연동을 위한 **입력/출력 schema + 가이드 instruction**.
- **SSOT**: `workflow-definitions` repo 의 Strategy YAML (또는 같은 repo 의 prompt 템플릿 파일).
- **배포**: Workflow App 이 Job spec 만들 때 Strategy YAML 에서 읽어 inline 으로 Runner 에 전달.
- **Version 정책**: Strategy YAML 의 commit hash 가 version. PR review 로 명시 audit.
- **목적**: Workflow App 의 outbound mapping 이 의존하는 **계약**. 계약 안 바뀌면 output 형식도 안 바뀌어야 함 (strict).
- **enforcement**: Runner 가 AI 결과를 schema 로 validation. 실패 = Job 실패.

#### 두 Type 의 합성
Runner 가 AI 호출 시 Type A 의 도메인 prompt + Type B 의 output instruction 을 **합쳐서** 한 번에 전달.
결과 → Type B schema validation → 통과 시 Workflow App 에 보고.

### Runner (Local Runner)
- 담당자의 **로컬 머신**에서 동작하는 Job 실행 컴포넌트.
- **접근 가능**: git (사용자 계정), AI CLI (Claude / Codex), local FS, Skill 패키지.
- **접근 불가**: DB, Jira (의도된 격리).
- Job 의 atomicity 를 책임진다: AI 호출 → schema 검증 → local write → git commit → **git push** → result 보고.
- Workflow App 과의 인터페이스는 **두 JSON 메시지뿐**: Job spec (수신), Job result (송신).

### Service
- 비즈니스 시스템 단위 (예: SCM, 주문, 결제, 알림).
- 속성: `id`, `name`, `purpose`, `role`, `repos[]` (be-repo, fe-repo, ...), 기타 메타데이터.
- **SSOT 는 Workflow App 의 DB** (약 영속). 사람이 운영자 UI / admin endpoint 로 CRUD.
- **사라져도 무방** — 회사가 Wiki 등 별도로 운영하는 시스템 정보 페이지가 있어, workflow 가 망가져 DB 가 날아가도 사람이 보고 다시 입력 가능. Wiki 는 *참고용 안전망일 뿐 SSOT 아님*.
- Routing Job 의 input 으로 전체 Service list 가 제공되어 AI 가 영향 받는 Service 들을 판단.

### Workflow App (중앙 서버)
- **접근 가능**: DB, Jira API, 외부 webhook 수신.
- **접근 불가**: git push, AI 실행 (모두 Runner 가 처리).
- 책임:
  - Runner 에게 Job spec 할당
  - Runner 에게서 Job result 수신 → DB 에 commit_hash 기록 → Strategy 의 outbound mapping 으로 Jira 갱신
  - Jira webhook 수신 → Strategy 의 inbound mapping 으로 다음 Job 결정
  - Spawn rules 적용 → 새 Task / Job 생성
- **Stateless reactor** 에 가까움. DB 는 in-flight cache / index. workflow 재시작 시 git + Jira 에서 catch-up 가능.

### Routing / Fan-out
- 별도 개념이 아니라 **특별한 Job type 의 한 종류** 이다.
- **Routing Job**: 현재 Task 의 Document + 외부 소스 (예: 소스코드 repo) 를 분석 → 다음 Task type 들의 list 를 **구조화 output** 으로 반환.
- **Spawn rules (Strategy L5)** 가 그 결과를 받아 새 Task 인스턴스(들) 을 생성.

---

## SSOT 분리

### 원칙
**Workflow 는 process automation 도구일 뿐이다. 영속 데이터의 소유자는 사용자 (= 사람과 git/Jira/Wiki).**
Workflow App 자체는 휘발성으로 취급.

**영속 강도의 두 단계**:
- **강 (필수)**: 산출물 (Document) — workflow 가 사라져도 반드시 남아야 한다.
- **약 (best-effort)**: process metadata (점수/분류/진단) — 가능한 한 남는 게 좋지만 필수는 아니다.

### 데이터별 SSOT
| 데이터 | SSOT | 영속 강도 | Workflow App 안 |
| --- | --- | --- | --- |
| Document 본문 (PRD/HLD/LLD/Spec markdown) | **Git repo** | 강 (필수) | commit hash pointer (cache) |
| 진행 상태 transition (사람 판단) | **Jira** | 강 (외부) | webhook event + cache |
| 사람용 view | **Wiki (Confluence)** | 강 (외부) | publish target |
| **Service Registry** (서비스 메타데이터, repo 목록) | **Workflow DB** | 약 (휘발) | DB SSOT. 사라지면 사람이 wiki 보고 재입력. |
| **Skill (Type A 도메인)** | **사설 marketplace** | 강 (외부) | Runner 머신에 install |
| **Strategy / Type B 통합 Skill** | **`workflow-definitions` repo** | 강 (git) | Workflow App memory cache |
| Job 실행 결과 (점수, 분류, 진단) | (없음) | 약 (best-effort) | DB (full) + Jira comment (사람-가독 요약) |
| Workflow / Task / Job 의 in-flight 상태 | (없음) | 약 (휘발) | DB, Jira+git 으로 catch-up |

> **원칙**: Workflow App 은 외부 시스템들의 **reactor + cache** 다. 자체 owned 영속 데이터는 사실상 없다. 산출물 (Document) 만 영속 SSOT 가 보장되어야 하고, 그 외는 외부 시스템이 SSOT 이거나 없어도 무방.

### Transition 권한 — `T-relaxed`
| 종류 | 권한 |
| --- | --- |
| 사람의 판단이 필요한 transition | **외부 사람-판단 event** 가 트리거 (Jira 가 default, GitHub PR review 같은 다른 외부 시스템 event 도 동일 model) |
| 결정론적 transition | **시스템** 이 자동 |

예시:
- PRD 승인 / 재시도요청 → **Jira event** 가 트리거.
- Code task 의 PR review / merge → **GitHub event** 가 트리거 (Jira 가 아님 — Code task 의 SSOT 는 GitHub PR state, I-18).
- generate → quality 자동 진행 / fan-out 시 LLD Task 자동 생성 → 시스템이 자동.

### Quality / Approval 표준 흐름 (모든 Document Task 공통)
```
quality Job → 점수 도출
   ├─ ≥ threshold → Jira "승인대기" (outbound)
   │     ↓ 사람의 "승인" transition (inbound)
   │     → 다음 Job (예: routing)
   └─ <  threshold → Jira "수정요청" + missing items comment (outbound)
         ↓ 사람의 정보 보완 + "재시도요청" transition (inbound)
         → revise Job (이전 feedback 을 input 으로)
```
threshold / status 명 / comment 포맷 모두 **Strategy YAML 의 outbound/inbound mapping 에 데이터로 정의** (코드 hardcode 금지 = F7 회귀 방지).

---

## Fan-out cardinality (단계 간)

| 종료 단계 | 다음 단계 | cardinality | hand-off 메커니즘 |
| --- | --- | --- | --- |
| PRD | HLD | **1 : 1** | routing Job 의 `next_task_types` |
| HLD | LLD | **1 : N** | `split` Job 의 `lld_scopes[]` 마다 Spawn |
| LLD | Spec | **1 : 1** | LLD task 종료 시 Spec task 자동 생성 |
| Spec | Code | **1 : 1** | Spec task 승인 시 Code task 자동 생성 (1 Spec = 1 PR) |
| Code (N 개) | TC | **N : 1 (fan-in)** | **Workflow Run 이 sync gate owner**. 모든 Code task terminal 도달 시 TC task 1 개 spawn. |
| TC | QA 또는 Deploy | **1 : 1 분기** | TC task 의 `analyze_change` job output `qa_required` 가 분기: true → QA task spawn / false → Deploy task spawn (QA skip) |
| QA | (back-edge LLD/Spec/Code) | **1 : N (back-edge)** | QA 가 발견한 버그 = 영향 LLD/Spec/Code task 의 **새 revise Job**. 새 task 인스턴스 / child task 생성 X. |
| QA | Deploy | **1 : 1** | QA 가 모든 버그 해소 후 사람 (QA) "승인" transition → Deploy task spawn |
| Deploy | (terminal) | **— (workflow run completed)** | Deploy task = Jira 티켓 "배포대기" 생성. 사람이 외부 CD 로 실제 배포 → Jira 수동 "완료" → workflow run completed |

### 원칙

- 한 PRD 의 의도 = "한 시스템 변화". service 별 독립 변화 묶음이라면 PRD 가 분리되어야 한다 (PRD 분할이 fan-out 보다 우선).
- TC 작성 위치 = **fe-repo** 기본. 화면 영향 있는 모든 변경의 검증이 fe-repo TC 에 모인다. server-to-server 만 영향 시 TC task 안 `analyze_change` 가 `qa_required=false` 로 판정하여 TC/QA 모두 skip.
- back-edge 는 새 task 인스턴스가 아니라 기존 task 의 새 revise Job — invariant I-5' (revise 무제한) 와 일관.

---

## Task Pattern 4 종

모든 Task 는 다음 4 패턴 중 하나를 따른다. 골격 (코드) 이 4 패턴 모두 cover 해야 한다.

| 패턴 | 적용 Task | 모양 |
| --- | --- | --- |
| **P1 Document** | PRD / HLD / LLD / Spec / TC | `generate → quality → (revise → quality)* → 사람 승인` (PRD-style). Approver 별 다름. revise 무제한 (I-5'). |
| **P2 Code** | Code | `generate_code+test (atomic) → open_pr → address_review* → merge`. 사람 판단 = **PR review (GitHub event SSOT, I-18)**. PR title 에 Jira ticket key 포함 강제 (I-19). revise = PR review comment → 새 commit. LLD/Spec 되돌림은 **back-edge 메커니즘 (I-15 와 동일)**: AI 가 Bug 티켓 + Jira link 자동 생성 → 사람 confirm → 영향 task "재시도요청" transition. |
| **P3 QA** | QA | `run_qa → 버그 발견 시 LLD/Spec/Code 의 새 revise Job (back-edge) → 모든 fix 완료 시 → 사람 (QA) 승인 → 종료`. lifecycle = 버그 fix loop 동안 open. **back-edge 메커니즘 (I-15)**: AI 가 Bug 티켓 + Jira issue link 자동 생성 → 사람 (QA) confirm/수정 → 영향 task "재시도요청" transition → 새 revise Job. 1 bug = 1 revise Job, 같은 task 의 N Job 은 순차 실행 (I-20). |
| **P4 Action-only** | Deploy | `Jira 티켓 생성 ("배포대기") → 사람의 외부 CD 배포 → Jira 수동 "완료" transition → workflow 완료`. quality / revise 없음. |

> 이 4 패턴이 **공통 골격 + Strategy YAML 데이터** 로 표현 가능한지가 "공통/특화 분석" 의 stress-test 핵심.
> **검증 결과 (2026-05-27 grilling, stages-task-job-analysis.md § 공통/특화 분석)**: ✅ 4 패턴 모두 아래 골격 4 컴포넌트 + Strategy 5 layer 로 표현 가능. 모델 재설계 불필요.

### 골격 4 컴포넌트 (M0/M1 코드의 구조)

| 컴포넌트 | 책임 |
| --- | --- |
| **Task State Machine** | task 단위 lifecycle (Job spawn → 결과 → 다음 Job → terminal). Strategy L1 + L3 + L4 + I-6/I-7/I-9/I-20 따름. |
| **Workflow Run Orchestrator** | sync gate (I-14, N→1 fan-in), 순방향 fan-out (1→N), 역방향 back-edge (I-15), restart recovery (I-21). Strategy L5 따름. |
| **Outbound Dispatcher** | Job result → 외부 시스템 (Jira/GitHub/etc) action. Strategy L2 따름. I-19 (PR title contract 같은 schema) 강제. |
| **Inbound Dispatcher** | 외부 event normalization (Jira event / GitHub event — I-5 일반화) → Strategy L3 lookup → 적절한 task/job event. source-agnostic. |

+ **Skill 합성** (Type A domain + Type B integration schema) → Runner 전달 → output schema validation (실패 = Job 실패).

---

## Jira Ticket Type 매핑

| Workflow 개념 | Jira issue type |
| --- | --- |
| 운영 요청 (source request) | Task |
| PRD | Initiative |
| HLD | Epic |
| LLD | Story |
| Spec | Task |
| **Bug (QA / Code back-channel)** | **Bug** |
| 그 외 (요청·메타·기록) | Task |

**운영 요청 ↔ PRD** 는 Jira 표준 계층상 직접 부모/자식이 불가하므로 **link** 로 묶는다 (link type 은 미정).

**Bug ↔ 영향 task** 는 Jira **issue link** 로 묶는다 (예: `is caused by` / `blocks`). AI 가 자동 생성, 사람이 confirm/수정 (I-15).

---

## 주요 대상 시스템

| 시스템 | 역할 |
| --- | --- |
| Workflow App | Workflow 관리, Jira event reactor |
| Jira | 진행 절차의 SSOT (사람 판단 transition) |
| Wiki (Confluence) | 사람용 문서 복제본 (system → wiki 단방향, 미확정) |
| prd-repo | PRD 문서 git repo |
| be-repo | 백엔드 코드 + HLD 문서 보관 |
| fe-repo | 프론트엔드 코드 (be-repo 와 동일할 수도 있음) |

---

## 4개 Role (Workflow 관점)

| Role | 책임 (간략) |
| --- | --- |
| 운영자 | Runner 등록·정지, 시스템 헬스 모니터링 |
| 기획자 | PRD intake, PRD 승인, feedback 제공 |
| 개발자 | HLD/LLD/Spec 승인, 구현, 코드 리뷰 |
| QA | Spec 의 TC 보강, Dev 완료 후 TC finalize, QA 검증 승인 |

> 1차 사용자는 1명 (역할 겸직). 동시 다중 사용자는 후속.

---

## 핵심 Invariant (모델 차원에서 보장되어야 함)

- **I-1 (F11 재정의)**: `generate / revise Job` 의 성공 조건 = git commit 완료. commit 전엔 Document version 이 존재하지 않음.
- **I-2**: DB 는 git commit hash + Jira issue key 만 가지면 본문/상태를 복원 가능해야 한다.
- **I-3**: Workflow 재시작 시 git + Jira 만으로 모든 Task/Job 상태를 catch-up 할 수 있어야 한다.
- **I-4**: Git outage 는 시스템이 명시적으로 정지하는 타당한 외부 의존성 (NFR-7 의 "outage 견딤" 대상에서 제외).
- **I-5 (F7 재정의)**: 시스템이 자체적으로 transition 정책을 가지지 않는다. 모든 사람-판단 transition 은 Jira event 가 트리거.
  - **따름정리 (I-5')**: Document Task (PRD/HLD/LLD/Spec) 의 revise loop 는 **무제한**. 사람이 "재시도요청" transition 안 하면 자연히 멈추므로 시스템 차원 hard limit 이 필요 없다. 비용/품질 escalation 신호가 필요하면 그것은 Strategy 의 outbound mapping (예: revise 5 회 도달 시 Jira comment 로 경고) 로 표현하고, 모델 차원 종료 조건은 두지 않는다. Code/Test/Deploy 의 revise 모양은 별도 (markdown 산출물과 다른 cycle).
- **I-6 (F10 재정의)**: Job 은 atomic. 재시도 개념이 모델에 없음. 같은 일을 다시 하려면 새 Job 인스턴스.
- **I-7**: `generate / revise Job` 의 성공 = git push 까지 완료 (local commit only 는 in-progress).
- **I-8**: DB 의 commit hash 는 git remote 에 실제 존재하는 commit 만 가리킨다 (verify-on-write).
- **I-9 (F8 재정의)**: Job 의 owner = Task 의 Jira assignee. assignee 와 매칭되는 Runner 가 없는 동안 Job 은 `pending-unassigned` 상태로 명시되고, Workflow 가 그 사실을 Jira comment 로 표시한다 (silent pending 금지).
- **I-10**: Runner 의 owner email 은 자기 Jira account email 과 같아야 한다 (Runner 등록 시 validation).
- **I-11**: Wiki publish 는 모든 Document version (generate / revise) 마다 실행된다. in-progress 포함.
- **I-12**: 사람의 PRD/HLD 수정 의도는 **Jira comment 로만** 전달된다. wiki 직접 수정은 다음 publish 가 덮어쓴다 (wiki 페이지 헤더에 안내).
- **I-13**: Wiki publish 실패는 task 진행을 막지 않는다. retry queue 로 background 처리.
- **I-14 (workflow-run sync gate)**: N→1 fan-in 의 owner 는 **Workflow Run** 이다. sync gate state 자체는 휘발 가능 (DB 만 보유) — Jira 의 모든 child task ticket status 로 언제든 재계산 가능 (I-3 와 정합). 첫 적용: N Code task → 1 TC task.
- **I-15 (QA back-edge)**: QA 가 발견한 버그는 **영향받는 LLD/Spec/Code task 의 새 revise Job** 으로 표현된다. 새 task 인스턴스 / child task 생성 금지. revise Job 의 input 에 "버그 티켓 코멘트" 가 feedback 으로 포함된다. (I-5 / I-5' / I-6 와 정합)
- **I-16 (QA path 분기 위치)**: `qa_required` 분기 결정은 **TC task 의 첫 job `analyze_change`** 에서 일어난다. PRD/HLD 단계에서 미리 결정하지 않는다 (실제 코드 변경을 봐야 정확). output `qa_required=false` 면 TC 작성 자체도 skip, 바로 Deploy task spawn.
- **I-17 (Deploy task = action-only)**: Deploy task 는 quality 도 revise 도 없다. Jira 티켓 ("배포대기") 생성 → 사람의 외부 CD 배포 → Jira "완료" transition → workflow run completed. workflow 의 책임은 "티켓 생성과 완료 hook" 까지로 한정 (실제 배포 / 환경 / 롤백 / CD 연동은 workflow scope 밖).
- **I-18 (Code task SSOT = GitHub PR state)**: Code task 의 진행 SSOT 는 **GitHub PR state**. workflow App 은 GitHub webhook (PR open / review / merge) 로 직접 react. Jira ticket 의 status 는 GitHub-Jira integration 의 부수 효과 (workflow App 이 set 하지 않음). Code task 의 Jira ticket 은 audit / Runner assignee 매칭용. (I-5 일반화: 사람-판단 transition = 외부 사람-판단 event, Jira 가 default 이지만 GitHub event 도 동일 model.)
- **I-19 (PR title contract)**: Code task 의 `open_pr` job 은 PR title 에 Jira ticket key 를 반드시 포함한다 (GitHub-Jira integration auto-sync trigger). Strategy YAML 의 PR title template + Type B integration skill schema 가 강제. 위반 = Job 실패.
- **I-20 (back-edge 순차 실행)**: 같은 task 의 N 개 revise Job (back-edge 로 생성된 것 포함) 은 **순차 실행**. 1 Runner = 1 사람 머신 = 직렬. git conflict 회피 + 직전 push 후 fresh state 에서 다음 Job 시작 (I-7 정합). AI 가 직전 fix commit 을 context 로 받아 다음 버그 처리.
- **I-21 (Workflow restart 회복)**: I-3 의 구체화. (a) DB 는 순수 cache — SSOT 는 git + Jira. (b) workflow App startup 시 모든 in-flight task 의 Jira status + git commit hash 를 **verify-on-startup** 으로 재확인, 불일치 시 git/Jira 가 truth, DB 를 그것에 맞춤. (c) "in-flight" 인데 git push 흔적 없는 Job = **failed 처리** (I-7: 성공 = push 까지). local commit only 는 Runner 자체 cleanup. (d) Job dedupe key = `git commit hash + Jira issue key + Job spec hash` — 같은 입력에 결과가 이미 git/Jira 에 있으면 skip.
- **I-22 (Bug auto-close on TC pass)**: QA task 가 매 run 마다 open Bug 의 연결된 TC 들을 재실행한다. 통과 시 Bug 자동 close (Outbound Dispatcher 가 Jira status set). 같은 TC 가 나중에 또 실패 시 **closed Bug 를 reopen** (Jira 표준 동작). 결함 추적이 한 ticket 에 누적.
- **I-23 (Strategy YAML schema versioning)**: 모든 Strategy YAML 파일은 schema `version` field 가 필수. M0 = `version: 1` only. 미래 v2 도입 시 골격의 Inbound/Outbound dispatcher 가 version 별 분기 추가만 하면 됨. v1 schema 의 backward compat 정책은 v2 도입 시점에 결정.

---

## 아직 미정 (다음 grilling)

- **Jira comment 의 포맷 규약** — 사람-가독 요약을 어떤 형식으로 (Strategy 의 outbound mapping 에 데이터로 정의).
- **Service Registry 의 사람-편집 인터페이스** — 운영자 UI? admin endpoint? CLI?
- **사설 marketplace 의 구체 형태** — Claude Code 의 custom marketplace URL? 자체 git registry? 별도 운영 서비스?
- **사설 marketplace outage 시** — Runner 가 새 Skill install 못할 때의 fallback.
- **Wiki 의 단방향성** — 사람이 wiki 를 수정했을 때의 처리.
- **Job 의 시스템 에러 처리** — CLI crash 시 새 Job 인스턴스 자동 생성? Jira 보고?
- **M0 acceptance bar** — cycle 1 happy path 의 정량적 기준 (1회? N회?).
- **code / deploy Task 의 상세 모델** — markdown 이 아닌 산출물의 같은 골격 적용 검증.
- **Skill 의 구조화 가이드 메커니즘** — schema 검증 위치, 실패 시 처리.
- **Workflow restart 시 in-flight Job 처리** — Runner / Workflow 한 쪽이 죽었을 때 회복 시나리오.

---

> 이 글로사리는 grilling 으로 결정이 추가될 때마다 inline 으로 갱신된다.
