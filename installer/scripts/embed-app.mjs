// 앱 빌드 결과(저장소 루트의 dist/app, `npm run build`가 `wrangler deploy --dry-run --outdir dist/app`로 만든 Worker 모듈)를
// 설치 페이지 Worker 안에 넣을 수 있게 src/generated/app-bundle.ts로 만듭니다.
// - .map(소스 맵)과 README.md는 넣지 않습니다.
// - 앱 버전은 루트 package.json의 version, 호환 날짜·플래그는 루트 wrangler.jsonc와 src/app-manifest.ts가 같은지 확인합니다.
// 다른 앱 빌드 폴더를 쓰려면: node scripts/embed-app.mjs <폴더> (또는 환경 변수 APP_DIST)
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const here = new URL("..", import.meta.url).pathname;
const root = resolve(here, "..");
const dist = resolve(process.argv[2] ?? process.env.APP_DIST ?? join(root, "dist/app"));

function fail(msg) {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

// ── 앱 버전 ──
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = String(pkg.version ?? "");
if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) fail(`루트 package.json의 version이 x.y.z 모양이 아닙니다: ${version}`);

// ── 호환 날짜·플래그: 루트 wrangler.jsonc ↔ src/app-manifest.ts ──
function stripJsonc(text) {
  // 문자열 밖의 // 주석과 /* */ 주석, 끝의 쉼표를 지웁니다.
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
const wr = JSON.parse(stripJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
const manifest = readFileSync(join(here, "src/app-manifest.ts"), "utf8");
const mDate = /COMPATIBILITY_DATE\s*=\s*"([^"]+)"/.exec(manifest)?.[1];
const mFlags = /COMPATIBILITY_FLAGS[^=]*=\s*(\[[^\]]*\])/.exec(manifest)?.[1];
if (!mDate || !mFlags) fail("src/app-manifest.ts에서 COMPATIBILITY_DATE·COMPATIBILITY_FLAGS를 읽지 못했습니다.");
const flags = JSON.parse(mFlags);
if (wr.compatibility_date !== mDate) fail(`compatibility_date가 다릅니다: wrangler.jsonc ${wr.compatibility_date} ↔ app-manifest.ts ${mDate}`);
if (JSON.stringify(wr.compatibility_flags ?? []) !== JSON.stringify(flags)) {
  fail(`compatibility_flags가 다릅니다: wrangler.jsonc ${JSON.stringify(wr.compatibility_flags)} ↔ app-manifest.ts ${mFlags}`);
}

// ── 모듈 ──
const TYPES = {
  ".js": { mime: "application/javascript+module", text: true },
  ".mjs": { mime: "application/javascript+module", text: true },
  ".cjs": { mime: "application/javascript", text: true },
  ".wasm": { mime: "application/wasm", text: false },
  ".txt": { mime: "text/plain", text: true },
  ".html": { mime: "text/plain", text: true },
  ".sql": { mime: "text/plain", text: true },
  ".bin": { mime: "application/octet-stream", text: false },
};
let names;
try {
  names = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else names.push(`${prefix}${name}`);
    }
  };
  walk(dist, "");
} catch {
  fail(`앱 빌드 폴더가 없습니다: ${dist}\n  저장소 루트에서 먼저 'npm run build'를 하세요.`);
}
const modules = [];
for (const name of names) {
  if (name.endsWith(".map") || /(^|\/)README(\.md)?$/i.test(name)) continue;
  const t = TYPES[extname(name)];
  if (!t) fail(`넣을 수 없는 파일 종류입니다: ${name} (scripts/embed-app.mjs의 TYPES에 추가하세요)`);
  const buf = readFileSync(join(dist, name));
  modules.push({ name, type: t.mime, b64: !t.text, content: t.text ? buf.toString("utf8") : buf.toString("base64") });
}
const main = modules.find((m) => m.name === "index.js") ?? (modules.filter((m) => m.type === "application/javascript+module").length === 1
  ? modules.find((m) => m.type === "application/javascript+module")
  : undefined);
if (!main) fail(`앱의 첫 모듈(index.js)을 찾지 못했습니다: ${dist}`);

let built = "";
try {
  built = /generated at (\S+?)\.?$/m.exec(readFileSync(join(dist, "README.md"), "utf8"))?.[1] ?? "";
} catch {}

const raw = modules.reduce((n, m) => n + Buffer.byteLength(m.content, m.b64 ? "base64" : "utf8"), 0);
const gz = modules.reduce((n, m) => n + gzipSync(Buffer.from(m.content, m.b64 ? "base64" : "utf8")).length, 0);
// 무료 요금제 Worker 크기 한도는 압축 후 3 MB입니다(선생님 계정).
if (gz > 3 * 1024 * 1024) fail(`앱 묶음이 압축 후 ${(gz / 1048576).toFixed(2)} MB로, 무료 요금제 한도(3 MB)를 넘습니다.`);
if (gz > 2.5 * 1024 * 1024) console.warn(`! 앱 묶음이 압축 후 ${(gz / 1048576).toFixed(2)} MB입니다. 무료 요금제 한도(3 MB)에 가깝습니다.`);

mkdirSync(join(here, "src/generated"), { recursive: true });
writeFileSync(
  join(here, "src/generated/app-bundle.ts"),
  "// 자동으로 만든 파일입니다(installer/scripts/embed-app.mjs). 직접 고치지 마세요.\n" +
    `export const APP_VERSION = ${JSON.stringify(version)};\n` +
    `export const APP_BUILT_AT = ${JSON.stringify(built)};\n` +
    `export const APP_MAIN_MODULE = ${JSON.stringify(main.name)};\n` +
    "export const APP_MODULES: { name: string; type: string; b64: boolean; content: string }[] = " +
    JSON.stringify(modules) + ";\n",
);
console.log(
  `앱 ${version}(빌드 ${built || "시각 모름"})의 모듈 ${modules.length}개(${modules.map((m) => m.name).join(", ")}), ` +
    `${(raw / 1024).toFixed(0)} KiB / 압축 ${(gz / 1024).toFixed(0)} KiB를 src/generated/app-bundle.ts에 넣었습니다.`,
);
