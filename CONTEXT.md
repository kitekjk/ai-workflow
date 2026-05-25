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
| 사람의 판단이 필요한 transition | **Jira event** 가 트리거 |
| 결정론적 transition | **시스템** 이 자동 |

예시:
- PRD 승인 / 재시도요청 → Jira event 가 트리거.
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

## Jira Ticket Type 매핑

| Workflow 개념 | Jira issue type |
| --- | --- |
| 운영 요청 (source request) | Task |
| PRD | Initiative |
| HLD | Epic |
| LLD | Story |
| Spec | Task |
| 그 외 (요청·메타·기록) | Task |

**운영 요청 ↔ PRD** 는 Jira 표준 계층상 직접 부모/자식이 불가하므로 **link** 로 묶는다 (link type 은 미정).

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
- **I-6 (F10 재정의)**: Job 은 atomic. 재시도 개념이 모델에 없음. 같은 일을 다시 하려면 새 Job 인스턴스.
- **I-7**: `generate / revise Job` 의 성공 = git push 까지 완료 (local commit only 는 in-progress).
- **I-8**: DB 의 commit hash 는 git remote 에 실제 존재하는 commit 만 가리킨다 (verify-on-write).
- **I-9 (F8 재정의)**: Job 의 owner = Task 의 Jira assignee. assignee 와 매칭되는 Runner 가 없는 동안 Job 은 `pending-unassigned` 상태로 명시되고, Workflow 가 그 사실을 Jira comment 로 표시한다 (silent pending 금지).
- **I-10**: Runner 의 owner email 은 자기 Jira account email 과 같아야 한다 (Runner 등록 시 validation).
- **I-11**: Wiki publish 는 모든 Document version (generate / revise) 마다 실행된다. in-progress 포함.
- **I-12**: 사람의 PRD/HLD 수정 의도는 **Jira comment 로만** 전달된다. wiki 직접 수정은 다음 publish 가 덮어쓴다 (wiki 페이지 헤더에 안내).
- **I-13**: Wiki publish 실패는 task 진행을 막지 않는다. retry queue 로 background 처리.

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
