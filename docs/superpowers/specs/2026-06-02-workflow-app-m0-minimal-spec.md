# Workflow App — M0 최소 빌드 spec

> **목적**: "이거 보고 바로 짜면 되는" 한 장. M0 = PRD happy path 를 한 시스템에서 끝까지.
> 상세 사고 기록은 §3/§4([architecture](./2026-05-27-workflow-architecture.md)) + [boundary](./2026-06-02-skill-owned-writes-boundary-design.md) 참조. 이 문서는 그중 **M0 에 실제 필요한 것만** 추린다.
>
> **한 줄**: 앱 = **Jira-reactor + 스케줄러 + 러너**. git/wiki/PR 은 스킬이 소유, 앱은 ref 를 불투명 메타로 보관·표시만.
>
> **작성**: 2026-06-02

---

## 1. 범위

**M0 (이 문서)**: PRD 한 사이클이 새 시스템에서 한 번 통과.
`intake → generate → quality → (사람 승인) → routing`. PRD task type 1개만.
**quality 1회 통과 happy path 가정** — revise 없음(아래 §3 quality 실패 처리 참조).

**M0 밖 (나중)**: HLD/LLD/Spec/Code/TC/QA/Deploy type, revise 루프, back-edge, fan-out 다수,
restart recovery 강화, dedupe, envelope 진위 검증, dashboard, RBAC, managed runner.

**앱 밖 (영원히 스킬 소유)**: 도메인 작업, git/wiki/PR 쓰기·읽기, 스킬 프롬프트·permissions.

---

## 2. Entity (3개, 핵심 필드만)

**WorkflowRun**
| 필드 | 비고 |
| --- | --- |
| `id` | UUID |
| `definition_version` | `workflows/` 디렉토리 git commit hash (재현성) |
| `source_request_ref` | 운영 요청 Jira issue key |
| `status` | `running` / `completed` / `canceled` / `failed` |
| `created_at` / `completed_at` | |

**Task** — workflow 의 stage 1회
| 필드 | 비고 |
| --- | --- |
| `id` | UUID |
| `run_id` | parent |
| `parent_task_id` | 나중 fan-out 용. M0 에선 보통 null |
| `type` | `prd` (M0). handler registry 키 |
| `jira_key` | 외부 Jira issue key (사람 transition SSOT) |
| `assignee_email` | Jira assignee 동기화. Runner owner 매칭 |
| `status` | `pending` / `in_progress` / `awaiting_human` / `succeeded` / `failed` / `canceled` |
| `refs` | **메타정보 배열** `[{system,key,url,label?}]` — 스킬 envelope 에서 누적. UI 클릭-이동용. 불투명 |
| `created_at` / `terminated_at` | |

**Job** — Runner 가 1회 실행하는 atomic 단위
| 필드 | 비고 |
| --- | --- |
| `id` | UUID |
| `task_id` | parent |
| `job_type` | `generate` / `quality` / `routing` (M0). revise 는 M0+ |
| `inline_inputs` | 앱이 webhook 으로 받은 입력(피드백 등) |
| `input_refs` | 직전 산출물 포인터(불투명 passthrough) |
| `status` | `pending` / `claimed` / `in_progress` / `succeeded` / `failed` / `canceled` |
| `envelope` | 스킬 결과 `{domain_output, refs[], next_task_candidates?}`. 미실행 시 null |
| `runner_id` | claim 한 Runner |
| `started_at` / `ended_at` | |

**불변식 (M0)**: Job atomic — 재시도 = 새 Job 인스턴스. 앱은 문서 *내용*을 절대 보유하지 않음(ref 만) — F11 의 *거짓 약속 표면* 제거. 단 ref 진위는 미검증(bare claim, D4 — §6 참조). 정책은 데이터(§4), 코드에 type 분기 hardcode 금지(F7 차단).

---

## 3. React 루프 (앱의 전부)

```
[Inbound: Jira webhook]
   │
   ├─ 신규 요청 티켓(트리거 status = _common.yaml 의 trigger.new_run_status, 데이터)
   │     └→ WorkflowRun 생성 + Task(prd) 생성 → Job(generate) spawn
   │
   └─ 사람 transition (예: "승인")
         └→ inbound lookup(transition→event) → handler 처리

[Runner]  Job claim → 스킬 호출(JobSpec) → envelope 반환 → 앱이 shape 검증 + 저장

[EventHandler]  job_finished 시 outcome 판정:
   generate 완료      → Task.refs 누적 → Job(quality) spawn
   quality ≥ threshold→ Jira "승인대기"(outbound) → Task=awaiting_human (사람 대기)
   quality < threshold→ Jira "수정요청"(outbound) → Task=failed, Run=failed
                        (M0: revise 없음 — happy path 가정, 실패 시 수동 종결)
   "승인" transition   → Job(routing) spawn
   routing 완료        → next_task_candidates 를 Task.refs / Job.envelope 에 기록 → Run=completed
                        (M0: 다음 Task spawn 없음 — prd 외 handler 미존재. 후보 기록만)
```

- **결정 주체는 앱.** 스킬은 결과 + 후보만 준다. 순차/fan-out 은 앱(M0 은 fan-out 없음).
- **Jira 만 outbound.** 상태/코멘트. git/wiki/PR 없음. 스킬 envelope 의 ref `url` 은 Jira 코멘트에 클릭-이동 링크로 렌더.
- **트리거 status 는 데이터.** 어떤 Jira status 진입이 새 run 을 여는지는 `_common.yaml` `trigger:` 에서 옴 — 코드 hardcode 금지(F7 차단).

---

## 4. Strategy 데이터 (M0 = 2파일)

`workflows/definitions/_common.yaml` + `prd.yaml`. per-task-type 1파일, flat, 공유는 코드(base handler)에서.

```yaml
# prd.yaml
version: 1
type: prd
meta:
  approver_role: planner          # advisory (assignee 힌트용)
jobs:
  generate:
    skill: prd.generate
    output_schema: { type: object, required: [summary], properties: { summary: {type: string} } }
  quality:
    skill: prd.quality
    threshold: 85
    output_schema:
      type: object
      required: [score, missing_items]
      properties:
        score: { type: integer, minimum: 0, maximum: 100 }
        missing_items: { type: array, items: { type: string } }
  routing:
    skill: prd.routing
    output_schema:
      type: object
      required: [next_task_types]
      properties:
        next_task_types: { type: array, items: { enum: [hld, lld, spec] } }
```

```yaml
# _common.yaml (Document 공통 trigger/outbound/inbound, base handler 가 읽음)
trigger:
  new_run_status: "PRD 요청"   # 이 Jira status 진입 = 새 WorkflowRun. 환경 의존 값, 데이터로 (F7 차단)
outbound:
  quality_passed: [ {action: jira_status, status: "승인대기"},  {action: jira_comment, template: "품질 {score}점 — 승인 대기. {summary}"} ]
  quality_failed: [ {action: jira_status, status: "수정요청"},  {action: jira_comment, template: "품질 {score}점(기준 {threshold}). 보완: {missing_items}"} ]
inbound:
  "승인": approved          # → routing job spawn
# M0 미사용: "재시도요청"→revise 는 M0 밖(revise handler 없음). 트리거되면 no-op.
```

- `output_schema` = envelope.domain_output 의 *모양* 검증(P-5). ref 진위는 검증 안 함(bare claim).
- envelope 의 `refs[]` 도 *모양*(`{system,key,url,label?}`) 을 검증 — 단 ref 가 가리키는 외부 실재(도달성)는 검증 안 함(bare claim, D4).
- status/transition/trigger 문자열은 실제 Jira config 값 — 변경 시 코드 아닌 이 데이터만 수정(F7 차단).

---

## 5. 컴포넌트 (M0, 얇음)

| 컴포넌트 | M0 책임 |
| --- | --- |
| **Inbound Dispatcher** | Jira webhook normalize → run/task 라우팅. transition명 의미해석은 handler |
| **Task/Job State Machine + EventHandler(prd)** | registry lookup + 결과→상태 + 다음 job 결정 |
| **Orchestrator** | task terminal → 다음 task spawn / run 종료. M0 fan-out 없음 |
| **Outbound Dispatcher** | **Jira 전용**. handler 가 채운 리터럴 status/comment apply |
| **Scheduler** | 단일 로컬 러너가 pending Job 폴링. lease 만료 없음, 재시도 없음(Job atomic — 실패=수동). owner 매칭(I-9)은 단일 사용자/러너라 trivially pass |
| **Runner** | Job claim → 스킬을 AI 엔진으로 호출 → envelope relay. git/wiki/PR 코드 없음. **engine = Claude CLI**, **stdout+stderr 둘 다 캡처(F9)**, **job 당 workspace 격리(F10)**, envelope = stdout JSON |

별도 spec 으로 derive: DB schema, HTTP API surface (이 entity/루프에서 파생).

---

## 6. M0 통과 기준

1. 기획자가 Jira PRD 티켓 생성 → 앱이 PRD generate → quality → "승인대기" 까지 자동 진행.
2. 기획자가 Jira 에서 "승인" → 앱이 routing 실행 → 결과가 Jira + DB 에 일관 기록 → Run=completed.
3. 스킬이 만든 wiki/git **ref 가 Task 메타로 저장되고 Jira 코멘트에 클릭-이동 링크로 렌더**된다 (UI 는 M0 밖).
4. **F7**(정책=데이터, 코드에 type 분기 0) 가 **구조적으로** 재발 불가.
5. **F11**: 앱이 문서 내용을 보유하지 않아 *거짓 약속 표면*이 제거됨. 단 ref 진위(외부 실재)는 스킬 정확성 + 후속 QA 가 보증 — bare claim(D4) 트레이드오프이며 **앱 차원 구조적 차단은 아님**([boundary-design §5](./2026-06-02-skill-owned-writes-boundary-design.md) 참조).
