import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  VERSION_RETRY_PAUSE_MS, VERSION_TIMEOUT_MS, VERSION_TTL_MS, appUpdateInfo, compareVersions, fetchLatestVersion, installerOrigin,
  isNewerVersion, parseVersion, subjectParticle, updatePageUrl, versionJsonUrl, type VersionMemo,
} from "../src/lib/app-update.ts";

const INSTALLER = "https://mandalart-installer.example.workers.dev";

test("버전 비교: 숫자 x.y.z만 읽고, 설치 페이지가 더 새것일 때만 알린다", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion(" 10.0.0 "), [10, 0, 0]);
  for (const bad of ["v1.2.3", "1.2", "1.2.3-beta", "1.2.3.4", "", "a.b.c", null, undefined, 123, {}]) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.12", "1.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "garbage"), null);
  assert.equal(isNewerVersion("1.0.1", "1.0.0"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("0.9.0", "1.0.0"), false);
  assert.equal(isNewerVersion(null, "1.0.0"), false);
  assert.equal(isNewerVersion("9.9.9", "dev"), false);
});

test("버전 뒤 조사: 1.2.0이 / 1.2.2가", () => {
  const said = (v: string) => `새 버전 ${v}${subjectParticle(v)} 있어요`;
  assert.equal(said("2.1.0"), "새 버전 2.1.0이 있어요");
  assert.equal(said("1.2.1"), "새 버전 1.2.1이 있어요");
  assert.equal(said("1.2.2"), "새 버전 1.2.2가 있어요");
  assert.equal(said("1.2.3"), "새 버전 1.2.3이 있어요");
  assert.equal(said("1.2.4"), "새 버전 1.2.4가 있어요");
  assert.equal(said("1.2.5"), "새 버전 1.2.5가 있어요");
  assert.equal(said("1.2.6"), "새 버전 1.2.6이 있어요");
  assert.equal(said("1.2.7"), "새 버전 1.2.7이 있어요");
  assert.equal(said("1.2.8"), "새 버전 1.2.8이 있어요");
  assert.equal(said("1.2.9"), "새 버전 1.2.9가 있어요");
  assert.equal(said("1.2.10"), "새 버전 1.2.10이 있어요");
});

test("package.json과 wrangler.jsonc의 APP_VERSION은 같은 x.y.z(설치 페이지가 package.json 버전을 넣음)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: unknown };
  assert.ok(parseVersion(pkg.version), `package.json version: ${String(pkg.version)}`);
  const wr = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const m = /"APP_VERSION"\s*:\s*"([^"]+)"/.exec(wr);
  if (m) assert.equal(m[1], pkg.version, "wrangler.jsonc의 vars.APP_VERSION(로컬 개발용)도 package.json과 맞추세요.");
});

test("설치 페이지 주소(INSTALLER_URL): https origin만(로컬 개발은 http://localhost), 이상한 값은 null", () => {
  assert.equal(installerOrigin(INSTALLER), INSTALLER);
  assert.equal(installerOrigin(`${INSTALLER}/some/path?x=1#y`), INSTALLER);
  assert.equal(installerOrigin(" https://a.example/ "), "https://a.example");
  assert.equal(installerOrigin("http://localhost:8789"), "http://localhost:8789");
  assert.equal(installerOrigin("http://127.0.0.1:8789/"), "http://127.0.0.1:8789");
  for (const bad of ["http://a.example", "javascript:alert(1)", "ftp://a.example", "https://user:pw@a.example", "not a url", "", null, undefined, 42]) {
    assert.equal(installerOrigin(bad), null, String(bad));
  }
  assert.equal(versionJsonUrl(INSTALLER), `${INSTALLER}/version.json`);
  assert.equal(updatePageUrl(INSTALLER), `${INSTALLER}/#update`);
});

type Init = RequestInit;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fresh = (): VersionMemo => ({ url: "", until: 0, value: null });

test("새 버전 확인: 설치 페이지의 /version.json을 2.5초 제한으로 읽는다", async () => {
  const calls: { url: string; init: Init }[] = [];
  const v = await fetchLatestVersion(INSTALLER, {
    state: fresh(),
    fetch: async (url, init) => { calls.push({ url, init }); return json({ version: "2.1.0" }); },
  });
  assert.equal(v, "2.1.0");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${INSTALLER}/version.json`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(VERSION_TIMEOUT_MS, 2500);
});

test("새 버전 확인: 받은 버전은 1시간 기억(같은 설치 페이지일 때), 받는 중인 요청은 나누지 않는다(Workers 요청 간 I/O 금지)", async () => {
  let now = 5_000_000;
  let n = 0;
  let version = "1.2.3";
  const state = fresh();
  const quick = async () => { n++; return json({ version }); };
  assert.equal(await fetchLatestVersion(INSTALLER, { state, now: () => now, fetch: quick }), "1.2.3");
  assert.equal(state.until, now + VERSION_TTL_MS);
  assert.equal(VERSION_TTL_MS, 60 * 60_000);

  version = "2.0.0";
  now += VERSION_TTL_MS - 1;
  assert.equal(await fetchLatestVersion(INSTALLER, { state, now: () => now, fetch: quick }), "1.2.3", "1시간 안에는 기억한 값");
  assert.equal(n, 1);
  assert.equal(await fetchLatestVersion("https://other.example", { state, now: () => now, fetch: quick }), "2.0.0", "설치 페이지가 바뀌면 다시 물음");
  assert.equal(n, 2);
  now += VERSION_TTL_MS;
  assert.equal(await fetchLatestVersion(INSTALLER, { state, now: () => now, fetch: quick }), "2.0.0", "1시간이 지나면 다시 물음");
  assert.equal(n, 3);

  // 동시에 들어온 두 요청은 각자 묻는다(한 요청의 fetch Promise를 다른 요청이 기다리지 않음)
  const s2 = fresh();
  let m = 0;
  const releases: (() => void)[] = [];
  const slow = async () => { m++; await new Promise<void>((r) => releases.push(r)); return json({ version: "3.0.0" }); };
  const a = fetchLatestVersion(INSTALLER, { state: s2, now: () => now, fetch: slow });
  const b = fetchLatestVersion(INSTALLER, { state: s2, now: () => now, fetch: slow });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m, 2);
  releases.forEach((r) => r());
  assert.deepEqual(await Promise.all([a, b]), ["3.0.0", "3.0.0"]);
});

test("새 버전 확인: 어떤 실패든 null(예외 없음), 실패한 뒤 5분은 다시 묻지 않는다", async () => {
  const cases: [string, (url: string, init: Init) => Promise<Response>][] = [
    ["404", async () => json({ message: "Not Found" }, 404)],
    ["500", async () => new Response("oops", { status: 500 })],
    ["302", async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })],
    ["JSON 아님", async () => new Response("<html>blocked</html>", { status: 200 })],
    ["version 없음", async () => json({ name: "x" })],
    ["version 모양 다름", async () => json({ version: "latest" })],
    ["배열", async () => json([1, 2, 3])],
    ["null", async () => json(null)],
    ["네트워크 오류", async () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [name, f] of cases) {
    const state = fresh();
    assert.equal(await fetchLatestVersion(INSTALLER, { state, now: () => 0, fetch: f }), null, name);
    assert.equal(state.until, VERSION_RETRY_PAUSE_MS, `${name}: 실패는 5분만 기억`);
  }

  // 응답이 오지 않으면 시간 제한(여기서는 50ms)에 끊는다
  const t0 = Date.now();
  const hang = (_url: string, init: Init) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
  const keepAlive = setTimeout(() => {}, 5_000); // AbortSignal.timeout의 타이머는 이벤트 루프를 붙잡지 않음
  assert.equal(await fetchLatestVersion(INSTALLER, { state: fresh(), fetch: hang, timeoutMs: 50 }), null);
  const stalledBody = async (_url: string, init: Init) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"version":')); init.signal?.addEventListener("abort", () => c.error(init.signal?.reason)); },
  }), { status: 200 });
  assert.equal(await fetchLatestVersion(INSTALLER, { state: fresh(), fetch: stalledBody, timeoutMs: 50 }), null);
  clearTimeout(keepAlive);
  assert.ok(Date.now() - t0 < 1000, "시간 제한에 끊겨야 함");

  let now = 1_000_000;
  let n = 0;
  const state = fresh();
  const fail = async () => { n++; throw new TypeError("fetch failed"); };
  assert.equal(await fetchLatestVersion(INSTALLER, { state, now: () => now, fetch: fail }), null);
  now += VERSION_RETRY_PAUSE_MS - 1;
  assert.equal(await fetchLatestVersion(INSTALLER, { state, now: () => now, fetch: async () => json({ version: "9.9.9" }) }), null);
  assert.equal(n, 1);
  now += 1;
  assert.equal(await fetchLatestVersion(INSTALLER, { state, now: () => now, fetch: async () => json({ version: "9.9.9" }) }), "9.9.9");
});

test("API 응답(appUpdateInfo): 새 버전이 있을 때만 latest와 업데이트 주소(#update)", async () => {
  const env = { APP_VERSION: "2.0.0", INSTALLER_URL: INSTALLER };
  assert.deepEqual(await appUpdateInfo(env, async () => "2.1.0"), { current: "2.0.0", latest: "2.1.0", updateUrl: `${INSTALLER}/#update` });
  assert.deepEqual(await appUpdateInfo(env, async () => "2.0.0"), { current: "2.0.0", latest: null, updateUrl: null });
  assert.deepEqual(await appUpdateInfo(env, async () => "1.9.0"), { current: "2.0.0", latest: null, updateUrl: null });
  assert.deepEqual(await appUpdateInfo(env, async () => null), { current: "2.0.0", latest: null, updateUrl: null });
  assert.deepEqual(await appUpdateInfo(env, async () => { throw new Error("x"); }), { current: "2.0.0", latest: null, updateUrl: null });
  // 설치 페이지 주소가 없거나 이상하면 묻지 않음
  let asked = 0;
  const spy = async () => { asked++; return "9.0.0"; };
  assert.deepEqual(await appUpdateInfo({ APP_VERSION: "2.0.0" }, spy), { current: "2.0.0", latest: null, updateUrl: null });
  assert.deepEqual(await appUpdateInfo({ APP_VERSION: "2.0.0", INSTALLER_URL: "javascript:alert(1)" }, spy), { current: "2.0.0", latest: null, updateUrl: null });
  assert.equal(asked, 0);
  // 지금 버전을 모르면 '새 버전'을 알리지 않음
  assert.deepEqual(await appUpdateInfo({ INSTALLER_URL: INSTALLER }, async () => "9.0.0"), { current: null, latest: null, updateUrl: null });
});
