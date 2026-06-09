AI를 활용한 개발 프로세스 자동화
---

목적

- 운영팀에서 요청하는 내용을 수집하여 요건을 정리하고 개발할 내역을 특정하고 이를 코딩 및 테스트 수행하고, 이후 배포까지 한다.


주요 대상
- workflow app : workflow 관리 및 jira 연동
- jira : 진행절차에 대한 SSOT
- wiki : 사람들이 볼수 있는 문서의 복제본
- prd-repo: prd 문서를 관리하는 git repo
- be-repo: 백엔트 코드를 관리하는 git repo, HLD 문서 보관 장소
- fe-repo: 프론트엔드 코드를 관리하는 git repo, be-repo 와 동일할 수도 있음


절차
- 운영팀에서 작성된 요청티켓 번호 연관 티켓으로 하는 PRD 티켓을 생성한다. (기획자)
- PRD 티켓 생성되면 하나의 workflow를 생성 후 실행한다. (jira hook)
- workflow 가 실행되면 요청티켓을 검토하여 PRD 문서를 작성한다. (prd 전용 repo  : 원본, wiki : 복제본)
- PRD 문서를 검토하여 모호하거나 부족한 부분이 있으면 질문 또는 추가자료 요청을 한다.
- 답변 및 추가자료를 제공하고 재리뷰요청하면 이를 감자한다 (jira hook)
- 제공된 정보를 바탕으로 PRD를 수정한다. 
- 수정된 PRD를 검토하여 일정 점수 이상이면 PRD 티켓 상태를 업데이트 한다.
- PRD 티켓이 승인되면 prd 문서를 바탕으로 작업규모를 분석한다. (hld, lld, spec 레벨)
- 만일 hld 규모라면 hld 티켓을 생성한다.
- 이후 과정은 prd 와 유사함. (작성 - 검토 - 재작성 등등)
- hld가 승인되면 
- hld 문서를 기반으로 lld 문서를 쪼개는 역할을 수행한다.
- 쪼개진 lld 별로 티켓 생성 후 작성 - 검토 - 재작성 등등의 프로세를 동일하게 진행 한다.


jira ticket type
- 요청티켓 : task
- PRD티켓 : Initiative
- HLD티켓 : epic
- LLD티켓 : story
- spec 티켓: task
- 이외 티켓: task


요구사항
- jira는 보고자, 담당자 변경이 가능하니 workflow로 생성해도 무방하다.
- 하지만 git 작업 및 ai 구동 계정은 가능하면 각 담당자 계정이면 좋을듯 함.(필수는 아님)
- 실제 실행하는 runner를 각 담당자 로컬 컴에서 구동가능하면 좋겠음
