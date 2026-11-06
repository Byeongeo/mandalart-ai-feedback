// 설치 페이지 전체 흐름 시험(브라우저): 가짜 Cloudflare API(mock-cf.mjs) + `wrangler dev`로 띄운 설치 페이지 + Playwright.
// 가짜 API는 올린 앱 모듈을 실제로 `wrangler dev`로 띄우므로, 설치 페이지의 '앱이 대답하는지 확인'과
// 업데이트 뒤 비밀값·데이터가 남는지까지 확인합니다.
// 실행: cd installer && npm run embed && node --experimental-strip-types --no-warnings test/e2e.mjs
// 환경 변수: E2E_WORKDIR(임시 폴더), INSTALLER_PORT(기본 8789), HEADLESS=0(창 보기)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-cf.mjs";
import { APP_MODULES, APP_VERSION, APP_MAIN_MODULE } from "../src/generated/app-bundle.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = new URL("..", import.meta.url).pathname;
const ROOT = join(HERE, "..");
const WORK = process.env.E2E_WORKDIR ?? join(tmpdir(), "mandalart-installer-e2e");
const PORT = Number(process.env.INSTALLER_PORT ?? 8789);
const ORIGIN = `http://localhost:${PORT}`;

const GOOD = "e2eGoodToken0123456789abcdefghijklmnopqr"; // 40자
const NOPERM = "e2eNoPermToken0123456789abcdefghijklmnop";
const BAD = "e2eWrongToken0123456789abcdefghijklmnopq";
const ALL_TOKENS = [GOOD, NOPERM, BAD];
const A1 = "1".repeat(32);
const A2 = "2".repeat(32);

const results = [];
let failed = 0;
/** 설치 페이지 문제가 아니라 앱(다른 작업 중) 쪽 사정으로 확인하지 못한 것 */
class Skip extends Error {}
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    if (e instanceof Skip) results.push(`SKIP ${name}: ${e.message}`);
    else {
      failed++;
      results.push(`FAIL ${name}: ${e?.stack ?? e}`);
    }
  }
  console.log(results.at(-1).split("\n")[0]);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const logsBefore = new Set(listWranglerLogs());

// ── 1. 가짜 Cloudflare API ──
const mock = await startMock({ workDir: join(WORK, "mock"), deployApps: true, log: (m) => console.log(m) });
mock.setState((s) => {
  s.tokens[GOOD] = { label: "good", accounts: [A1, A2] };
  s.tokens[NOPERM] = { label: "noperm", accounts: [A1], perms: { d1: false } };
  s.accounts[A1] = { id: A1, name: "김선생 계정", subdomain: null, scripts: {}, d1: {} };
  s.accounts[A2] = { id: A2, name: "학교 공용 계정", subdomain: "school-shared", scripts: {}, d1: {} };
  s.subdomainConflicts = 1;
});

// ── 2. 설치 페이지(wrangler dev) ──
// 다른 개발 서버가 같은 포트를 쓰고 있으면 엉뚱한 서버를 시험하게 되므로 먼저 확인합니다.
{
  const { createServer } = await import("node:net");
  const busy = await new Promise((r) => {
    const s = createServer().once("error", () => r(true)).listen(PORT, "127.0.0.1", () => s.close(() => r(false)));
  });
  if (busy) throw new Error(`포트 ${PORT}을(를) 이미 다른 프로그램이 쓰고 있습니다. INSTALLER_PORT=다른번호 로 실행하세요.`);
}
const installerLog = join(WORK, "installer-wrangler.log");
let installerOut = "";
const installer = spawn(process.execPath, [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1",
  "--var", `CF_API_BASE:${mock.base}`, "--show-interactive-dev-session=false", "--persist-to", join(WORK, "installer-state")], {
  cwd: HERE,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
installer.stdout.on("data", (b) => { installerOut += b; });
installer.stderr.on("data", (b) => { installerOut += b; });
for (let i = 0; i < 120 && !/Ready on/.test(installerOut); i++) await sleep(500);
if (!/Ready on/.test(installerOut)) {
  console.error(installerOut);
  throw new Error("설치 페이지 wrangler dev가 뜨지 않았습니다.");
}

const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ko-KR" });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const apiBodies = [];
page.on("response", async (r) => {
  if (r.url().includes("/api/")) apiBodies.push(await r.text().catch(() => ""));
});
const shot = (name) => page.screenshot({ path: join(WORK, `${name}.png`), fullPage: true });

async function pasteAndCheck(tokenText) {
  await page.fill("#token", tokenText);
  await page.click("#check");
  await page.waitForFunction(() => {
    const m = document.getElementById("check-msg");
    return m && /good|bad/.test(m.className);
  }, null, { timeout: 30_000 });
  return page.textContent("#check-msg");
}

async function freshPage(hash = "") {
  await page.goto("about:blank");
  await page.goto(`${ORIGIN}/${hash}`);
}

async function runToDone({ account, update = false, newCode = false }) {
  await freshPage(update ? "#update" : "");
  const msg = await pasteAndCheck(GOOD);
  assert(/토큰이 맞아요/.test(msg), `계정 확인 실패: ${msg}`);
  await page.check(`input[name=account][value="${account}"]`);
  if (newCode) await page.check("#new-code");
  await page.click("#start");
  await page.waitForSelector("#step4:not([hidden]), #error:not([hidden])", { timeout: 150_000 });
  const err = await page.$("#error:not([hidden])");
  if (err) throw new Error(`설치 오류 표시: ${await err.textContent()}`);
}

let setupCode = "";
let appUrl = "";
let teacherCreated = false;

try {
  await check("첫 화면: 한국어 안내, 토큰 링크(권한 3개), 보안 머리글, 휴대폰 폭에서 가로 스크롤 없음", async () => {
    const res = await page.goto(`${ORIGIN}/`);
    const h = res.headers();
    assert(/script-src 'self'/.test(h["content-security-policy"] ?? ""), "CSP 없음");
    assert(h["x-frame-options"] === "DENY" && h["cache-control"] === "no-store" && h["x-content-type-options"] === "nosniff", "보안 머리글");
    assert((await page.textContent("h1")).includes("설치하기"), "제목");
    const href = await page.getAttribute("#token-link", "href");
    const u = new URL(href);
    assert(u.origin === "https://dash.cloudflare.com" && u.pathname === "/profile/api-tokens", href);
    const perms = JSON.parse(u.searchParams.get("permissionGroupKeys"));
    assert(JSON.stringify(perms) === JSON.stringify([{ key: "account_settings", type: "read" }, { key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" }]), JSON.stringify(perms));
    assert(u.searchParams.get("accountId") === "*" && u.searchParams.get("zoneId") === "all", "accountId/zoneId");
    const bodyText = await page.textContent("body");
    assert(!/OpenRouter API 키|openrouter 키를 입력/i.test(bodyText), "OpenRouter 키 입력 안내가 있으면 안 됨");
    assert(!(await page.$("input[name*=openrouter i], #openrouter")), "OpenRouter 입력칸");
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(sw <= 390, `가로 스크롤 ${sw}`);
    await shot("01-first");
  });

  await check("OpenRouter 키를 붙여 넣으면 서버로 보내지 않고 한국어로 막는다", async () => {
    const n = mock.state.requests.length;
    const msg = await pasteAndCheck("sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef");
    assert(/OpenRouter/.test(msg) && /Cloudflare 설치 토큰/.test(msg), msg);
    assert(mock.state.requests.length === n, "가짜 API로 요청이 감");
    // 서버도 거절(브라우저 검사를 건너뛴 경우)
    const r = await page.evaluate(async () => {
      const res = await fetch("/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "sk-or-v1-abcdefabcdefabcdefabcdefabcdef" }) });
      return { status: res.status, body: await res.json() };
    });
    assert(r.status === 400 && /OpenRouter/.test(r.body.error), JSON.stringify(r));
    assert(mock.state.requests.length === n, "가짜 API로 요청이 감(서버)");
  });

  await check("틀린 토큰: 한국어 오류", async () => {
    const msg = await pasteAndCheck(BAD);
    assert(/토큰이 맞지 않거나 만료/.test(msg), msg);
    assert(!msg.includes(BAD), "오류에 토큰");
  });

  await check("권한이 빠진 토큰: 빠진 권한 이름과 함께 한국어 오류", async () => {
    const msg = await pasteAndCheck(NOPERM);
    assert(/권한이 빠져 있어요/.test(msg) && /D1/.test(msg), msg);
    await shot("02-missing-permission");
  });

  await check("Cloudflare의 확인용 curl 명령을 통째로 붙여 넣어도 계정 두 개를 보여 준다", async () => {
    const msg = await pasteAndCheck(`curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \\\n     -H "Authorization: Bearer ${GOOD}"`);
    assert(/여러 개/.test(msg), msg);
    const names = await page.$$eval("#account-list .choice", (els) => els.map((e) => e.textContent));
    assert(names.length === 2 && names[0].includes("김선생 계정"), names.join("|"));
    assert(await page.isDisabled("#start"), "계정을 고르기 전에는 시작 버튼이 꺼져 있어야 함");
    await shot("03-accounts");
  });

  await check("처음 설치: 진행 상황 → 완료 화면(앱 주소, 첫 교사 계정 만들기, 토큰 지우기, AI 연결 키 안내)", async () => {
    await runToDone({ account: A1 });
    const sub = mock.state.accounts[A1].subdomain;
    assert(/^mandalart-[a-z0-9]{6}$/.test(sub), `하위 도메인 ${sub}`);
    appUrl = await page.inputValue("#app-url");
    assert(appUrl === `https://mandalart.${sub}.workers.dev`, appUrl);
    const setupHref = await page.getAttribute("#setup-link", "href");
    setupCode = await page.inputValue("#setup-code");
    assert(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{24}$/.test(setupCode), setupCode);
    assert(setupHref === `${appUrl}/teacher/setup#code=${setupCode}`, setupHref);
    const done = await page.textContent("#step4");
    assert(/토큰 지우러 가기/.test(done) && /AI 연결 키/.test(done) && /강사에게 받은 키/.test(done), "완료 안내");
    assert(await page.getAttribute("#step4 a[href='https://dash.cloudflare.com/profile/api-tokens']", "href"), "토큰 지우기 링크");
    assert((await page.inputValue("#token")) === "", "끝난 뒤 토큰 칸을 비움");
    const ready = await page.textContent("#ready-msg");
    console.log(`  · 앱 대답: ${ready}`);
    await shot("04-done");
  });

  await check("업로드 내용: multipart metadata(main_module·호환 날짜·플래그·바인딩)와 모듈이 앱 빌드와 같다", async () => {
    const up = mock.state.uploads[0];
    assert(up && up.accountId === A1 && up.name === "mandalart", "업로드 없음");
    const md = up.metadata;
    assert(md.main_module === APP_MAIN_MODULE, md.main_module);
    assert(md.compatibility_date === "2026-10-01" && JSON.stringify(md.compatibility_flags) === '["nodejs_compat"]', "compat");
    const b = Object.fromEntries(md.bindings.map((x) => [x.name, x]));
    const dbId = Object.keys(mock.state.accounts[A1].d1)[0];
    assert(b.DB?.type === "d1" && b.DB.id === dbId, JSON.stringify(b.DB));
    assert(b.APP_VERSION?.type === "plain_text" && b.APP_VERSION.text === APP_VERSION, "APP_VERSION");
    assert(b.INSTALLER_URL?.type === "plain_text" && b.INSTALLER_URL.text === ORIGIN, `INSTALLER_URL ${b.INSTALLER_URL?.text}`);
    assert(b.APP_SECRET?.type === "secret_text" && b.APP_SECRET.text.length >= 32, "APP_SECRET");
    assert(b.SETUP_TOKEN?.type === "secret_text" && b.SETUP_TOKEN.text === setupCode, "SETUP_TOKEN");
    assert(md.keep_bindings === undefined, "설치에는 keep_bindings 없음");
    assert(Object.keys(md).sort().join() === "bindings,compatibility_date,compatibility_flags,main_module", Object.keys(md).join());
    for (const m of APP_MODULES) {
      const part = up.parts.find((p) => p.name === m.name);
      const want = createHash("sha256").update(m.b64 ? Buffer.from(m.content, "base64") : Buffer.from(m.content, "utf8")).digest("hex");
      assert(part && part.sha256 === want && part.filename === m.name && part.type === m.type, `모듈 ${m.name}: ${JSON.stringify(part)}`);
    }
    assert(up.parts.length === APP_MODULES.length, "모듈 개수");
    const d1 = mock.state.requests.find((r) => r.method === "POST" && r.path.endsWith("/d1/database"));
    assert(d1.json.name === "mandalart-db" && d1.json.primary_location_hint === "apac", JSON.stringify(d1.json));
    const en = mock.state.requests.find((r) => r.path.endsWith("/workers/scripts/mandalart/subdomain"));
    assert(en.json.enabled === true && en.json.previews_enabled === false, JSON.stringify(en.json));
    const puts = mock.state.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/workers/subdomain"));
    assert(puts.length === 2, `하위 도메인 만들기 시도 ${puts.length}번(첫 번째는 겹침)`);
  });

  await check("(보너스) 올린 앱이 실제로 떠서 /api/auth/setup에 대답하고 설정 코드가 들어가 있다", async () => {
    let r = null;
    for (let i = 0; i < 60; i++) {
      r = await fetch(`${mock.url}/__probe/${new URL(appUrl).host}/api/auth/setup`).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch(() => null);
      if (r?.status === 200) break;
      await sleep(1000);
    }
    assert(r?.status === 200, `앱 응답 ${JSON.stringify(r)}\n${mock.appOutput(A1).slice(-1500)}`);
    console.log(`  · 앱 /api/auth/setup: ${JSON.stringify(r.body)}`);
    assert(r.body.tokenConfigured === true, "SETUP_TOKEN이 앱에 들어가 있지 않음");
  });

  await check("(보너스) 설정 코드로 첫 교사 계정 만들기(앱이 지금 DB를 다룰 수 있을 때만)", async () => {
    const r = await fetch(`${mock.url}/__probe/${new URL(appUrl).host}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: setupCode, loginId: "kimteacher", displayName: "김선생", password: "correct-horse-battery" }),
    }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
    console.log(`  · 교사 계정 만들기: ${r.status} ${JSON.stringify(r.body)}`);
    teacherCreated = r.status === 200 || r.status === 201;
    if (!teacherCreated) {
      // 앱(다른 사람이 작업 중)이 아직 D1에서 동작하지 않으면 가짜 API에 '교사 있음'을 알려 다음 시험을 이어 갑니다.
      const dbId = Object.keys(mock.state.accounts[A1].d1)[0];
      mock.setState((s) => { s.teachersOverride[dbId] = 1; });
      throw new Skip(`앱이 아직 D1에서 교사 계정을 만들지 못합니다(앱 쪽 작업 중): ${r.status} ${JSON.stringify(r.body)}. 가짜 API에 '교사 있음'으로 두고 계속합니다.`);
    }
  });

  await check("다시 '설치 시작'하면 교사 계정이 있으므로 멈추고 '업데이트'로 안내한다(한국어)", async () => {
    const before = mock.state.uploads.length;
    await freshPage();
    await pasteAndCheck(GOOD);
    await page.check(`input[name=account][value="${A1}"]`);
    await page.click("#start");
    await page.waitForSelector("#error:not([hidden])", { timeout: 60_000 });
    const t = await page.textContent("#error");
    assert(/이미 앱이 설치되어/.test(t) && /업데이트/.test(t), t);
    assert(!/이어서 해요/.test(t), "일부러 멈춘 것은 '다시 누르면 이어서' 안내를 붙이지 않음");
    assert((await page.textContent("#error-goto-link")) === "업데이트 화면으로 가기", "업데이트로 가기 버튼");
    assert(await page.isHidden("#wait-hint"), "오류 뒤에는 '기다려 주세요'를 숨김");
    assert(mock.state.uploads.length === before, "올리면 안 됨");
    await shot("05-already-installed");
  });

  await check("업데이트(#update): keep_bindings로 비밀값 유지, 같은 D1, 새 INSTALLER_URL·APP_VERSION, 설정 코드는 안 바뀜", async () => {
    const before = mock.state.uploads.length;
    const secretsBefore = mock.state.accounts[A1].scripts.mandalart.bindings.filter((b) => b.type === "secret_text").map((b) => `${b.name}=${b.text}`).sort();
    await runToDone({ account: A1, update: true });
    assert((await page.textContent("#done-title")).includes("업데이트가 끝났어요"), "업데이트 완료 제목");
    assert(await page.isHidden("#setup-box"), "설정 코드는 새로 안 만듦");
    assert((await page.inputValue("#app-url")) === appUrl, "같은 주소");
    const up = mock.state.uploads[before];
    assert(up && JSON.stringify(up.metadata.keep_bindings) === '["secret_text"]', JSON.stringify(up?.metadata));
    assert(!up.metadata.bindings.some((b) => b.type === "secret_text"), "업데이트에 비밀값을 보내면 안 됨");
    assert(up.keptNames.sort().join() === "APP_SECRET,SETUP_TOKEN", up.keptNames.join());
    const dbId = Object.keys(mock.state.accounts[A1].d1)[0];
    assert(up.metadata.bindings.find((b) => b.name === "DB").id === dbId, "같은 D1");
    assert(Object.keys(mock.state.accounts[A1].d1).length === 1, "D1 하나");
    const secretsAfter = mock.state.accounts[A1].scripts.mandalart.bindings.filter((b) => b.type === "secret_text").map((b) => `${b.name}=${b.text}`).sort();
    assert(JSON.stringify(secretsAfter) === JSON.stringify(secretsBefore), "비밀값이 바뀜");
    await shot("06-updated");
  });

  await check("(보너스) 업데이트 뒤 다시 뜬 앱: 설정 코드 유지, 교사 계정(데이터) 유지", async () => {
    let r = null;
    for (let i = 0; i < 60; i++) {
      r = await fetch(`${mock.url}/__probe/${new URL(appUrl).host}/api/auth/setup`).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch(() => null);
      if (r?.status === 200) break;
      await sleep(1000);
    }
    assert(r?.status === 200 && r.body.tokenConfigured === true, JSON.stringify(r));
    if (teacherCreated) assert(r.body.needsSetup === false, `교사 계정이 사라짐: ${JSON.stringify(r.body)}`);
    else throw new Skip(`설정 코드(비밀값)는 유지됨. 교사 계정 유지는 확인 못 함(앱이 아직 교사 계정을 만들지 못함): ${JSON.stringify(r.body)}`);
  });

  await check("업데이트 + '설정 코드도 새로 만들기': secrets로 SETUP_TOKEN만 바꾸고 새 설정 링크를 보여 준다", async () => {
    const appSecretBefore = mock.state.accounts[A1].scripts.mandalart.bindings.find((b) => b.name === "APP_SECRET").text;
    await runToDone({ account: A1, update: true, newCode: true });
    const code = await page.inputValue("#setup-code");
    assert(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{24}$/.test(code) && code !== setupCode, code);
    const put = mock.state.requests.filter((r) => r.path.endsWith("/workers/scripts/mandalart/secrets")).at(-1);
    assert(put?.json?.name === "SETUP_TOKEN" && put.json.text === code && put.json.type === "secret_text", JSON.stringify(put?.json?.name));
    assert(mock.state.accounts[A1].scripts.mandalart.bindings.find((b) => b.name === "APP_SECRET").text === appSecretBefore, "APP_SECRET 유지");
    await shot("07-update-new-code");
  });

  await check("업데이트할 앱이 없는 계정: 한국어로 '처음 설치' 안내", async () => {
    await freshPage("#update");
    await pasteAndCheck(GOOD);
    await page.check(`input[name=account][value="${A2}"]`);
    await page.click("#start");
    await page.waitForSelector("#error:not([hidden])", { timeout: 60_000 });
    const t = await page.textContent("#error");
    assert(/아직 설치된 앱이 없어요/.test(t), t);
    assert((await page.getAttribute("#error-goto-link", "href")) === "#install", "처음 설치로 가기 버튼");
    await page.click("#error-goto-link");
    await page.waitForFunction(() => document.body.className === "mode-install", null, { timeout: 5_000 });
    const label = (await page.innerText("#start")).trim();
    assert(label === "설치 시작" && await page.isHidden("#error"), `버튼을 누르면 처음 설치 화면: '${label}'`);
  });

  await check("API 보안: 다른 Origin·Origin 없음 거절, 본문 크기 제한, accountId·mode 검사, GET 거절, version.json", async () => {
    const post = (path, body, headers = {}) => fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.text(), h: r.headers }));
    const n = mock.state.requests.length;
    let r = await post("/api/accounts", JSON.stringify({ token: GOOD }), { Origin: "https://evil.example" });
    assert(r.status === 403, `evil origin ${r.status}`);
    r = await post("/api/accounts", JSON.stringify({ token: GOOD }));
    assert(r.status === 403, `no origin ${r.status}`);
    r = await post("/api/accounts", JSON.stringify({ token: GOOD, pad: "x".repeat(5000) }), { Origin: ORIGIN });
    assert(r.status === 413, `big body ${r.status}`);
    r = await post("/api/accounts", "not json", { Origin: ORIGIN });
    assert(r.status === 400, `bad json ${r.status}`);
    r = await post("/api/install", JSON.stringify({ token: GOOD, accountId: "../../x", mode: "install" }), { Origin: ORIGIN });
    assert(r.status === 400 && /계정/.test(JSON.parse(r.body).error), `bad account ${r.status}`);
    r = await post("/api/install", JSON.stringify({ token: GOOD, accountId: A1, mode: "delete" }), { Origin: ORIGIN });
    assert(r.status === 400, `bad mode ${r.status}`);
    r = await post("/api/install", JSON.stringify({ token: GOOD, accountId: A1, mode: "install" }), { Origin: ORIGIN, "Content-Type": "text/plain" });
    assert(r.status === 415, `content-type ${r.status}`);
    assert(mock.state.requests.length === n, "거절한 요청이 Cloudflare로 가면 안 됨");
    const g = await fetch(`${ORIGIN}/api/accounts`);
    assert(g.status === 404, `GET api ${g.status}`);
    const v = await fetch(`${ORIGIN}/version.json`);
    assert(v.headers.get("access-control-allow-origin") === "*", "version.json CORS");
    assert(JSON.stringify(await v.json()) === JSON.stringify({ version: APP_VERSION }), "version.json 내용");
    const a = await post("/api/accounts", JSON.stringify({ token: BAD }), { Origin: ORIGIN });
    assert(a.h.get("cache-control") === "no-store" && a.h.get("access-control-allow-origin") === null, "api 머리글");
  });

  await check("휴대폰 폭에서 완료 화면까지 가로 스크롤 없음, 브라우저 콘솔 오류 없음", async () => {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(sw <= 390, `가로 스크롤 ${sw}`);
    const real = consoleErrors.filter((e) => !/status of (400|403|404|413|415)/.test(e));
    assert(real.length === 0, real.join("\n"));
  });
} finally {
  await browser.close().catch(() => {});
  installer.kill("SIGTERM");
  await sleep(1500);
  await mock.close();
}

await check("토큰이 설치 페이지 기록(wrangler 출력·로그 파일)과 API 응답 어디에도 없다", async () => {
  writeFileSync(installerLog, installerOut);
  const newLogs = listWranglerLogs().filter((f) => !logsBefore.has(f));
  const texts = [installerOut, ...newLogs.map((f) => readFileSync(f, "utf8")), ...apiBodies];
  for (const t of ALL_TOKENS) for (const text of texts) assert(!text.includes(t), `토큰 노출: ${t.slice(0, 8)}…`);
  assert(installerOut.length > 0 && apiBodies.length > 5, "확인할 기록이 너무 적음");
  console.log(`  · 확인한 것: wrangler 출력 ${installerOut.length}자, 새 로그 파일 ${newLogs.length}개, API 응답 ${apiBodies.length}개`);
});

console.log("\n" + results.map((r) => r.split("\n")[0]).join("\n"));
console.log(`\n실패 ${failed}개 / 전체 ${results.length}개(SKIP ${results.filter((r) => r.startsWith("SKIP")).length}개). 화면·기록: ${WORK}`);
process.exit(failed ? 1 : 0);

function listWranglerLogs() {
  const dir = join(homedir(), ".config/.wrangler/logs");
  try {
    return readdirSync(dir).map((f) => join(dir, f)).filter((f) => statSync(f).isFile());
  } catch {
    return [];
  }
}
