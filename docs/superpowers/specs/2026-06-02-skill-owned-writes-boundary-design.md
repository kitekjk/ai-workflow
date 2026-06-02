# AI Workflow — 경계 재설계: 외부 쓰기를 스킬로, 앱은 Jira-reactor 로

> **목적**: Workflow App 과 AI 스킬 사이의 책임 경계를 재정의한다.
> 핵심 이동: **모든 외부 산출물 쓰기(git / wiki / PR)를 AI 스킬이 소유**하고, 앱은
> **Jira 와만 대화하는 reactor + 스케줄러 + runner** 로 얇아진다.
>
> **전제 문서**:
> - [`2026-05-27-workflow-architecture.md`](./2026-05-27-workflow-architecture.md) — §3 6골격 컴포넌트 + §4 Strategy schema (이 문서가 개정)
> - [`2026-05-25-ai-workflow-rebuild-ideas.md`](./2026-05-25-ai-workflow-rebuild-ideas.md) — F5~F11 교훈, I-1~I-23 invariants
>
> **작성**: 2026-06-02 (brainstorming 세션, 20f6e47 이후)

---

## 0. 왜 다시 보는가

§3 아키텍처의 **Outbound Dispatcher** 는 Jira + GitHub + **Wiki + Git** 을 모두 쓰는 범용
다중-시스템 컴포넌트였고, Runner 가 git commit/push 를 직접 수행했다. 그런데 "중요한 도메인
작업은 AI 가 처리하고, 그 AI 작업을 별도 스킬로 만든다" 는 전제에서 한 가지가 자연스럽게 따라온다:

> 그 스킬은 도메인 산출물을 **만들 뿐 아니라, 그것을 wiki / git 에 쓰는 행위까지** 자기 안에서
> 한다. 그러면 앱이 wiki/git 쓰기를 중복으로 가질 이유가 없다.

이 문서는 그 경계 이동을 확정하고, 어느 컴포넌트가 줄고 어느 invariant 가 영향을 받는지 기록한다.

---

## 1. 결정 (이번 세션)

| # | 결정 | 근거 |
| --- | --- | --- |
| **D1** | **스킬이 모든 외부 쓰기를 소유**: 도메인 산출물 생성 + git commit/push + wiki publish + PR open/comment. | 도메인 작업과 그 결과물의 영속화는 한 곳(스킬)에서 일어나야 contract 가 안 끊긴다 (F11 교훈의 재해석). |
| **D2** | **앱이 흐름을 소유**: Jira 상태/코멘트(양방향), 결과→상태 매핑, 결과→다음작업 결정, 스케줄링, 러닝. | 결정성·감사 가시성이 중요한 부분은 앱(데이터+코드)에 남긴다. |
| **D3** | 스킬은 *후보* 다음작업 리스트를 반환할 수 있으나, **순차 실행 vs fan-out 은 앱(Orchestrator)이 결정**. | cross-task 오케스트레이션은 §3 NOT-D 원칙대로 앱의 first-class 책임. 스킬은 cross-task 를 모른다. |
| **D4** | **bare envelope 신뢰**: 앱은 스킬이 보고한 ref(commit hash / wiki page id / PR id)를 envelope schema 의 *모양*만 검증하고 신뢰한다. 앱은 git/wiki read 능력을 갖지 않는다. | 최대 단순화. 잔존 위험(스킬이 실제 쓰기 없이 ref 를 주장)은 스킬 정확성 + 후속 QA 로 흡수. |
| **D5** | `meta.output_location` 은 **스킬로 이동**. 앱은 사전 위치 template 을 갖지 않고, envelope 의 실제 ref 만 받는다. | 쓰기를 스킬이 하므로 위치 결정도 스킬 책임. 앱은 결과 ref 만 알면 Jira 코멘트에 쓸 수 있다. |

---

## 2. §3 6 골격 컴포넌트 → 개정 후

| §3 컴포넌트 | 개정 후 | 변화 |
| --- | --- | --- |
| **EventHandler** (결과→상태, 다음 job 결정) | **유지** | 앱이 결정 주체 (D2) |
| **Workflow Run Orchestrator** (fan-out/fan-in/back-edge) | **유지** | 순차/병렬은 앱 (D3) |
| **Outbound Dispatcher** (Jira+GitHub+Wiki+Git) | **Jira 전용으로 축소** | wiki·git·PR 쓰기 → 스킬 (D1) |
| **Inbound Dispatcher** (Jira/GitHub webhook) | **유지** | 트리거 |
| **JobSpecBuilder + JobOutputValidator** (TypeA+TypeB 합성) | **단순화** | 통합 코드가 스킬 안으로 → "스킬 1개 + input + output_schema". Validator 는 envelope(도메인 output + claimed refs) 검증으로 유지 |
| **Runner** (AI + validate + **git push**) | **축소** | git/wiki/PR 코드 제거. AI 세션에 workspace·자격증명만 제공하고, 실제 쓰기는 스킬이 세션 안에서 실행 |

### 2.1 가장 큰 코드 감소

앱이 **wiki + git + PR 통합 코드 전체를 들어낸다**. 옛 `integrations/confluence-wiki.ts`,
git push 로직, PR open/comment 로직은 전부 스킬 쪽(또는 스킬이 쓰는 MCP 도구: confluence /
github / git)으로 이동. 앱에 남는 외부 통합은:

- **Jira**: inbound webhook + outbound 상태/코멘트 — **양방향**
- **GitHub**: inbound webhook(PR 상태, I-18)만 — PR open/comment 는 스킬
- **Wiki / Git**: 앱은 read 도 write 도 안 함

---

## 3. 책임 경계 (앱 vs 스킬)

```
┌──────────────────────────── Workflow App (얇아진 reactor) ────────────────────────────┐
│  Inbound Dispatcher  ──→  Task State Machine ──→ EventHandler  ──→ Orchestrator         │
│   (Jira/GitHub webhook)        (결과→상태)        (다음 job 결정)   (순차/fan-out 결정)  │
│                                       │                                                 │
│  Outbound Dispatcher (Jira 전용)  ←───┘   Scheduler ──→ Runner ──(skill 호출)──┐         │
└────────────────────────────────────────────────────────────────────────────┼─────────┘
                                                                               │ JobSpec
                                                                               ▼
                                       ┌──────────────── AI Skill (도메인 + 외부 쓰기) ──┐
                                       │  도메인 산출물 생성/수정                          │
                                       │  git commit + push   /  wiki publish  /  PR open │
                                       │  → envelope { domain_output, refs[], next? } 반환 │
                                       └───────────────────────────────────────────────────┘
```

- **앱은 git/wiki 를 모른다.** Jira 상태 매핑과 cross-task 오케스트레이션만 결정한다.
- **스킬은 cross-task 를 모른다.** 자기 task 의 산출물 생성·영속화·(후보) 다음작업 추천까지.
- **러너는 workflow 의미를 모른다.** 스킬을 AI 엔진으로 호출하고 envelope 를 앱에 relay 만.
- 결과로 **Jira 상태 업데이트 / 다음 task 생성**의 *결정*은 앱, *수행될 도메인 작업과 그 영속화*는 스킬.

---

## 4. §4 Strategy 데이터에 미치는 영향

| 데이터 | 개정 후 |
| --- | --- |
| `jobs` / L4 (`skill` 이름 + `output_schema`) | **유지** — 어느 스킬 호출, envelope 검증 |
| `outbound` lookup (결과 outcome → Jira 상태/코멘트) | **유지** — 앱이 Jira 매핑 소유 |
| `inbound` lookup (외부 transition → semantic event) | **유지** |
| `meta.output_location` (산출물 위치 template) | **제거 (D5)** — 스킬이 위치 결정, 앱은 envelope ref 수신 |
| `wiki publish` standing outbound (§4.3) | **앱에서 제거** — 스킬이 publish |
| envelope schema | **확장** — 스킬이 보고하는 `refs[]`(commit/wiki/PR) 를 포함 (bare claim, D4) |

state graph 도 pattern enum 도 여전히 없다. 로직은 handler·orchestrator 코드, 데이터는
L4 + lookup. 이 문서는 그 위에서 **데이터 일부를 더 덜어낸다**(output_location, wiki publish).

---

## 5. Invariant 트레이드오프 (정직한 기록)

bare claim(D4) 선택의 대가를 명시한다.

| Invariant | 영향 |
| --- | --- |
| **I-7 / I-8** (push 흔적=success, verify-on-write) | 앱 차원 강제력 **상실**. push 의 진위는 스킬 신뢰 + 후속 QA 로 이동. envelope 에 ref 가 있으면 성공으로 본다. |
| **P-2 / I-21** (외부 SSOT, restart 시 외부만으로 catch-up) | **분화**된다. **Jira 는 여전히 외부 SSOT** (restart 시 재확인). **git/wiki ref 는 앱 DB 의 cached 값이 권위 소스** — 앱이 git/wiki 를 재독하지 않으므로. restart catch-up = Jira(외부) + artifact refs(DB cache). |
| **P-5** (schema 강제) | **유지** — envelope(도메인 output + refs)는 여전히 output_schema 로 검증. 단 검증 대상이 "모양"이지 "ref 의 외부 실재"는 아님. |
| **I-18** (Code task SSOT = GitHub PR state) | **유지** — GitHub inbound webhook 으로 PR 상태 수신. PR open 은 스킬, 상태 추적은 앱. |
| 그 외 (I-3 일부, I-5, I-6, I-9, I-13~I-15, I-19, I-20, I-22) | 영향 없음 또는 §3 그대로. |

> **핵심 한 줄**: 이 설계는 "외부 쓰기를 한 곳(스킬)에 모아 코드를 덜어내는 대신, 그 쓰기의
> 진위 검증을 앱에서 포기"하는 거래다. F11 의 *모델 차원 차단*은 약해지고, *스킬 정확성 + QA*
> 로 대체된다. 이 거래는 의식적으로 선택되었다.

---

## 6. 다음 작업 (이 문서 밖)

- §3/§4 본문을 이 결정에 맞게 개정 (Outbound 를 Jira-only 로, Runner 에서 git 제거, `output_location` 삭제, envelope schema 에 `refs[]` 추가).
- AI 스킬의 책임 경계 spec (도메인 작업 + git/wiki/PR 쓰기 + envelope contract) — 별도 문서.
- envelope schema 의 `refs[]` 구조 확정 (system / key / url).
