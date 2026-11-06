// 로컬 시험용 가짜 Cloudflare API(v4). 설치 페이지가 부르는 주소만 흉내 내고, 받은 요청을 모두 기록합니다.
// - 올린 Worker(multipart)를 해석해 metadata·모듈을 기록하고, keep_bindings도 실제 API처럼 처리합니다.
// - deployApps가 켜져 있으면 올린 모듈을 `wrangler dev`로 실제로 띄워서(D1은 계정마다 따로 저장),
//   /__probe/<앱 호스트>/<경로> 로 그 앱에 이어 줍니다(설치 페이지의 '앱이 대답하는지 확인' 단계).
// - D1 query는 띄운 앱의 로컬 D1 파일(node:sqlite)에 그대로 실행합니다(없으면 빈 DB).
// 단독 실행: node test/mock-cf.mjs [port]  → 상태 보기 GET /__state, 설정 POST /__control
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname; // 저장소 루트
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");

const ok = (result, extra = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const err = (code, message) => ({ success: false, errors: [{ code, message }], messages: [], result: null });

export function defaultState() {
  return {
    tokens: {},
    accounts: {},
    subdomainConflicts: 0,
    takenSubdomains: ["mandalart-taken1"],
    failNext: [],
    teachersOverride: {},
    requests: [],
    uploads: [],
  };
}

/** 지금 비어 있는 포트(다른 작업의 개발 서버와 겹치지 않게) */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startMock({ port = 0, workDir, deployApps = false, log = () => {} } = {}) {
  if (!workDir) throw new Error("workDir가 필요합니다.");
  mkdirSync(workDir, { recursive: true });
  let state = defaultState();
  /** accountId → { proc, host, dbId } */
  const apps = new Map();

  function sqliteFor(dbId) {
    const dir = join(workDir, "persist", dbId, "v3", "d1");
    if (!existsSync(dir)) return null;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) stack.push(p);
        // miniflare의 metadata.sqlite가 아니라 데이터베이스 파일(<해시>.sqlite)
        else if (n.endsWith(".sqlite") && n !== "metadata.sqlite") return p;
      }
    }
    return null;
  }

  async function runSql(dbId, sql) {
    const { DatabaseSync } = await import("node:sqlite");
    const file = sqliteFor(dbId);
    const db = file ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(":memory:");
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }

  async function stopApp(accountId) {
    const a = apps.get(accountId);
    if (!a) return;
    apps.delete(accountId);
    if (a.proc.exitCode === null) {
      const done = new Promise((r) => a.proc.once("exit", r));
      a.proc.kill("SIGTERM");
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      if (a.proc.exitCode === null) a.proc.kill("SIGKILL");
    }
  }

  async function deployApp(accountId, script) {
    await stopApp(accountId);
    const dir = join(workDir, "deployed", accountId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const m of script.modules) writeFileSync(join(dir, m.name), m.buf);
    const d1 = script.bindings.find((b) => b.type === "d1");
    const vars = Object.fromEntries(script.bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]));
    const secrets = script.bindings.filter((b) => b.type === "secret_text");
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
      name: "mandalart",
      main: script.metadata.main_module,
      no_bundle: true,
      compatibility_date: script.metadata.compatibility_date,
      compatibility_flags: script.metadata.compatibility_flags,
      d1_databases: d1 ? [{ binding: d1.name, database_name: "mandalart-db", database_id: d1.id }] : [],
      vars,
      rules: [{ type: "ESModule", globs: ["**/*.js"] }],
    }, null, 2));
    writeFileSync(join(dir, ".dev.vars"), secrets.map((s) => `${s.name}=${JSON.stringify(s.text)}`).join("\n") + "\n");
    const port = await freePort();
    const persist = join(workDir, "persist", d1?.id ?? "none");
    const proc = spawn(process.execPath, [WRANGLER, "dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"], {
      cwd: dir,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (b) => { out += b; });
    proc.stderr.on("data", (b) => { out += b; });
    const acct = state.accounts[accountId];
    const host = `mandalart.${acct.subdomain}.workers.dev`;
    apps.set(accountId, { proc, host, port, dbId: d1?.id, output: () => out });
    log(`[mock] 앱 띄우는 중: ${host} → 127.0.0.1:${port}`);
  }

  function findAccountForHost(host) {
    for (const [id, a] of apps) if (a.host === host && state.accounts[id]?.scripts?.mandalart?.workersDev) return a;
    return null;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://mock");
    const path = url.pathname;

    // ── 시험용 제어 ──
    if (path === "/__state") return send(res, 200, { ...state, apps: [...apps].map(([id, a]) => ({ id, host: a.host, port: a.port })) });
    if (path === "/__control" && req.method === "POST") {
      const c = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (c.reset) {
        for (const id of [...apps.keys()]) await stopApp(id);
        state = defaultState();
      }
      Object.assign(state, c.set ?? {});
      return send(res, 200, { ok: true });
    }
    if (path.startsWith("/__probe/")) {
      const rest = path.slice("/__probe/".length);
      const host = rest.split("/")[0];
      const app = findAccountForHost(host);
      if (!app) return send(res, 502, { error: "no app (DNS not ready)" });
      try {
        const r = await fetch(`http://127.0.0.1:${app.port}/${rest.slice(host.length + 1)}${url.search}`, {
          method: req.method,
          headers: { "Content-Type": req.headers["content-type"] ?? "application/json", Accept: "application/json", Host: host },
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req),
        });
        const text = await r.text();
        res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "text/plain" });
        return res.end(text);
      } catch {
        return send(res, 502, { error: "app not up yet" });
      }
    }

    if (!path.startsWith("/client/v4/")) return send(res, 404, err(7003, "Could not route"));
    const p = path.slice("/client/v4".length);
    const raw = await readBody(req);
    const auth = req.headers.authorization ?? "";
    const tok = /^Bearer (.+)$/.exec(auth)?.[1];
    const t = tok ? state.tokens[tok] : undefined;
    const rec = { method: req.method, path: p, query: url.search, auth: t ? t.label : tok ? "unknown" : "none", contentType: req.headers["content-type"] ?? "" };
    if ((req.headers["content-type"] ?? "").startsWith("application/json")) {
      try { rec.json = JSON.parse(raw.toString("utf8")); } catch { rec.json = "INVALID"; }
    }
    if (req.headers["cloudflare-workers-script-api-date"]) rec.apiDate = req.headers["cloudflare-workers-script-api-date"];
    state.requests.push(rec);

    // 미리 정한 실패
    const fi = state.failNext.findIndex((f) => f.method === req.method && new RegExp(f.path).test(p));
    if (fi >= 0) {
      const f = state.failNext.splice(fi, 1)[0];
      const errors = (f.errors ?? []).map((e) => ({ ...e, message: String(e.message).replace("{TOKEN}", tok ?? "") }));
      return send(res, f.status, { success: false, errors, messages: [], result: null });
    }

    if (p === "/user/tokens/verify" && req.method === "GET") {
      if (!t) return send(res, 401, err(1000, "Invalid API Token"));
      return send(res, 200, ok({ id: createHash("sha256").update(tok).digest("hex").slice(0, 32), status: t.status ?? "active" }));
    }
    if (!t) return send(res, 400, { success: false, errors: [{ code: 6003, message: "Invalid request headers", error_chain: [{ code: 6111, message: "Invalid format for Authorization header" }] }], messages: [], result: null });

    if (p === "/accounts" && req.method === "GET") {
      const list = (t.accounts ?? []).map((id) => state.accounts[id]).filter(Boolean).map((a) => ({ id: a.id, name: a.name, type: "standard", settings: {}, created_on: "2026-01-01T00:00:00Z" }));
      return send(res, 200, ok(list, { result_info: { page: 1, per_page: 50, count: list.length, total_count: list.length } }));
    }

    const m = /^\/accounts\/([^/]+)(\/.*)$/.exec(p);
    if (!m) return send(res, 404, err(7003, "Could not route"));
    const [, accountId, sub] = m;
    const acct = state.accounts[accountId];
    const isD1 = sub.startsWith("/d1/");
    if (!acct || !(t.accounts ?? []).includes(accountId)) return send(res, 403, isD1 ? err(7403, "The given account is not valid or is not authorized to access this service") : err(10000, "Authentication error"));
    if (isD1 && t.perms?.d1 === false) return send(res, 403, err(7403, "The given account is not valid or is not authorized to access this service"));
    if (!isD1 && t.perms?.workers === false) return send(res, 403, err(10000, "Authentication error"));

    // workers.dev 하위 도메인
    if (sub === "/workers/subdomain") {
      if (req.method === "GET") {
        if (!acct.subdomain) return send(res, 404, err(10007, "This subdomain does not exist."));
        return send(res, 200, ok({ subdomain: acct.subdomain }));
      }
      if (req.method === "PUT") {
        const name = rec.json?.subdomain;
        if (typeof name !== "string" || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return send(res, 400, err(10032, "Invalid subdomain"));
        if (state.subdomainConflicts > 0 || state.takenSubdomains.includes(name)) {
          state.subdomainConflicts = Math.max(0, state.subdomainConflicts - 1);
          return send(res, 409, err(10031, "Subdomain unavailable"));
        }
        acct.subdomain = name;
        state.takenSubdomains.push(name);
        return send(res, 200, ok({ subdomain: name }));
      }
    }

    // 스크립트 목록
    if (sub === "/workers/scripts" && req.method === "GET") {
      return send(res, 200, ok(Object.keys(acct.scripts).map((id) => ({ id, created_on: "2026-01-01T00:00:00Z", modified_on: "2026-01-01T00:00:00Z" }))));
    }
    const sm = /^\/workers\/scripts\/([^/]+)(\/[a-z-]+)?$/.exec(sub);
    if (sm) {
      const [, name, rest] = sm;
      const script = acct.scripts[name];
      if (!rest && req.method === "PUT") return upload(res, req, raw, acct, name, url);
      if (!script) return send(res, 404, err(10007, "This Worker does not exist on your account."));
      if (rest === "/settings" && req.method === "GET") {
        const bindings = script.bindings.map((b) => (b.type === "secret_text" ? { type: b.type, name: b.name } : b));
        return send(res, 200, ok({ bindings, compatibility_date: script.metadata.compatibility_date, compatibility_flags: script.metadata.compatibility_flags }));
      }
      if (rest === "/subdomain" && req.method === "POST") {
        const b = rec.json ?? {};
        if (typeof b.enabled !== "boolean") return send(res, 400, err(10021, "enabled must be boolean"));
        script.workersDev = b.enabled;
        script.previews = b.previews_enabled ?? false;
        return send(res, 200, ok({ enabled: script.workersDev, previews_enabled: script.previews }));
      }
      if (rest === "/secrets" && req.method === "PUT") {
        const b = rec.json ?? {};
        if (b.type !== "secret_text" || typeof b.name !== "string" || typeof b.text !== "string") return send(res, 400, err(10021, "bad secret"));
        script.bindings = script.bindings.filter((x) => x.name !== b.name).concat([{ type: "secret_text", name: b.name, text: b.text }]);
        if (deployApps && acct.subdomain) await deployApp(acct.id, script);
        return send(res, 200, ok({ name: b.name, type: "secret_text" }));
      }
    }

    // D1
    if (sub.startsWith("/d1/database")) {
      if (sub === "/d1/database" && req.method === "GET") {
        const name = url.searchParams.get("name");
        const list = Object.values(acct.d1).filter((d) => !name || d.name.includes(name));
        return send(res, 200, ok(list.map((d) => ({ uuid: d.uuid, name: d.name, version: "production", created_at: d.created_at })), { result_info: { page: 1, per_page: 100, count: list.length, total_count: list.length } }));
      }
      if (sub === "/d1/database" && req.method === "POST") {
        const b = rec.json ?? {};
        if (typeof b.name !== "string") return send(res, 400, err(7400, "bad name"));
        if (Object.values(acct.d1).some((d) => d.name === b.name)) return send(res, 400, err(7502, "A database with that name already exists"));
        const d = { uuid: randomUUID(), name: b.name, primary_location_hint: b.primary_location_hint ?? null, created_at: new Date().toISOString() };
        acct.d1[d.uuid] = d;
        return send(res, 200, ok({ uuid: d.uuid, name: d.name, version: "production", created_at: d.created_at }));
      }
      const qm = /^\/d1\/database\/([^/]+)\/query$/.exec(sub);
      if (qm && req.method === "POST") {
        const d = acct.d1[qm[1]];
        if (!d) return send(res, 404, err(7404, "Database not found"));
        const sql = String(rec.json?.sql ?? "");
        const override = state.teachersOverride[d.uuid];
        let results;
        if (override !== undefined && /teachers/.test(sql)) results = [{ n: /sqlite_master/.test(sql) ? 1 : override }];
        else {
          try {
            results = await runSql(d.uuid, sql);
          } catch (e) {
            return send(res, 400, err(7500, `SQL error: ${e.message}`));
          }
        }
        return send(res, 200, ok([{ results, success: true, meta: { changes: 0 } }]));
      }
    }
    return send(res, 404, err(7003, "Could not route"));
  }

  async function upload(res, req, raw, acct, name, url) {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.startsWith("multipart/form-data")) return send(res, 400, err(10021, "Expected multipart/form-data"));
    if (acct.emailVerified === false) return send(res, 400, err(10034, "workers.api.error.email_verification_required"));
    let form;
    try {
      form = await new Request("http://mock/", { method: "PUT", headers: { "content-type": ct }, body: raw }).formData();
    } catch (e) {
      return send(res, 400, err(10021, `multipart parse failed: ${e.message}`));
    }
    const metaRaw = form.get("metadata");
    let metadata;
    try {
      metadata = JSON.parse(typeof metaRaw === "string" ? metaRaw : await metaRaw.text());
    } catch {
      return send(res, 400, err(10021, "metadata is not JSON"));
    }
    const parts = [];
    const modules = [];
    for (const [key, value] of form.entries()) {
      if (key === "metadata") continue;
      if (typeof value === "string") {
        parts.push({ name: key, kind: "string" });
        continue;
      }
      const buf = Buffer.from(await value.arrayBuffer());
      parts.push({ name: key, filename: value.name, type: value.type, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
      modules.push({ name: key, type: value.type, buf });
    }
    if (!metadata.main_module || !modules.some((x) => x.name === metadata.main_module)) {
      return send(res, 400, err(10021, "No such module: main_module part missing"));
    }
    const prev = acct.scripts[name];
    let bindings = Array.isArray(metadata.bindings) ? metadata.bindings : [];
    for (const b of bindings) {
      if (b.type === "d1" && !acct.d1[b.id]) return send(res, 400, err(10021, `D1 binding ${b.name} references unknown database`));
    }
    const kept = [];
    if (prev && Array.isArray(metadata.keep_bindings)) {
      for (const b of prev.bindings) {
        if (metadata.keep_bindings.includes(b.type) && !bindings.some((x) => x.name === b.name)) kept.push(b);
      }
    }
    bindings = bindings.concat(kept);
    state.uploads.push({ accountId: acct.id, name, query: url.search, metadata, parts, keptNames: kept.map((b) => b.name) });
    const script = { metadata, bindings, modules, workersDev: prev?.workersDev ?? false, previews: prev?.previews };
    acct.scripts[name] = script;
    if (deployApps && acct.subdomain) await deployApp(acct.id, script);
    return send(res, 200, ok({ id: name, etag: createHash("sha256").update(raw).digest("hex"), handlers: ["fetch"] }));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`[mock] 처리 오류: ${e?.stack ?? e}`);
      if (!res.headersSent) send(res, 500, err(10013, "mock internal error"));
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}`,
    base: `http://127.0.0.1:${actual}/client/v4`,
    get state() { return state; },
    setState(fn) { fn(state); },
    appOutput(accountId) { return apps.get(accountId)?.output() ?? ""; },
    async close() {
      for (const id of [...apps.keys()]) await stopApp(id);
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock({ port: Number(process.argv[2] ?? 8788), workDir: process.env.MOCK_WORKDIR ?? "/tmp/mock-cf", deployApps: process.env.DEPLOY_APPS === "1", log: console.log });
  console.log(`가짜 Cloudflare API: ${m.base}`);
}
