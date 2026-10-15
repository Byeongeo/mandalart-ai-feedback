// db/schema.sql → src/lib/schema-sql.ts 를 다시 만듭니다. 사용법: node tests/gen-schema-sql.mjs
// (배포된 앱은 파일을 읽지 않고 schema-sql.ts의 문자열을 실행하므로, schema.sql을 고쳤으면 꼭 다시 만드세요.
//  tests/schema.test.ts가 두 내용이 같은지 확인합니다.)
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const sql = readFileSync(new URL("db/schema.sql", root), "utf8");
if (/[`\\]|\$\{/.test(sql)) throw new Error("schema.sql에 ` \\ ${ 는 쓸 수 없습니다(String.raw 템플릿에 넣기 때문).");
const out =
  "// db/schema.sql과 글자 하나까지 같은 사본입니다. 직접 고치지 말고 `node tests/gen-schema-sql.mjs`로 다시 만드세요.\n" +
  "// 배포된 앱은 파일을 읽지 않고 이 문자열을 실행합니다(src/lib/db.ts의 ensureSchema). tests/schema.test.ts가 두 내용을 비교합니다.\n" +
  "export const SCHEMA_SQL = String.raw`" + sql + "`;\n";
writeFileSync(new URL("src/lib/schema-sql.ts", root), out);
console.log("src/lib/schema-sql.ts를 다시 만들었습니다.");
