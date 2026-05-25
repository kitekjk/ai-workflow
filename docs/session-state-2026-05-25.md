# Session State - 2026-05-25

## Session 목적

AI Workflow 재개발 (rebuild) 의 도메인 모델 / 책임 분리 / 데이터 SSOT 를 **grilling 세션** 으로 확정.
입력은 사용자의 자유 형식 메모 (`docs/req.md`) 와 1차 정제본 PRD (`docs/superpowers/specs/2026-05-25-ai-workflow-rebuild-ideas.md`). 이번 세션의 작업은 grill-with-docs 스킬로 사용자에게 한 번에 한 결정을 묻고 답을 CONTEXT.md / stages 분석 문서로 캡처하는 것.

## 다음 세션에서 어디서부터 — 빠른 follow-up

1. **`CONTEXT.md`** (repo root) 를 먼저 읽는다. 지금까지 확정된 모든 결정과 핵심 invariant (I-1 ~ I-13), SSOT 분리, 아직 미정 항목이 한 곳에 있다.
2. **`docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md`** 를 연다. 이 문서가 **다음 작업의 본체**.
   - PRD / HLD / LLD / Spec / Code / Test / Deploy 7 단계의 task/job 분석 표가 있다.
   - 각 섹션의 `[TBD]` 와 `❓ 확인:` 부분을 사용자가 직접 채우는 단계.
   - 채워진 후 § 공통/특화 분석 절을 grilling 으로 같이 채운다 → 골격 vs Strategy 데이터의 경계 박힘 → M0 범위 결정.
3. grilling 을 재개할 때 명령: **`/grill-with-docs`** + 작업 목적 ("전체 단계 분석 이어서").
4. 사용자가 이전에 정정한 **방향 전환** 기억: "M0 부터 개발하는 게 중요한 게 아니라, 먼저 전체 단계의 task/job 을 나열하고 공통/특화를 정리해야 함." → 다음 세션은 stages 분석 표 채우기가 먼저, 골격/M0 결정은 그 다음.

## 이번 세션의 산출물 (untracked, 이번 커밋에 포함)

| 파일 | 내용 |
| --- | --- |
| `CONTEXT.md` | 새 시스템의 도메인 glossary. 어휘 + SSOT + 13 개 invariant + 미정 항목. **다음 세션의 1차 참고서.** |
| `docs/req.md` | 사용자가 직접 쓴 초기 요구사항 메모 (이 세션의 1차 입력). |
| `docs/superpowers/specs/2026-05-25-ai-workflow-rebuild-ideas.md` | 1차 정제본 PRD (이 세션 시작 전 작성). 검토 결과 — 6절 도메인 모델이 후보 B 를 묵시 전제하고 있음 등 모호점 다수 발견. grilling 으로 다시 결정. |
| `docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md` | **다음 세션의 작업 대상 문서.** 7 단계의 task/job 분석 빈칸. |
| `docs/session-state-2026-05-25.md` | 이 파일. 핸드오프. |

## 확정된 결정 (요약, 자세한 내용은 CONTEXT.md)

### 도메인 모델
- **Workflow Run** = 한 source request 가 트리거한 1회 진행 단위. 자체 transition 권한 없음 — reactor.
- **Task** = workflow 안의 한 종류의 단계. type 을 가진다. **주요 Document 1 개를 1급 속성으로** 가진다.
- **Job** = Runner 가 1회 실행하는 atomic 단위. **재시도 개념 없음** — 같은 일을 다시 하려면 새 Job 인스턴스.
- **Document** = Task 의 1급 산출물 (markdown). **본문의 SSOT = Git repo commit**.
- **Strategy** = Task type 별 차이를 캡슐화한 **데이터 (workflow definition YAML)**. 코드 클래스 아님. L1 Job sequence / L2 Outbound mapping / L3 Inbound mapping / L4 Job spec / L5 Spawn rules.
- **Skill** = 두 type 분리:
  - **Type A 도메인** — 사설 marketplace SSOT, latest 사용, 결과 이상 시 skill 수정 → 재시도.
  - **Type B 통합** — Strategy YAML 의 output schema + instruction, strict 계약.
- **Service** = 비즈니스 시스템 단위 (예: SCM, 주문). repos[] 보유. SSOT = Workflow DB (약 영속, 사라져도 wiki 보고 재입력).
- **Runner** = 담당자 로컬 머신. git + AI 만 접근, DB/Jira 접근 불가. Workflow App 과의 인터페이스는 Job spec / Job result 두 JSON 메시지뿐.
- **Workflow App** = 중앙 서버. DB + Jira 접근. **외부 시스템들의 reactor + cache**, 자체 owned 영속 데이터 사실상 없음.

### SSOT 분리
| 데이터 | SSOT | 영속 강도 |
| --- | --- | --- |
| Document 본문 | **Git repo** | 강 (필수) |
| 진행 transition (사람 판단) | **Jira** | 강 (외부) |
| 사람용 view | **Wiki (Confluence)** | 강 (외부) |
| Service Registry | **Workflow DB** | 약 (휘발 가능) |
| Skill (Type A) | **사설 marketplace** | 강 (외부) |
| Strategy / Type B | **`workflow-definitions` repo** | 강 (git) |
| Job 결과 metadata | (없음) | 약 (DB full + Jira comment 요약) |
| Workflow/Task/Job in-flight | (없음) | 약 (DB, Jira+git 으로 catch-up) |

### Transition 권한 — T-relaxed
- 사람 판단 transition → Jira event 가 트리거
- 결정론적 transition → 시스템이 자동
- Quality 표준 흐름: 점수 ≥ threshold → Jira "승인대기" → 사람 "승인", 점수 < threshold → Jira "수정요청" → 사람 "재시도요청"

### Jira ticket type 매핑
- 운영 요청 = Task / PRD = Initiative / HLD = Epic / LLD = Story / Spec = Task / 그 외 = Task
- 운영 요청 ↔ PRD 는 link 로

### Job ownership (cycle 1 F8 회귀 방지)
- Job owner = Task 의 Jira assignee
- assignee 변경 시 ownership 자동 변경
- Runner 의 owner email = 자기 Jira account email

### Atomicity
- generate/revise Job 의 성공 = **git push 까지 완료** (commit only 는 in-progress)
- DB write / Jira 갱신은 Job 종료 후 Workflow App 이 처리 (별도 단계)

### Wiki publish 정책
- 모든 Document version 마다 publish (in-progress 포함)
- 사람의 wiki 직접 수정은 무시 (다음 publish 가 덮어씀). 수정 의도는 Jira comment 로만.
- Wiki publish 실패는 task 진행 차단 안 함 (retry queue)

## 아직 미정 (다음 세션에서 결정)

`CONTEXT.md` § 아직 미정 절 + `stages-task-job-analysis.md` 의 `[TBD]` / `❓ 확인:` 모음:

- **Wiki 의 정확한 영역 / 단방향 안내 페이지 헤더 문구**
- **사설 marketplace 의 구체 형태** (Claude Code custom marketplace? git registry?)
- **사설 marketplace outage 시 fallback**
- **Service Registry 의 사람-편집 인터페이스** (운영자 UI? admin endpoint?)
- **Jira comment 의 포맷 규약** (Strategy outbound mapping 데이터)
- **HLD / LLD / Spec 의 산출물 위치** (어느 repo, 어느 디렉토리)
- **Spec ↔ Code 의 fan-out/fan-in** 모양
- **Code task 의 Author 종류** (AI / hybrid / 사람)
- **PR review 가 PRD revise 패턴에 들어맞는가**
- **Test (QA) 가 별도 Task 인지 sub-step 인지**
- **Deploy 의 사람 승인 시점 / 외부 CD 연동 방식**
- **revise loop 의 cardinality limit**
- **Workflow restart 시 in-flight Job 회복 알고리즘**
- **M0 acceptance bar** (위 분석 완료 후 자연 결정)

## 다음 세션 시작 명령 (사용자용)

```text
/grill-with-docs

이전 세션 (docs/session-state-2026-05-25.md) 이어서.
CONTEXT.md 의 결정을 전제로,
docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md 의
[TBD] / ❓ 확인 항목을 grilling 으로 채워나가자.
```

## 사용자가 다른 컴퓨터에서 시작하기 전 체크리스트

1. `git pull` (`worktree-rebuild-prd` 또는 main branch — 이번 푸시 본인 확인)
2. IDE 에서 다음 파일 열기:
   - `CONTEXT.md`
   - `docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md`
   - `docs/req.md` (원래 의도 환기 용)
3. `/grill-with-docs` 호출 (위 시작 명령 참고)
