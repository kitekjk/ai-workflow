# 전체 단계 Task/Job 분석

> **목적**: PRD → HLD → LLD → Spec → Code → Test → Deploy 의 각 단계를 task/job 수준으로 분석하여, **공통 골격(코드)** 과 **단계별 특화(Strategy YAML 데이터)** 의 경계를 박는다.
>
> **사용법**: 각 단계 섹션의 `[TBD]` 와 `❓ 확인:` 를 사용자가 채운다. `(추정)` 으로 표시된 것은 grilling 추정값이니 검증/수정. 채워진 후 § 단계 간 hand-off 와 § 공통/특화 분석 절을 같이 채운다.
>
> **확정 전제 (이전 grilling 결과, CONTEXT.md 참조)**:
> - Job 은 atomic (재시도 = 새 Job 인스턴스)
> - Document = Git repo SSOT
> - T-relaxed (사람 판단 transition 만 Jira event 로)
> - Quality → "승인대기 / 수정요청" → 사람의 "승인 / 재시도요청" transition
> - Job owner = Task 의 Jira assignee
> - Skill = 사설 marketplace (Type A) + Strategy YAML (Type B)
> - Service Registry = Workflow DB
>
> **작성**: 2026-05-25 (grilling 세션)

---

## 필드 정의 (각 단계마다 동일 항목)

| 필드 | 의미 |
| --- | --- |
| Input | 이 Task 가 받는 입력 (이전 단계 산출물 + 부수 데이터) |
| 산출물 type | 결과물의 종류 (markdown / code / 테스트결과 / 배포결과 …) |
| 산출물 위치 | 산출물이 commit / 저장되는 곳 (어느 git repo, 어느 디렉토리) |
| Default Job sequence | happy path 의 job 순서 |
| 사람 판단 transition | Jira 의 어떤 status 가 사람 판단 대기 / 어떤 transition 으로 다음 단계 |
| 자동 transition | 시스템이 자동으로 처리하는 transition |
| Fan-out | Task 종료 시 만들어지는 child Task 들의 개수/모양 |
| Approver role | 4 role (운영자/기획자/개발자/QA) 중 누구 |
| Author 종류 | AI 단독 / AI+사람 hybrid / 사람 단독 |
| revise loop | revise 의 cardinality / 종료 조건 |

---

## 1. PRD

| 필드 | 값 |
| --- | --- |
| Input | source request (Jira task ticket) + (선택) 첨부 자료 |
| 산출물 type | markdown |
| 산출물 위치 | **prd-repo** (확정, req.md 13행) |
| Default Job sequence | `generate` → `quality` → (사람) → `revise`* → `quality` → (사람 승인) → `routing` |
| 사람 판단 transition | Jira status `승인대기` 에서 `승인` / `수정요청` 에서 `재시도요청` |
| 자동 transition | `generate` 종료 → `quality` 자동. `quality 성공` → Jira `승인대기` outbound. `quality 실패` → Jira `수정요청` outbound. `routing` 의 자동 분기. |
| Fan-out | routing 결과의 `next_task_types` 에 따라 1+ next task (HLD 또는 LLD 또는 Spec) 생성 |
| Approver role | **기획자** |
| Author 종류 | AI 단독 (사람은 feedback 만 제공) |
| revise loop | ❓ 확인: 횟수 제한 있나? `[TBD]` |

---

## 2. HLD

| 필드 | 값 |
| --- | --- |
| Input | 승인된 PRD + 영향 Services 의 repos (Routing 이 식별한 service list) |
| 산출물 type | markdown (+ 선택적 다이어그램?) |
| 산출물 위치 | ❓ 확인: req.md 14행 "be-repo: ... HLD 문서 보관" 이지만 한 PRD 가 **여러 Service 에 영향** 일 때 HLD 가 어느 repo 에? `[TBD]` (옵션: 각 service 의 be-repo 에 각각 / 별도 docs-repo / prd-repo) |
| Default Job sequence | `generate` → `quality` → (사람) → `revise`* → ... → (사람 승인) → `split` (LLD 쪼개기) |
| 사람 판단 transition | (PRD 와 동일 패턴 - 추정) |
| 자동 transition | (PRD 와 동일 패턴 - 추정) |
| Fan-out | `split` 결과의 LLD scope list 에 따라 1+ LLD Task 생성 |
| Approver role | **개발자** |
| Author 종류 | AI 단독 (추정) |
| revise loop | `[TBD]` |

---

## 3. LLD

| 필드 | 값 |
| --- | --- |
| Input | 승인된 HLD 의 한 scope |
| 산출물 type | markdown |
| 산출물 위치 | `[TBD]` — HLD 위치와 동일? Service 의 repo 안? |
| Default Job sequence | `generate` → `quality` → (사람) → `revise`* → ... → (사람 승인) → (next?) |
| 사람 판단 transition | (PRD 와 동일 패턴 - 추정) |
| 자동 transition | (PRD 와 동일 패턴 - 추정) |
| Fan-out | ❓ 확인: 1 LLD → **1 Spec** 인가, **여러 Spec** 인가? `[TBD]` |
| Approver role | **개발자** |
| Author 종류 | AI 단독 (추정) |
| revise loop | `[TBD]` |

---

## 4. Spec

| 필드 | 값 |
| --- | --- |
| Input | 승인된 LLD |
| 산출물 type | markdown (machine-readable spec — code 생성 가능 수준) |
| 산출물 위치 | `[TBD]` — be-repo `/specs/` ? 또는 LLD 와 같은 위치? |
| Default Job sequence | `generate` → `quality` → (사람) → `revise`* → ... → (사람 승인) → (next: code) |
| 사람 판단 transition | (PRD 와 동일 패턴 - 추정) |
| 자동 transition | (PRD 와 동일 패턴 - 추정) |
| Fan-out | ❓ 확인: 1 Spec → 1 PR 인가, **여러 Spec 묶음 → 1 PR** 인가? `[TBD]` |
| Approver role | **개발자** |
| Author 종류 | AI 단독 (추정) |
| revise loop | `[TBD]` |

---

## 5. Code (코딩)

> ⚠️ **이 단계가 산출물 type 변화 (markdown → code+tests) 의 첫 지점.** 같은 골격이 들어맞는지 stress-test 핵심.

| 필드 | 값 |
| --- | --- |
| Input | 승인된 Spec(s) |
| 산출물 type | **code + tests** (markdown 아님) |
| 산출물 위치 | **be-repo / fe-repo 의 feature branch** (req.md 14-15행) |
| Default Job sequence | `[TBD]` (추정: `generate_code` → `run_tests` → `open_pr` → `address_review`* → `merge`) |
| 사람 판단 transition | ❓ 확인: PRD/HLD/LLD 의 "승인대기/수정요청" 패턴 그대로? 또는 PR review 라는 다른 메커니즘? `[TBD]` |
| 자동 transition | tests 자동 실행 (추정) |
| Fan-out | 보통 1 PR (추정), 또는 fan-in (여러 Spec → 1 PR)? `[TBD]` |
| Approver role | **개발자 (리뷰어)** |
| Author 종류 | ❓ 확인: **AI 단독 / AI + 사람 hybrid / 사람 단독** — 어느 모델? `[TBD]` |
| revise loop | PR review comment 마다 새 commit → 같은 패턴? `[TBD]` |

### Code task 의 특이 사항 (논의 필요)
- ❓ **PR open/merge 가 Jira transition 인가, git/GitHub event 인가**?
  - PR open = "리뷰대기", merge = "구현완료" 같이 Jira status 로 표현?
  - 또는 GitHub PR state 자체가 SSOT 이고 Jira 는 mirror?
- ❓ **테스트 실패 시 처리** — code Job 안의 sub-step 으로 실패가 새 `address_test_failure` Job 을 만드나? 또는 PR review 와 동일 처리?
- ❓ **revise 의 단위** — Spec 자체를 revise (위 단계로 되돌림) vs code 만 수정?

---

## 6. Test (QA)

> ❓ **이 단계가 정말 별도 Task 인가, 또는 Code task 의 sub-step 인가?**

| 필드 | 값 |
| --- | --- |
| Input | merged code + 테스트 케이스 |
| 산출물 type | 테스트 케이스 (코드) + 실행 결과 (보고서) |
| 산출물 위치 | be-repo `/tests/` + Jira (결과 요약) |
| Default Job sequence | `[TBD]` (추정: `tc_draft` (Spec 기반) → `tc_review` → (사람) → `tc_finalize` → `run_tc` → `qa_signoff`) |
| 사람 판단 transition | ❓ 확인: QA 단독 검토? 또는 PRD 처럼 quality job + 사람 승인? `[TBD]` |
| 자동 transition | tc 실행 자동 (추정) |
| Fan-out | — (단일 task) |
| Approver role | **QA** |
| Author 종류 | ❓ 확인: tc 작성을 AI 가 Spec 보고 draft → QA 가 finalize 패턴? `[TBD]` |
| revise loop | tc 실행 실패 → 어디서 다시 시작? code? spec? `[TBD]` |

### Test task 의 특이 사항 (논의 필요)
- ❓ **QA 가 시작되는 시점** — code merge 전? merge 후? PR 안에 QA 까지 포함?
- ❓ **회귀 테스트 / 통합 테스트 의 위치** — Test task 안? 별도 task? CI 의 책임?

---

## 7. Deploy (배포)

| 필드 | 값 |
| --- | --- |
| Input | 승인된 release / merged code |
| 산출물 type | **배포 결과** (성공 / 실패 / 부분 성공) |
| 산출물 위치 | 외부 CD 시스템 (k8s / infra 등) + Jira (결과 요약) |
| Default Job sequence | `[TBD]` (추정: `prepare_release` → `run_pipeline` → `verify` → `notify`) |
| 사람 판단 transition | ❓ 확인: 배포 시작 자체에 사람 승인 필요? 자동? `[TBD]` |
| 자동 transition | pipeline 자동 실행 (추정) |
| Fan-out | — |
| Approver role | **운영자** |
| Author 종류 | ❓ 확인: AI 가 pipeline 트리거? 운영자만? `[TBD]` |
| revise loop | 배포 실패 → rollback? 재시도? `[TBD]` |

### Deploy task 의 특이 사항 (논의 필요)
- ❓ **배포 환경 분리** (dev / staging / prod) — 각각 별도 task? 하나의 task 의 sub-step?
- ❓ **롤백** — 별도 task? Deploy task 의 새 인스턴스?
- ❓ **외부 CD 시스템 연동** — Argo / Spinnaker / GitHub Actions 등 — Workflow 가 직접? 또는 CD 자체에 맡김?

---

## 단계 간 hand-off

> Task 가 종료될 때 다음 Task 가 어떻게 만들어지는지의 정확한 모양.

| 종료 Task | hand-off 메커니즘 | 다음 Task |
| --- | --- | --- |
| PRD | `routing` Job 의 output `next_task_types` 에 따라 Spawn rule 적용 | HLD 또는 LLD 또는 Spec (분류에 따라) |
| HLD | `split` Job 의 output `lld_scopes[]` 마다 Spawn | LLD x N |
| LLD | `[TBD]` Spec 으로 자동? 또는 명시적 분리 Job? | Spec (1 또는 N) |
| Spec | `[TBD]` Code 로 자동? 또는 묶음 단위 결정 Job? | Code (1 또는 N) |
| Code (merge) | `[TBD]` Test 로 자동? 또는 PR merge = code task 종료 + test task 시작? | Test |
| Test (QA pass) | `[TBD]` Deploy 로 자동? 또는 사람 trigger? | Deploy |
| Deploy | Terminal — workflow run completed | — |

---

## 공통 / 특화 분석 (단계별 표 완료 후 작성)

> 위 표가 채워진 후, 각 행을 비교하여 다음을 추출.

### 모든 단계 공통 (= 골격 = 코드)

후보 (단계별 표 완료 시 검증):
- `[추정]` Job atomic, 재시도 = 새 Job 인스턴스
- `[추정]` Job 결과 → 위로 전달 (Task → Workflow), 자체 transition 안 함
- `[추정]` Outbound mapping (Job 결과 → Jira) 의 메커니즘은 모든 task type 동일
- `[추정]` Inbound mapping (Jira event → 다음 Job) 의 메커니즘 동일
- `[추정]` revise loop 의 구조 (사람 feedback → 새 Job 인스턴스) 동일
- `[추정]` Document version = git commit, atomicity = push 까지
- `[추정]` Spawn rule 의 메커니즘 (이전 Job output 에서 child task spec 추출) 동일

### Task type 별 특화 (= Strategy YAML 데이터)

후보 (단계별 표 완료 시 검증):
- Job sequence 의 정확한 순서
- 각 Job 의 prompt / skill / output schema (Type A + Type B)
- Outbound mapping 의 정확한 Jira status / comment 포맷
- Inbound mapping 의 정확한 trigger
- Spawn rule 의 input → child task spec 변환 로직
- Fan-out 의 모양 (1→1 / 1→N / N→1)
- Approver role
- 산출물 type 별 commit / publish 로직 (markdown vs code vs test result)

### 골격이 안 맞을 가능성 (= 모델 재설계 후보)

후보 (가설, 검증 필요):
- **산출물 type 변화** (Code 의 code+test, Deploy 의 배포결과) 가 같은 commit-per-version 모델에 들어맞나?
- **PR review 의 cycle** 이 PRD revise 의 cycle 과 같은 모양인가? (PR 은 inline comment 들, PRD 는 ticket comment 들 — 데이터 구조 다름)
- **Deploy 의 외부 CD 연동** 이 Skill 패턴에 들어맞나? (CD 트리거는 AI 가 아니라 시스템 트리거)
- **Test 의 사람 개입** 시점이 다른 단계와 다른 모양인가?

---

## 미해결 결정 (전체 분석 진행 중 결정 필요)

각 ❓ 항목 + 추가로:
- 한 task 의 in-flight Job 이 fail 했을 때 자동 재시도 정책 (= 새 Job 인스턴스 자동 생성?)
- Workflow restart 시 in-flight 회복 알고리즘
- Revise 의 cardinality limit
- M0 의 범위 (이 분석 완료 후 자연스럽게 결정)
