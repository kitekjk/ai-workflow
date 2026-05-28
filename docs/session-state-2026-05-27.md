# Session State — 2026-05-27

## Session 목적

AI Workflow 재개발 (rebuild) 의 **범용 컴포넌트 + 전략 패턴 설계** 를 grill-with-docs 세션으로 진행.
2026-05-25 세션이 도메인 모델 / SSOT / invariants 를 확정했고, 2026-05-26~27 세션이 **task pattern + fan-out tree + back-channel + 단순화 (1 패턴 + unified handler)** 까지 확정했다.

## 다음 세션에서 어디서부터 — 빠른 follow-up

1. **`CONTEXT.md`** 먼저 읽기. 도메인 glossary + invariants (I-1~I-23) + **`## Task Pattern — 1 패턴 + 4 axis`** + 골격 컴포넌트 (단일 EventHandler + Orchestrator + 2 Dispatcher).
2. **`docs/superpowers/specs/2026-05-27-workflow-architecture.md`** 가 **다음 작업의 본체**.
   - §1 Scope + 5 설계 원칙 (P-1~P-5) — 완료
   - §2 도메인 모델 (WorkflowRun / Task / Job + value objects) — 완료
   - §3 골격 컴포넌트 인터페이스 (단일 EventHandler / Orchestrator / Outbound·Inbound Dispatcher / Skill 합성) + 호출 다이어그램 — 완료
   - **§4 Strategy 데이터 schema (L4 + 메타) — 다음 작업 (placeholder 만 있음)**
   - §5 6 task type 별 예시 (handler + 메타) — placeholder
   - §6 적합성 검토 — placeholder
3. **`docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md`** = 요구사항/분석 (8 task type 표 + hand-off + 공통/특화 분석). 참고용. 공통/특화 분석 절은 superseded 노트로 §27 architecture 문서를 가리킴.

## 핵심 단순화 결정 (이걸 모르면 혼란 — 반드시 숙지)

2026-05-27 grilling 에서 "왜 복잡해졌나 → essential vs accidental" 분석 후 **accidental complexity 단순화 A/B/C 적용, NOT D**:

- **A**: 과거 4 task pattern (P1 Document / P2 Code / P3 QA / P4 Action-only) → **1 패턴 + 4 axis** (generate / quality / revise-trigger / 사람-승인-source). 별도 pattern enum 없음.
- **B**: 3 handler interface → **단일 `EventHandler`** (`event = task_spawned | job_finished | external_event`).
- **C**: task-internal 로직 (과거 L1/L2/L3) → **handler 코드**. 데이터로 남는 것 = **L4 (Job I/O schema) + 메타** (approver / 위치 template / axis 값 / lookup table / schema version).
- **NOT D**: cross-task 오케스트레이션 (fan-out / fan-in sync gate / back-edge) 은 **Workflow Run Orchestrator 의 first-class 메커니즘으로 명시 유지**. essential 복잡도라 가시성 보존.

> 결정 로직 = handler/orchestrator (코드), 데이터 = L4 schema + 메타 (YAML), dispatcher 들 = type-agnostic 실행기.

## 확정 결정 요약 (커밋 순서, 자세한 내용은 CONTEXT.md)

| commit | 내용 |
| --- | --- |
| `5b0cb52` | 도메인 glossary + SSOT 분리 + I-1~I-13 |
| `e1ca842` | task pattern + fan-out tree (PRD→HLD 1:1, HLD→LLD 1:N, LLD→Spec 1:1, Spec→Code 1:1, Code→TC N:1 fan-in, TC→QA/Deploy 분기, QA→back-edge, Deploy terminal) + I-5'/I-14~I-17 |
| `7691a7e` | back-channel (QA + Code review 통일 메커니즘) + restart recovery + I-18~I-21 |
| `9a4b469` | 공통/특화 분석 + I-22 (Bug auto-close) / I-23 (schema version) |
| `586001f` | architecture 문서 §1~§3 + **단순화 A/B/C** + definition_id/별도 repo 제거 (YAGNI) |

핵심 fan-out tree:
```
PRD →(1:1)→ HLD →(1:N)→ LLD →(1:1)→ Spec →(1:1)→ Code
   →(N:1 fan-in, workflow run sync gate)→ TC
   →(analyze_change: qa_required 분기)→ QA 또는 Deploy
QA →(back-edge: Bug 티켓 + Jira link → 사람 confirm → "재시도요청")→ LLD/Spec/Code 의 새 revise Job
QA →(모든 버그 fix + QA 승인)→ Deploy
Deploy = action-only (Jira "배포대기" 생성 → 사람 외부 CD 배포 → "완료" hook → run completed)
```

## 다음 작업 (순서)

1. **§4 Strategy 데이터 schema** — L4 (Job I/O JSON schema + Type A skill 이름) + 메타 (approver / 위치 template / 4 axis 값 / schema version) + lookup tables (Outbound status·template / Inbound transition명→event type) 의 정확한 YAML 구조 정의. 작성 중 결정 필요한 부분 (axis 메타 표현 방식, schema 파일 분할 단위) 은 grilling.
2. **§5 6 task type 별 예시** — PRD/HLD/LLD/Spec/Code/QA (+ TC/Deploy 보너스) 의 handler + 메타 YAML 실제 예시.
3. **§6 적합성 검토** — 각 type 의 요구사항 (stages 문서 표) 이 §4 schema + handler 모델로 100% 표현 가능한지 줄별 점검. 불가 항목 발견 시 schema/모델 보강.
4. **M0 acceptance bar (Step D)** — 위 검증 후 결정. (참고: PRD §2.2 의 원래 M0 = PRD only. grilling 에서 전체 chain 으로 확장됨. M0 축소 대신 essential complexity 유지 + accidental 단순화로 결론. M0 범위는 §6 후 재논의.)

## 미해결 항목 (CONTEXT.md "아직 미정" + 추가)

- Jira comment 포맷 규약 (Outbound 메타 데이터)
- Service Registry 사람-편집 인터페이스 (UI / admin API / CLI)
- 사설 marketplace 구체 형태 + outage fallback
- Wiki 단방향 안내 페이지 헤더 문구
- Bug 티켓 ↔ 영향 task 매핑의 사람 confirm UX 구체
- M0 acceptance bar (§6 후 결정)

## 다음 세션 시작 프롬프트 (사용자용)

```text
/grill-with-docs

이전 세션 (docs/session-state-2026-05-27.md) 이어서.
CONTEXT.md 의 결정 + 단순화 (1 패턴 + 4 axis / 단일 EventHandler / handler 코드 + L4·메타 데이터 / fan-in·back-edge 는 Orchestrator 명시 유지) 를 전제로,
docs/superpowers/specs/2026-05-27-workflow-architecture.md 의
§4 Strategy 데이터 schema (L4 + 메타) 부터 작성하자.
작성 중 결정 필요한 부분은 한 번에 하나씩 grilling 으로 물어줘.
```

## 다른 컴퓨터에서 시작하기 전 체크리스트

1. `git pull` (branch `worktree-rebuild-prd` — origin 보다 앞서 있으면 이 머신에서 push 필요)
2. IDE 에서 열기:
   - `CONTEXT.md`
   - `docs/superpowers/specs/2026-05-27-workflow-architecture.md`
   - `docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md` (참고)
   - `docs/session-state-2026-05-27.md` (이 파일)
3. 위 시작 프롬프트로 `/grill-with-docs` 호출.
