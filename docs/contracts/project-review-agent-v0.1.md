# 프로젝트 검수 Agent v0.1

프로젝트의 검수 화면과 대화를 연결한다. 단계는 검수 작업의 위치이며 Agent 대화는 단계 이동 뒤에도 유지한다. 로그인, 모델 카탈로그, 프로젝트 모델/effort 설정은 기존 로컬 Codex app-server 연결을 재사용한다. 새 API 키나 Paseo 실행 의존성은 추가하지 않는다.

## 대화와 근거

SQLite `project_agent_conversations`는 검수 세션/원본/규칙/도구 계약 버전에 묶인 대화와 Codex thread ID를 보존한다. `project_agent_turns`는 사용자 메시지, 첨부, 모델/effort, 근거 지문, 상태, 최종 답변, 조회 범위, 변경안/저장 대상을 보존한다. 첫 요청은 `thread/start`의 `ephemeral:false`/experimental dynamicTools이고 다음 요청은 같은 ID의 `thread/resume`이다. 호스트 프로세스는 turn마다 정리하지만 저장된 Codex 대화는 이어진다. 연결 실패 시 조용히 새 thread를 만들지 않는다. 사용자가 명시적으로 새 대화를 시작할 수 있고 지난 대화는 읽기 전용으로 조회한다. 이전 단발 추천 이력은 자동으로 Codex 대화에 합치지 않는다.

첫 입력은 사용자 메시지(4,000자 이하), 문서명/원본·규칙·검수 근거 지문, 현재 단계/페이지, 서버의 선택 페이지, 선택한 실제 refs(최대 30개, UI에서 제한 표시), 선택적으로 저장된 영역 주석이다. 원본 전체 JSON이나 PNG를 넣지 않는다. 화면의 미저장 초안은 첨부되지 않으며 이를 UI에서 표시한다. 요청 중 설정 변경은 다음 turn부터 사용한다. 취소/서버 중단 시 자동 추론 재시도는 없고 중단 상태와 이력만 남는다.

검수 DB가 확정 기록의 기준이다. `agentReviewBasis`는 페이지 판단/역할/순서/연결/제목/개요/단계 기록과 영향을 반영한다. 화면 이동·선택·필터·표시 크기·navigation revision은 이 지문에서 제외한다. 따라서 이동은 대화를 유지하지만 판단 변경은 진행 중 조회와 오래된 변경안의 저장을 제한한다. 원본/규칙 버전은 별도로 검증한다.

## 읽기 도구와 변경안

`candoc_query`는 summary/pages/page/search/region/pattern/refs/reviews/outline을 지원한다. 페이지·ref·좌표·문구·offset/limit을 서버가 검증한다. 검색은 유지 페이지를 기본으로 하고 refs/원본 출처 조회는 제외 출처도 보존한다. pattern은 사용자의 정규화 bbox와 겹치는 실제 텍스트의 다른 유지 페이지 후보이며 자동 머리말 판정이 아니다. 문구·인접 조각·제목/본문을 Agent와 사람이 추가 대조한다. JSON에 없는 줄 단위 hbox/누락 원문을 만들지 않는다.

각 조회는 최대 30개/60,000 UTF-8 bytes, turn 전체는 80회/1 MiB로 제한한다. 전체 대상 수/offset/nextOffset/조회 한계를 반환하며 원문을 자르지 않는다. 개별 원본 항목이 한도를 넘으면 명시 오류로 남긴다. 반환한 항목은 전체 text/orig/원본 소속과 모든 provenance(제외 유지 혼합/bbox/charspan/확장 필드 포함)를 보존한다. 부분 조회는 전체 검수 완료가 아니다.

`candoc_propose_roles`는 **이번 turn에서 실제 조회한 refs**의 머리말/꼬리말/페이지 번호 역할만 변경안으로 만든다. 묶음별 근거/대상/변경 전후/원본 문구·페이지를 서버가 검증하고, 중복·없는 참조·제외 페이지만의 대상·없는 bbox·불가능한 역할 조합·조회하지 않은 항목은 거부한다. 최대 30묶음, 묶음당 300개이다. Agent의 도구는 DB 검수 판단을 쓰지 않는다. 완료된 turn에서만 변경안을 공개하고 실패·취소·중단의 변경안은 폐기한다.

실행 가능한 변경안의 범위는 반복 요소 역할이다. 다른 단계는 현재 페이지·원문·검수 기록·목차를 조회하고 설명할 수 있다. 기존 페이지/제목 추천·승인 경로는 호환 보존하며 이번 계약이 페이지 제외/제목 구조/다음 단계의 자동 저장을 새로 허용하지 않는다.

## 사람의 확인과 저장

프로젝트 공통 우측 패널은 필요할 때 열며 대화/첨부/원본/변경안을 같은 공간에서 대조한다. 970px 이하에서는 포커스 제한/Escape/복귀가 있는 drawer이다. 사용자 대상/예외 선택 뒤 ‘승인’은 UI 확인 상태이며 DB 쓰기가 아니다. 예외 변경 시 승인을 해제한다. 별도 ‘판단 저장’만 검수 기록을 쓴다. 미저장 초안/오래된 근거에서는 저장하지 않는다.

저장 요청은 서버 소유 turn/proposal ID, 예외, sourceHash/ruleHash와 현재 revision을 전달한다. 클라이언트가 role/ref 변경안을 공급하지 않는다. 서버는 근거/범위/예외를 재검증하고 기존 roleStore.saveBatch로 모든 선택 대상과 저장 결과를 한 트랜잭션에서 기록한다. 소속은 유지하고 이미지 대조를 자동 기록하지 않는다. 관련 검수 영향과 기존 직전 일괄 복원을 재사용한다. 일부 저장 실패는 역할/이력/변경안 저장 상태/revision 전부 rollback한다. 하나를 저장하면 동일한 옛 근거의 다른 변경안은 다시 요청해야 한다.

## API와 운영

- `GET /api/project/agent?offset=0&conversationId=...`: 현재/지난 대화 이력(30 turn씩), 현재 지문과 stale 상태. 첫 조회는 빈 대화이며 검수 revision을 변경하지 않는다.
- `POST /api/project/agent`: 현재 대화 ID/메시지/첨부/원본·규칙·검수 revision. 202 후 GET polling. 프로젝트당 동시 한 turn. 잘못된 입력 400, 오래된 근거/동시 요청 409.
- `DELETE /api/project/agent`: 현재 실행 ID의 명시 취소. 주석/검수 판단은 유지.
- `POST /api/project/agent/new`: 실행 종료 후 사용자가 명시적으로 새 대화 시작. 이전 이력 보존.
- `GET /api/project/agent/item?ref=...`: 검증된 원본 항목과 모든 출처. PNG는 기존 페이지 이미지 API로 사람에게만 표시.
- `PUT /api/review/agent-proposal`: 승인한 선택 대상의 명시 저장. 기존 검수 mutation/원자성/충돌 계약 적용.

Codex는 read-only/approvalPolicy never이며 MCP/apps/plugins/multi-agent/shell/unified exec/code mode/web search를 비활성화한다. 호스트는 현재 thread/turn의 두 등록 dynamic tools만 응답하고 알 수 없는 도구/승인 요청을 거부한다. 문서 원문은 지시가 아닌 자료로 다룬다. 원본 수정, 실제 사용자 DB 테스트 쓰기, 기존 서버 제어는 하지 않는다. 교정된 DoclingDocument 사본 생성은 이번 구현에 포함되지 않으며 공식 스키마/HTML 교정 완료를 주장하지 않는다.

프로토콜 근거: [Codex App Server](https://learn.chatgpt.com/docs/app-server)의 thread/resume 및 experimental dynamic tools와 설치된 Codex 0.160.1 생성 스키마. 검증은 임시 DB/별도 포트/빌드/합성 stdio, 설치 binary는 로컬 실패 HTTP 공급자에만 연결한다. 실제 모델의 도구 호출/추천 품질은 사용자 실 요청과 구분한다.
