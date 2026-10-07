# 영역 주석 Codex -32602 수정

현재 HEAD 96cc115의 작업트리는 깨끗했다. 페이지 입력 약 562,332자, 기존 영역 입력 약 2,221,003자다. 설치된 Codex 0.160.1을 오직 로컬 실패 응답 제공자에 연결한 격리 검증에서 `turn/start`가 `-32602`, `input_error_code=input_too_large`, `max_chars=1048576`, `actual_chars=2221003`으로 거부하는 것을 확인했다. 외부 모델 추론은 실행하지 않았다. 앞선 합성 fixture는 이 실 입력 길이 제한을 검사하지 않았다.

원본/검수 DB/기존 서버를 유지한다. 영역 추천의 wire 자료만 열 이름+행 배열로 직렬화하고 동일 orig/text 중복 및 파생 pages/repeatedPages/정규화 bbox 중복을 제거한다. 원본 텍스트와 다른 orig, 소속, 모든 실제 provenance/bbox/charspan과 페이지 크기는 보존하며 현재 역할은 필요한 필드만 함께 보낸다. 어떤 참조/문구도 잘라서 추천하지 않는다. 저장·추천 대상/예외·이력 계약은 유지한다.

공통 Codex client에 Unicode 문자 수 제한 사전 검사를 추가한다. RPC 오류는 요청 method와 제한 관련 안전한 구조화 사유를 표시하고 임의 error.message/data/원문/계정 상세는 노출하지 않는다. 실 fixture와 모든 기존 판단이 있는 경우의 길이/자료 보존, 경계/Unicode/실패 무변경, 실제 UI 오류·재요청, API·타입·별도 빌드·전체 브라우저를 격리 검증한다. 로컬 커밋하고 기존 서버를 재시작하지 않은 새 미리보기를 보고한다.

## 검증 결과

- 기존 입력은 설치된 app-server에서 `-32602/input_too_large`로 거부됐다. 같은 실제 텍스트를 보존한 compact 자료는 869,528자로 `turn/start`가 수락했다. Codex 공급자는 로컬 HTTP 실패 stub으로 강제하고 effective config의 provider/base_url을 확인했다. prewarm 요청 2개도 이 stub에만 도달했으며 외부 모델 추론·도구·검수 쓰기는 없었다. 실제 추론 성공/추천 품질 검증과 구분한다.
- API 전체 74/74 통과. 실제 2,937개 원문 텍스트에서 기존 중복 입력의 제한 초과를 고정하고, 모든 현재 역할 판단이 있는 경우까지 compact 자료가 충분한 여유를 두고 제한 이하임을 검사했다. 모든 ref/text/다른 orig/label/layer/원본 소속/모든 prov·bbox·charspan을 복원 비교했다. 확장 bbox/prov 필드·유지/제외 혼합과 상태 보존, Unicode 경계/사전 실패, 안전 RPC 표시도 통과했다.
- 타입 검사 통과. `CANDOC_BUILD_DIR=qa/annotation-input-dist` 격리 빌드와 전체 페이지/AI/설정/3/4/5 브라우저 회귀 통과. 추가 실제 문서 UI 검사도 통과했다: 합성 upstream 길이 오류의 안전 표시 → 새로고침 실패 이력 복구 → 같은 주석의 명시 재요청 → 완료 빈 추천, 기존 주석/판단/revision 보존. 실제 모델은 실행하지 않았다. 캡처 `web-ui/qa/annotation-input-actual-1512.png`.
- `stage5-simple-annotation-rpc-before/after.json` 전체 일치: 원본 168개, 실제 DB 전체 스키마/행, 기존 서버의 검수/메모리 추천, 기존 dist·4/5 static 9파일. 4380/4382/4383/3696/1528 PID 각각 34092/8000/25540/43836/28408 유지.
- 모든 개발 검증은 임시 DB·별도 포트/빌드에서 수행했다. 새 미리보기는 기존 1528의 검수 DB를 읽기 전용으로 복사하며 원본 입력을 읽는 별도 서버다. 기존 서버는 재시작하지 않는다. 더 큰 문서/비정상적으로 큰 provenance가 제한을 넘으면 범위를 몰래 자르지 않고 사전 오류를 표시한다. 저장 계약이나 교정 사본은 변경하지 않는다.
