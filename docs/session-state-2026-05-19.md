# Session State - 2026-05-19

## Summary

이번 세션은 구현을 진행하지 않고, `docs/development-plan.md`를 실제 개발 착수 전 의사결정 문서로 보강했다. 기존 PRD confirmation vertical slice와 CLI runner 검증 결과를 참고 구현으로 두고, 전체 AI workflow 시스템의 workflow/job/document/state/approval/revision 정책을 단계별로 확정했다.

## Documents Updated

- `docs/development-plan.md`: 전체 개발계획, 단계별 결정 agenda, PRD QG/revision/approval sequence diagram, M1 storage/model 결정 보강
- `docs/session-state-2026-05-19.md`: 다음 세션 handoff용 현재 상태 요약

## Confirmed Decisions

- Workflow의 canonical node와 UI primary node는 `workflow_job` 기준이다.
- 문서(PRD/HLD/LLD/Spec)는 job에 연결된 aggregate/artifact이며, job 상세에서 문서 링크를 보여준다.
- 문서 생성/수정 job은 markdown 생성, Git 저장, Wiki publish를 묶어서 처리한다.
- Quality evaluation은 별도 gate job으로 둔다.
- Approval은 job이 아니라 Jira 상태 기반 gate로 둔다.
- PRD 생성 직후 QG를 자동 수행하고, QG 통과 후에 기획자 승인 대기로 보낸다.
- QG 실패 시 자동 rewrite하지 않는다. 담당자 feedback이 있어야 revision job을 실행한다.
- 새 feedback 없이 revision을 요청하면 runner를 실행하지 않고 Jira comment로 feedback 필요를 알린다.
- PRD/HLD/LLD/Spec은 공통 generate -> quality evaluation -> feedback revision -> approval 패턴을 사용한다.
- Workflow role은 `운영자`, `기획자`, `개발자`, `QA` 네 가지로 제한한다.
- PRD approval은 `기획자`, HLD/LLD/Spec approval은 `개발자`가 담당한다.
- Jira 상태명은 한글 표준을 사용하고, 문서 타입별 prefix를 붙인다.
- PRD 최초 상태는 `PRD 요청`이다.
- Workflow intake는 `PRD 요청` 상태의 PRD ticket만 허용한다.
- Source request snapshot은 summary, description, status, key, issue type, links 등 핵심 metadata만 포함하고 Jira comment는 제외한다.
- 같은 source request는 active 또는 `보류` PRD workflow에 중복 연결할 수 없다.
- `취소됨` 또는 완료된 PRD의 source request는 새 PRD에서 재사용할 수 있다.
- `보류`는 running job을 강제 중단하지 않고 완료까지 둔다. 후속 job 생성/claim만 멈춘다.
- `취소됨`은 terminal cancel이다. pending job은 취소하고 running job에는 cancel request를 보낸다.
- 취소된 PRD의 Git markdown은 보존하고, Wiki page는 삭제하지 않고 `[취소됨]` 표시 후 유지한다.
- PRD `승인 완료` 감지 후 downstream routing은 자동 실행한다.
- Routing low confidence 상태는 `규모 확인 필요`다.
- `규모 확인 필요` 답변 담당은 `개발자`다.
- 개발자가 HLD/LLD/Spec 시작점을 직접 선택하면 그 선택을 우선하고, 설명만 있으면 `prd.route_downstream`을 재실행한다.
- Downstream routing 기준은 기존 requirements의 rule을 사용한다.
- `adr_needed: true`는 HLD/LLD 생성 job에서 ADR 후보를 도출하고 필요한 항목만 별도 ADR job으로 분리한다.
- PRD는 product-level Acceptance Criteria를 포함하고, 기획자가 PRD 승인과 함께 AC를 승인한다.
- Spec은 implementation-level AC와 TC draft를 포함한다.
- TC draft는 Spec 생성 job이 자동 생성하고, 개발자가 Spec 승인 전에 수정/보강할 수 있다.
- QA는 Dev 완료 후 TC를 finalize하고 QA 검증 결과를 승인한다.
- QA finalized TC와 검증 결과는 Spec revision이 아니라 별도 QA artifact로 저장한다.
- QA artifact는 v1에서 Wiki summary + DB/API detail로 제공하고, 이후 Excel export를 추가한다.
- M1 storage는 repository interface + in-memory adapter로 모델을 안정화한 뒤 같은 milestone 후반에 MySQL schema/transaction으로 전환한다.
- Workflow graph node 테이블명은 `workflow_job`이다.
- `workflow_job.primary_document_id`와 `workflow_job_document_link`를 함께 사용한다.
- `workflow_job_document_link.role`은 `primary`, `reads`, `creates`, `updates`, `evaluates`로 시작한다.
- `workflow_job.status`는 `pending`, `claimed`, `running`, `succeeded`, `failed`, `cancel_requested`, `canceled`, `skipped`, `retrying`으로 시작한다.

## PRD Jira Status Baseline

```text
PRD 요청
초안 작성 중
품질 평가 중
수정 필요
수정 중
승인 대기
승인 완료
하위 단계 라우팅 중
규모 확인 필요
하위 단계 시작됨
보류
취소됨
```

## Next Session Starting Point

다음 세션은 구현을 바로 시작하기보다 M1의 남은 모델/API 결정을 짧게 확인한 뒤 `docs/superpowers/plans/YYYY-MM-DD-core-workflow-persistence.md` 형태의 M1 구현계획으로 분리하면 된다.

우선 확인할 항목:

- `workflow_job_result`의 필드와 error code 체계
- `workflow_event`에 기록할 event type 범위
- `document_version`과 artifact current pointer 갱신 규칙
- MySQL migration 방식과 local dev DB 실행 방식
- 기존 `backend/src/prd-confirmation/*` vertical slice를 generic repository adapter로 감싸는 순서

## Notes

- 이번 세션에서는 구현 코드를 변경하지 않았다.
- 현재 브랜치에는 이전 세션의 미커밋 코드/문서 변경이 남아 있다. 이번 세션 커밋에는 `docs/development-plan.md`와 `docs/session-state-2026-05-19.md`만 포함해야 한다.
