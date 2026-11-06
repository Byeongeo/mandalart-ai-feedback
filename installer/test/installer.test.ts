// 설치 순서(install.ts)와 Cloudflare 호출(cf-api.ts)을 가짜 Cloudflare API(mock-cf.mjs)에 대고 빠르게 확인합니다(wrangler 없이).
// 실행: cd installer && npm test   (먼저 npm run embed로 src/generated/app-bundle.ts가 있어야 함)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-cf.mjs";
import { CfError, cfClient, cleanMessage, koreanError } from "../src/cf-api.ts";
import {
  SETUP_ALPHABET, makeAppSecret, makeSetupToken, makeSubdomain, runInstall, uploadForm, uploadMetadata,
  type InstallEvent, type ProbeResult,
} from "../src/install.ts";
import { TOKEN_PERMISSIONS, tokenTemplateUrl } from "../src/app-manifest.ts";
import { extractToken } from "../src/index.ts";

const GOOD = "goodTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 40자
const A1 = "a".repeat(32);
const A2 = "b".repeat(32);
const bundle = { version: "9.8.7", mainModule: "index.js", modules: [{ name: "index.js", type: "application/javascript+module", b64: false, content: "export default { fetch() { return new Response('hi') } }" }] };

let mock: Awaited<ReturnType<typeof startMock>>;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mock-cf-"));
  mock = await startMock({ workDir: dir });
});
after(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

function fresh(extra: (s: any) => void = () => {}) {
  mock.setState((s) => {
    Object.assign(s, { tokens: {}, accounts: {}, subdomainConflicts: 0, failNext: [], teachersOverride: {}, requests: [], uploads: [] });
    s.tokens[GOOD] = { label: "good", accounts: [A1, A2] };
    s.accounts[A1] = { id: A1, name: "선생님 계정", subdomain: null, scripts: {}, d1: {} };
    s.accounts[A2] = { id: A2, name: "다른 계정", subdomain: "existing-sub", scripts: {}, d1: {} };
    extra(s);
  });
}

async function run(opts: { mode: "install" | "update"; accountId?: string; newSetupCode?: boolean; probe?: () => Promise<ProbeResult> }) {
  const events: InstallEvent[] = [];
  let error: unknown = null;
  try {
    await runInstall({
      cf: cfClient(mock.base, GOOD),
      accountId: opts.accountId ?? A1,
      mode: opts.mode,
      newSetupCode: opts.newSetupCode,
      installerUrl: "https://installer.example.workers.dev",
      bundle,
      emit: (e) => events.push(e),
      probe: opts.probe ?? (async () => ({ ok: true, tokenConfigured: true })),
      sleep: async () => {},
      waitMs: 0,
    });
  } catch (e) {
    error = e;
  }
  return { events, error, done: events.find((e) => e.type === "done") as Extract<InstallEvent, { type: "done" }> | undefined };
}

test("토큰 만들기 링크: 권한 세 가지(계정 설정 읽기, Workers 스크립트·D1 편집)만, R2·Queues 없음", () => {
  const u = new URL(tokenTemplateUrl());
  assert.equal(u.origin + u.pathname, "https://dash.cloudflare.com/profile/api-tokens");
  assert.deepEqual(JSON.parse(u.searchParams.get("permissionGroupKeys")!), [
    { key: "account_settings", type: "read" },
    { key: "workers_scripts", type: "edit" },
    { key: "d1", type: "edit" },
  ]);
  assert.equal(u.searchParams.get("accountId"), "*");
  assert.equal(u.searchParams.get("zoneId"), "all");
  assert.ok(u.searchParams.get("name"));
  assert.equal(TOKEN_PERMISSIONS.length, 3);
});

test("비밀값: 설정 코드는 정해진 글자 24자, APP_SECRET은 32자 이상, 하위 도메인은 mandalart-xxxxxx", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = makeSetupToken();
    assert.equal(t.length, 24);
    for (const ch of t) assert.ok(SETUP_ALPHABET.includes(ch), ch);
    seen.add(t);
    assert.ok(makeAppSecret().length >= 32);
    assert.match(makeSubdomain(), /^mandalart-[a-z0-9]{6}$/);
  }
  assert.equal(seen.size, 200);
});

test("붙여 넣은 글에서 토큰 꺼내기(curl 확인 명령 통째로도 됨), 이상한 값은 거절", () => {
  assert.equal(extractToken(`  ${GOOD}\n`), GOOD);
  assert.equal(extractToken(`curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \\\n -H "Authorization: Bearer ${GOOD}"`), GOOD);
  assert.equal(extractToken(`"${GOOD}"`), GOOD);
  assert.equal(extractToken("짧음"), null);
  assert.equal(extractToken("has space inside token value here"), null);
  assert.equal(extractToken(123), null);
});

test("Cloudflare 오류 메시지에서 토큰을 가리고, 한국어로 설명한다(머리글 없음)", () => {
  assert.equal(cleanMessage(`bad token ${GOOD} here`, [GOOD]), "bad token *** here");
  assert.equal(cleanMessage(`leak ${"Zx9".repeat(14)}`), "leak ***");
  assert.equal(cleanMessage("db 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 ok"), "db 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 ok");
  const msg = koreanError(new CfError(403, [{ code: 10000, message: "Authentication error" }], "앱 올리기"));
  assert.match(msg, /권한/);
  assert.match(msg, /10000/);
  assert.match(koreanError(new CfError(400, [{ code: 10034, message: "workers.api.error.email_verification_required" }], "앱 올리기")), /이메일 인증/);
  assert.match(koreanError(new Error("x")), /예상하지 못한/);
});

test("업로드 metadata: 설치는 비밀값을 넣고, 업데이트는 keep_bindings로 비밀값을 그대로 둔다", async () => {
  const inst = uploadMetadata({ dbId: "db-1", installerUrl: "https://i.example", bundle, secrets: { APP_SECRET: "s".repeat(43), SETUP_TOKEN: "T".repeat(24) } });
  assert.deepEqual(inst, {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "d1", name: "DB", id: "db-1" },
      { type: "plain_text", name: "APP_VERSION", text: "9.8.7" },
      { type: "plain_text", name: "INSTALLER_URL", text: "https://i.example" },
      { type: "secret_text", name: "APP_SECRET", text: "s".repeat(43) },
      { type: "secret_text", name: "SETUP_TOKEN", text: "T".repeat(24) },
    ],
  });
  const upd = uploadMetadata({ dbId: "db-1", installerUrl: "https://i.example", bundle });
  assert.deepEqual(upd.keep_bindings, ["secret_text"]);
  assert.ok(!(upd.bindings as { type: string }[]).some((b) => b.type === "secret_text"));
  const form = uploadForm({ dbId: "db-1", installerUrl: "https://i.example", bundle });
  const mod = form.get("index.js") as File;
  assert.equal(mod.type, "application/javascript+module");
  assert.equal(mod.name, "index.js");
  assert.equal(await mod.text(), bundle.modules[0].content);
});

test("처음 설치: 새 계정이면 workers.dev 하위 도메인을 만들고(이름이 겹치면 다시), D1·Worker·주소 켜기 순서로 한다", async () => {
  fresh((s) => { s.subdomainConflicts = 1; });
  const { error, done, events } = await run({ mode: "install" });
  assert.equal(error, null, String(error));
  assert.ok(done);
  const st = mock.state;
  const sub = st.accounts[A1].subdomain;
  assert.match(sub, /^mandalart-[a-z0-9]{6}$/);
  assert.equal(done.url, `https://mandalart.${sub}.workers.dev`);
  assert.equal(done.ready, true);
  assert.match(done.setupUrl!, new RegExp(`^https://mandalart\\.${sub}\\.workers\\.dev/teacher/setup#code=[${SETUP_ALPHABET}]{24}$`));
  assert.ok(events.some((e) => e.type === "step" && e.step === "wait"));

  const calls = st.requests.map((r: any) => `${r.method} ${r.path.replace(A1, "{a}").replace(/\/d1\/database\/[^/]+\/query/, "/d1/database/{db}/query")}`);
  assert.deepEqual(calls, [
    "GET /accounts/{a}/workers/scripts",
    "GET /accounts/{a}/workers/subdomain",
    "PUT /accounts/{a}/workers/subdomain", // 겹침(409, 10031)
    "GET /accounts/{a}/workers/subdomain",
    "PUT /accounts/{a}/workers/subdomain",
    "GET /accounts/{a}/d1/database",
    "POST /accounts/{a}/d1/database",
    "PUT /accounts/{a}/workers/scripts/mandalart",
    "POST /accounts/{a}/workers/scripts/mandalart/subdomain",
  ]);
  const d1Create = st.requests.find((r: any) => r.method === "POST" && r.path.endsWith("/d1/database"));
  assert.deepEqual(d1Create.json, { name: "mandalart-db", primary_location_hint: "apac" });
  const enable = st.requests.find((r: any) => r.path.endsWith("/mandalart/subdomain"));
  assert.deepEqual(enable.json, { enabled: true, previews_enabled: false });
  const up = st.uploads[0];
  assert.equal(up.query, "?excludeScript=true");
  const dbId = Object.keys(st.accounts[A1].d1)[0];
  const byName = Object.fromEntries(up.metadata.bindings.map((b: any) => [b.name, b]));
  assert.deepEqual(byName.DB, { type: "d1", name: "DB", id: dbId });
  assert.equal(byName.APP_VERSION.text, "9.8.7");
  assert.equal(byName.INSTALLER_URL.text, "https://installer.example.workers.dev");
  assert.equal(byName.SETUP_TOKEN.text, done.setupUrl!.split("#code=")[1]);
  assert.ok(byName.APP_SECRET.text.length >= 32);
  assert.equal(up.metadata.keep_bindings, undefined);
  for (const r of st.requests) assert.equal(r.auth, "good");
});

test("이미 설치되어 교사 계정이 있으면 새로 설치하지 않고 업데이트로 안내한다(아무것도 만들거나 올리지 않음)", async () => {
  fresh();
  assert.equal((await run({ mode: "install" })).error, null);
  const dbId = Object.keys(mock.state.accounts[A1].d1)[0];
  mock.setState((s) => { s.teachersOverride[dbId] = 1; s.requests = []; s.uploads = []; });
  const { error } = await run({ mode: "install" });
  assert.match(koreanError(error), /이미 앱이 설치되어/);
  assert.match(koreanError(error), /업데이트/);
  assert.equal(mock.state.uploads.length, 0);
  assert.ok(!mock.state.requests.some((r: any) => r.method !== "GET" && !r.path.endsWith("/query")));
});

test("지난번 설치가 끝나기 전에 끊겼으면(교사 계정 없음) 같은 D1로 이어서 설치한다", async () => {
  fresh((s) => { s.failNext = [{ method: "POST", path: "/workers/scripts/mandalart/subdomain$", status: 500, errors: [{ code: 10013, message: "boom" }] }]; });
  const first = await run({ mode: "install" });
  assert.match(koreanError(first.error), /잠깐 문제/);
  const dbId = Object.keys(mock.state.accounts[A1].d1)[0];
  const second = await run({ mode: "install" });
  assert.equal(second.error, null, String(second.error));
  assert.equal(Object.keys(mock.state.accounts[A1].d1).length, 1, "D1을 하나 더 만들지 않음");
  const last = mock.state.uploads.at(-1);
  assert.equal(last.metadata.bindings.find((b: any) => b.name === "DB").id, dbId);
  assert.ok(second.events.some((e) => e.type === "step" && /이어서/.test(e.message)));
});

test("업데이트: 같은 D1, 새 버전·설치 주소, keep_bindings로 APP_SECRET·SETUP_TOKEN 유지(비밀값을 보내지 않음)", async () => {
  fresh();
  const inst = await run({ mode: "install" });
  const before = mock.state.accounts[A1].scripts.mandalart.bindings.filter((b: any) => b.type === "secret_text");
  mock.setState((s) => { s.requests = []; });
  const upd = await run({ mode: "update" });
  assert.equal(upd.error, null, String(upd.error));
  assert.equal(upd.done!.url, inst.done!.url);
  assert.equal(upd.done!.setupUrl, undefined);
  const last = mock.state.uploads.at(-1);
  assert.deepEqual(last.metadata.keep_bindings, ["secret_text"]);
  assert.ok(!last.metadata.bindings.some((b: any) => b.type === "secret_text"));
  assert.deepEqual(last.keptNames.sort(), ["APP_SECRET", "SETUP_TOKEN"]);
  const after = mock.state.accounts[A1].scripts.mandalart.bindings.filter((b: any) => b.type === "secret_text");
  assert.deepEqual(after.map((b: any) => [b.name, b.text]).sort(), before.map((b: any) => [b.name, b.text]).sort());
  // 업데이트는 하위 도메인·D1을 새로 만들지 않음
  assert.ok(!mock.state.requests.some((r: any) => r.method === "PUT" && r.path.endsWith("/workers/subdomain")));
  assert.ok(!mock.state.requests.some((r: any) => r.method === "POST" && r.path.endsWith("/d1/database")));
  assert.ok(mock.state.requests.some((r: any) => r.path.endsWith("/workers/scripts/mandalart/settings")));
});

test("업데이트 + 새 설정 코드: secrets 주소로 SETUP_TOKEN만 바꾸고 새 설정 링크를 준다", async () => {
  fresh();
  await run({ mode: "install" });
  const oldSecret = mock.state.accounts[A1].scripts.mandalart.bindings.find((b: any) => b.name === "APP_SECRET").text;
  const upd = await run({ mode: "update", newSetupCode: true });
  assert.equal(upd.error, null, String(upd.error));
  const put = mock.state.requests.find((r: any) => r.path.endsWith("/secrets"));
  assert.equal(put.json.name, "SETUP_TOKEN");
  assert.equal(put.json.type, "secret_text");
  assert.equal(upd.done!.setupUrl!.split("#code=")[1], put.json.text);
  assert.equal(mock.state.accounts[A1].scripts.mandalart.bindings.find((b: any) => b.name === "APP_SECRET").text, oldSecret);
});

test("업데이트할 앱이 없으면 한국어로 '처음 설치'를 안내한다", async () => {
  fresh();
  const { error } = await run({ mode: "update", accountId: A2 });
  assert.match(koreanError(error), /아직 설치된 앱이 없어요/);
});

test("교사 기록이 있는 예전 D1이 남아 있으면 건드리지 않고 멈춘다", async () => {
  fresh((s) => {
    s.accounts[A2].d1["old-db"] = { uuid: "old-db", name: "mandalart-db", created_at: "2025-01-01" };
    s.teachersOverride["old-db"] = 2;
  });
  const { error } = await run({ mode: "install", accountId: A2 });
  assert.match(koreanError(error), /예전에 쓰던 데이터베이스/);
  assert.equal(mock.state.uploads.length, 0);
});

test("권한이 없거나 이메일 인증 전이면 한국어로 알려 주고, 오류 문구에 토큰이 들어가지 않는다", async () => {
  fresh((s) => { s.tokens[GOOD].perms = { d1: false }; });
  let r = await run({ mode: "install" });
  assert.match(koreanError(r.error), /권한/);
  fresh((s) => { s.accounts[A1].emailVerified = false; });
  r = await run({ mode: "install" });
  assert.match(koreanError(r.error), /이메일 인증/);
  fresh((s) => { s.failNext = [{ method: "POST", path: "/d1/database$", status: 400, errors: [{ code: 7400, message: "token {TOKEN} rejected" }] }]; });
  r = await run({ mode: "install" });
  const msg = koreanError(r.error);
  assert.ok(!msg.includes(GOOD), msg);
  assert.match(msg, /7400/);
});

test("앱이 아직 대답하지 않으면 기다린 뒤 ready=false로 끝낸다(설치는 끝남)", async () => {
  fresh();
  const { error, done } = await run({ mode: "install", probe: async () => ({ ok: false }) });
  assert.equal(error, null);
  assert.equal(done!.ready, false);
});
