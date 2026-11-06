// 요청 하나의 정보(Cloudflare 바인딩, 쿠키, 주소)를 담아 두는 곳입니다.
// worker/index.ts가 요청마다 als.run(...)으로 채우고, db.ts·next/headers 흉내(worker/shims)가 여기서 꺼내 씁니다.
// 이렇게 하면 원래 Next.js 앱의 lib·API 코드를 거의 그대로 쓸 수 있습니다.
import { AsyncLocalStorage } from "node:async_hooks";

/** D1에서 쓰는 만큼만 적은 타입(@cloudflare/workers-types의 D1Database와 호환) */
export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all(): Promise<D1ResultLike>;
}
export interface D1ResultLike {
  results?: Record<string, unknown>[];
  meta?: { changes?: number; last_row_id?: number };
}

export type AppEnv = {
  DB: D1Like;
  /** 설치 프로그램이 넣는 비밀값(세션 서명·AI 키 암호화). 없으면 DB에 자동으로 만든 값을 씁니다. */
  APP_SECRET?: string;
  /** 첫 교사 계정을 만들 때 쓰는 설정 코드(설치 프로그램이 넣음) */
  SETUP_TOKEN?: string;
  /** 이 앱을 설치한 설치 페이지 주소(업데이트 안내에 씀) */
  INSTALLER_URL?: string;
  APP_VERSION?: string;
  [k: string]: unknown;
};

export type RequestCtx = {
  env: AppEnv;
  url: URL;
  cookiesIn: Map<string, string>;
  cookiesOut: string[];
  waitUntil: (p: Promise<unknown>) => void;
  /** 이 요청에서 읽어 둔 OpenRouter 키(ensureAiKey가 채움). undefined = 아직 안 읽음, null = 없음 */
  aiKey?: string | null;
};

export const als = new AsyncLocalStorage<RequestCtx>();

export function rc(): RequestCtx {
  const c = als.getStore();
  if (!c) throw new Error("요청 문맥이 없습니다(worker/index.ts의 als.run 안에서만 부를 수 있음).");
  return c;
}

export function maybeRc(): RequestCtx | undefined {
  return als.getStore();
}

export function parseCookieHeader(h: string | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!h) return m;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || m.has(k)) continue;
    try {
      m.set(k, decodeURIComponent(v));
    } catch {
      m.set(k, v);
    }
  }
  return m;
}
