import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import * as nodeModule from "node:module";
import { DB_URL_MISSING, normalizeDbUrl, pickDbUrl } from "../src/lib/dbconfig.ts";
import { SESSION_SECRET_MIN, envSessionSecret, newSessionSecret, sessionSecretWarning, usableStoredSecret } from "../src/lib/secret.ts";
import { CONCERN_KIND_KEYS, normalizeConcern } from "../src/lib/feedback/categories.ts";

test("DB 주소: DATABASE_URL을 먼저, 없으면 POSTGRES_URL, 빈 값은 없는 것으로", () => {
  assert.equal(pickDbUrl({ DATABASE_URL: "postgres://a", POSTGRES_URL: "postgres://b" }), "postgres://a");
  assert.equal(pickDbUrl({ DATABASE_URL: "  ", POSTGRES_URL: "postgres://b" }), "postgres://b");
  assert.equal(pickDbUrl({ POSTGRES_URL: "postgres://b" }), "postgres://b");
  assert.equal(pickDbUrl({}), null);
  assert.equal(pickDbUrl({ DATABASE_URL: "" }), null);
});

test("DB 주소 다듬기: Neon은 channel_binding을 빼고 sslmode=verify-full(인증서 확인)로", () => {
  const neon = "postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
  const out = new URL(normalizeDbUrl(neon));
  assert.equal(out.searchParams.get("sslmode"), "verify-full");
  assert.equal(out.searchParams.has("channel_binding"), false);
  assert.equal(out.hostname, "ep-x-pooler.ap-southeast-1.aws.neon.tech");
  assert.equal(out.username, "u");
  assert.equal(out.password, "p");
  assert.equal(out.pathname, "/neondb");
});

test("DB 주소 다듬기: 원격은 sslmode가 없거나 약해도 verify-full 하나만, 내 컴퓨터는 그대로", () => {
  const remote = (q: string) => new URL(normalizeDbUrl(`postgres://u:p@db.example.com:5432/x${q}`)).searchParams;
  for (const q of ["", "?sslmode=require", "?sslmode=prefer", "?sslmode=disable", "?ssl=true", "?sslmode=verify-ca&sslrootcert=system", "?sslmode=verify-full"]) {
    const p = remote(q);
    assert.deepEqual(p.getAll("sslmode"), ["verify-full"], q);
    assert.equal(p.has("ssl"), false, q);
    assert.equal(p.has("sslrootcert"), false, q);
  }
  // 다른 설정은 그대로 둡니다.
  assert.equal(remote("?application_name=app&sslmode=require").get("application_name"), "app");
  // 내 컴퓨터(localhost, 127.0.0.1, ::1, 유닉스 소켓)는 TLS 없이 그대로
  assert.equal(new URL(normalizeDbUrl("postgres://u@127.0.0.1:54329/x")).searchParams.has("sslmode"), false);
  assert.equal(new URL(normalizeDbUrl("postgres://u@localhost/x")).searchParams.has("sslmode"), false);
  assert.equal(new URL(normalizeDbUrl("postgres://u@[::1]:5432/x")).searchParams.has("sslmode"), false);
  assert.equal(new URL(normalizeDbUrl("postgres://u@localhost/x?sslmode=disable")).searchParams.get("sslmode"), "disable");
  assert.equal(new URL(normalizeDbUrl("postgres://u@x/db?host=/var/run/postgresql")).searchParams.has("sslmode"), false);
  assert.equal(new URL(normalizeDbUrl("postgres:///db")).searchParams.has("sslmode"), false);
  assert.equal(normalizeDbUrl("이상한 값"), "이상한 값");
});

test("세션 비밀값: 환경 변수가 32자 이상일 때만 쓰고, 아니면 DB 자동값으로(경고는 짧을 때만)", () => {
  const long = "x".repeat(SESSION_SECRET_MIN);
  assert.equal(envSessionSecret({ SESSION_SECRET: long }), long);
  assert.equal(envSessionSecret({ SESSION_SECRET: ` ${long} ` }), long);
  assert.equal(envSessionSecret({ SESSION_SECRET: "short" }), null);
  assert.equal(envSessionSecret({ SESSION_SECRET: "" }), null);
  assert.equal(envSessionSecret({}), null);
  assert.equal(sessionSecretWarning({}), null);
  assert.equal(sessionSecretWarning({ SESSION_SECRET: long }), null);
  const w = sessionSecretWarning({ SESSION_SECRET: "short-secret" });
  assert.ok(w && w.includes("32자"));
  assert.ok(!w!.includes("short-secret"), "경고에 값이 들어가면 안 됨");
});

test("세션 비밀값: 새로 만든 값은 64자 16진수이고 매번 다름, 저장값 검사", () => {
  const a = newSessionSecret();
  const b = newSessionSecret();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(usableStoredSecret(a), true);
  assert.equal(usableStoredSecret("짧음"), false);
  assert.equal(usableStoredSecret(null), false);
  assert.equal(usableStoredSecret(undefined), false);
});

test("안전 신호 다듬기: 표시 없으면 종류도 없음, 종류가 없거나 낯설면 other", () => {
  assert.deepEqual(normalizeConcern({ flag: false, kind: "self_harm" }), { flag: false, kind: null });
  assert.deepEqual(normalizeConcern({ flag: true, kind: "self_harm" }), { flag: true, kind: "self_harm" });
  assert.deepEqual(normalizeConcern({ flag: true, kind: null }), { flag: true, kind: "other" });
  assert.deepEqual(normalizeConcern({ flag: true, kind: "toString" }), { flag: true, kind: "other" });
  assert.deepEqual(normalizeConcern({ flag: "true", kind: "abuse" }), { flag: false, kind: null });
  assert.deepEqual(normalizeConcern(null), { flag: false, kind: null });
  assert.deepEqual(normalizeConcern({ flag: true, kind: "bullying" }), { flag: true, kind: "bullying" });
  // AI가 concern을 빼먹거나 이상한 모양으로 보내도 실패가 아니라 '신호 없음'
  assert.deepEqual(normalizeConcern(undefined), { flag: false, kind: null });
  assert.deepEqual(normalizeConcern("true"), { flag: false, kind: null });
  assert.deepEqual(normalizeConcern([true]), { flag: false, kind: null });
  // DB check 제약과 같은 여섯 종류
  assert.deepEqual([...CONCERN_KIND_KEYS], ["self_harm", "abuse", "bullying", "eating", "violence", "other"]);
});

// ── DB 연결 확인(checkDb): 표 준비를 한 번 끝낸 뒤 DB가 멈춰도 알아차림 ─────────────
// 서버 전용 모듈(import "server-only", 확장자 없는 상대 경로)을 테스트에서 불러오기 위한 설정
type Resolved = { url: string; shortCircuit?: boolean };
(nodeModule as unknown as {
  registerHooks(h: { resolve(s: string, c: object, next: (s: string, c: object) => Resolved): Resolved }): void;
}).registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

// 아무도 듣지 않는 포트(잠깐 열었다 닫은 포트)
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test("DB 연결 확인: 표 준비가 끝난 인스턴스라도 DB에 실제로 물어 보고, 실패하면 설정 화면용 한국어 문구", async () => {
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  // 이 인스턴스에서 이미 표 준비(ensureSchema)를 마친 상태로 시작합니다.
  (globalThis as { __mandalartDb?: object }).__mandalartDb = { ready: true };
  const { checkDb, sql, DB_UNREACHABLE } = await import("../src/lib/db.ts");
  const quiet = console.error;
  console.error = () => {}; // 실패 기록(서버 로그용)은 테스트 출력에 남기지 않음
  try {
    assert.deepEqual(await checkDb(), { ok: false, error: DB_URL_MISSING });
    process.env.DATABASE_URL = `postgres://app@127.0.0.1:${await closedPort()}/mandalart`;
    assert.deepEqual(await checkDb(), { ok: false, error: DB_UNREACHABLE });
    assert.match(DB_UNREACHABLE, /^데이터베이스에 연결하지 못했습니다\./);
  } finally {
    console.error = quiet;
    await sql.end({ timeout: 1 });
  }
});
