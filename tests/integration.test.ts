// 통합 테스트: 실제 API 라우트(src/app/api/**/route.ts)를 메모리 SQLite(D1 흉내, tests/d1-sqlite.ts) 위에서 그대로 실행합니다.
// 트랜잭션 없이 바꾼 곳(저장 번호 확인, 피드백 '만드는 중' 표시, 첫 교사 만들기, 로그인 잠금, 카드 응답 중복 막기 등)이
// 동시에 들어온 요청에서도 원래 보장을 지키는지 확인합니다. 문장마다 양보하므로 동시 요청의 문장이 서로 끼어듭니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { D1Sqlite } from "./d1-sqlite.ts";

const root = new URL("..", import.meta.url);
const NAV_SHIM = `
export class NavigationThrow extends Error { constructor(kind, to) { super(kind); this.kind = kind; this.to = to; } }
export function redirect(to) { throw new NavigationThrow("redirect", to); }
export function notFound() { throw new NavigationThrow("notFound"); }`;
type Resolved = { url: string; shortCircuit?: boolean };
(nodeModule as unknown as {
  registerHooks(h: { resolve(s: string, c: object, next: (s: string, c: object) => Resolved): Resolved }): void;
}).registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (specifier === "next/headers") return { url: new URL("worker/shims/next-headers.ts", root).href, shortCircuit: true };
    // worker/shims/next-navigation.ts와 같은 동작(그 파일은 생성자 매개변수 속성을 써서 node의 타입 지우기로는 못 읽음)
    if (specifier === "next/navigation") return { url: `data:text/javascript,${encodeURIComponent(NAV_SHIM)}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return { url: new URL(`src/${specifier.slice(2)}.ts`, root).href, shortCircuit: true };
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

const { als } = await import("../src/lib/request-context.ts");
const setup = await import("../src/app/api/auth/setup/route.ts");
const teacherAuth = await import("../src/app/api/auth/teacher/route.ts");
const studentAuth = await import("../src/app/api/auth/student/route.ts");
const classesApi = await import("../src/app/api/teacher/classes/route.ts");
const classApi = await import("../src/app/api/teacher/classes/[id]/route.ts");
const pinsApi = await import("../src/app/api/teacher/classes/[id]/pins/route.ts");
const rosterApi = await import("../src/app/api/teacher/classes/[id]/roster/route.ts");
const studentsApi = await import("../src/app/api/teacher/classes/[id]/students/route.ts");
const studentApi = await import("../src/app/api/teacher/classes/[id]/students/[sid]/route.ts");
const exportApi = await import("../src/app/api/teacher/classes/[id]/export/route.ts");
const reopenApi = await import("../src/app/api/teacher/classes/[id]/reopen/route.ts");
const aiKeyApi = await import("../src/app/api/teacher/ai-key/route.ts");
const aiStatusApi = await import("../src/app/api/teacher/ai-status/route.ts");
const statusApi = await import("../src/app/api/teacher/status/route.ts");
const mineApi = await import("../src/app/api/mandalart/route.ts");
const oneApi = await import("../src/app/api/mandalart/[id]/route.ts");
const feedbackApi = await import("../src/app/api/mandalart/[id]/feedback/route.ts");
const submitApi = await import("../src/app/api/mandalart/[id]/submit/route.ts");
const respondApi = await import("../src/app/api/cards/[id]/respond/route.ts");
const { contentHash } = await import("../src/lib/save-rules.ts");
const { emptyContent } = await import("../src/lib/mandalart.ts");
const { verifyPassword, verifyPasswordOrDummy, hashPassword, PBKDF2_ITERATIONS } = await import("../src/lib/password.ts");
const { encryptAiKey, decryptAiKey, normalizeAiKey } = await import("../src/lib/ai-key.ts");
const { isMock } = await import("../src/lib/feedback/client.ts");

const D1 = new D1Sqlite();
const SETUP_TOKEN = "integration-setup-token-0123456789";
const baseEnv: Record<string, unknown> = { DB: D1, SETUP_TOKEN, APP_VERSION: "test" };
let envExtra: Record<string, unknown> = {};

// 라우트마다 params 모양이 달라({ id } / { id, sid }) any로 받습니다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx: { params: Promise<any> }) => Response | Promise<Response>;
type Res = { status: number; body: any; text: string; headers: Headers };

/** 브라우저 하나(쿠키 보관함). host를 바꾸면 그 주소로 온 요청처럼 됩니다. */
class Browser {
  jar = new Map<string, string>();
  host: string;
  constructor(host = "localhost:8787") {
    this.host = host;
  }
  async call(handler: Handler | undefined, path: string, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}): Promise<Res> {
    assert.ok(handler, `handler for ${path}`);
    const url = new URL(path, `http://${this.host}`);
    const req = new Request(url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const ctx = {
      env: { ...baseEnv, ...envExtra } as never,
      url,
      cookiesIn: new Map(this.jar),
      cookiesOut: [] as string[],
      waitUntil: () => {},
    };
    const res = await als.run(ctx, () => handler(req, { params: Promise.resolve(opts.params ?? {}) }));
    for (const c of ctx.cookiesOut) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    // res.text()는 맨 앞 BOM을 지우므로, CSV의 BOM을 확인할 수 있게 그대로 읽습니다.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text, headers: res.headers };
  }
}

// ── AI 흉내(fetch): 진단 호출 수를 세고, 필요하면 응답을 붙잡아 둡니다 ──
let aiCalls: { auth: string | null; name: string }[] = [];
let aiGate: Promise<void> | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const name = body?.response_format?.json_schema?.name ?? "";
  aiCalls.push({ auth: new Headers(init?.headers).get("authorization"), name });
  if (aiGate) await aiGate;
  const content = name === "mandalart_diagnosis" ? JSON.stringify({ items: [], concern: { flag: false, kind: null } }) : JSON.stringify({ ok: true });
  return new Response(JSON.stringify({ model: "test/model", provider: "Test", choices: [{ finish_reason: "stop", message: { content } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

async function untilAiCalled() {
  for (let i = 0; aiCalls.length === 0; i++) {
    if (i > 10_000) throw new Error("AI가 불리지 않음");
    await new Promise((r) => setImmediate(r));
  }
}

function fullCore(goal = "1년 안에 수학 성적 20점 올리기") {
  const c = emptyContent();
  c.goal = goal;
  c.subs = c.subs.map((_, i) => `세부 목표 ${i + 1}`);
  return c;
}

const teacher = new Browser();
let classId = "";
let classCode = "";

test("첫 교사 계정: 설정 코드가 맞아야 하고, 동시에 두 번 만들어도 한 계정만 생긴다", async () => {
  const g = await teacher.call(setup.GET, "/api/auth/setup");
  assert.equal(g.status, 200);
  assert.equal(g.body.needsSetup, true);
  assert.equal(g.body.tokenConfigured, true);

  const wrong = await teacher.call(setup.POST, "/api/auth/setup", { body: { token: "wrong-token-xxxxxxxx", loginId: "kim", displayName: "김선생", password: "password-1234" } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "wrong_token");

  const a = new Browser(), b = new Browser();
  const [ra, rb] = await Promise.all([
    a.call(setup.POST, "/api/auth/setup", { body: { token: SETUP_TOKEN, loginId: "kim", displayName: "김선생", password: "password-1234" } }),
    b.call(setup.POST, "/api/auth/setup", { body: { token: SETUP_TOKEN, loginId: "lee", displayName: "이선생", password: "password-5678" } }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  assert.equal(D1.get<{ n: number }>("select count(*) as n from teachers")!.n, 1);
  const t = D1.get<{ login_id: string; password_hash: string }>("select login_id, password_hash from teachers")!;
  assert.match(t.password_hash, new RegExp(`^pbkdf2\\$${PBKDF2_ITERATIONS}\\$`));
  assert.ok(!t.password_hash.includes("password"));

  const again = await teacher.call(setup.POST, "/api/auth/setup", { body: { token: SETUP_TOKEN, loginId: "park", displayName: "박", password: "password-0000" } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "exists");
  // 이긴 쪽 아이디로 로그인
  const winner = t.login_id;
  const pw = winner === "kim" ? "password-1234" : "password-5678";
  assert.equal(await verifyPassword(pw, t.password_hash), true);
  const bad = await teacher.call(teacherAuth.POST, "/api/auth/teacher", { body: { loginId: winner, password: "nope-nope" } });
  assert.equal(bad.status, 401);
  const ok = await teacher.call(teacherAuth.POST, "/api/auth/teacher", { body: { loginId: winner, password: pw } });
  assert.equal(ok.status, 200);
  assert.ok(teacher.jar.get("mdl_session"));
  // 실패 기록에는 아이디 원문·비밀번호가 남지 않음, 성공하면 앞 실패는 cleared
  const log = D1.all<{ type: string; payload: string }>("select type, payload from event_log where student_id is null");
  assert.ok(log.every((l) => !String(l.payload).includes(winner) && !String(l.payload).includes("nope")));
  assert.ok(log.some((l) => l.type === "teacher_login_fail_cleared"));

  // 비밀번호 다시 정하기 → 그 전 세션은 끝남
  const other = new Browser();
  await other.call(teacherAuth.POST, "/api/auth/teacher", { body: { loginId: winner, password: pw } });
  const reset = await teacher.call(setup.POST, "/api/auth/setup", { body: { mode: "reset", token: SETUP_TOKEN, loginId: winner, password: "new-password-99" } });
  assert.equal(reset.status, 200);
  assert.equal((await other.call(statusApi.GET, "/api/teacher/status")).status, 401);
  assert.equal((await teacher.call(statusApi.GET, "/api/teacher/status")).status, 200);
  assert.equal(D1.get<{ n: number }>("select count(*) as n from event_log where type = 'teacher_password_reset'")!.n, 1);
});

test("학급 만들기: 학급과 학생이 함께 생기고(PIN 포함) 학급 목록·화면에 보임", async () => {
  const r = await teacher.call(classesApi.POST, "/api/teacher/classes", {
    body: { name: "2-3반", roster: [{ number: 1, name: "가나다" }, { number: 2, name: "라마바" }, { number: 3, name: "사아자" }] },
  });
  assert.equal(r.status, 200, r.text);
  classId = r.body.id;
  classCode = r.body.class_code;
  assert.match(classId, /^[0-9a-f-]{36}$/);
  const students = D1.all<{ pin: string }>("select pin from students where class_id = ? order by number", classId);
  assert.equal(students.length, 3);
  assert.ok(students.every((s) => /^\d{4}$/.test(s.pin)));
  const list = await teacher.call(classesApi.GET, "/api/teacher/classes");
  assert.equal(list.body.classes.length, 1);
  assert.equal(list.body.classes[0].n_students, 3);
  assert.equal(list.body.classes[0].is_open, true);
  assert.equal(list.body.classes[0].require_pin, true);
  const ov = await teacher.call(classApi.GET, `/api/teacher/classes/${classId}`, { params: { id: classId } });
  assert.equal(ov.status, 200);
  assert.equal(ov.body.students.length, 3);
  assert.equal(ov.body.students[0].locked, false);
  assert.equal(ov.body.students[0].filled, 0);
  assert.equal(ov.body.hasWork, false);
  // 다른 교사 세션이 아니면 못 봄
  assert.equal((await new Browser().call(classApi.GET, `/api/teacher/classes/${classId}`, { params: { id: classId } })).status, 401);
});

function pinOf(number: number): string {
  return D1.get<{ pin: string }>("select pin from students where class_id = ? and number = ?", classId, number)!.pin;
}
function wrongPin(number: number): string {
  const p = pinOf(number);
  return p === "9999" ? "9998" : "9999";
}

test("학생 로그인: 동시에 틀려도 횟수가 빠지지 않고 8번째에 잠기며, 잠긴 동안은 맞는 PIN도 막힘", async () => {
  const s = new Browser();
  const login = (pin: string, name = "가나다") => s.call(studentAuth.POST, "/api/auth/student", { body: { classCode, number: 1, name, pin } });
  // 빈 PIN은 세지 않음
  assert.equal((await login("")).status, 401);
  assert.equal(D1.get<{ f: number }>("select failed_logins as f from students where class_id = ? and number = 1", classId)!.f, 0);
  const results = await Promise.all(Array.from({ length: 8 }, () => login(wrongPin(1))));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 429]);
  const row = D1.get<{ f: number; locked_until: string }>("select failed_logins as f, locked_until from students where class_id = ? and number = 1", classId)!;
  assert.equal(row.f, 8);
  assert.ok(row.locked_until > new Date().toISOString());
  assert.equal(D1.get<{ n: number }>("select count(*) as n from event_log where type = 'login_locked'")!.n, 1);
  const locked = await login(pinOf(1));
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /10분 뒤/);
  // 잠긴 학생도 PIN이 로그·응답에 없음
  assert.ok(!JSON.stringify(D1.all("select payload from event_log")).includes(pinOf(1)));

  // 선생님이 잠금 풀기 → 들어올 수 있음
  const sid = D1.get<{ id: string }>("select id from students where class_id = ? and number = 1", classId)!.id;
  const un = await teacher.call(studentsApi.PATCH, `/api/teacher/classes/${classId}/students`, {
    method: "PATCH", params: { id: classId }, body: { updates: [{ id: sid, unlock: true }] },
  });
  assert.equal(un.status, 200);
  assert.equal(un.body.updated, 1);
  assert.equal(D1.get<{ n: number }>("select count(*) as n from event_log where type = 'login_unlocked' and student_id = ?", sid)!.n, 1);
  const ok = await login(pinOf(1), " 가 나 다 ");
  assert.equal(ok.status, 200, ok.text);
  assert.ok(s.jar.get("mdl_session"));
});

const student = new Browser();
let mandalartId = "";
let revision = 0;

test("저장: 번호 확인으로 오래된 탭은 새 글을 덮지 못하고, 동시에 두 탭이 저장해도 하나만 반영", async () => {
  const login = await student.call(studentAuth.POST, "/api/auth/student", { body: { classCode, number: 2, name: "라마바", pin: pinOf(2) } });
  assert.equal(login.status, 200);
  const home = await student.call(mineApi.GET, "/api/mandalart");
  assert.equal(home.status, 200, home.text);
  mandalartId = home.body.mandalart.id;
  assert.equal(home.body.mandalart.revision, 0);
  assert.equal(home.body.aiReady, false);
  const put = (content: unknown, meta: Record<string, unknown>) =>
    student.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content, ...meta } });

  const c1 = fullCore();
  const r1 = await put(c1, { revision: 0 });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.body.revision, 1);
  // 오래된 탭(번호 0)이 다른 글을 보냄 → 409 stale, 글은 그대로
  const stale = await put(fullCore("옛 글"), { revision: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.stale, true);
  // 같은 글을 다시 보내면(번호를 모르는 화면) 바꾸지 않고 지금 번호
  const same = await put(c1, { revision: 0 });
  assert.equal(same.status, 200);
  assert.equal(same.body.revision, 1);

  // 두 탭이 같은 번호(1)로 동시에 다른 글을 저장 → 하나만 반영, 다른 하나는 stale
  // (둘 다 읽기를 마친 뒤에 쓰기를 하도록 붙잡아, 읽기와 쓰기 사이에 다른 탭이 끼어드는 경우를 꼭 만듦)
  D1.holdUntil(/^\s*update mandalarts set content/, 2);
  const [a, b] = await Promise.all([put(fullCore("탭 A"), { revision: 1 }), put(fullCore("탭 B"), { revision: 1 })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? "탭 A" : "탭 B";
  const row = D1.get<{ content: string; revision: number }>("select content, revision from mandalarts where id = ?", mandalartId)!;
  assert.equal(JSON.parse(row.content).goal, winner);
  assert.equal(row.revision, 2);
  revision = 2;

  // 다른 학생의 만다라트는 못 고침
  const other = new Browser();
  await other.call(studentAuth.POST, "/api/auth/student", { body: { classCode, number: 3, name: "사아자", pin: pinOf(3) } });
  const foreign = await other.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content: fullCore("남의 글"), revision: 2 } });
  assert.equal(foreign.status, 404);
});

test("저장: 규칙 안전 신호는 실제로 덮어쓴 행 기준으로 적히고, 교사 '확인했어요' 뒤 새 신호만 다시 뜸", async () => {
  const sid = D1.get<{ id: string }>("select id from students where class_id = ? and number = 2", classId)!.id;
  const c = fullCore("1년 안에 수학 성적 20점 올리기");
  c.actions[0][0] = "죽고 싶다";
  const r = await student.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content: c, revision } });
  assert.equal(r.status, 200, r.text);
  revision = r.body.revision;
  const m = D1.get<{ rule_concern_kind: string; rule_concern_at: string; rule_concern_current: number }>("select rule_concern_kind, rule_concern_at, rule_concern_current from mandalarts where id = ?", mandalartId)!;
  assert.equal(m.rule_concern_kind, "self_harm");
  assert.equal(m.rule_concern_current, 1);
  assert.match(m.rule_concern_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const detail = await teacher.call(studentApi.GET, `/api/teacher/classes/${classId}/students/${sid}`, { params: { id: classId, sid } });
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.needs_review, true);
  assert.equal(detail.body.rule_concern.kind, "self_harm");
  const seen = detail.body.concern_seen_until;
  // 확인 → 살펴볼 학생에서 빠짐
  const rev = await teacher.call(studentApi.PATCH, `/api/teacher/classes/${classId}/students/${sid}`, { method: "PATCH", params: { id: classId, sid }, body: { reviewConcern: true, seenUntil: seen } });
  assert.equal(rev.status, 200, rev.text);
  let ov = await teacher.call(classApi.GET, `/api/teacher/classes/${classId}`, { params: { id: classId } });
  assert.equal(ov.body.students.find((s: { id: string }) => s.id === sid).needs_review, false);
  // 같은 글을 다시 저장해도 다시 뜨지 않음
  const again = await student.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content: { ...c, goal: c.goal + "!" }, revision } });
  revision = again.body.revision;
  ov = await teacher.call(classApi.GET, `/api/teacher/classes/${classId}`, { params: { id: classId } });
  assert.equal(ov.body.students.find((s: { id: string }) => s.id === sid).needs_review, false);
  // 다른 칸에 새 표현 → 다시 뜸. 옛 seen으로 다시 '확인'하면 409(새 신호를 놓치지 않게)
  const c2 = structuredClone(c);
  c2.actions[1][0] = "자해하고 싶다";
  const fresh = await student.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content: c2, revision } });
  revision = fresh.body.revision;
  ov = await teacher.call(classApi.GET, `/api/teacher/classes/${classId}`, { params: { id: classId } });
  assert.equal(ov.body.students.find((s: { id: string }) => s.id === sid).needs_review, true);
  assert.equal(ov.body.ruleConcerns.length, 1);
  const late = await teacher.call(studentApi.PATCH, `/api/teacher/classes/${classId}/students/${sid}`, { method: "PATCH", params: { id: classId, sid }, body: { reviewConcern: true, seenUntil: seen } });
  assert.equal(late.status, 409);
  // 안전 신호 글은 지워 둠(다음 테스트에 영향 없게)
  const clean = await student.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content: fullCore(), revision } });
  revision = clean.body.revision;
});

test("AI 키: 교사 화면에서 넣은 키는 암호화해 저장되고, 응답에는 끝 4자리만, 피드백 호출에 그 키가 쓰임", async () => {
  const bad = await teacher.call(aiKeyApi.PUT, "/api/teacher/ai-key", { method: "PUT", body: { key: "not-a-key" } });
  assert.equal(bad.status, 400);
  assert.equal((await new Browser().call(aiKeyApi.GET, "/api/teacher/ai-key")).status, 401);
  assert.deepEqual((await teacher.call(aiKeyApi.GET, "/api/teacher/ai-key")).body, { configured: false, last4: null, fromEnv: false });
  const key = "sk-or-v1-" + "a1b2c3d4".repeat(8);
  const put = await teacher.call(aiKeyApi.PUT, "/api/teacher/ai-key", { method: "PUT", body: { key: `  ${key}\n` } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { ok: true, configured: true, last4: key.slice(-4), fromEnv: false });
  assert.ok(!put.text.includes(key.slice(0, 20)));
  const stored = D1.get<{ value: string }>("select value from app_settings where key = 'openrouter_api_key'")!.value;
  assert.match(stored, /^v1\./);
  assert.ok(!stored.includes(key) && !stored.includes(key.slice(9, 25)));
  const get = await teacher.call(aiKeyApi.GET, "/api/teacher/ai-key");
  assert.deepEqual(get.body, { configured: true, last4: key.slice(-4), fromEnv: false });
  // 새 요청에서도 키가 준비됨(ensureAiKey)
  const st = await teacher.call(statusApi.GET, "/api/teacher/status");
  assert.equal(st.body.ai.keyConfigured, true);
  const ai = await teacher.call(aiStatusApi.GET, "/api/teacher/ai-status?check=1");
  assert.equal(ai.body.keyConfigured, true);
  assert.equal(ai.body.check.ok, true);
  assert.ok(aiCalls.length > 0 && aiCalls.every((c) => c.auth === `Bearer ${key}`));
  assert.ok(!ai.text.includes(key.slice(9)));
  // 학생 화면도 AI 준비됨
  assert.equal((await student.call(mineApi.GET, "/api/mandalart")).body.aiReady, true);
  // 환경 변수 키가 있으면 그것이 먼저
  envExtra = { OPENROUTER_API_KEY: "sk-or-v1-envkeyenvkeyenvkey0000" };
  assert.deepEqual((await teacher.call(aiKeyApi.GET, "/api/teacher/ai-key")).body, { configured: true, last4: "0000", fromEnv: true });
  envExtra = {};
  aiCalls = [];
});

test("피드백: 동시에 두 번 눌러도 AI는 한 번만 부르고(만드는 중 표시), 회차와 카드가 함께 저장됨", async () => {
  const meta = { revision, hash: contentHash(fullCore()) };
  let release!: () => void;
  aiGate = new Promise<void>((r) => (release = r));
  const req = () => student.call(feedbackApi.POST, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId }, body: { stage: { kind: "core" }, ...meta } });
  // 정말 동시에 두 요청(둘 다 '만드는 중 아님'을 읽은 뒤 표시를 잡으려 함) → 하나만 표시를 잡고 AI를 부름
  D1.holdUntil(/^\s*update mandalarts set feedback_pending_until = strftime/, 2);
  const both = [req(), req()];
  await untilAiCalled();
  for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
  assert.equal(aiCalls.length, 1, "AI는 한 번만");
  const loser = await Promise.race(both.map((p) => p.then((r) => r)));
  assert.equal(loser.status, 409);
  assert.equal(loser.body.code, "busy");
  const first = (async () => {
    const [a, b] = await Promise.all(both);
    return a.status === 200 ? a : b;
  })();
  // 첫 요청이 AI를 부르는 동안 또 요청
  const second = await req();
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "busy");
  // 만드는 중에는 제출도 받지 않음
  const sub = await student.call(submitApi.POST, `/api/mandalart/${mandalartId}/submit`, { params: { id: mandalartId }, body: { content: fullCore(), revision } });
  assert.equal(sub.status, 409);
  assert.equal(sub.body.code, "feedback_pending");
  const pending = await student.call(feedbackApi.GET, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId } });
  assert.equal(pending.body.pending, true);
  release();
  aiGate = null;
  const r = await first;
  assert.equal(r.status, 200, r.text);
  assert.equal(aiCalls.filter((c) => c.name === "mandalart_diagnosis").length, 1);
  assert.equal(r.body.round.round_no, 1);
  assert.equal(r.body.round.stage, "core");
  // 끝나면 표시가 지워짐
  assert.equal(D1.get<{ p: string | null }>("select feedback_pending_until as p from mandalarts where id = ?", mandalartId)!.p, null);
  const after = await student.call(feedbackApi.GET, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId } });
  assert.equal(after.body.pending, false);
  assert.equal(after.body.rounds.length, 1);
  // 카드가 없던 단계는 확인 피드백이 필요 없음(같은 단계 2회차)
  const again = await req();
  assert.equal(again.status, 400);
  assert.equal(again.body.code, "not_needed");
  // 오래된 화면(번호도 지문도 다름) → stale
  const stale = await student.call(feedbackApi.POST, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId }, body: { stage: { kind: "core" }, revision: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale");
  aiCalls = [];
});

test("피드백(모의 모드): 내 컴퓨터 주소 + FEEDBACK_MOCK=1일 때만 켜지고, 카드 저장·응답 중복 막기", async () => {
  envExtra = { FEEDBACK_MOCK: "1" };
  // 바깥 주소로 온 요청은 모의 모드가 아님
  const remoteTeacher = new Browser("mandalart.example.workers.dev");
  remoteTeacher.jar = new Map(teacher.jar);
  assert.equal((await remoteTeacher.call(statusApi.GET, "/api/teacher/status")).body.ai.mock, false);
  assert.equal((await teacher.call(statusApi.GET, "/api/teacher/status")).body.ai.mock, true);

  // 블록 0: 실천 칸을 몇 개 비워 규칙 진단(빈칸) 카드가 생기게
  D1.run("update feedback_rounds set created_at = ? where mandalart_id = ?", new Date(Date.now() - 60_000).toISOString(), mandalartId);
  const c = fullCore();
  c.actions[0] = ["매일 문제 5개", "오답 노트", "주 3회 복습", "선생님께 질문", "친구와 스터디", "인강 1개", "", ""];
  c.actions[1] = ["a 1", "a 2", "a 3", "a 4", "a 5", "a 6", "", ""];
  const saved = await student.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content: c, revision } });
  revision = saved.body.revision;
  const fb = await student.call(feedbackApi.POST, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId }, body: { stage: { kind: "block", index: 0 }, revision } });
  assert.equal(fb.status, 200, fb.text);
  assert.equal(aiCalls.length, 0, "모의 모드는 AI를 부르지 않음");
  // 30초 안에 다른 단계를 또 요청 → wait
  const soon = await student.call(feedbackApi.POST, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId }, body: { stage: { kind: "block", index: 1 }, revision } });
  assert.equal(soon.status, 429);
  assert.equal(soon.body.code, "wait");
  const cards = fb.body.round.cards as { id: string; body: string }[];
  assert.ok(cards.length > 0);
  assert.match(cards[0].body, /모의 피드백/);
  const dbCards = D1.all<{ target: string }>("select target from feedback_cards c join feedback_rounds r on r.id = c.round_id where r.id = ?", fb.body.round.id);
  assert.equal(dbCards.length, cards.length);
  assert.ok(dbCards.every((x) => typeof JSON.parse(x.target).kind === "string"));

  // 카드 응답: 같은 응답을 동시에 두 번 → 한 번만 저장. 다른 응답은 저장
  const cardId = cards[0].id;
  const respond = (body: unknown) => student.call(respondApi.POST, `/api/cards/${cardId}/respond`, { params: { id: cardId }, body });
  const [x, y] = await Promise.all([respond({ action: "accept" }), respond({ action: "accept" })]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.equal(D1.get<{ n: number }>("select count(*) as n from feedback_responses where card_id = ?", cardId)!.n, 1);
  await respond({ action: "reject", reasonCode: "not_my_goal", reasonText: "다른 방법으로 할래요" });
  await respond({ action: "reject", reasonCode: "not_my_goal", reasonText: "다른 방법으로 할래요" });
  assert.equal(D1.get<{ n: number }>("select count(*) as n from feedback_responses where card_id = ?", cardId)!.n, 2);
  const view = await student.call(feedbackApi.GET, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId } });
  const card = view.body.rounds.flatMap((r: { cards: unknown[] }) => r.cards).find((k: { id: string }) => k.id === cardId);
  assert.deepEqual(card.response, { action: "reject", reason_code: "not_my_goal", reason_text: "다른 방법으로 할래요" });

  // 교사 화면: 카드 수·응답 수
  const ov = await teacher.call(classApi.GET, `/api/teacher/classes/${classId}`, { params: { id: classId } });
  const me = ov.body.students.find((s: { number: number }) => s.number === 2);
  assert.equal(me.cards, cards.length);
  assert.equal(me.rejected, 1);
  assert.equal(me.rounds, 2);
  assert.ok(me.filled >= 12);
  assert.equal(ov.body.hasWork, true);
  assert.equal(ov.body.ai.mock, true);

  // 확인 피드백(2회차): 카드가 가리킨 칸을 고친 뒤
  D1.run("update feedback_rounds set created_at = ? where mandalart_id = ?", new Date(Date.now() - 60_000).toISOString(), mandalartId);
  const c2 = structuredClone(c);
  c2.actions[0] = ["매일 문제 5개", "오답 노트", "주 3회 복습", "선생님께 질문", "친구와 스터디", "인강 1개", "기출 풀기", ""];
  c2.actions[1] = c.actions[1];
  const s2 = await student.call(oneApi.PUT, `/api/mandalart/${mandalartId}`, { method: "PUT", params: { id: mandalartId }, body: { content: c2, revision } });
  revision = s2.body.revision;
  const fb2 = await student.call(feedbackApi.POST, `/api/mandalart/${mandalartId}/feedback`, { params: { id: mandalartId }, body: { stage: { kind: "block", index: 0 }, revision } });
  assert.equal(fb2.status, 200, fb2.text);
  assert.equal(fb2.body.round.attempt, 2);
  // 확인 피드백 뒤에는 1회차 카드에 응답할 수 없음
  assert.equal((await respond({ action: "accept" })).status, 409);
  envExtra = {};
});

test("피드백: 만드는 중 표시 시간이 지나 제출된 뒤라면 회차·카드를 저장하지 않음(batch의 '작성 중일 때만')", async () => {
  envExtra = {};
  // 새 학생(3번)으로
  const s3 = new Browser();
  await s3.call(studentAuth.POST, "/api/auth/student", { body: { classCode, number: 3, name: "사아자", pin: pinOf(3) } });
  const home = await s3.call(mineApi.GET, "/api/mandalart");
  const id = home.body.mandalart.id;
  const saved = await s3.call(oneApi.PUT, `/api/mandalart/${id}`, { method: "PUT", params: { id }, body: { content: fullCore(), revision: 0 } });
  const rev = saved.body.revision;
  let release!: () => void;
  aiGate = new Promise<void>((r) => (release = r));
  aiCalls = [];
  const fb = s3.call(feedbackApi.POST, `/api/mandalart/${id}/feedback`, { params: { id }, body: { stage: { kind: "core" }, revision: rev } });
  await untilAiCalled();
  // 표시 시간이 지난 것처럼 만들고 제출
  D1.run("update mandalarts set feedback_pending_until = ? where id = ?", new Date(Date.now() - 1000).toISOString(), id);
  const sub = await s3.call(submitApi.POST, `/api/mandalart/${id}/submit`, { params: { id }, body: { content: fullCore(), revision: rev } });
  assert.equal(sub.status, 200, sub.text);
  release();
  aiGate = null;
  const r = await fb;
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "submitted");
  assert.equal(D1.get<{ n: number }>("select count(*) as n from feedback_rounds where mandalart_id = ?", id)!.n, 0);
  // 제출 뒤 저장은 409 submitted, 같은 글 다시 제출은 성공
  const put = await s3.call(oneApi.PUT, `/api/mandalart/${id}`, { method: "PUT", params: { id }, body: { content: fullCore("바꿈"), revision: rev + 1 } });
  assert.equal(put.status, 409);
  assert.equal(put.body.submitted, true);
  const resub = await s3.call(submitApi.POST, `/api/mandalart/${id}/submit`, { params: { id }, body: { content: fullCore(), revision: 0 } });
  assert.equal(resub.status, 200);
  // 교사가 제출 취소 → 다시 쓸 수 있음
  const sid = D1.get<{ id: string }>("select id from students where class_id = ? and number = 3", classId)!.id;
  const reopen = await teacher.call(reopenApi.POST, `/api/teacher/classes/${classId}/reopen`, { params: { id: classId }, body: { studentId: sid } });
  assert.equal(reopen.status, 200);
  const cur = D1.get<{ revision: number }>("select revision from mandalarts where id = ?", id)!.revision;
  assert.equal((await s3.call(oneApi.PUT, `/api/mandalart/${id}`, { method: "PUT", params: { id }, body: { content: fullCore("다시 씀"), revision: cur } })).status, 200);
  aiCalls = [];
});

test("CSV 내보내기: 이름·글은 있고 PIN·안전 신호는 없음, 수식은 막힘", async () => {
  // AI 안전 신호가 붙은 회차를 하나 만들어 둠(교사 화면에는 보이고 CSV에는 없어야 함)
  // (앞 테스트에서 회차 시각을 앞당겼으므로, 교사의 '확인했어요' 뒤에 생긴 신호가 되도록 시각을 지금으로 둠)
  D1.run("update feedback_rounds set concern = 1, concern_kind = 'bullying', created_at = ? where mandalart_id = ? and round_no = 1",
    new Date().toISOString(), mandalartId);
  const ov = await teacher.call(classApi.GET, `/api/teacher/classes/${classId}`, { params: { id: classId } });
  assert.equal(ov.body.aiConcerns.length, 1);
  assert.deepEqual(ov.body.aiConcerns[0].kinds, ["bullying"]);
  assert.equal(typeof ov.body.aiConcerns[0].after_review, "boolean");
  assert.match(ov.body.aiConcerns[0].last_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(ov.body.students.find((x: { number: number }) => x.number === 2).concern_count, 1);
  const list = await teacher.call(classesApi.GET, "/api/teacher/classes");
  assert.equal(list.body.classes[0].n_concern_students, 1);
  for (const type of ["mandalart", "cards"]) {
    const r = await teacher.call(exportApi.GET, `/api/teacher/classes/${classId}/export?type=${type}`, { params: { id: classId } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
    assert.ok(r.text.startsWith("\ufeff"));
    assert.ok(r.text.includes("라마바"));
    for (const n of [1, 2, 3]) assert.ok(!r.text.includes(`,${pinOf(n)},`) && !r.text.includes(`"${pinOf(n)}"`));
    assert.ok(!/self_harm|bullying|괴롭힘|안전 신호/.test(r.text));
  }
  const m = await teacher.call(exportApi.GET, `/api/teacher/classes/${classId}/export?type=mandalart`, { params: { id: classId } });
  const line2 = m.text.split("\r\n").find((l) => l.startsWith("2,"))!;
  assert.match(line2, /^2,라마바,작성 중,/);
  const cards = await teacher.call(exportApi.GET, `/api/teacher/classes/${classId}/export?type=cards`, { params: { id: classId } });
  assert.ok(cards.text.includes("다른 방법으로 할래요") || cards.text.includes("안 할래요"));
});

test("학생 PIN 켜기·끄기: 세션이 끝나고 잠금이 풀리며, 켤 때 PIN 없는 학생에게 PIN을 만듦", async () => {
  // 1번 학생을 잠가 둠, 3번 학생의 PIN을 지워 둠
  D1.run("update students set failed_logins = 8, locked_until = ? where class_id = ? and number = 1", new Date(Date.now() + 600_000).toISOString(), classId);
  const before = (await student.call(mineApi.GET, "/api/mandalart")).status;
  assert.equal(before, 200);
  const off = await teacher.call(classApi.PATCH, `/api/teacher/classes/${classId}`, { method: "PATCH", params: { id: classId }, body: { requirePin: false } });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.body, { ok: true, require_pin: false, pins_created: 0 });
  assert.equal((await student.call(mineApi.GET, "/api/mandalart")).status, 401, "PIN 설정이 바뀌면 학생 세션이 끝남");
  const l1 = D1.get<{ f: number; lu: string | null }>("select failed_logins as f, locked_until as lu from students where class_id = ? and number = 1", classId)!;
  assert.deepEqual(l1, { f: 0, lu: null });
  // PIN 없이(아무 PIN이나) 들어옴
  const s = new Browser();
  assert.equal((await s.call(studentAuth.POST, "/api/auth/student", { body: { classCode, number: 1, name: "가나다", pin: "" } })).status, 200);
  assert.equal((await s.call(studentAuth.POST, "/api/auth/student", { body: { classCode, number: 1, name: "틀린이름", pin: "" } })).status, 401);

  D1.run("update students set pin = null where class_id = ? and number = 3", classId);
  // 동시에 두 번 켜기 → PIN은 한 번만 만들어짐
  const [on1, on2] = await Promise.all([
    teacher.call(classApi.PATCH, `/api/teacher/classes/${classId}`, { method: "PATCH", params: { id: classId }, body: { requirePin: true } }),
    teacher.call(classApi.PATCH, `/api/teacher/classes/${classId}`, { method: "PATCH", params: { id: classId }, body: { requirePin: true } }),
  ]);
  assert.deepEqual([on1.status, on2.status], [200, 200]);
  assert.equal(on1.body.pins_created + on2.body.pins_created, 1);
  assert.match(pinOf(3), /^\d{4}$/);
  assert.equal(D1.get<{ r: number }>("select require_pin as r from classes where id = ?", classId)!.r, 1);
  // 이름·열기만 바꾸기
  const ren = await teacher.call(classApi.PATCH, `/api/teacher/classes/${classId}`, { method: "PATCH", params: { id: classId }, body: { name: "2학년 3반", isOpen: false, schoolLevel: "high" } });
  assert.equal(ren.status, 200);
  const cls = D1.get<{ name: string; is_open: number; school_level: string }>("select name, is_open, school_level from classes where id = ?", classId)!;
  assert.deepEqual(cls, { name: "2학년 3반", is_open: 0, school_level: "high" });
  await teacher.call(classApi.PATCH, `/api/teacher/classes/${classId}`, { method: "PATCH", params: { id: classId }, body: { isOpen: true } });
});

test("PIN 다시 만들기·명렬표 다시 올리기", async () => {
  const sid = D1.get<{ id: string }>("select id from students where class_id = ? and number = 2", classId)!.id;
  const old = pinOf(2);
  const one = await teacher.call(pinsApi.POST, `/api/teacher/classes/${classId}/pins`, { params: { id: classId }, body: { studentId: sid } });
  assert.equal(one.status, 200);
  assert.equal(one.body.number, 2);
  assert.equal(one.body.pin, pinOf(2));
  assert.notEqual(pinOf(2), old === pinOf(2) ? "" : old);
  assert.equal((await teacher.call(pinsApi.POST, `/api/teacher/classes/${classId}/pins`, { params: { id: classId }, body: { studentId: crypto.randomUUID() } })).status, 404);
  D1.run("update students set pin = null where class_id = ? and number in (1, 3)", classId);
  const [p1, p2] = await Promise.all([
    teacher.call(pinsApi.POST, `/api/teacher/classes/${classId}/pins`, { params: { id: classId }, body: {} }),
    teacher.call(pinsApi.POST, `/api/teacher/classes/${classId}/pins`, { params: { id: classId }, body: {} }),
  ]);
  assert.equal(p1.body.count + p2.body.count, 2);
  assert.equal(D1.get<{ n: number }>("select count(*) as n from students where class_id = ? and pin is null", classId)!.n, 0);

  // 이미 글을 쓴 학급에서 이름이 바뀌는 번호 → 확인 없이는 409, 확인하면 반영. 새 번호는 추가(PIN 포함)
  const roster = [{ number: 1, name: "가나다" }, { number: 2, name: "새이름" }, { number: 3, name: "사아자" }, { number: 4, name: "차카타" }];
  const r1 = await teacher.call(rosterApi.PUT, `/api/teacher/classes/${classId}/roster`, { method: "PUT", params: { id: classId }, body: { roster } });
  assert.equal(r1.status, 409);
  assert.deepEqual(r1.body.renames, [{ number: 2, from: "라마바", to: "새이름" }]);
  assert.equal(D1.get<{ n: number }>("select count(*) as n from students where class_id = ?", classId)!.n, 3);
  const r2 = await teacher.call(rosterApi.PUT, `/api/teacher/classes/${classId}/roster`, { method: "PUT", params: { id: classId }, body: { roster, confirmRenames: true } });
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(r2.body, { ok: true, added: 1, renamed: 1 });
  assert.match(pinOf(4), /^\d{4}$/);
  assert.equal(D1.get<{ name: string }>("select name from students where class_id = ? and number = 2", classId)!.name, "새이름");
});

test("학급 지우기: 학급 코드가 맞아야 하고, 학생·만다라트·회차·카드·응답·기록이 함께 지워짐", async () => {
  const wrong = await teacher.call(classApi.DELETE, `/api/teacher/classes/${classId}`, { method: "DELETE", params: { id: classId }, body: { confirmCode: "WRONG1" } });
  assert.equal(wrong.status, 400);
  const ok = await teacher.call(classApi.DELETE, `/api/teacher/classes/${classId}`, { method: "DELETE", params: { id: classId }, body: { confirmCode: classCode.toLowerCase() } });
  assert.equal(ok.status, 200);
  for (const t of ["classes", "students", "mandalarts", "feedback_rounds", "feedback_cards", "feedback_responses"]) {
    assert.equal(D1.get<{ n: number }>(`select count(*) as n from ${t}`)!.n, 0, t);
  }
  assert.equal(D1.get<{ n: number }>("select count(*) as n from event_log where student_id is not null")!.n, 0);
});

test("비밀번호 해시(PBKDF2)·AI 키 암호화: 모양이 이상하거나 비밀값·암호문이 다르면 실패", async () => {
  const h = await hashPassword("correct horse battery");
  assert.match(h, /^pbkdf2\$20000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  // 옛 scrypt 해시·지나치게 큰 반복 횟수·깨진 값은 false(오류 아님)
  for (const bad of ["scrypt$abc$def", h.replace("$20000$", "$999999999$"), h.replace("$20000$", "$10$"), "pbkdf2$20000$!!!$###", "", h + "$x"]) {
    assert.equal(await verifyPassword("correct horse battery", bad), false, bad);
  }
  assert.equal(await verifyPasswordOrDummy("x", null), false);

  const secret = "s".repeat(64);
  const key = "sk-or-v1-" + "f".repeat(64);
  const enc = await encryptAiKey(key, secret);
  assert.notEqual(enc, await encryptAiKey(key, secret), "IV가 매번 다름");
  assert.equal(await decryptAiKey(enc, secret), key);
  assert.equal(await decryptAiKey(enc, "t".repeat(64)), null, "비밀값이 다르면 못 풂");
  const [v, iv, ct] = enc.split(".");
  const flipped = ct.slice(0, 5) + (ct[5] === "A" ? "B" : "A") + ct.slice(6);
  assert.equal(await decryptAiKey(`${v}.${iv}.${flipped}`, secret), null, "바뀐 암호문은 못 풂(GCM 태그)");
  assert.equal(await decryptAiKey("garbage", secret), null);
  assert.equal(normalizeAiKey("  " + key + "\n"), key);
  for (const bad of ["sk-or-short", "sk-ant-" + "a".repeat(40), "sk-or-v1-abc def" + "a".repeat(30), 42, null]) assert.equal(normalizeAiKey(bad), null);
  // 요청 문맥이 없으면(단위 테스트) 모의 모드는 언제나 꺼짐
  assert.equal(isMock(), false);
});
