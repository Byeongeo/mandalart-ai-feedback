// 타입 검사(tsc)용 선언. 원래 Next.js 앱의 코드가 가져오는 모듈을 Cloudflare Worker에서는 wrangler.jsonc의 alias가
// worker/shims/*로 바꿔 끼웁니다. tsc는 그 alias를 모르므로 여기서 같은 모양을 알려 줍니다(실제 코드는 worker/shims/).
declare module "server-only" {}

declare module "next/headers" {
  type CookieOpts = { httpOnly?: boolean; secure?: boolean; sameSite?: "lax" | "strict" | "none"; path?: string; maxAge?: number };
  export function cookies(): Promise<{
    get(name: string): { name: string; value: string } | undefined;
    set(name: string, value: string, opts?: CookieOpts): void;
    delete(name: string): void;
  }>;
  export function headers(): Promise<Headers>;
}

declare module "next/navigation" {
  export function redirect(to: string): never;
  export function notFound(): never;
}
