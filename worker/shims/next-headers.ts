// next/headers의 cookies()를 흉내 냅니다(Cloudflare Worker용). 요청 문맥(src/lib/request-context.ts)에서 읽고 씁니다.
import { rc } from "../../src/lib/request-context";

type CookieOpts = { httpOnly?: boolean; secure?: boolean; sameSite?: "lax" | "strict" | "none"; path?: string; maxAge?: number };

function serialize(name: string, value: string, o: CookieOpts): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/"}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAge)}`);
  if (o.maxAge !== undefined && o.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (o.httpOnly) parts.push("HttpOnly");
  // https로 열면 언제나 Secure(로컬 http 개발 서버에서는 뺌)
  if (rc().url.protocol === "https:") parts.push("Secure");
  if (o.sameSite) parts.push(`SameSite=${o.sameSite[0].toUpperCase()}${o.sameSite.slice(1)}`);
  return parts.join("; ");
}

export async function cookies() {
  const c = rc();
  return {
    get(name: string) {
      const v = c.cookiesIn.get(name);
      return v === undefined ? undefined : { name, value: v };
    },
    set(name: string, value: string, opts: CookieOpts = {}) {
      c.cookiesIn.set(name, value);
      c.cookiesOut.push(serialize(name, value, opts));
    },
    delete(name: string) {
      c.cookiesIn.delete(name);
      c.cookiesOut.push(serialize(name, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" }));
    },
  };
}

export async function headers() {
  return new Headers();
}
