import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCHEMA_SQL } from "../src/lib/schema-sql.ts";
import {
  BASE_MIGRATION_ID, LATER_MIGRATIONS, MIGRATIONS_TABLE_SQL, allMigrations, changedMigrations, meaningfulSql, migrationHash, migrationProblems,
  pendingMigrations,
} from "../src/lib/migrations.ts";
import { CONCERN_KIND_KEYS } from "../src/lib/feedback/categories.ts";

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

test("스키마는 여러 번 실행해도 안전하다(create는 모두 if not exists, drop·truncate·delete 없음)", () => {
  for (const s of statements) {
    if (/^create /i.test(s)) assert.match(s, /^create (unique )?(table|index) if not exists /i, s);
    else assert.match(s, /^alter table \w+ enable row level security$/i, s);
  }
  assert.ok(!/\b(drop|truncate)\b|\bdelete from\b/i.test(statements.join(";")));
});

test("모든 표에 RLS를 켠다", () => {
  const tables = statements.map((s) => /^create table if not exists (\w+)/i.exec(s)?.[1]).filter(Boolean);
  const rls = statements.map((s) => /^alter table (\w+) enable row level security$/i.exec(s)?.[1]).filter(Boolean);
  assert.deepEqual([...rls].sort(), [...tables].sort());
  assert.deepEqual([...tables].sort(), [
    "app_settings", "classes", "event_log", "feedback_cards", "feedback_responses", "feedback_rounds", "mandalarts", "students", "teachers",
  ]);
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
  for (const col of ["rule_concern_kind text", "rule_concern_at timestamptz", "feedback_pending_until timestamptz"]) {
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

test("마이그레이션 기록 표: 여러 번 실행해도 안전하고 RLS를 켠다", () => {
  const sql = meaningfulSql(MIGRATIONS_TABLE_SQL);
  assert.match(sql, /create table if not exists schema_migrations \(/);
  assert.match(sql, /alter table schema_migrations enable row level security;/);
  assert.ok(!/\b(drop|truncate)\b|\bdelete from\b/i.test(sql));
});

test("이후 마이그레이션은 지우는 문장(drop table·truncate·delete)을 쓰지 않는다", () => {
  for (const m of LATER_MIGRATIONS) assert.ok(!/\bdrop table\b|\btruncate\b|\bdelete from\b/i.test(meaningfulSql(m.sql)), m.id);
});
