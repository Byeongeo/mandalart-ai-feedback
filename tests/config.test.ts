import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { SESSION_SECRET_MIN, envSessionSecret, newSessionSecret, sessionSecretWarning, usableStoredSecret } from "../src/lib/secret.ts";
import { CONCERN_KIND_KEYS, normalizeConcern } from "../src/lib/feedback/categories.ts";

test("세션 비밀값: Cloudflare 비밀값 APP_SECRET이 32자 이상일 때만 쓰고, 아니면 DB 자동값으로(경고는 짧을 때만)", () => {
  const long = "x".repeat(SESSION_SECRET_MIN);
  assert.equal(envSessionSecret({ APP_SECRET: long }), long);
  assert.equal(envSessionSecret({ APP_SECRET: ` ${long} ` }), long);
  assert.equal(envSessionSecret({ APP_SECRET: "short" }), null);
  assert.equal(envSessionSecret({ APP_SECRET: "" }), null);
  assert.equal(envSessionSecret({}), null);
  // 예전 이름(SESSION_SECRET)이나 문자열이 아닌 값은 보지 않음
  assert.equal(envSessionSecret({ SESSION_SECRET: long }), null);
  assert.equal(envSessionSecret({ APP_SECRET: 123 }), null);
  assert.equal(sessionSecretWarning({}), null);
  assert.equal(sessionSecretWarning({ APP_SECRET: long }), null);
  const w = sessionSecretWarning({ APP_SECRET: "short-secret" });
  assert.ok(w && w.includes("32자") && w.includes("APP_SECRET"));
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

test("DB 연결 확인: 표 준비가 끝난 인스턴스라도 DB에 실제로 물어 보고, 실패하면 설정 화면용 한국어 문구", async () => {
  // 이 인스턴스에서 이미 표 준비(ensureSchema)를 마친 상태로 시작합니다.
  (globalThis as { __mandalartSchema?: object }).__mandalartSchema = { ready: true };
  const { checkDb, setDbForTests, DB_UNREACHABLE } = await import("../src/lib/db.ts");
  const quiet = console.error;
  console.error = () => {}; // 실패 기록(서버 로그용)은 테스트 출력에 남기지 않음
  const broken = {
    prepare() {
      const st = { bind: () => st, all: async () => { throw new Error("D1_ERROR: network connection lost"); } };
      return st;
    },
    batch: async () => { throw new Error("D1_ERROR: network connection lost"); },
  };
  const working = {
    prepare() {
      const st = { bind: () => st, all: async () => ({ results: [{ one: 1 }], meta: { changes: 0 } }) };
      return st;
    },
    batch: async () => [],
  };
  try {
    setDbForTests(broken);
    const r = await checkDb();
    assert.deepEqual(r, { ok: false, error: DB_UNREACHABLE });
    assert.match(DB_UNREACHABLE, /^데이터베이스에 연결하지 못했습니다\./);
    // 오류 문구에 DB 원문(영어 오류)은 넣지 않음
    assert.ok(!JSON.stringify(r).includes("D1_ERROR"));
    setDbForTests(working);
    assert.deepEqual(await checkDb(), { ok: true });
  } finally {
    console.error = quiet;
    setDbForTests(null);
    delete (globalThis as { __mandalartSchema?: object }).__mandalartSchema;
  }
});
