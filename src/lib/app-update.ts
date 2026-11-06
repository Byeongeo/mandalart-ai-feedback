// 교사 화면의 '앱 업데이트' 카드에 쓰는 순수 함수와 상수. 서버(API)와 화면(AppUpdateCard) 모두 불러 쓰므로 다른 모듈을 불러오지 않습니다.
// 이 앱은 강사가 운영하는 설치 페이지(installer/)로 선생님 Cloudflare 계정에 설치됩니다. 설치 페이지 주소는 설치할 때
// INSTALLER_URL 변수로 들어가고, 새 버전은 `${INSTALLER_URL}/version.json`({ version })으로 확인합니다.
// 업데이트는 설치 페이지의 '업데이트' 탭(`${INSTALLER_URL}/#update`)에서 합니다(학생 글·교사 계정·설정 코드는 그대로 남음).

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

/** 설치 페이지 버전(latest)이 지금 버전(current)보다 새것일 때만 true(읽을 수 없으면 false). */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  return compareVersions(latest, current) === 1;
}

/** 버전 뒤에 붙일 조사(이/가): 마지막 숫자를 읽는 소리로 정합니다(1.2.0이, 1.2.2가). */
export function subjectParticle(version: string): "이" | "가" {
  return /[2459]$/.test(version.trim()) ? "가" : "이";
}

// ── 설치 페이지 주소 ─────────────────────────────────────────

/**
 * INSTALLER_URL에서 origin만 꺼냅니다. https만 받고(로컬 개발은 http://localhost·127.0.0.1도), 그 밖이면 null.
 * 이 값으로 서버가 fetch하고 화면이 링크를 만들므로 다른 모양(javascript:, 사용자 정보가 든 주소 등)은 받지 않습니다.
 */
export function installerOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  return u.origin;
}

export const versionJsonUrl = (origin: string) => `${origin}/version.json`;
/** 설치 페이지의 '업데이트' 화면 */
export const updatePageUrl = (origin: string) => `${origin}/#update`;

// ── 최신 버전 받기 ────────────────────────────────────────────

export const VERSION_TIMEOUT_MS = 2_500;
/** 받은 버전을 이 시간 동안 기억합니다(이 Worker 인스턴스 안에서만). */
export const VERSION_TTL_MS = 60 * 60_000;
/** 실패한 뒤 이 시간 동안은 다시 묻지 않습니다(이 Worker 인스턴스 안에서만). */
export const VERSION_RETRY_PAUSE_MS = 5 * 60_000;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
/** 기억해 둔 결과: 어느 주소의 값인지, 언제까지 쓰는지 */
export type VersionMemo = { url: string; until: number; value: string | null };
const memo: VersionMemo = { url: "", until: 0, value: null };

/**
 * 설치 페이지의 앱 버전(`/version.json`). 어떤 실패든(시간 초과 2.5초, 네트워크, 200이 아닌 응답, 모양이 다른 내용) null을 돌려주고
 * 예외를 던지지 않습니다. 결과는 이 Worker 인스턴스 안에서 기억합니다(성공 1시간, 실패 5분).
 * 받는 중인 Promise는 다른 요청과 나누지 않습니다. Workers에서는 다른 요청이 시작한 fetch를 기다리다가 그 요청이 끝나면
 * 멈출 수 있기 때문입니다(요청 사이 I/O 공유 금지). 그래서 동시에 들어온 요청은 각자 묻고, 끝난 값만 함께 씁니다.
 */
export async function fetchLatestVersion(
  origin: string,
  opts: { fetch?: Fetcher; timeoutMs?: number; now?: () => number; state?: VersionMemo } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now;
  const state = opts.state ?? memo;
  const url = versionJsonUrl(origin);
  if (state.url === url && now() < state.until) return state.value;
  const value = await readLatestVersion(url, opts.fetch ?? ((u, init) => fetch(u, init)), opts.timeoutMs ?? VERSION_TIMEOUT_MS);
  state.url = url;
  state.value = value;
  state.until = now() + (value ? VERSION_TTL_MS : VERSION_RETRY_PAUSE_MS);
  return value;
}

async function readLatestVersion(url: string, doFetch: Fetcher, timeoutMs: number): Promise<string | null> {
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
      // Workers의 fetch는 redirect "error"를 받지 않을 수 있어 "manual"(3xx는 res.ok가 아니므로 실패로 봄)
      redirect: "manual",
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const version = data && typeof data === "object" ? (data as { version?: unknown }).version : undefined;
    return parseVersion(version) ? (version as string).trim() : null;
  } catch {
    return null;
  }
}

export type AppUpdateInfo = {
  /** 지금 버전(APP_VERSION). 모르면 null */
  current: string | null;
  /** 설치 페이지에 있는 더 새 버전. 없거나(같은 버전) 확인하지 못하면 null */
  latest: string | null;
  /** 업데이트하러 갈 설치 페이지 주소(latest가 있을 때만) */
  updateUrl: string | null;
};

/** GET /api/teacher/app-update의 내용: 환경 변수(APP_VERSION, INSTALLER_URL)와 설치 페이지의 버전으로 만듭니다. */
export async function appUpdateInfo(
  env: { APP_VERSION?: unknown; INSTALLER_URL?: unknown },
  getLatest: (origin: string) => Promise<string | null> = (o) => fetchLatestVersion(o),
): Promise<AppUpdateInfo> {
  const current = parseVersion(env.APP_VERSION) ? (env.APP_VERSION as string).trim() : null;
  const origin = installerOrigin(env.INSTALLER_URL);
  const newest = origin ? await getLatest(origin).catch(() => null) : null;
  const latest = newest && isNewerVersion(newest, current) ? newest : null;
  return { current, latest, updateUrl: latest && origin ? updatePageUrl(origin) : null };
}
