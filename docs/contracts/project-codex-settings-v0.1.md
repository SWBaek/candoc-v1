# 프로젝트 Codex 설정 계약 v0.1

사이드바 하단 `설정`에서 프로젝트의 로컬 Codex 연결을 확인하고 모델/Reasoning effort를 저장한다. 기존 Codex app-server stdio 인증을 재사용한다. API 키 입력이나 Paseo 실행 의존성은 추가하지 않는다.

## 연결 확인

`initialize` → `initialized` → `account/read` → `model/list`만 실행한다. 실제 모델 턴·추천·도구 실행은 없다. 로그인과 모델 카탈로그 접근 성공을 ‘연결 확인됨’으로 표시하며 실제 추론 성공이나 개별 모델의 사용 권한/할당량을 보장하지 않는다. 확인은 사용자가 요청하며 실제 프로세스의 제한 시간은 30초다. 오류 시 실패 사유를 표시하고 이전 연결 성공·목록을 지운다. 저장 설정은 유지한다.

연결 상태와 목록은 서버 메모리에만 있다. 서버 재시작 후 연결은 미확인이며 저장 모델/effort는 복구된다. 추천 실행 시 기존 runner가 로그인·현재 목록·지원 조합을 다시 확인한다. 계정 이메일/토큰은 전송·저장하지 않는다.

## HTTP와 저장

기존 localhost·동일 출처·JSON 제한을 적용한다.

| 경로 | 메서드/본문 | 결과 |
| --- | --- | --- |
| `/api/project/codex` | GET | `{settings, connection}` |
| `/api/project/codex/check` | POST `{}` | 모델 목록/로그인 확인. 성공 200, 실패 503, 확인 중 중복 409 |
| `/api/project/codex` | PUT `{model, effort, version}` | 확인한 목록의 지원 조합 저장. 무효 400, 설정 버전 충돌 409 |

`settings`: model, effort, version, updatedAt. 최초 빈 모델/effort, version=0. 저장마다 설정 version만 증가한다. `connection`: status(unchecked/checking/connected/failed), checkedAt, models(model/displayName/efforts/defaultEffort/isDefault), error.

검수 SQLite의 별도 `project_codex_settings` 단일 행에 저장하며 source/rule별 검수 session에 종속되지 않는다. 설정 저장·확인은 검수 revision, 페이지/영역/순서/제목 판단과 단계 완료를 바꾸지 않는다. 원본 JSON·PNG를 수정하지 않는다. 모델과 effort를 한 문장으로 원자 저장하며 version 검사도 같은 동기 저장에서 수행한다. 창 간 충돌은 초안을 보존하고 최신 저장값 확인/취소 후 다시 열기를 제공한다.

페이지·목차·영역 추천은 설정값을 공유한다. 기존 클라이언트 호환을 위해 최초 미설정이면 페이지 추천은 기존 기본 모델/환경 설정을, 제목·영역 요청은 명시 모델/effort를 사용한다. 프로젝트 설정이 있으면 이를 우선하고 명시 요청이 다르면 409로 거부한다. 현재 카탈로그에 저장 조합이 없으면 새 추천을 거부한다. 실행 중 요청은 시작 당시 모델/effort를 유지하며 이후 설정 변경은 다음 요청부터 적용한다. 이미 생성된 추천의 승인/검수 계약은 바꾸지 않는다.

## UI

설정은 필요할 때만 여는 모달이다. 모바일에서도 과정 목록을 펼치지 않고 사이드바 하단에서 접근한다. 모델 선택 시 지원 effort만 제공하며 지원하지 않는 저장값은 표시하고 다시 선택하도록 한다. 취소/닫기는 설정을 저장하지 않는다. 검수 초안과 탐색은 유지한다. Escape, 포커스 제한·복귀와 배경 inert, 44px 조작 영역을 제공한다. 각 추천 화면은 별도 선택기를 두지 않고 프로젝트 설정으로 연결한다.

검증은 임시 DB·자체 포트·별도 빌드에서 수행하며 실제 모델은 실행하지 않는다. 엄격한 가짜 stdio 서버는 연결 확인에서 thread/turn 시작을 거부한다. 저장/충돌/지원 조합/실패 복구·세 추천 전달·실행 중 설정 보존·프로세스 재시작과 두 테마 레이아웃을 검사한다. 설정 저장은 검수 기록이나 교정된 DoclingDocument 사본 생성과 별개다.
