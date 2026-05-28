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
| revise loop | **I-5' 따름정리: 무제한** (사람이 "재시도요청" 안 하면 멈춤). 비용/품질 escalation 은 Strategy outbound mapping 로 표현. |

---

## 2. HLD

| 필드 | 값 |
| --- | --- |
| Input | 승인된 PRD + 영향 Services 의 repos (Routing 이 식별한 service list) |
| 산출물 type | markdown (+ 선택적 다이어그램?) |
| 산출물 위치 | prd 와 hld는 1:1 이라서 be-repo 에 저장 |
| Default Job sequence | `generate` → `quality` → (사람) → `revise`* → ... → (사람 승인) → `split` (LLD 쪼개기) |
| 사람 판단 transition | (PRD 와 동일 패턴 - 추정) |
| 자동 transition | (PRD 와 동일 패턴 - 추정) |
| Fan-out | `split` 결과의 LLD scope list 에 따라 1+ LLD Task 생성 |
| Approver role | **개발자** |
| Author 종류 | AI 단독 (추정) |
| revise loop | **I-5' 따름정리: 무제한** (PRD 와 동일 패턴). |

---

## 3. LLD

| 필드 | 값 |
| --- | --- |
| Input | 승인된 HLD 의 한 scope |
| 산출물 type | markdown |
| 산출물 위치 | be, fe 에 따라 be-repo, fe-repo 선정 |
| Default Job sequence | `generate` → `quality` → (사람) → `revise`* → ... → (사람 승인) → (next?) |
| 사람 판단 transition | (PRD 와 동일 패턴 - 추정) |
| 자동 transition | (PRD 와 동일 패턴 - 추정) |
| Fan-out | 안함, 1 개의 lld는 1개의 spec용 task와 연결 |
| Approver role | **개발자** |
| Author 종류 | AI 단독 (추정) |
| revise loop | **I-5' 따름정리: 무제한** (PRD 와 동일 패턴). |

---

## 4. Spec

| 필드 | 값 |
| --- | --- |
| Input | 승인된 LLD |
| 산출물 type | markdown (machine-readable spec — code 생성 가능 수준) |
| 산출물 위치 | LLD 와 같은 repo 하지만 폴더는 specs |
| Default Job sequence | `generate` → `quality` → (사람) → `revise`* → ... → (사람 승인) → (next: code) |
| 사람 판단 transition | (PRD 와 동일 패턴 - 추정) |
| 자동 transition | (PRD 와 동일 패턴 - 추정) |
| Fan-out | 1 PR |
| Approver role | **개발자** |
| Author 종류 | AI 단독 (추정) |
| revise loop | **I-5' 따름정리: 무제한** (PRD 와 동일 패턴). |

---

## 5. Code (코딩)

> ⚠️ **이 단계가 산출물 type 변화 (markdown → code+tests) 의 첫 지점.** 같은 골격이 들어맞는지 stress-test 핵심.

| 필드 | 값 |
| --- | --- |
| Input | 승인된 Spec(s) |
| 산출물 type | **code + tests** (markdown 아님) |
| 산출물 위치 | **be-repo / fe-repo 의 feature branch** (req.md 14-15행) |
| Default Job sequence | `generate_code and test` → `open_pr` → `address_review`* → `merge`) |
| 사람 판단 transition | PR review 라는 다른 메커니즘 |
| 자동 transition | tests 자동 실행 (추정) |
| Fan-out | 1 PR |
| Approver role | **개발자 (리뷰어)** |
| Author 종류 |  **AI 단독 |
| revise loop | PR review comment 마다 새 commit  |

### Code task 의 특이 사항 (확정)
- **PR open/merge 의 SSOT (I-18 확정)**: **GitHub PR state 가 진행 SSOT**. workflow App 은 GitHub webhook (PR merge 등) 로 직접 react. Jira ticket 의 status 변화는 GitHub-Jira integration 의 부수 효과 — workflow App 이 set 안 함. Code task 의 Jira ticket 은 audit / Runner assignee 매칭용.
- **PR title contract (I-19 확정)**: PR title 에 **Jira ticket key 포함 강제** (GitHub-Jira integration auto-sync trigger). Strategy YAML 의 PR title template + Type B schema 가 강제. 위반 = Job 실패.
- **테스트 실패 시 처리**: code 단계의 test 는 unit test 이므로 generate+test 가 한 atomic job. 테스트 실패 시 같은 job 안에서 코드 수정 같이 진행.
- **revise 의 LLD/Spec 되돌림 (확정)**: PR review 에서 "이건 LLD 가 잘못됨" 류의 코멘트 → **back-edge 메커니즘 (I-15 와 동일)**. AI 가 Bug 티켓 + Jira issue link 자동 생성 → 사람 (개발자) confirm/수정 → 영향 task "재시도요청" transition → 새 revise Job. QA back-edge 와 통일 모델.

---

## 6. TC (Test Case 작성 task)

> **fan-in 의 첫 등장 지점.** N 개 Code task 가 모두 terminal 도달 시 Workflow Run 이 sync gate 로 이 task 를 1 개 spawn.
> **분기 결정 지점.** 첫 job `analyze_change` 가 실제 merged 코드 변경을 분석하여 `qa_required` 를 판정. 그 결과로 다음이 QA 인지 Deploy 인지가 갈림 (I-16).

| 필드 | 값 |
| --- | --- |
| Input | 모든 merged Code (PR diff) + PRD (AC 섹션 포함) + Spec(s) |
| 산출물 type | markdown (TC 명세) — `qa_required=false` 면 산출물 없음 (분석 결과만) |
| 산출물 위치 | **fe-repo** `/tests/` 또는 `/qa/tc/{prd-key}.md` (TC 작성 시) |
| Default Job sequence | `analyze_change` → (분기)<br>• `qa_required=true` → `tc_generate` → `quality` → `revise`* → `quality` → (사람 승인) → 종료<br>• `qa_required=false` → 사람 승인 (또는 자동 승인) → 종료 |
| 사람 판단 transition | (qa_required=true) PRD 와 동일 패턴: `승인대기` → `승인` / `수정요청` → `재시도요청` |
| 자동 transition | `analyze_change` 종료 → 분기. `tc_generate` 종료 → `quality` 자동. quality 결과로 Jira outbound. |
| Fan-out | **1 : 1 분기** — `qa_required=true` → QA task 1 개 / `qa_required=false` → Deploy task 1 개 (TC 자체 산출물도 skip) |
| Approver role | **QA** (qa_required=true) / **개발자** (qa_required=false 의 분석 결과 confirm) |
| Author 종류 | AI 단독 (사람은 feedback 만) |
| revise loop | **I-5' 따름정리: 무제한** (PRD 와 동일 패턴). |

### TC task 의 특이 사항

- `analyze_change` 의 input 은 **모든 merged PR diff + PRD AC 섹션**. 화면 영향 여부 판단의 SSOT 는 실제 코드.
- `qa_required=false` 케이스에서 TC 작성을 skip 하는 이유 = token 낭비 방지 + workflow 단순화.
- AC (Acceptance Criteria) 는 PRD 의 한 섹션으로 존재 (workflow 별도 관리 X). TC 생성 job 의 rubric 에 "AC cover 율" 포함.

---

## 7. QA (QA 수행 task)

> **back-edge 의 첫 등장 지점.** 버그 발견 시 영향 LLD/Spec/Code task 의 **새 revise Job** 으로 표현 (I-15).
> **lifecycle** = 모든 버그 fix 까지 open.

| 필드 | 값 |
| --- | --- |
| Input | 승인된 TC + merged code + 영향 fe 화면 / API |
| 산출물 type | QA 실행 보고서 (markdown) + N 개 버그 티켓 (Jira) |
| 산출물 위치 | fe-repo `/qa/reports/{prd-key}/{run-n}.md` + Jira (버그 티켓들) |
| Default Job sequence | `run_qa` → (버그 발견 시) `file_bug_tickets` → **back-edge: 영향 LLD/Spec/Code 의 새 revise Job 트리거** → (모든 fix 완료 대기) → `run_qa` (재실행) → ... → 버그 없음 → 사람 (QA) 승인 → 종료 |
| 사람 판단 transition | (1) 사람이 버그 검토 후 코멘트로 수정 방안 명시 → 이게 영향 task 의 revise Job input 이 됨. (2) 모든 버그 close 후 QA 가 "QA 승인" transition → Deploy task spawn. |
| 자동 transition | `run_qa` 종료 후 결과로 분기. 영향 task 들이 모두 terminal 도달 시 QA `run_qa` 자동 재실행. |
| Fan-out | **1 : N back-edge** (버그마다 영향 task 의 새 revise Job) + **1 : 1 순방향** (QA 승인 시 Deploy spawn) |
| Approver role | **QA** |
| Author 종류 | AI + 사람 hybrid — AI 가 자동 QA / 사람 (QA) 가 수동 검증 + 버그 검토 |
| revise loop | **I-5' 따름정리: 무제한** (`run_qa` ↔ 버그 fix 사이클이 모든 버그 해소 + QA 승인까지 반복) |

### QA task 의 특이 사항 (확정)

- **버그 티켓 Jira type**: **Bug** (CONTEXT.md Jira Ticket Type 매핑 참조).
- **버그 티켓 ↔ 영향 task 매핑**: **Jira issue link** (예: `is caused by` / `blocks`). AI 가 자동 생성, 사람이 confirm/수정.
- **묶음 처리**: **1 bug = 1 revise Job** (N 버그 = N revise Job). 같은 task 의 N Job 은 **순차 실행** (I-20) — git conflict 회피 + 직전 fix 결과를 다음 Job context 로.
- **trigger 메커니즘 (I-15 확정)**: QA AI 가 의심 사항 자동 Bug 티켓 생성 + 후보 영향 task 자동 Jira link → 사람 (QA) confirm/수정 + 수정 방안 코멘트 → 영향 task 의 **"재시도요청" transition** 이 trigger → 새 revise Job 의 input 에 Bug 티켓 코멘트 포함. Code back-channel 도 동일 메커니즘.

---

## 8. Deploy (배포 task)

> **Action-only pattern.** quality / revise 없음. Workflow 가 Jira 티켓만 만들고, 실제 배포 / 환경 / 롤백 / CD 연동은 workflow scope 밖 (사람 + 외부 시스템).

| 필드 | 값 |
| --- | --- |
| Input | QA 승인 또는 `qa_required=false` 의 TC task 종료 |
| 산출물 type | Jira 배포 티켓 1 개 |
| 산출물 위치 | Jira (별도 git 산출물 없음) |
| Default Job sequence | `create_deploy_ticket` (Jira status = "배포대기") → 종료 (in-progress 상태로 사람 transition 대기) |
| 사람 판단 transition | 사람이 외부 CD 로 실제 배포 후 Jira "완료" 수동 transition → hook → workflow run completed |
| 자동 transition | `create_deploy_ticket` 후 task = pending-human (작업 없음). Jira "완료" hook 수신 시 workflow run terminal. |
| Fan-out | — (terminal) |
| Approver role | **운영자** (배포 실행자) |
| Author 종류 | AI 가 티켓만 생성, 실제 배포 = 사람 |
| revise loop | 없음 (action-only) |

### Deploy task 의 특이 사항

- 배포 정책은 아직 확정되지 않음 (M0+ 범위 밖). 환경 분리 (dev/staging/prod) / 롤백 / 외부 CD 연동은 모두 workflow 밖.
- 향후 정책 확정 시 task pattern 이 변경될 수 있음 (action-only → 더 복잡한 패턴).

---

## 단계 간 hand-off

> Task 가 종료될 때 다음 Task 가 어떻게 만들어지는지의 정확한 모양.

| 종료 Task | hand-off 메커니즘 | 다음 Task |
| --- | --- | --- |
| PRD | `routing` Job 의 output `next_task_types` 에 따라 Spawn rule 적용 | HLD (1 : 1, 또는 HLD skip 시 LLD/Spec) |
| HLD | `split` Job 의 output `lld_scopes[]` 마다 Spawn | LLD x N |
| LLD | LLD task 승인 시 Spec task 1 개 자동 spawn | Spec x 1 |
| Spec | Spec task 승인 시 Code task 1 개 자동 spawn (1 Spec = 1 PR) | Code x 1 |
| Code (PR merge) | **Workflow Run 이 sync gate owner**. 모든 Code task 가 terminal 도달 시 TC task 1 개 spawn (N→1 fan-in, I-14). | TC x 1 |
| TC | `analyze_change` job output `qa_required` 가 분기. true → QA spawn, false → Deploy spawn (TC 작성 자체도 skip 가능, I-16). | QA 또는 Deploy |
| QA | QA 가 모든 버그 해소 후 사람 (QA) "승인" transition → Deploy task spawn. 버그 발견 시 영향 LLD/Spec/Code 의 새 revise Job (back-edge, I-15). | Deploy |
| Deploy | Jira 티켓 "배포대기" 생성 → 사람 외부 CD 배포 → Jira 수동 "완료" → hook → workflow run completed (I-17). | — terminal |

---

## 공통 / 특화 분석 (확정)

> **갱신 (2026-05-27)**: 아래 분석은 4 패턴 (P1~P4) 을 별개로 본 stress-test 다. 후속 grilling 에서 **이 4 패턴이 1 패턴 + 4 axis 의 변이** 임이 확인되어 통합 단순화됨 (A/B/C). 최신 모델은 `2026-05-27-workflow-architecture.md` + CONTEXT.md `## Task Pattern — 1 패턴 + 4 axis`. 아래 표는 그 통합으로 이어진 원 분석으로 보존.
>
> 4 task pattern (P1 Document / P2 Code / P3 QA / P4 Action-only) 의 stress-test 결과. 골격이 모든 패턴을 cover 가능함을 확인.

### 패턴별 lifecycle 비교

| dimension | P1 Document | P2 Code | P3 QA | P4 Action-only |
| --- | --- | --- | --- | --- |
| Job sequence 모양 | generate → quality → (revise→quality)* → 종료 | gen+test → open_pr → review* → merge | run_qa → (fan-out bug) → run_qa* → 종료 | create_ticket → 종료 |
| Quality job 존재? | ✅ | ❌ (test pass = 품질) | ❌ (사람 검토) | ❌ |
| 사람-판단 transition source | Jira event | **GitHub event** | Jira event | Jira event |
| revise loop trigger | 사람 "재시도요청" | PR review comment / back-edge | 새 버그 발견 + back-edge | 없음 |
| fan-out 방향 | 순방향 | 순방향 (TC fan-in) | **역방향 (back-edge)** + 순방향 | 없음 |
| 산출물 type | markdown | code + tests | QA 보고서 + Bug 티켓 | Jira 티켓 |
| 산출물 SSOT | git commit | git commit (PR merged) | git commit + Jira (Bug) | Jira (ticket) |
| terminal trigger | 사람 "승인" | PR merge | 사람 (QA) "승인" | 사람 "완료" |
| Approver | Strategy 별 | 리뷰어 | QA | 운영자 |

### 모든 패턴 공통 (= 골격 = 코드 책임)

골격이 cover 해야 할 4 컴포넌트:

1. **Task State Machine**
   - task 단위 lifecycle: Job spawn → Job 결과 → 다음 Job 결정 → terminal
   - Job atomic (I-6), git push 까지 = success (I-7)
   - Task assignee = Jira ticket assignee (I-9)
   - in-flight Job pending-unassigned 표시 (I-9)
   - 같은 task 의 N 개 revise Job 순차 실행 (I-20)
2. **Workflow Run Orchestrator**
   - 순방향 fan-out (1→N): Strategy L5 Spawn rules
   - 역방향 back-edge: Bug 티켓 생성 + Jira link + 영향 task transition trigger (I-15)
   - N→1 fan-in: workflow run sync gate (I-14)
   - restart recovery: verify-on-startup + push-or-fail + dedupe by hash (I-21)
3. **Outbound Dispatcher**
   - Job result → 외부 시스템 (Jira/GitHub/etc) action
   - Strategy L2 outbound mapping 따름
   - I-19 (PR title contract 같은 schema) 강제
4. **Inbound Dispatcher**
   - 외부 event normalization (Jira event / GitHub event / etc — I-5 일반화)
   - Strategy L3 inbound mapping lookup → 적절한 task/job event
   - source-agnostic

+ **Skill 합성** (Type A domain + Type B integration schema) 후 Runner 에 전달, output schema validation (실패 = Job 실패)

### Task type 별 특화 (= Strategy YAML 데이터, 5 layer)

| Layer | 내용 |
| --- | --- |
| **L1 Job sequence skeleton** | default job 순서, branch 표현 (TC `qa_required`, QA fan-out back-edge) |
| **L2 Outbound mapping** | Job 결과 → 외부 시스템 update (Jira status / comment / GitHub PR / Jira ticket 생성), template/threshold/format |
| **L3 Inbound mapping** | 외부 event → 다음 Job (Jira transition name, GitHub event, back-edge transition) |
| **L4 Job spec** | 각 Job 의 Type A skill 이름 + Type B output schema + I/O contract |
| **L5 Spawn rules** | child task 생성 규칙 (fan-out / fan-in 대기 / 분기) |

+ **추가 데이터**:
- **Task pattern flag** (P1/P2/P3/P4): 골격이 패턴별 동작 분기 (예: P1 = quality+승인 wait, P2 = PR webhook react, P3 = back-edge orchestration, P4 = 사람 transition wait)
- **Approver role** (운영자/기획자/개발자/QA)
- **산출물 위치 template** (`be-repo/docs/hld/{prd-key}.md` 등)
- **Strategy YAML schema version** (I-23) — M0 는 `version: 1`

### 패턴 안 변이의 처리

- **P1 안의 TC**: 첫 job `analyze_change` 가 `qa_required` 분기. P1 의 변이가 아니라 L1 (job sequence) 의 `on_output_branch` rule 로 표현 가능.
- **P3 의 Bug auto-close**: QA task 가 매 run 마다 open Bug 의 TC 들을 재실행. 통과 시 Bug 자동 close (Outbound Dispatcher 가 set), 재실패 시 reopen (I-22). 이것도 L2 outbound mapping 데이터로 표현.

### 검증 결과

✅ **4 패턴 모두 위 4 골격 컴포넌트 + Strategy 5 layer + 추가 데이터로 표현 가능.** 모델 재설계 불필요.

---

## 다음 결정 (M0 acceptance bar)

위 분석 완료 → 다음은 **M0 의 범위** 결정.

후보:
- M0 = cycle 1 happy path (PRD 1 → HLD 1 → LLD 1 → Spec 1 → Code 1 → TC 1 → QA pass → Deploy 1, 모두 1 회 통과)
- M0 = + back-edge 1 회 (revise loop 와 QA Bug 1 개라도 검증)
- M0 = + fan-out 1 회 (1 PRD → N LLD 검증)

다음 grilling 에서 결정.
