// 설치 페이지 Worker 입구.
//   GET  /               설치 안내 화면(한 페이지, #update는 업데이트 화면)
//   GET  /installer.js   화면 스크립트, /installer.css 화면 모양
//   GET  /version.json   { version } 선생님 앱이 새 버전을 확인할 때 씀(CORS *)
//   POST /api/accounts   { token } → [{ id, name }] 토큰 확인과 계정 목록
//   POST /api/install    { token, accountId, mode, newSetupCode? } → NDJSON 진행 상황
// 토큰은 요청 본문으로만 받고, 기록·저장·응답에 넣지 않습니다.
import { APP_BUILT_AT, APP_MAIN_MODULE, APP_MODULES, APP_VERSION } from "./generated/app-bundle.ts";
import { CF_API_BASE, tokenTemplateUrl } from "./app-manifest.ts";
import { CfError, InstallStop, cfClient, isAuthError, koreanError, type CfClient } from "./cf-api.ts";
import { runInstall, type InstallEvent, type ProbeResult } from "./install.ts";
import { PAGE_CSS, PAGE_JS, renderPage } from "./page.ts";

export type Env = {
  /** 로컬 개발 전용: 가짜 Cloudflare API 주소. 요청 주소가 localhost/127.0.0.1일 때만 씁니다. */
  CF_API_BASE?: string;
};

const BODY_LIMIT = 4096;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cache-Control": "no-store",
};
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function isLocal(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function respond(body: BodyInit | null, init: { status?: number; type?: string; headers?: Record<string, string> } = {}, url?: URL): Response {
  const headers = new Headers(SECURITY_HEADERS);
  if (init.type) headers.set("Content-Type", init.type);
  if (url && url.protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
  for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v);
  return new Response(body, { status: init.status ?? 200, headers });
}

function jsonRes(data: unknown, status = 200, url?: URL): Response {
  return respond(JSON.stringify(data), { status, type: "application/json; charset=utf-8" }, url);
}

const fail = (message: string, status: number, url?: URL) => jsonRes({ error: message }, status, url);

/** 같은 주소(설치 페이지)에서 보낸 요청인지. 다른 사이트가 선생님 브라우저로 보내는 요청을 막습니다. */
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("Origin");
  if (!origin || origin !== url.origin) return false;
  const site = req.headers.get("Sec-Fetch-Site");
  return !site || site === "same-origin";
}

/** JSON 본문을 크기 제한(4 KB) 안에서 읽습니다. */
async function readJson(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; status: number; message: string }> {
  if (!(req.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 415, message: "요청 형식이 맞지 않아요." };
  }
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > BODY_LIMIT) return { ok: false, status: 413, message: "요청이 너무 커요." };
  if (!req.body) return { ok: false, status: 400, message: "요청 내용이 비어 있어요." };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413, message: "요청이 너무 커요." };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(buf));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, message: "요청 내용을 읽지 못했어요." };
  }
}

/**
 * 붙여 넣은 글에서 토큰만 꺼냅니다. Cloudflare가 토큰을 만든 뒤 보여 주는 확인용 curl 명령(… Bearer <토큰> …)을
 * 통째로 붙여 넣어도 됩니다. 토큰 모양이 아니면 null.
 */
export function extractToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const bearer = /Bearer\s+([A-Za-z0-9._~+/=-]+)/.exec(s);
  if (bearer) s = bearer[1];
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  return /^[A-Za-z0-9._~+/=-]{20,300}$/.test(s) ? s : null;
}

/** OpenRouter 키를 잘못 붙여 넣었는지(이 설치 페이지는 OpenRouter 키를 받지 않음) */
function looksLikeOpenRouterKey(raw: unknown): boolean {
  return typeof raw === "string" && /sk-or-/i.test(raw);
}

const OPENROUTER_REFUSAL =
  "붙여 넣은 것은 OpenRouter(AI) 키예요. 이 칸에는 Cloudflare 설치 토큰을 넣어야 해요. " +
  "AI 키는 설치가 끝난 뒤 내 앱의 교사 화면 'AI 연결 키'에 넣으세요(이 페이지에는 넣지 마세요).";

function apiBase(env: Env, url: URL): string {
  return isLocal(url) && env.CF_API_BASE ? env.CF_API_BASE.replace(/\/+$/, "") : CF_API_BASE;
}

async function readToken(req: Request, url: URL): Promise<{ ok: true; token: string; body: Record<string, unknown> } | { ok: false; res: Response }> {
  if (!sameOrigin(req, url)) return { ok: false, res: fail("이 설치 페이지에서만 쓸 수 있어요.", 403, url) };
  const body = await readJson(req);
  if (!body.ok) return { ok: false, res: fail(body.message, body.status, url) };
  if (looksLikeOpenRouterKey(body.value.token)) return { ok: false, res: fail(OPENROUTER_REFUSAL, 400, url) };
  const token = extractToken(body.value.token);
  if (!token) {
    return {
      ok: false,
      res: fail("토큰 모양이 아니에요. Cloudflare 토큰 화면의 'Copy' 버튼으로 복사한 값을 그대로 붙여 넣어 주세요.", 400, url),
    };
  }
  return { ok: true, token, body: body.value };
}

// ── POST /api/accounts ────────────────────────────────────────

type AccountItem = { id?: unknown; name?: unknown };

/** 이 계정에서 Workers·D1 권한이 있는지 읽기 전용으로 살짝 확인합니다. 빠진 권한 이름 목록. */
async function missingPermissions(cf: CfClient, accountId: string): Promise<string[]> {
  const probe = async (path: string, label: string) => {
    try {
      await cf.call("GET", `/accounts/${accountId}${path}`, { action: "권한 확인", timeoutMs: 15_000 });
      return null;
    } catch (e) {
      return isAuthError(e) ? label : null; // 다른 오류(일시적)는 설치 단계에서 다시 알려 줌
    }
  };
  const r = await Promise.all([probe("/workers/scripts", "Workers Scripts (Edit)"), probe("/d1/database?per_page=1", "D1 (Edit)")]);
  return r.filter((x): x is string => !!x);
}

async function handleAccounts(req: Request, env: Env, url: URL): Promise<Response> {
  const t = await readToken(req, url);
  if (!t.ok) return t.res;
  const cf = cfClient(apiBase(env, url), t.token);
  try {
    const v = await cf.call<{ status?: unknown; expires_on?: unknown } | null>("GET", "/user/tokens/verify", { action: "토큰 확인", timeoutMs: 15_000 });
    if (v?.status !== "active") {
      return fail(
        v?.status === "expired"
          ? "토큰이 만료되었어요. 2단계의 '설치 토큰 만들기' 버튼으로 토큰을 새로 만들어 주세요."
          : "이 토큰은 지금 쓸 수 없는 상태예요(사용 중지 또는 시작 전). 2단계의 '설치 토큰 만들기' 버튼으로 토큰을 새로 만들어 주세요.",
        400,
        url,
      );
    }
    const list = await cf.call<AccountItem[]>("GET", "/accounts?per_page=50", { action: "계정 목록 읽기", timeoutMs: 15_000 });
    const accounts = (Array.isArray(list) ? list : [])
      .filter((a) => typeof a?.id === "string" && ACCOUNT_ID.test(a.id))
      .map((a) => ({ id: a.id as string, name: typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 100) : (a.id as string) }));
    if (!accounts.length) {
      return fail(
        "이 토큰으로 볼 수 있는 Cloudflare 계정이 없어요. 토큰 화면의 'Account Resources'에서 내 계정을 골랐는지 확인하고 토큰을 다시 만들어 주세요. " +
          "(Cloudflare 이메일 인증을 아직 안 했다면 먼저 해 주세요.)",
        400,
        url,
      );
    }
    // 권한 확인(최대 10개 계정)
    const checked = await Promise.all(accounts.slice(0, 10).map(async (a) => ({ a, missing: await missingPermissions(cf, a.id) })));
    const usable = checked.filter((c) => !c.missing.length).map((c) => c.a);
    if (!usable.length) {
      const missing = [...new Set(checked.flatMap((c) => c.missing))];
      return fail(
        `토큰에 필요한 권한이 빠져 있어요: ${missing.join(", ")}. 토큰 화면의 Permissions에 Account Settings(Read), Workers Scripts(Edit), D1(Edit) ` +
          "세 줄이 모두 있어야 해요. 2단계의 '설치 토큰 만들기' 버튼으로 토큰을 새로 만들어 주세요.",
        403,
        url,
      );
    }
    return jsonRes(usable, 200, url);
  } catch (e) {
    return fail(koreanError(e), e instanceof CfError && isAuthError(e) ? 403 : 502, url);
  }
}

// ── POST /api/install ─────────────────────────────────────────

/** 앱이 대답하는지: GET /api/auth/setup이 JSON으로 대답하면 ok */
function makeProbe(env: Env, url: URL): (appUrl: string) => Promise<ProbeResult> {
  const local = isLocal(url) && env.CF_API_BASE;
  return async (appUrl) => {
    // 로컬 개발: 가짜 API 서버가 '올린 앱'을 대신 띄워 /__probe/<호스트>/... 로 이어 줍니다.
    const target = local
      ? `${apiBase(env, url).replace(/\/client\/v4$/, "")}/__probe/${new URL(appUrl).host}/api/auth/setup`
      : `${appUrl}/api/auth/setup`;
    try {
      const res = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000), redirect: "manual" });
      if (!res.ok) return { ok: false };
      const data = (await res.json().catch(() => null)) as { tokenConfigured?: unknown } | null;
      if (!data || typeof data !== "object" || !("tokenConfigured" in data)) return { ok: false };
      return { ok: true, tokenConfigured: data.tokenConfigured === true };
    } catch {
      return { ok: false };
    }
  };
}

async function handleInstall(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const t = await readToken(req, url);
  if (!t.ok) return t.res;
  const { accountId, mode, newSetupCode } = t.body;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return fail("설치할 계정을 다시 골라 주세요.", 400, url);
  if (mode !== "install" && mode !== "update") return fail("설치인지 업데이트인지 알 수 없어요. 페이지를 새로 고쳐 주세요.", 400, url);
  if (newSetupCode !== undefined && typeof newSetupCode !== "boolean") return fail("요청 내용을 읽지 못했어요.", 400, url);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const emit = (e: InstallEvent) => {
    if (closed) return;
    writer.write(enc.encode(`${JSON.stringify(e)}\n`)).catch(() => {
      closed = true; // 브라우저가 연결을 끊음: 설치는 계속하고 알림만 멈춤
    });
  };

  const job = (async () => {
    try {
      await runInstall({
        cf: cfClient(apiBase(env, url), t.token),
        accountId,
        mode,
        newSetupCode: mode === "update" && newSetupCode === true,
        installerUrl: url.origin,
        bundle: { version: APP_VERSION, mainModule: APP_MAIN_MODULE, modules: APP_MODULES },
        emit,
        probe: makeProbe(env, url),
      });
    } catch (e) {
      const stop = e instanceof InstallStop;
      emit({ type: "error", message: koreanError(e), retry: !stop, ...(stop && e.goto ? { goto: e.goto } : {}) });
    } finally {
      closed = true;
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(job);

  return respond(readable, {
    type: "application/x-ndjson; charset=utf-8",
    // 중간 압축·버퍼링 없이 바로 흘려보내기
    headers: { "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  }, url);
}

// ── 입구 ──────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path.startsWith("/api/")) {
      if (method !== "POST") return fail("없는 주소예요.", method === "GET" ? 404 : 405, url);
      if (path === "/api/accounts") return handleAccounts(req, env, url);
      if (path === "/api/install") return handleInstall(req, env, url, ctx);
      return fail("없는 주소예요.", 404, url);
    }
    if (method !== "GET" && method !== "HEAD") return respond("Method Not Allowed", { status: 405, type: "text/plain; charset=utf-8" }, url);

    switch (path) {
      case "/":
      case "/index.html":
        return respond(renderPage({ version: APP_VERSION, builtAt: APP_BUILT_AT, tokenUrl: tokenTemplateUrl() }), {
          type: "text/html; charset=utf-8",
          headers: { "Content-Security-Policy": PAGE_CSP },
        }, url);
      case "/installer.js":
        return respond(PAGE_JS, { type: "text/javascript; charset=utf-8" }, url);
      case "/installer.css":
        return respond(PAGE_CSS, { type: "text/css; charset=utf-8" }, url);
      case "/version.json":
        return respond(JSON.stringify({ version: APP_VERSION }), {
          type: "application/json; charset=utf-8",
          headers: { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" },
        }, url);
      default:
        return respond("없는 주소예요.", { status: 404, type: "text/plain; charset=utf-8" }, url);
    }
  },
} satisfies ExportedHandler<Env>;
