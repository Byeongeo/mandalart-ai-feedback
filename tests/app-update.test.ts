import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UPDATE_WORKFLOW_YML } from "../src/lib/update-workflow-yml.ts";
import {
  MANUAL_INSTALL_DOCS_URL, UPDATE_DOCS_URL, UPSTREAM_PACKAGE_JSON_URL, UPSTREAM_WORKFLOW_RAW_URL, VERSION_RETRY_PAUSE_MS, VERSION_TIMEOUT_MS,
  VERSION_TTL_MS, WORKFLOW_PATH, compareVersions, fetchLatestVersion, installWorkflowUrl, isNewerVersion, parseVersion, repoFromEnv,
  runWorkflowUrl, subjectParticle, type VersionMemo,
} from "../src/lib/app-update.ts";

const workflowBytes = readFileSync(new URL("../.github/workflows/update-from-template.yml", import.meta.url));
const workflowText = workflowBytes.toString("utf8");
const repo = { owner: "Byeongeo", repo: "mandalart" };

test("교사 화면에 넣은 workflow 내용(update-workflow-yml.ts)은 .github/workflows/update-from-template.yml과 바이트 하나까지 같다", () => {
  assert.ok(Buffer.from(UPDATE_WORKFLOW_YML, "utf8").equals(workflowBytes),
    "workflow 파일을 고쳤다면 `node tests/gen-update-workflow.mjs`로 src/lib/update-workflow-yml.ts를 다시 만드세요.");
  assert.equal(WORKFLOW_PATH, ".github/workflows/update-from-template.yml");
  // 문서와 화면이 인용하는 이름·실행 방식
  assert.match(workflowText, /^name: 앱 업데이트$/m);
  assert.match(workflowText, /^\s+workflow_dispatch:/m);
});

test("'업데이트 기능 설치' 링크: GitHub 새 파일 화면, 파일 이름과 내용이 workflow 파일 그대로 풀린다", () => {
  const href = installWorkflowUrl(repo, UPDATE_WORKFLOW_YML);
  const u = new URL(href);
  assert.equal(u.origin, "https://github.com");
  assert.equal(u.pathname, "/Byeongeo/mandalart/new/main");
  assert.deepEqual([...u.searchParams.keys()], ["filename", "value"]);
  assert.equal(u.searchParams.get("filename"), ".github/workflows/update-from-template.yml");
  assert.equal(u.searchParams.get("value"), workflowText);
  // '+'를 빈칸으로 읽는 서버(Rails)에서도 같게: 쿼리에 날것의 + 빈칸 줄바꿈 & # 이 없고, decodeURIComponent만으로 원문이 나온다.
  const query = href.slice(href.indexOf("?") + 1);
  assert.doesNotMatch(query.replace(/^filename=[^&]*&value=/, ""), /[+ \n&#]/);
  const pairs = Object.fromEntries(query.split("&").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; }));
  assert.equal(pairs.filename, WORKFLOW_PATH);
  assert.equal(pairs.value, workflowText);
  assert.ok(Buffer.from(pairs.value, "utf8").equals(workflowBytes));
  // 너무 긴 주소는 GitHub가 거절할 수 있음(지금 약 3.6 KB)
  assert.ok(href.length < 6000, `링크 길이 ${href.length}`);
});

test("'업데이트 받기' 링크, 설치 링크는 배포된 가지와 상관없이 언제나 main(workflow가 main에서만 동작)", () => {
  assert.equal(runWorkflowUrl(repo), "https://github.com/Byeongeo/mandalart/actions/workflows/update-from-template.yml");
  // 미리보기 배포(다른 가지)에서도 main에 넣는다: Run workflow는 기본 가지(main)의 파일에만 나오고, workflow는 main을 받아 main에 올림
  const preview = repoFromEnv({ VERCEL_GIT_REPO_OWNER: "t", VERCEL_GIT_REPO_SLUG: "mandalart", VERCEL_GIT_COMMIT_REF: "feature/새-기능" });
  assert.deepEqual(preview, { owner: "t", repo: "mandalart" });
  assert.equal(new URL(installWorkflowUrl(preview!, "x")).pathname, "/t/mandalart/new/main");
  assert.match(workflowText, /^\s+ref: main$/m);
  assert.match(workflowText, /git push origin HEAD:main$/m);
});

test("저장소 알아내기: Vercel 시스템 환경 변수가 있을 때만(없으면 null, 필수 아님)", () => {
  assert.deepEqual(
    repoFromEnv({ VERCEL_GIT_REPO_OWNER: "Byeongeo", VERCEL_GIT_REPO_SLUG: "mandalart", VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_PROVIDER: "github" }),
    repo,
  );
  assert.deepEqual(repoFromEnv({ VERCEL_GIT_REPO_OWNER: " t-1 ", VERCEL_GIT_REPO_SLUG: "my.app_2" }), { owner: "t-1", repo: "my.app_2" });
  assert.equal(repoFromEnv({}), null);
  assert.equal(repoFromEnv({ VERCEL_GIT_REPO_OWNER: "Byeongeo" }), null);
  assert.equal(repoFromEnv({ VERCEL_GIT_REPO_OWNER: "", VERCEL_GIT_REPO_SLUG: "mandalart" }), null);
  assert.equal(repoFromEnv({ VERCEL_GIT_REPO_OWNER: "a/b", VERCEL_GIT_REPO_SLUG: "mandalart" }), null);
  assert.equal(repoFromEnv({ VERCEL_GIT_REPO_OWNER: "a", VERCEL_GIT_REPO_SLUG: ".." }), null);
  assert.equal(repoFromEnv({ VERCEL_GIT_REPO_OWNER: "a", VERCEL_GIT_REPO_SLUG: "b", VERCEL_GIT_PROVIDER: "gitlab" }), null);
  // 가지 이름은 보지 않음(이상한 값이어도 저장소는 알아냄)
  assert.deepEqual(repoFromEnv({ VERCEL_GIT_REPO_OWNER: "a", VERCEL_GIT_REPO_SLUG: "b", VERCEL_GIT_COMMIT_REF: "x?y" }), { owner: "a", repo: "b" });
});

test("버전 비교: 숫자 x.y.z만 읽고, 원본이 더 새것일 때만 알린다", () => {
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
  assert.equal(said("1.2.0"), "새 버전 1.2.0이 있어요");
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

test("package.json에는 x.y.z 버전이 있다(교사 화면 '지금 버전')", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: unknown };
  assert.ok(parseVersion(pkg.version), `package.json version: ${String(pkg.version)}`);
});

type Init = RequestInit & { next?: unknown };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fresh = (): VersionMemo => ({ until: 0, value: null });

test("새 버전 확인: 원본 main의 package.json을 시간 제한을 걸어 읽는다(Next fetch 캐시는 쓰지 않음)", async () => {
  const calls: { url: string; init: Init }[] = [];
  const v = await fetchLatestVersion({
    state: fresh(),
    fetch: async (url, init) => { calls.push({ url, init }); return json({ name: "mandalart-app", version: "1.2.3" }); },
  });
  assert.equal(v, "1.2.3");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://raw.githubusercontent.com/Byeongeo/mandalart-ai-feedback/main/package.json");
  assert.equal(calls[0].url, UPSTREAM_PACKAGE_JSON_URL);
  // next.revalidate를 쓰면 Next가 지난 값을 뒤에서 새로 받을 때 signal을 빼서 시간 제한이 사라짐 → no-store + 직접 기억
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.next, undefined);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(VERSION_TIMEOUT_MS, 2500);
});

test("새 버전 확인: 받은 버전은 1시간 기억하고, 받는 중에 온 요청은 같은 결과를 함께 기다린다", async () => {
  let now = 5_000_000;
  let n = 0;
  let version = "1.2.3";
  let release: () => void = () => {};
  const state = fresh();
  const slow = async () => {
    n++;
    await new Promise<void>((r) => { release = r; });
    return json({ version });
  };
  const a = fetchLatestVersion({ state, now: () => now, fetch: slow });
  const b = fetchLatestVersion({ state, now: () => now, fetch: slow });
  await Promise.resolve();
  assert.equal(n, 1, "받는 중에는 다시 묻지 않음");
  release();
  assert.deepEqual(await Promise.all([a, b]), ["1.2.3", "1.2.3"]);
  assert.equal(state.until, now + VERSION_TTL_MS);
  assert.equal(VERSION_TTL_MS, 60 * 60_000);

  version = "2.0.0";
  const quick = async () => { n++; return json({ version }); };
  now += VERSION_TTL_MS - 1;
  assert.equal(await fetchLatestVersion({ state, now: () => now, fetch: quick }), "1.2.3", "1시간 안에는 기억한 값");
  assert.equal(n, 1);
  now += 1;
  assert.equal(await fetchLatestVersion({ state, now: () => now, fetch: quick }), "2.0.0", "1시간이 지나면 다시 물음");
  assert.equal(n, 2);
});

test("새 버전 확인: 어떤 실패든 null(예외 없음), 실패한 뒤 잠시 다시 묻지 않는다", async () => {
  const cases: [string, (url: string, init: Init) => Promise<Response>][] = [
    ["404", async () => json({ message: "Not Found" }, 404)],
    ["500", async () => new Response("oops", { status: 500 })],
    ["JSON 아님", async () => new Response("<html>blocked</html>", { status: 200 })],
    ["version 없음", async () => json({ name: "x" })],
    ["version 모양 다름", async () => json({ version: "latest" })],
    ["배열", async () => json([1, 2, 3])],
    ["null", async () => json(null)],
    ["네트워크 오류", async () => { throw new TypeError("fetch failed"); }],
    ["프록시 403", async () => new Response("Forbidden", { status: 403 })],
  ];
  for (const [name, f] of cases) {
    const state = fresh();
    assert.equal(await fetchLatestVersion({ state, now: () => 0, fetch: f }), null, name);
    assert.equal(state.until, VERSION_RETRY_PAUSE_MS, `${name}: 실패는 5분만 기억`);
  }

  // 응답이 오지 않으면 시간 제한(여기서는 50ms)에 끊는다
  const t0 = Date.now();
  const hang = (_url: string, init: Init) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
  const keepAlive = setTimeout(() => {}, 5_000); // AbortSignal.timeout의 타이머는 이벤트 루프를 붙잡지 않음(서버에서는 상관없음)
  assert.equal(await fetchLatestVersion({ state: fresh(), fetch: hang, timeoutMs: 50 }), null);
  // 본문을 읽다가 멈춰도 끊는다
  const stalledBody = async (_url: string, init: Init) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"version":')); init.signal?.addEventListener("abort", () => c.error(init.signal?.reason)); },
  }), { status: 200 });
  assert.equal(await fetchLatestVersion({ state: fresh(), fetch: stalledBody, timeoutMs: 50 }), null);
  clearTimeout(keepAlive);
  assert.ok(Date.now() - t0 < 1000, "시간 제한에 끊겨야 함");

  // 실패한 뒤 VERSION_RETRY_PAUSE_MS 동안은 묻지 않음
  let now = 1_000_000;
  let n = 0;
  const state = fresh();
  const fail = async () => { n++; throw new TypeError("fetch failed"); };
  assert.equal(await fetchLatestVersion({ state, now: () => now, fetch: fail }), null);
  assert.equal(n, 1);
  now += VERSION_RETRY_PAUSE_MS - 1;
  assert.equal(await fetchLatestVersion({ state, now: () => now, fetch: async () => json({ version: "9.9.9" }) }), null);
  assert.equal(n, 1);
  now += 1;
  assert.equal(await fetchLatestVersion({ state, now: () => now, fetch: async () => json({ version: "9.9.9" }) }), "9.9.9");
});

// GitHub가 제목에서 만드는 주소 조각(#...)과 같은 규칙: 소문자, 글자·숫자·빈칸·_·- 말고는 빼고, 빈칸은 하이픈으로
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

test("화면의 설치 안내 링크(#5, #5-3)는 docs/설치_안내.md에 실제로 있는 제목을 가리킨다", () => {
  const doc = readFileSync(new URL("../docs/설치_안내.md", import.meta.url), "utf8");
  const anchors = new Set([...doc.matchAll(/^#{2,4} (.+)$/gm)].map((m) => slug(m[1])));
  for (const url of [UPDATE_DOCS_URL, MANUAL_INSTALL_DOCS_URL]) {
    const u = new URL(url);
    assert.equal(decodeURIComponent(u.pathname), "/Byeongeo/mandalart-ai-feedback/blob/main/docs/설치_안내.md");
    const frag = decodeURIComponent(u.hash.slice(1));
    assert.ok(anchors.has(frag), `문서에 없는 제목: #${frag}`);
  }
  // 문서는 직접 넣을 때 쓰는 원문 주소를 그대로 적는다
  assert.ok(doc.includes(UPSTREAM_WORKFLOW_RAW_URL));
});

test("문서 안의 #제목 링크(설치 안내, 수업 사용 안내, README)는 모두 실제로 있는 제목을 가리킨다", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const headings = (path: string) => new Set([...read(path).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  let checked = 0;
  for (const file of ["docs/설치_안내.md", "docs/수업_사용_안내.md", "README.md"]) {
    for (const m of read(file).matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
      const [, target, frag] = m;
      if (/^[a-z]+:/i.test(target)) continue; // 바깥 주소
      const path = !target ? file : file.startsWith("docs/") && !target.startsWith("docs/") ? `docs/${target}` : target;
      assert.ok(headings(path).has(decodeURIComponent(frag)), `${file}: 없는 제목 ${path}#${frag}`);
      checked++;
    }
  }
  assert.ok(checked > 30, `확인한 링크 ${checked}개`);
});
