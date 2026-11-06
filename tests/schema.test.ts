import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCHEMA_SQL } from "../src/lib/schema-sql.ts";
import {
  BASE_MIGRATION_ID, LATER_MIGRATIONS, MIGRATIONS_TABLE_SQL, allMigrations, changedMigrations, meaningfulSql, migrationHash, migrationProblems,
  pendingMigrations,
} from "../src/lib/migrations.ts";
import { CONCERN_KIND_KEYS } from "../src/lib/feedback/categories.ts";
import { DEFAULT_SCHOOL_LEVEL, SCHOOL_LEVEL_KEYS } from "../src/lib/school-level.ts";

const fileSql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

test("자동 설치에 쓰는 스키마(schema-sql.ts)는 db/schema.sql과 글자 하나까지 같다", () => {
  assert.equal(SCHEMA_SQL, fileSql, "db/schema.sql을 고쳤다면 `node tests/gen-schema-sql.mjs`로 src/lib/schema-sql.ts를 다시 만드세요.");
});

// 주석을 뺀 문장 목록
const statements = fileSql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((s) => s.trim().replace(/\s+/g, " "))
  .filter(Boolean);

test("스키마는 여러 번 실행해도 안전하다(모두 create … if not exists, drop·truncate·delete 없음)", () => {
  for (const s of statements) assert.match(s, /^create (unique )?(table|index) if not exists /i, s);
  assert.ok(!/\b(drop|truncate)\b|\bdelete from\b/i.test(statements.join(";")));
});

test("표 목록(D1에는 Postgres의 RLS가 없음: 앱만 DB에 접근)", () => {
  const tables = statements.map((s) => /^create table if not exists (\w+)/i.exec(s)?.[1]).filter(Boolean);
  assert.deepEqual([...tables].sort(), [
    "app_settings", "classes", "event_log", "feedback_cards", "feedback_responses", "feedback_rounds", "mandalarts", "students", "teachers",
  ]);
  assert.ok(!/row level security|timestamptz|jsonb|gen_random_uuid|now\(\)/i.test(statements.join(";")), "Postgres 문법이 남아 있음");
});

test("String.raw 템플릿에 넣을 수 없는 글자(` \\ ${)가 없다", () => {
  assert.ok(!/[`\\]|\$\{/.test(fileSql));
});

test("안전 신호 종류: DB check 제약(AI 회차·규칙 신호)이 CONCERN_KINDS와 같다", () => {
  const checks = [...fileSql.matchAll(/(concern_kind|rule_concern_kind) in \(([^)]*)\)/g)];
  assert.equal(checks.length, 2);
  for (const m of checks) {
    const kinds = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    assert.deepEqual(kinds, [...CONCERN_KIND_KEYS], m[1]);
  }
});

test("기본 스키마에 새 열(규칙 안전 신호, 피드백 만드는 중)이 있고 쓰지 않는 error 열은 없다", () => {
  for (const col of ["rule_concern_kind text", "rule_concern_at text", "feedback_pending_until text", "revision integer not null default 0"]) {
    assert.ok(fileSql.includes(col), col);
  }
  assert.ok(!/^\s*error text/m.test(fileSql));
});

// ── 마이그레이션 ──
const MIGRATIONS = allMigrations(SCHEMA_SQL);

test("마이그레이션: 첫 번째는 기본 스키마(db/schema.sql과 같은 글)", () => {
  assert.equal(MIGRATIONS[0].id, BASE_MIGRATION_ID);
  assert.equal(MIGRATIONS[0].sql, fileSql);
  assert.equal(MIGRATIONS.length, 1 + LATER_MIGRATIONS.length);
});

test("마이그레이션 목록: id 형식·중복·순서·빈 SQL 검사", () => {
  assert.deepEqual(migrationProblems(MIGRATIONS), []);
  const base = { id: BASE_MIGRATION_ID, sql: "create table if not exists a (x int);" };
  const v2 = { id: "0002_add_b", sql: "alter table a add column if not exists b text;" };
  const v3 = { id: "0003_add_c", sql: "alter table a add column if not exists c text;" };
  assert.deepEqual(migrationProblems([base, v2, v3]), []);
  assert.ok(migrationProblems([base, v3, v2]).some((p) => p.includes("순서")));
  assert.ok(migrationProblems([base, v2, v2]).some((p) => p.includes("중복")));
  assert.ok(migrationProblems([base, { id: "2_bad", sql: "select 1" }]).some((p) => p.includes("형식")));
  assert.ok(migrationProblems([base, { id: "0002_empty", sql: "-- 주석만\n" }]).some((p) => p.includes("비어")));
  assert.ok(migrationProblems([v2]).some((p) => p.includes(BASE_MIGRATION_ID)));
});

test("마이그레이션: 적용하지 않은 것만 순서대로(기본 스키마는 한 번 적용하면 다시 실행하지 않음)", () => {
  const list = [
    { id: BASE_MIGRATION_ID, sql: "create table if not exists a (x int);" },
    { id: "0002_add_b", sql: "alter table a add column if not exists b text;" },
    { id: "0003_add_c", sql: "alter table a add column if not exists c text;" },
  ];
  assert.deepEqual(pendingMigrations(list, []).map((m) => m.id), [BASE_MIGRATION_ID, "0002_add_b", "0003_add_c"]);
  assert.deepEqual(pendingMigrations(list, [BASE_MIGRATION_ID]).map((m) => m.id), ["0002_add_b", "0003_add_c"]);
  assert.deepEqual(pendingMigrations(list, ["0003_add_c", BASE_MIGRATION_ID, "0002_add_b"]), []);
  // 기록에만 있는 id(더 새 버전이 적용한 것 등)는 무시
  assert.deepEqual(pendingMigrations(list, [BASE_MIGRATION_ID, "0002_add_b", "0003_add_c", "0009_future"]), []);
  // 같은 입력이면 같은 결과(멱등)
  assert.deepEqual(pendingMigrations(list, [BASE_MIGRATION_ID]), pendingMigrations(list, [BASE_MIGRATION_ID]));
});

test("마이그레이션 해시: 주석·공백만 바꾸면 같고, SQL을 바꾸면 다름", () => {
  const a = { id: "0002_x", sql: "-- 설명\nalter table a\n  add column if not exists b text;\n" };
  const b = { id: "0002_x", sql: "-- 다른 설명으로 고침\nalter table a add column if not exists b text;  -- 끝" };
  const c = { id: "0002_x", sql: "alter table a add column if not exists b integer;" };
  assert.equal(meaningfulSql(a.sql), "alter table a add column if not exists b text;");
  assert.equal(migrationHash(a), migrationHash(b));
  assert.notEqual(migrationHash(a), migrationHash(c));
  assert.match(migrationHash(a), /^[0-9a-f]{16}$/);
  assert.deepEqual(changedMigrations([a], [{ id: "0002_x", hash: migrationHash(b) }]), []);
  assert.deepEqual(changedMigrations([c], [{ id: "0002_x", hash: migrationHash(a) }]), ["0002_x"]);
  assert.deepEqual(changedMigrations([a], [{ id: "0099_gone", hash: "x" }]), []);
});

test("마이그레이션 기록 표: 여러 번 실행해도 안전하다", () => {
  const sql = meaningfulSql(MIGRATIONS_TABLE_SQL);
  assert.match(sql, /create table if not exists schema_migrations \(/);
  assert.ok(!/\b(drop|truncate)\b|\bdelete from\b/i.test(sql));
});

test("이후 마이그레이션은 지우는 문장(drop table·truncate·delete)을 쓰지 않는다", () => {
  for (const m of LATER_MIGRATIONS) assert.ok(!/\bdrop table\b|\btruncate\b|\bdelete from\b/i.test(meaningfulSql(m.sql)), m.id);
});

// 이미 배포한 마이그레이션의 해시(주석·공백을 뺀 SQL). 설치된 앱의 schema_migrations에 이 값이 적혀 있고, 다시 실행하지 않으므로
// SQL을 고쳐도 설치된 DB에는 반영되지 않습니다. 바꿀 것이 있으면 고치지 말고 새 마이그레이션을 덧붙이세요.
// 새 마이그레이션을 더하면 그 해시도 여기에 적습니다(아직 배포하기 전이면 고쳐도 됩니다).
// Cloudflare판(v2, D1)의 기본 스키마는 Postgres판(v1)과 다른 DB라 해시도 다릅니다(v1의 0002·0003은 v2 기본 스키마에 들어 있음).
const SHIPPED_HASHES: Record<string, string> = {
  "0001_base": "3dbf4882ec3a7ca9",
};

test("배포한 마이그레이션(기본 스키마 포함)의 SQL은 바뀌지 않았다(주석만 고치는 것은 괜찮음)", () => {
  for (const m of MIGRATIONS) {
    assert.ok(m.id in SHIPPED_HASHES, `${m.id}의 해시를 SHIPPED_HASHES에 적어 주세요: ${migrationHash(m)}`);
    assert.equal(migrationHash(m), SHIPPED_HASHES[m.id], `${m.id}의 SQL이 바뀌었습니다. 고치지 말고 새 마이그레이션을 덧붙이세요.`);
  }
});

// 이후 마이그레이션의 문장 목록(주석을 뺀 것)
const laterStatements = (m: { sql: string }) => meaningfulSql(m.sql).split(";").map((s) => s.trim()).filter(Boolean);

test("이후 마이그레이션은 여러 번 실행해도 안전하고, 이미 행이 있는 표에도 적용된다", () => {
  for (const m of LATER_MIGRATIONS) {
    for (const s of laterStatements(m)) {
      if (/\badd column\b/i.test(s)) {
        // SQLite에는 'add column if not exists'가 없습니다(문법 오류). 이미 있으면 db.ts가 'duplicate column'을 적용된 것으로 봅니다.
        assert.doesNotMatch(s, /\bif not exists\b/i, `${m.id}: ${s}`);
        // not null 열은 default가 있어야 이미 있는 행에 값이 채워집니다(없으면 설치된 앱에서 실패).
        if (/\bnot null\b/i.test(s)) assert.match(s, /\bdefault\b/i, `${m.id}: ${s}`);
      }
      if (/^create /i.test(s)) assert.match(s, /^create (unique )?(table|index) if not exists /i, `${m.id}: ${s}`);
    }
  }
});

test("학생 PIN 사용(require_pin)·학교급(school_level)은 Cloudflare판 기본 스키마에 처음부터 있다(Postgres판 0002·0003)", () => {
  assert.match(meaningfulSql(fileSql), /require_pin integer not null default 1 check \(require_pin in \(0, 1\)\)/);
  const m = /school_level text not null default '(\w+)' check \(school_level in \(([^)]*)\)\)/.exec(meaningfulSql(fileSql));
  assert.ok(m);
  // DB가 받는 값은 화면·API의 학교급 목록(school-level.ts)과 같아야 합니다.
  assert.equal(m[1], DEFAULT_SCHOOL_LEVEL);
  assert.deepEqual([...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]), [...SCHOOL_LEVEL_KEYS]);
  // 지금은 기본 스키마 하나뿐이고, 처음 설치하는 DB에는 그것만 적용합니다.
  assert.deepEqual(pendingMigrations(MIGRATIONS, []).map((x) => x.id), [BASE_MIGRATION_ID, ...LATER_MIGRATIONS.map((x) => x.id)]);
});
