// Cloudflare Worker 입구. 원래 Next.js 앱의 API 라우트(src/app/api/**/route.ts)를 그대로 불러 Hono로 연결하고,
// 학생·교사 화면(web/, Vite로 만든 React 앱)은 빌드 결과를 Worker 안에 넣어 둔 것(worker/generated/assets.ts)을 돌려줍니다.
import { Hono, type Context } from "hono";
import { als, parseCookieHeader, type AppEnv, type RequestCtx } from "../src/lib/request-context";
import { ASSETS } from "./generated/assets";
import { NavigationThrow } from "./shims/next-navigation";
import { viewRoutes } from "./views";

import * as authLogout from "../src/app/api/auth/logout/route";
import * as authSetup from "../src/app/api/auth/setup/route";
import * as authStudent from "../src/app/api/auth/student/route";
import * as authTeacher from "../src/app/api/auth/teacher/route";
import * as cardRespond from "../src/app/api/cards/[id]/respond/route";
import * as mandalartFeedback from "../src/app/api/mandalart/[id]/feedback/route";
import * as mandalartOne from "../src/app/api/mandalart/[id]/route";
import * as mandalartSubmit from "../src/app/api/mandalart/[id]/submit/route";
import * as mandalartMine from "../src/app/api/mandalart/route";
import * as teacherAiKey from "../src/app/api/teacher/ai-key/route";
import * as teacherAiStatus from "../src/app/api/teacher/ai-status/route";
import * as teacherAppUpdate from "../src/app/api/teacher/app-update/route";
import * as classExport from "../src/app/api/teacher/classes/[id]/export/route";
import * as classPins from "../src/app/api/teacher/classes/[id]/pins/route";
import * as classReopen from "../src/app/api/teacher/classes/[id]/reopen/route";
import * as classRoster from "../src/app/api/teacher/classes/[id]/roster/route";
import * as classOne from "../src/app/api/teacher/classes/[id]/route";
import * as classStudent from "../src/app/api/teacher/classes/[id]/students/[sid]/route";
import * as classStudents from "../src/app/api/teacher/classes/[id]/students/route";
import * as classes from "../src/app/api/teacher/classes/route";
import * as teacherStatus from "../src/app/api/teacher/status/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 라우트마다 params 모양({ id } 등)이 다름
type Handler = (req: Request, ctx: { params: Promise<any> }) => Response | Promise<Response>;
type Mod = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>;

const app = new Hono<{ Bindings: AppEnv }>();

function mount(path: string, mod: Mod) {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const h = mod[method];
    if (!h) continue;
    app.on(method, path, (c: Context) => h(c.req.raw, { params: Promise.resolve(c.req.param() as Record<string, string>) }));
  }
}

mount("/api/auth/logout", authLogout);
mount("/api/auth/setup", authSetup);
mount("/api/auth/student", authStudent);
mount("/api/auth/teacher", authTeacher);
mount("/api/cards/:id/respond", cardRespond);
mount("/api/mandalart/:id/feedback", mandalartFeedback);
mount("/api/mandalart/:id/submit", mandalartSubmit);
mount("/api/mandalart/:id", mandalartOne);
mount("/api/mandalart", mandalartMine);
mount("/api/teacher/ai-key", teacherAiKey);
mount("/api/teacher/ai-status", teacherAiStatus);
mount("/api/teacher/app-update", teacherAppUpdate);
mount("/api/teacher/classes/:id/export", classExport);
mount("/api/teacher/classes/:id/pins", classPins);
mount("/api/teacher/classes/:id/reopen", classReopen);
mount("/api/teacher/classes/:id/roster", classRoster);
mount("/api/teacher/classes/:id/students/:sid", classStudent);
mount("/api/teacher/classes/:id/students", classStudents);
mount("/api/teacher/classes/:id", classOne);
mount("/api/teacher/classes", classes);
mount("/api/teacher/status", teacherStatus);
// 화면에 필요한 데이터(원래 서버 화면이 DB에서 읽던 것)를 JSON으로 돌려주는 주소: /api/view/...
viewRoutes(app);

app.all("/api/*", (c) => c.json({ error: "없는 주소예요." }, 404));

app.onError((err, c) => {
  if (err instanceof NavigationThrow) {
    return err.kind === "redirect" ? c.json({ error: "다시 로그인해 주세요.", redirect: err.to }, 401) : c.json({ error: "찾을 수 없어요." }, 404);
  }
  console.error("[오류]", err instanceof Error ? `${err.name}: ${err.message}` : err);
  return c.json({ error: "서버에서 문제가 생겼어요. 잠시 뒤 다시 해 주세요." }, 500);
});

// ── 화면 파일(Vite 빌드 결과) ──
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function serveAsset(path: string, req: Request): Response | null {
  const a = ASSETS[path];
  if (!a) return null;
  const headers = new Headers({ "Content-Type": a.type, ETag: `"${a.etag}"`, ...SECURITY_HEADERS });
  headers.set("Cache-Control", a.immutable ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.headers.get("If-None-Match") === `"${a.etag}"`) return new Response(null, { status: 304, headers });
  return new Response(a.b64 ? decode(a.body) : a.body, { headers });
}

app.get("*", (c) => {
  const path = new URL(c.req.url).pathname;
  return serveAsset(path, c.req.raw) ?? serveAsset("/index.html", c.req.raw) ?? c.text("화면 파일이 없습니다(npm run build:web).", 500);
});

export default {
  async fetch(req: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const rctx: RequestCtx = {
      env,
      url: new URL(req.url),
      cookiesIn: parseCookieHeader(req.headers.get("Cookie")),
      cookiesOut: [],
      waitUntil: (p) => ctx.waitUntil(p),
    };
    const res = await als.run(rctx, () => app.fetch(req, env, ctx));
    if (!rctx.cookiesOut.length && !rctx.url.pathname.startsWith("/api/")) return res;
    const out = new Response(res.body, res);
    for (const c of rctx.cookiesOut) out.headers.append("Set-Cookie", c);
    if (rctx.url.pathname.startsWith("/api/")) {
      out.headers.set("Cache-Control", "no-store");
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    }
    return out;
  },
};
