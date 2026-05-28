# Session State — 2026-05-28

## Session 목적

`grill-with-docs` 세션 이어서 — `2026-05-27-workflow-architecture.md` 의 **§4 Strategy 데이터 schema (L4 + 메타)** 를 작성. 이번 세션으로 **Step A (§1~§4) 완성**.

## 이번 세션 결과 (한 줄 요약)

§4 전체 + §2/§3 정합성 수정 완료. **데이터 = `version`/`type` + `meta` + `jobs`(L4) + `outbound`/`inbound`(lookup), Document 공통은 `_common.yaml`. 로직(sequence/branch/spawn/back-edge)은 전부 handler·orchestrator 코드.**

## 다음 세션에서 어디서부터 — 빠른 follow-up

1. **`CONTEXT.md`** 읽기 (glossary + I-1~I-23 + Task Pattern 1패턴+4axis + 골격 컴포넌트). **이번 세션에서 CONTEXT.md 변경 없음** (§4 는 전부 구현 schema → glossary-only 원칙상 미반영).
2. **`docs/superpowers/specs/2026-05-27-workflow-architecture.md`** 가 본체.
   - §1 Scope + 5 원칙 — 완료
   - §2 도메인 모델 — 완료 (이번 세션에 `Task.pattern` enum **삭제**)
   - §3 골격 컴포넌트 — 완료 (이번 세션에 §3.3/§3.4 를 **D1** 로 교정)
   - **§4 Strategy 데이터 schema — 완료 (이번 세션)**
   - **§5 6 task type 별 YAML 예시 — 다음 작업 (placeholder, = Step B)**
   - §6 적합성 검토 — placeholder (Step C)
3. **`docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md`** = 요구사항/분석 (8 task type 표). §5/§6 작성 시 줄별 대조용.

## 이번 세션 결정 로그 (§4 grilling Q1~Q6)

| Q | 결정 | 핵심 근거 |
| --- | --- | --- |
| **Q1** 파일 조직 | **per-task-type 파일** (`workflows/definitions/<type>.yaml`) + `_common.yaml` | handler registry 가 type 키 → 코드(`handlers/<type>.ts`)와 데이터 1:1. definition_version = workflows/ dir commit hash 라 파일 개수 무관. |
| **Q2** `_common` 공유 방식 | **(III) 코드에서 공유** — `_common.yaml` 은 Document **base handler** 가 읽음. per-type YAML 은 flat, cross-ref 0. | YAML cross-file 상속 = 네이티브 아님 = 자작 merge 엔진(accidental complexity). 공유는 TS 클래스 계층(`PrdHandler extends DocumentTaskHandler`). |
| **Q3** 4 axis 표현 | **(X) implicit** — axis/`pattern` enum 데이터 블록 없음. §2 `pattern` 행 삭제. | 단순화 A 본뜻 = 1-field enum 죽이기. (Y) explicit 은 4-field enum 으로 바꿔 F7 회귀. axis 는 (handler 클래스)+(L4)+(lookup) 으로 흡수. |
| **Q4** `output_location` | **(P) 단일 `{}` 템플릿 문자열** — 변수 resolve=코드, 해석(path/branch)=handler. Deploy=null. | path *모양*=데이터(F7 정신), `{repo}` be/fe *선택*=코드(service registry). |
| **Q5** Type B schema | **인라인 JSON Schema + `$ref` 성장 경로** | M0 output 작음 + per-type locality. `$ref` 는 JSON Schema 네이티브 → 나중 분리 non-breaking. |
| **Q6** lookup 누가 읽나 | **(D1) handler 가 읽고 resolve, dispatcher 는 dumb apply** | §4.0 binding table·Q2·§3.7 와 정합. D2(dispatcher 가 per-type meta 읽고 templating) 는 type-agnostic 분리 깨짐. |

### Q5 에서 같이 확정한 L4 모양 (fork 없이 확정)
- `jobs:` = 그 type 이 spawn 가능한 모든 job type → L4 맵. handler 가 어느 걸 언제 spawn 할지 *결정*.
- `skill:` = 이름만 (버전 핀 없음, always-latest). 쓰인 version 은 사후 `Job.skill_versions` audit.
- legacy `requiredCapability`/`retry`/`versionRange` **제거** (I-9 / I-6 / always-latest 와 충돌).
- `output_schema` 필수·검증(P-5), `input_schema` 선택·비강제, job param(threshold)은 해당 job L4 안.
- `git_commit_ref` 는 output_schema 아님 — Job result envelope 필드, 시스템이 verify-on-write(I-8).

## 미완 / 다음 결정 (순서)

1. **§5 (Step B)** — PRD/HLD/LLD/Spec/Code/QA (+ TC/Deploy) 의 **실제 `<type>.yaml` + `_common.yaml`** 예시. §4 schema 가 8 type 을 다 표현하는지 처음으로 실증.
2. **§6 (Step C)** — stages-task-job-analysis.md 표를 §4 schema + handler 모델로 줄별 점검. 표현 안 되는 항목 발견 시 §4 보강.
3. **M0 acceptance bar (Step D)** — §6 후 별도 grilling.
4. **ADR 보류 1건 (이번 세션에 제안, 미작성)** — `docs/adr/0001-strategy-data-code-boundary.md`: "Strategy 데이터 = per-type 파일 + handler 클래스 계층 공유(YAML 상속 아님); dispatcher type-agnostic, handler 가 외부 문자열 resolve(D1)". 세 기준(되돌리기 어려움/맥락없이 놀라움/진짜 trade-off) 충족. rejected 대안(YAML 상속 (I), explicit ref (II), D2)+근거를 보존하려면 작성. `docs/adr/` 아직 없음.

## 미해결 항목 (CONTEXT.md "아직 미정" + 이번 세션 추가)

- **Jira comment 의 정확한 wording/format 규약** — §4.3 은 `{var}` 템플릿 문자열 schema 만 확정. 실제 wording 은 데이터라 나중에. (schema 는 안 막음)
- status/transition 문자열 = **실제 Jira 프로젝트 config 의존** — 값은 실 환경에서. schema 가 보관.
- Service Registry 사람-편집 인터페이스 / 사설 marketplace 구체 형태·outage fallback / Wiki 단방향 안내 / Bug↔task 매핑 confirm UX / M0 acceptance bar — 기존대로 미정.

## 다음 세션 시작 프롬프트 (사용자용)

```text
/grill-with-docs

이전 세션 (docs/session-state-2026-05-28.md) 이어서.
Step A (§1~§4) 완료. 이제 docs/superpowers/specs/2026-05-27-workflow-architecture.md 의
§5 (6 task type 별 Strategy YAML 실제 예시 = Step B) 를 작성하자.
§4 schema (per-type 파일 + _common.yaml, meta/jobs(L4)/outbound·inbound lookup) 와
2026-05-25-stages-task-job-analysis.md 의 8 task type 표를 전제로,
PRD 부터 한 type 씩 _common.yaml + <type>.yaml 예시를 만들고
표현 안 되는 요구사항이 나오면 한 번에 하나씩 grilling 으로 물어줘.
(보류된 ADR 0001-strategy-data-code-boundary 작성 여부도 물어봐줘.)
```

## 다른 컴퓨터에서 시작하기 전 체크리스트

1. `git pull` (branch `worktree-rebuild-prd` — 이 세션에서 push 완료).
2. IDE 에서 열기:
   - `CONTEXT.md`
   - `docs/superpowers/specs/2026-05-27-workflow-architecture.md` (§4 까지 작성됨, §5 부터)
   - `docs/superpowers/specs/2026-05-25-stages-task-job-analysis.md` (참고)
   - `docs/session-state-2026-05-28.md` (이 파일)
3. 위 시작 프롬프트로 `/grill-with-docs` 호출.
