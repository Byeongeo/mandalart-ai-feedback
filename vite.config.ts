// 학생·교사 화면(web/)을 만드는 Vite 설정. 결과는 dist/web에 나오고, scripts/embed-assets.mjs가 Worker 안에 넣습니다.
// 원래 Next.js 컴포넌트(src/components)를 그대로 쓰도록 next/link·next/navigation을 web/shims의 작은 흉내로 바꿔 끼웁니다.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("./web"),
  publicDir: here("./web/public"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^next\/link$/, replacement: here("./web/shims/link.tsx") },
      { find: /^next\/navigation$/, replacement: here("./web/shims/navigation.ts") },
      { find: /^@\//, replacement: here("./src/") },
    ],
  },
  build: {
    outDir: here("./dist/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    // 휴대폰·학교 PC의 오래된 브라우저도 고려(React 19가 받는 범위)
    target: "es2020",
    sourcemap: false,
  },
  server: {
    // 화면만 고칠 때(npx vite): /api/*를 따로 띄운 wrangler dev(기본 8787)로 넘깁니다.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
