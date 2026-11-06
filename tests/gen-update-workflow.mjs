// .github/workflows/update-from-template.yml → src/lib/update-workflow-yml.ts 를 다시 만듭니다. 사용법: node tests/gen-update-workflow.mjs
// (교사 화면의 '업데이트 기능 설치 (처음 한 번)' 링크에 이 내용을 그대로 넣습니다. workflow 파일을 고쳤으면 꼭 다시 만드세요.
//  tests/app-update.test.ts가 두 내용이 같은지 확인합니다.)
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const yml = readFileSync(new URL(".github/workflows/update-from-template.yml", root), "utf8");
const out =
  "// .github/workflows/update-from-template.yml과 글자 하나까지 같은 사본입니다. 직접 고치지 말고 `node tests/gen-update-workflow.mjs`로 다시 만드세요.\n" +
  "// 교사 화면의 '업데이트 기능 설치 (처음 한 번)' 링크가 이 내용으로 GitHub 새 파일 화면을 채웁니다(src/lib/app-update.ts). tests/app-update.test.ts가 두 내용을 비교합니다.\n" +
  "export const UPDATE_WORKFLOW_YML: string = " + JSON.stringify(yml) + ";\n";
writeFileSync(new URL("src/lib/update-workflow-yml.ts", root), out);
console.log("src/lib/update-workflow-yml.ts를 다시 만들었습니다.");
