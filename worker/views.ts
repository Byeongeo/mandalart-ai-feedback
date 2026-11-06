// 화면 데이터 주소(/api/view/...). 원래 Next.js 서버 화면(src/app/**/page.tsx)이 DB에서 읽던 것을 JSON으로 돌려줍니다.
// (웹 화면 담당이 채웁니다.)
import type { Hono } from "hono";
import type { AppEnv } from "../src/lib/request-context";

export function viewRoutes(app: Hono<{ Bindings: AppEnv }>) {
  void app;
}
