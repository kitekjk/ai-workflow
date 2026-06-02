# Session State — 2026-06-02

## Session 목적

진행 중이던 계획을 **원점부터 재검토**. 핵심 질문: "중요한 도메인 작업은 AI(별도 스킬)가 처리하고
그 스킬이 wiki·git 쓰기까지 한다면, workflow 앱은 더 단순해지지 않나?" → **그렇다.** 경계를 재정의하고
**M0 최소 빌드 spec** 한 장으로 증류했다.

## 이번 세션 결과 (한 줄 요약)

**앱 = Jira-reactor + 스케줄러 + 러너. git/wiki/PR 은 스킬이 소유, 앱은 ref 를 불투명 메타로 보관·표시(클릭-이동)만.**
빠른 최소 개발이 목표 — 리스크(특히 bare claim)는 의식적으로 수용하고 운영하며 개선.

## 이번 세션 산출물 (커밋)

| commit | 내용 |
| --- | --- |
| `9084e06` | [boundary-design.md](superpowers/specs/2026-06-02-skill-owned-writes-boundary-design.md) — 경계 재설계 D1~D5 + §3 컴포넌트 축소 + invariant 트레이드오프 |
| `191e537` | 같은 문서 §6 — 앱↔스킬 계약 표면(JobSpec/envelope, 불투명 ref) |
| `4e4e355` | 위 §6 보강(refs-as-metadata, 클릭-이동) + [m0-minimal-spec.md](superpowers/specs/2026-06-02-workflow-app-m0-minimal-spec.md) 신규 |

## 이번 세션 결정 로그

| # | 결정 | 근거 |
| --- | --- | --- |
| **D1** | 스킬이 **모든 외부 쓰기** 소유 (도메인 산출물 + git commit/push + wiki publish + PR open/comment) | 작업과 영속화를 한 곳에 → contract 안 끊김 |
| **D2** | 앱이 **흐름** 소유 (Jira 상태/코멘트 양방향, 결과→상태 매핑, 결과→다음작업 결정, 스케줄링, 러닝) | 결정성·감사 가시성 부분은 앱 |
| **D3** | 스킬은 *후보* 다음작업 리스트만, **순차 vs fan-out 은 앱(Orchestrator)** 결정 | cross-task 오케스트레이션은 앱 first-class. 스킬은 cross-task 모름 |
| **D4** | **bare envelope 신뢰** — 앱은 ref 의 *모양*만 schema 검증, git/wiki read 안 함 | 최대 단순화. 위험은 스킬 정확성+QA 로 |
| **D5** | `meta.output_location` **스킬로 이동** (앱은 envelope ref 만 수신) | 쓰기를 스킬이 하니 위치도 스킬 |
| **(추가)** | 앱은 **artifact-store-agnostic** — git/wiki/PR 이 앱 어휘에 없음. 경계 넘는 건 **불투명 ref** 뿐 | 사용자 교정: job 내부/ git 은 앱 관심사 아님 |
| **(추가)** | 단, **wiki url·git repo+commit 은 메타정보로 저장 + UI 클릭-이동**. "관리"=저장+표시, read/write/verify 아님 | 사용자 요구 — 충돌 없음, §6 의 `refs[]` 가 그대로 충족 |

### §3 6 컴포넌트 → 개정 후
- EventHandler / Orchestrator / Inbound Dispatcher: **유지**
- Outbound Dispatcher: **Jira 전용으로 축소** (wiki/git/PR 제거)
- JobSpecBuilder+Validator: **단순화** (통합 코드가 스킬로, Validator 는 envelope shape 검증만)
- Runner: **축소** (git/wiki/PR 코드 제거, AI 호출 + envelope relay)
- **가장 큰 코드 감소**: 앱이 wiki+git+PR 통합 코드 전체를 들어냄

### Invariant 트레이드오프 (의식적 수용)
- **I-7/I-8** (push=success, verify-on-write): 앱 강제력 상실 → 스킬+QA
- **P-2/I-21** 분화: Jira 는 외부 SSOT 유지, git/wiki ref 는 앱 DB cached 값이 권위
- **P-5** 유지: envelope domain_output 의 *모양*은 검증, ref 외부 실재는 아님

## 앱↔스킬 계약 (확정)

- **JobSpec (앱→스킬)**: `{ job_type, inline_inputs(피드백 등), input_refs[](불투명 passthrough) }`
- **envelope (스킬→앱)**: `{ domain_output(요약+판단값 예 score), refs[]{system,key,url,label?}(불투명), next_task_candidates? }`
- **입력 계약**: 문서=git ref(스킬이 읽음), 사람 피드백=inline(앱이 webhook 으로 받음). **앱은 문서 내용 무보유**(F11 차단).
- 스킬 내부(프롬프트, git/wiki 사용법, permissions)는 스킬 패키지 self-contained — 이 spec 무관.

## M0 범위 (m0-minimal-spec.md)

- **M0**: PRD 한 사이클 — `intake → generate → quality → (사람 승인) → routing`. PRD type 1개.
- **M0 밖**: HLD/LLD/Spec/Code/TC/QA/Deploy, revise 루프, back-edge, fan-out 다수, restart 강화, dedupe, envelope 진위검증, dashboard, RBAC, managed runner.
- Entity 3개(WorkflowRun/Task/Job, Task.refs 에 메타 누적), React 루프, Strategy 2파일(`prd.yaml`+`_common.yaml`), 컴포넌트 6개(Outbound=Jira전용, Runner=git코드없음).
- **통과 기준**: PRD 자동 진행 + 승인 후 routing + ref 클릭-이동 + F7/F11 구조적 차단.

## 미완 / 다음 결정 (순서)

1. **M0 spec 사용자 리뷰** — 아직 명시적 승인 전. 손볼 곳 확인.
2. 그 다음 갈래(택1):
   - **DB schema** (entity 3개 → 테이블) 별도 spec
   - **HTTP API surface** 별도 spec
   - 바로 **구현 계획**(`writing-plans` skill)으로 → 빌드 시작
3. (보류) §3/§4 본문 개정 — Outbound Jira-only화, Runner git 제거, output_location 삭제, envelope refs[] 반영. *사고 기록으로 남겨도 무방, 빌드 기준은 M0 spec.*
4. (보류) ADR 0001-strategy-data-code-boundary (2026-05-28 세션에서 제안, 미작성).

## 미해결 항목

- Jira comment 정확한 wording, status/transition 문자열 = 실 Jira config 의존(데이터라 나중).
- M0 acceptance bar 세부, Service Registry, marketplace 형태 등 — 기존대로 미정.

## 다음 세션 시작 프롬프트 (사용자용)

```text
이전 세션 (docs/session-state-2026-06-02.md) 이어서.
workflow 앱을 "최소 스펙으로 빠르게" 만드는 방향으로 재정의 완료.
기준 문서 = docs/superpowers/specs/2026-06-02-workflow-app-m0-minimal-spec.md.

먼저 이 M0 spec 을 리뷰해서 손볼 곳 있으면 고치고,
괜찮으면 다음 중 하나로 진행: (a) DB schema spec, (b) HTTP API spec,
(c) 바로 writing-plans 로 구현 계획.
앱은 Jira-reactor + 스케줄러 + 러너. git/wiki/PR 은 스킬 소유, 앱은 ref 불투명 메타 보관·표시만.
```

## 다른 컴퓨터에서 시작하기 전 체크리스트

1. `git pull` (branch `worktree-rebuild-prd` — 이 세션 push 완료).
2. IDE 에서 열기:
   - `docs/superpowers/specs/2026-06-02-workflow-app-m0-minimal-spec.md` (**빌드 기준, 본체**)
   - `docs/superpowers/specs/2026-06-02-skill-owned-writes-boundary-design.md` (경계 결정 근거)
   - `docs/superpowers/specs/2026-05-27-workflow-architecture.md` (§3/§4 상세 사고 기록)
   - `docs/session-state-2026-06-02.md` (이 파일)
3. 위 시작 프롬프트로 이어서 진행.
