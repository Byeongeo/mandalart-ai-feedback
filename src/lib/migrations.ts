// DB 스키마 마이그레이션 목록과 순수 함수(서버·단위 테스트 공용). 실제 실행은 db.ts의 ensureSchema가 합니다.
//
// 동작:
// - 0001_base = db/schema.sql(= schema-sql.ts). 처음 설치하는 DB에 표를 만듭니다.
// - 그 뒤 버전에서 바꿀 것은 LATER_MIGRATIONS에 순서대로 덧붙입니다. 한 번 배포한 마이그레이션은 고치거나 지우지 마세요.
// - 적용한 id는 schema_migrations 표에 기록하고, 이미 적용한 것은 다시 실행하지 않습니다(기본 스키마 포함).
// - 여러 함수 인스턴스가 동시에 떠도 advisory lock으로 한 곳만 실행하고, 표 잠금은 5초까지만 기다립니다(lock_timeout).
//   남은 마이그레이션은 한 트랜잭션으로 함께 적용되므로, 중간에 실패하면 모두 되돌려지고 다음 요청에서 다시 시도합니다.
// - 해시는 주석과 공백을 뺀 SQL로 만듭니다(주석만 고쳐도 해시는 같음). 기록용이며, 적용 여부는 id로 판단합니다.
//
// 새 마이그레이션 쓰는 법(예시):
//   { id: "0003_student_note", sql: `alter table students add column if not exists note text;` },
// - id는 '4자리 순번_이름'이고 순번은 앞 것보다 커야 합니다(tests/schema.test.ts가 검사).
// - 다시 실행해도 안전하게(add column if not exists 등) 쓰고, 오래 걸리는 작업(큰 표 다시 쓰기)은 피하세요(tests/schema.test.ts가 검사).
//   새 열은 null 허용 또는 상수 default로 추가하면 Postgres가 표를 다시 쓰지 않아 빠릅니다.
//   not null 열에는 꼭 default를 주세요(이미 행이 있는 표에서 실패하지 않게).
// - 새 표를 만들면 'alter table … enable row level security'도 함께 넣으세요.
import { createHash } from "node:crypto";

export type Migration = { id: string; sql: string };

export const BASE_MIGRATION_ID = "0001_base";

// v2부터 여기에 덧붙입니다. 순서대로 쌓기만 하고, 배포한 것은 고치지 마세요.
export const LATER_MIGRATIONS: readonly Migration[] = [
  {
    // 학급마다 학생 PIN을 쓸지(기본 켬). 이미 있는 학급도 켜진 채로 둡니다(상수 default라 표를 다시 쓰지 않음).
    // PIN을 끄면 학급 코드·번호·이름만으로 들어오므로, 같은 반 친구가 다른 학생으로 들어가 글을 고치거나 지우거나 제출하고,
    // 피드백 기회를 써 버리거나, 걱정되는 글을 써서 안전 신호가 엉뚱한 학생에게 붙게 할 수 있습니다. 시범 수업처럼 짧게 쓸 때만 끕니다.
    id: "0002_class_require_pin",
    sql: `alter table classes add column if not exists require_pin boolean not null default true;`,
  },
];

/** 실행할 전체 목록(기본 스키마 + 이후 마이그레이션, 순서대로) */
export function allMigrations(baseSql: string): Migration[] {
  return [{ id: BASE_MIGRATION_ID, sql: baseSql }, ...LATER_MIGRATIONS];
}

// 적용 기록 표. 마이그레이션보다 먼저 (잠금 안에서) 만듭니다.
export const MIGRATIONS_TABLE_SQL = `
create table if not exists schema_migrations (
  id text primary key,
  hash text not null,
  applied_at timestamptz not null default now()
);
alter table schema_migrations enable row level security;
`;

/** 의미 있는 SQL만: 줄 주석(--)을 빼고 공백을 하나로 모읍니다(문자열 안의 '--'는 쓰지 마세요). */
export function meaningfulSql(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function migrationHash(m: Migration): string {
  return createHash("sha256").update(meaningfulSql(m.sql)).digest("hex").slice(0, 16);
}

const ID_FORMAT = /^(\d{4})_[a-z0-9_]+$/;

/** 목록이 올바른지(형식, 중복 없음, 순번이 커지는 순서, 빈 SQL 없음). 문제가 있으면 설명 목록. */
export function migrationProblems(list: readonly Migration[]): string[] {
  const problems: string[] = [];
  let prev = -1;
  const seen = new Set<string>();
  for (const m of list) {
    const match = ID_FORMAT.exec(m.id);
    if (!match) problems.push(`형식이 맞지 않는 id: ${m.id}`);
    if (seen.has(m.id)) problems.push(`중복 id: ${m.id}`);
    seen.add(m.id);
    const n = match ? Number(match[1]) : -1;
    if (match && n <= prev) problems.push(`순서가 맞지 않음: ${m.id}`);
    if (match) prev = n;
    if (!meaningfulSql(m.sql)) problems.push(`SQL이 비어 있음: ${m.id}`);
  }
  if (list[0]?.id !== BASE_MIGRATION_ID) problems.push(`첫 마이그레이션은 ${BASE_MIGRATION_ID}이어야 합니다.`);
  return problems;
}

/** 아직 적용하지 않은 마이그레이션(목록 순서 유지). applied는 schema_migrations의 id들. */
export function pendingMigrations(list: readonly Migration[], applied: Iterable<string>): Migration[] {
  const done = new Set(applied);
  return list.filter((m) => !done.has(m.id));
}

/** 이미 적용했는데 지금 코드의 SQL과 해시가 다른 마이그레이션 id(배포 뒤에 고친 것: 경고만 하고 다시 실행하지 않음) */
export function changedMigrations(list: readonly Migration[], applied: readonly { id: string; hash: string }[]): string[] {
  const byId = new Map(list.map((m) => [m.id, migrationHash(m)]));
  return applied.filter((a) => byId.has(a.id) && byId.get(a.id) !== a.hash).map((a) => a.id);
}
