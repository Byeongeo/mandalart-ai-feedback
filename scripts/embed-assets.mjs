// Vite 빌드 결과(dist/web)를 Worker 안에 넣을 수 있게 worker/generated/assets.ts로 만듭니다.
// 글(HTML·JS·CSS·SVG·JSON)은 그대로, 그 밖(아이콘 등)은 base64로 넣습니다. /assets/ 아래 파일은 이름에 해시가 있어 오래 캐시합니다.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist/web");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".png": "image/png",
  ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const TEXT = new Set([".html", ".js", ".css", ".svg", ".json", ".txt"]);
const out = {};
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const ext = extname(name);
      const buf = readFileSync(p);
      const path = "/" + relative(dist, p).split("\\").join("/");
      const text = TEXT.has(ext);
      out[path] = {
        type: TYPES[ext] ?? "application/octet-stream",
        body: text ? buf.toString("utf8") : buf.toString("base64"),
        b64: !text,
        etag: createHash("sha256").update(buf).digest("hex").slice(0, 16),
        immutable: path.startsWith("/assets/"),
      };
    }
  }
}
walk(dist);
mkdirSync(join(root, "worker/generated"), { recursive: true });
writeFileSync(
  join(root, "worker/generated/assets.ts"),
  "// 자동으로 만든 파일입니다(scripts/embed-assets.mjs). 직접 고치지 마세요.\n" +
    "export const ASSETS: Record<string, { type: string; body: string; b64: boolean; etag: string; immutable: boolean }> = " +
    JSON.stringify(out) + ";\n",
);
console.log(`화면 파일 ${Object.keys(out).length}개를 worker/generated/assets.ts에 넣었습니다.`);
