# 로컬 재현 입력

원본 문서와 대용량 이미지는 소스 전달물이 아니다. 원본 JSON·PNG·PDF는 Git 추적에서 제외하고 로컬 fixture로 사용한다. 입력 원본을 수정하거나 삭제하지 않는다.

현재 PC의 로컬 fixture 디렉터리는 `C:\Projects\candoc-v1\working-project\ieee-1547`이다. Git에서 제외한 `raw/ieee1547-document.json`과 JSON의 상대 URI가 가리키는 `raw/artifacts/*.png`를 그대로 유지한다. JSON은 약 7.14 MiB, PNG 167개는 약 83.22 MiB이며 PDF는 현재 fixture에 없다.

다른 PC에서는 저장소 외부 디렉터리(예: `C:\CanDocFixtures\ieee-1547`)에 같은 `raw` 구조를 준비하고 `--project`로 실행한다. 실제 검수 DB도 해당 프로젝트의 `inspection/review.sqlite`에 별도로 저장된다.

```powershell
cd C:\Projects\candoc-v1\web-ui
npm start -- --project C:\CanDocFixtures\ieee-1547
```

기존 fixture의 입력 SHA-256은 `bc2986e0685472527debf1c85129a17041501f8441270c0e69069732ca91ccff`다. 입력과 이미지가 없는 소스 checkout만으로 실제 문서 검사를 재현할 수는 없다. 회귀 검사는 `CANDOC_FIXTURE_PROJECT` 환경 변수로 저장소 외부 fixture 프로젝트를 지정할 수 있다. 테스트 DB는 별도 임시 디렉터리에 생성한다. 자세한 준비 조건은 [web-ui README](../web-ui/README.md#파일과-저장)에서 안내한다.

기준 커밋 `c83f2f5`에는 입력 JSON과 PNG가 이미 포함됐다. 이후 별도 커밋에서 `.gitignore`와 `git rm --cached`로 현재 추적만 해제했다. 기준 커밋을 삭제하거나 이력을 재작성하지 않았으므로 **원본 입력은 기준 커밋 이력에 남아 있다.** 로컬 작업 파일은 그대로 보존한다.
