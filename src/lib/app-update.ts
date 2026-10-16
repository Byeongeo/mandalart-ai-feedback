// 교사 화면의 '앱 업데이트' 카드에 쓰는 순수 함수와 상수(서버에서만 부르지만 단위 테스트를 위해 server-only는 붙이지 않음).
// Deploy 버튼이 만든 교사 사본에는 .github/workflows가 따라오지 않으므로, 교사가 GitHub 새 파일 화면에서
// workflow 파일을 한 번 넣게 하고(installWorkflowUrl), 그 뒤로는 Actions에서 실행하게 합니다(runWorkflowUrl).

export const UPSTREAM_OWNER = "Byeongeo";
export const UPSTREAM_REPO = "mandalart-ai-feedback";
export const WORKFLOW_FILE = "update-from-template.yml";
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;

/** 원본 저장소의 최신 package.json(버전 확인용, 공개 저장소) */
export const UPSTREAM_PACKAGE_JSON_URL = `https://raw.githubusercontent.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/main/package.json`;
/** 원본 저장소의 workflow 파일 원문(직접 복사해 넣을 때) */
export const UPSTREAM_WORKFLOW_RAW_URL = `https://raw.githubusercontent.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/main/${WORKFLOW_PATH}`;
/** 설치 안내 5. 앱 업데이트 받기(원본 저장소, 교사 사본은 비공개라 원본을 가리킴) */
export const UPDATE_DOCS_URL = encodeURI(`https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/blob/main/docs/설치_안내.md#5-앱-업데이트-받기`);
/** 설치 안내 5-3. 직접 넣기(카드가 없거나 새 파일 화면의 편집 칸이 비어 있을 때) */
export const MANUAL_INSTALL_DOCS_URL = encodeURI(
  `https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/blob/main/docs/설치_안내.md#5-3-직접-넣기-카드가-없거나-편집-칸이-비어-있을-때`,
);

/**
 * workflow 파일을 넣는 가지는 언제나 main입니다. workflow가 main을 받아 main에 올리고(checkout ref: main, push HEAD:main),
 * GitHub의 'Run workflow'는 기본 가지(Deploy 복제본은 main)에 있는 파일에만 나오기 때문입니다.
 * (VERCEL_GIT_COMMIT_REF는 미리보기 배포에서 다른 가지일 수 있어 쓰지 않습니다.)
 */
export const WORKFLOW_BRANCH = "main";

export type GitRepo = { owner: string; repo: string };

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Vercel 시스템 환경 변수(VERCEL_GIT_REPO_OWNER, VERCEL_GIT_REPO_SLUG, 빌드·실행 때 모두 있음)에서
 * 이 앱의 GitHub 저장소를 알아냅니다. 없거나(내 컴퓨터, 시스템 변수 노출을 끈 경우) GitHub가 아니면 null.
 * 필수 값이 아닙니다. null이면 화면이 버튼 대신 직접 하는 방법을 보여 줍니다.
 */
export function repoFromEnv(env: Record<string, string | undefined>): GitRepo | null {
  const owner = env.VERCEL_GIT_REPO_OWNER?.trim() ?? "";
  const repo = env.VERCEL_GIT_REPO_SLUG?.trim() ?? "";
  const provider = env.VERCEL_GIT_PROVIDER?.trim().toLowerCase();
  if (provider && provider !== "github") return null;
  if (!NAME.test(owner) || !NAME.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo };
}

const enc = encodeURIComponent;

/**
 * GitHub 새 파일 화면(파일 이름·내용이 채워진 채로). 교사는 'Commit changes…' → 'Commit changes'만 누르면 됩니다.
 * content에는 src/lib/update-workflow-yml.ts의 UPDATE_WORKFLOW_YML(workflow 파일과 같은 내용)을 넣습니다.
 */
export function installWorkflowUrl(r: GitRepo, content: string): string {
  return `https://github.com/${enc(r.owner)}/${enc(r.repo)}/new/${WORKFLOW_BRANCH}?filename=${enc(WORKFLOW_PATH)}&value=${enc(content)}`;
}

/** Actions의 '앱 업데이트' 화면('Run workflow' 버튼이 있는 곳) */
export function runWorkflowUrl(r: GitRepo): string {
  return `https://github.com/${enc(r.owner)}/${enc(r.repo)}/actions/workflows/${WORKFLOW_FILE}`;
}

// ── 버전 ─────────────────────────────────────────────────────

/** 'x.y.z'(숫자만) → [x, y, z]. 다른 모양(접두사 v, -beta 등)은 null. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a가 b보다 새 버전이면 1, 같으면 0, 옛 버전이면 -1. 둘 중 하나라도 읽을 수 없으면 null. */
export function compareVersions(a: unknown, b: unknown): 1 | 0 | -1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** 원본 버전(latest)이 지금 버전(current)보다 새것일 때만 true(읽을 수 없으면 false). */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  return compareVersions(latest, current) === 1;
}

/** 버전 뒤에 붙일 조사(이/가): 마지막 숫자를 읽는 소리로 정합니다(1.2.0이, 1.2.2가). */
export function subjectParticle(version: string): "이" | "가" {
  return /[2459]$/.test(version.trim()) ? "가" : "이";
}

export const VERSION_TIMEOUT_MS = 2_500;
/** 받은 버전을 이 시간 동안 기억합니다(이 서버 인스턴스 안에서만). */
export const VERSION_TTL_MS = 60 * 60_000;
/** 실패한 뒤 이 시간 동안은 다시 묻지 않습니다(이 서버 인스턴스 안에서만). */
export const VERSION_RETRY_PAUSE_MS = 5 * 60_000;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
/** 기억해 둔 결과(받는 중이면 그 Promise)와 다시 물을 수 있는 시각 */
export type VersionMemo = { until: number; value: Promise<string | null> | null };
const memo: VersionMemo = { until: 0, value: null };

/**
 * 원본 저장소 main의 package.json 버전을 읽습니다. 어떤 실패든(시간 초과, 네트워크, 200이 아닌 응답, 모양이 다른 내용) null을
 * 돌려주고 예외를 던지지 않습니다.
 * Next.js fetch 캐시(next.revalidate)는 쓰지 않습니다. 지난 값을 뒤에서 새로 받을 때 Next가 signal(시간 제한)을 빼고 보내서,
 * 원본이 응답하지 않으면 그 요청이 끝없이 남기 때문입니다. 대신 이 서버 인스턴스 안에서 결과를 기억합니다(성공 1시간, 실패 5분,
 * 받는 중에 온 요청은 같은 결과를 함께 기다림). 그래서 네트워크 요청은 언제나 timeoutMs 안에 끝납니다.
 */
export function fetchLatestVersion(
  opts: { fetch?: Fetcher; timeoutMs?: number; now?: () => number; state?: VersionMemo } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now;
  const state = opts.state ?? memo;
  if (state.value && now() < state.until) return state.value;
  const value = readLatestVersion(opts.fetch ?? ((url, init) => fetch(url, init)), opts.timeoutMs ?? VERSION_TIMEOUT_MS);
  state.value = value;
  state.until = Infinity; // 받는 동안(최대 timeoutMs)
  void value.then((v) => {
    if (state.value === value) state.until = now() + (v ? VERSION_TTL_MS : VERSION_RETRY_PAUSE_MS);
  });
  return value;
}

async function readLatestVersion(doFetch: Fetcher, timeoutMs: number): Promise<string | null> {
  try {
    const res = await doFetch(UPSTREAM_PACKAGE_JSON_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json, text/plain" },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const version = data && typeof data === "object" ? (data as { version?: unknown }).version : undefined;
    return parseVersion(version) ? (version as string).trim() : null;
  } catch {
    return null;
  }
}
