// 설치·업데이트 순서. 단계마다 진행 상황(event)을 내보내고, Cloudflare API 호출은 cf-api.ts의 CfClient로만 합니다.
//
// 설치(mode "install")
//   1) check     : 계정에 'mandalart' Worker가 이미 있는지(GET /workers/scripts)
//                  있으면 그 앱의 D1에 교사 계정이 하나라도 있는지 보고, 있으면 멈추고 '업데이트'로 안내합니다.
//                  교사 계정이 없으면(지난번 설치가 중간에 끊김) 새 비밀값으로 이어서 설치합니다.
//   2) subdomain : 계정의 workers.dev 하위 도메인(GET /workers/subdomain, 없으면 PUT으로 mandalart-xxxxxx 만들기, 겹치면 다른 이름)
//   3) database  : D1 'mandalart-db'(primary_location_hint apac). 이미 있으면 교사 계정이 없을 때만 다시 씁니다(지난번 시도의 빈 DB).
//                  교사 계정이 있는 DB는 학생 기록을 지키려고 건드리지 않고 멈춥니다.
//   4) upload    : Worker 올리기(PUT /workers/scripts/mandalart, multipart: metadata + 모듈). 바인딩 DB, APP_SECRET, SETUP_TOKEN,
//                  INSTALLER_URL, APP_VERSION.
//   5) route     : workers.dev 주소 켜기(POST /workers/scripts/mandalart/subdomain {enabled:true, previews_enabled:false})
//   6) wait      : https://mandalart.<sub>.workers.dev/api/auth/setup 이 대답할 때까지 최대 약 60초 기다림(새 주소는 몇 분 걸릴 수 있음)
// 업데이트(mode "update")
//   check → database(앱에 연결된 D1 찾기) → upload(같은 D1, 새 APP_VERSION·INSTALLER_URL, keep_bindings ["secret_text"]로
//   APP_SECRET·SETUP_TOKEN 유지) → (선택) secret: 새 설정 코드(PUT /workers/scripts/mandalart/secrets) → route → wait
import { CfError, InstallStop, isAuthError, type CfClient } from "./cf-api.ts";
import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, DB_BINDING, DB_LOCATION_HINT, DB_NAME, SCRIPT_NAME, SUBDOMAIN_PREFIX } from "./app-manifest.ts";

export type StepKey = "check" | "subdomain" | "database" | "upload" | "secret" | "route" | "wait";
export type InstallEvent =
  | { type: "step"; step: StepKey; message: string }
  /** retry: 같은 버튼을 다시 누르면 이어서 할 수 있음, goto: 다른 탭(처음 설치/업데이트)으로 안내 */
  | { type: "error"; message: string; retry: boolean; goto?: "install" | "update" }
  | { type: "done"; url: string; setupUrl?: string; ready: boolean; version: string };

export type AppBundle = {
  version: string;
  mainModule: string;
  modules: { name: string; type: string; b64: boolean; content: string }[];
};

export type ProbeResult = { ok: boolean; tokenConfigured?: boolean };

export type InstallOptions = {
  cf: CfClient;
  accountId: string;
  mode: "install" | "update";
  /** 업데이트 때 설정 코드를 새로 만들지 */
  newSetupCode?: boolean;
  installerUrl: string;
  bundle: AppBundle;
  emit: (e: InstallEvent) => void;
  /** 앱 주소의 /api/auth/setup을 한 번 물어봄 */
  probe: (appUrl: string) => Promise<ProbeResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 기다리는 최대 시간(ms) */
  waitMs?: number;
  random?: (bytes: Uint8Array) => Uint8Array;
};

// ── 비밀값 ─────────────────────────────────────────────────────

/** 설정 코드에 쓰는 글자(헷갈리는 0 O 1 I L 뺌) */
export const SETUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SETUP_TOKEN_LENGTH = 24;

const rand = (b: Uint8Array) => crypto.getRandomValues(b);

/** 고르게 뽑은 설정 코드(24자, 약 119비트) */
export function makeSetupToken(random: (b: Uint8Array) => Uint8Array = rand): string {
  const n = SETUP_ALPHABET.length; // 31
  const limit = 256 - (256 % n); // 248: 이 값 이상은 버려서 치우침 없앰
  let out = "";
  while (out.length < SETUP_TOKEN_LENGTH) {
    for (const b of random(new Uint8Array(32))) {
      if (b < limit && out.length < SETUP_TOKEN_LENGTH) out += SETUP_ALPHABET[b % n];
    }
  }
  return out;
}

/** 세션 서명·키 암호화용 비밀값(32바이트, base64url 43자) */
export function makeAppSecret(random: (b: Uint8Array) => Uint8Array = rand): string {
  const bytes = random(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** workers.dev 하위 도메인 후보: mandalart-xxxxxx(소문자·숫자 6자) */
export function makeSubdomain(random: (b: Uint8Array) => Uint8Array = rand): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36
  let s = "";
  while (s.length < 6) for (const b of random(new Uint8Array(12))) if (b < 252 && s.length < 6) s += a[b % 36];
  return SUBDOMAIN_PREFIX + s;
}

// ── Cloudflare 호출 ────────────────────────────────────────────

type ScriptListItem = { id?: unknown };
type D1Info = { uuid?: unknown; name?: unknown };
type Binding = { type?: unknown; name?: unknown; id?: unknown; database_id?: unknown };

const acct = (id: string) => `/accounts/${id}`;

async function scriptExists(cf: CfClient, accountId: string): Promise<boolean> {
  const list = await cf.call<ScriptListItem[]>("GET", `${acct(accountId)}/workers/scripts`, { action: "설치된 앱 확인" });
  return Array.isArray(list) && list.some((s) => s?.id === SCRIPT_NAME);
}

/** 계정의 workers.dev 하위 도메인. 없으면 만들고(이름이 겹치면 다른 이름으로 최대 4번), created=true. */
export async function ensureSubdomain(cf: CfClient, accountId: string, random?: (b: Uint8Array) => Uint8Array): Promise<{ subdomain: string; created: boolean }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await cf.call<{ subdomain?: unknown } | null>("GET", `${acct(accountId)}/workers/subdomain`, { action: "workers.dev 주소 확인" });
      if (typeof r?.subdomain === "string" && r.subdomain) return { subdomain: r.subdomain, created: false };
    } catch (e) {
      // 10007: 아직 하위 도메인이 없음(새 계정). 그 밖의 오류는 그대로 알림.
      if (!(e instanceof CfError) || !(e.has(10007) || e.status === 404)) throw e;
    }
    const name = makeSubdomain(random);
    try {
      const r = await cf.call<{ subdomain?: unknown } | null>("PUT", `${acct(accountId)}/workers/subdomain`, {
        action: "workers.dev 주소 만들기",
        json: { subdomain: name },
      });
      return { subdomain: typeof r?.subdomain === "string" && r.subdomain ? r.subdomain : name, created: true };
    } catch (e) {
      // 권한·인증 문제는 다시 해도 같으므로 바로 알림. 이름이 겹치면(10031 등) 다른 이름으로 다시.
      if (isAuthError(e) || !(e instanceof CfError) || e.status >= 500) throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new InstallStop("workers.dev 주소를 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.");
}

/** 앱 Worker에 연결된 D1 ID(설정의 바인딩에서). 못 찾으면 null. */
async function boundDatabaseId(cf: CfClient, accountId: string): Promise<string | null> {
  try {
    const s = await cf.call<{ bindings?: Binding[] } | null>("GET", `${acct(accountId)}/workers/scripts/${SCRIPT_NAME}/settings`, { action: "앱 설정 읽기" });
    const b = (s?.bindings ?? []).find((x) => x?.type === "d1" && x?.name === DB_BINDING);
    const id = b?.id ?? b?.database_id;
    return typeof id === "string" && id ? id : null;
  } catch (e) {
    if (isAuthError(e)) throw e;
    return null;
  }
}

async function databaseByName(cf: CfClient, accountId: string): Promise<string | null> {
  const q = new URLSearchParams({ name: DB_NAME, per_page: "100" });
  const list = await cf.call<D1Info[]>("GET", `${acct(accountId)}/d1/database?${q}`, { action: "데이터베이스 찾기" });
  const hit = Array.isArray(list) ? list.find((d) => d?.name === DB_NAME && typeof d?.uuid === "string") : undefined;
  return hit ? (hit.uuid as string) : null;
}

async function d1Count(cf: CfClient, accountId: string, dbId: string, sql: string): Promise<number | null> {
  const r = await cf.call<{ results?: { n?: unknown }[]; success?: unknown }[]>("POST", `${acct(accountId)}/d1/database/${dbId}/query`, {
    action: "데이터베이스 확인",
    json: { sql },
  });
  const n = Array.isArray(r) ? r[0]?.results?.[0]?.n : undefined;
  return typeof n === "number" ? n : null;
}

/**
 * 교사 계정이 하나도 없는 DB인지(= 지난번 설치가 끝나기 전에 끊겼거나 아직 아무도 쓰지 않음).
 * 확인하지 못하면 false(쓰는 중으로 보고 건드리지 않음).
 */
export async function databaseUnused(cf: CfClient, accountId: string, dbId: string): Promise<boolean> {
  try {
    const hasTable = await d1Count(cf, accountId, dbId, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'teachers'");
    if (hasTable === 0) return true;
    if (hasTable === null) return false;
    return (await d1Count(cf, accountId, dbId, "SELECT count(*) AS n FROM teachers")) === 0;
  } catch (e) {
    if (isAuthError(e)) throw e;
    return false;
  }
}

async function createDatabase(cf: CfClient, accountId: string): Promise<string> {
  const r = await cf.call<D1Info | null>("POST", `${acct(accountId)}/d1/database`, {
    action: "데이터베이스 만들기",
    json: { name: DB_NAME, primary_location_hint: DB_LOCATION_HINT },
  });
  if (typeof r?.uuid !== "string" || !r.uuid) throw new InstallStop("데이터베이스를 만들었지만 Cloudflare가 ID를 알려 주지 않았어요. 잠시 뒤 다시 눌러 주세요.");
  return r.uuid;
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type UploadSpec = {
  dbId: string;
  installerUrl: string;
  bundle: AppBundle;
  /** 새로 넣을 비밀값(설치). 없으면 keep_bindings로 이전 비밀값을 그대로 둠(업데이트). */
  secrets?: { APP_SECRET: string; SETUP_TOKEN: string };
};

/** PUT /workers/scripts/{name}에 보낼 metadata(Cloudflare multipart 업로드 형식) */
export function uploadMetadata(spec: UploadSpec): Record<string, unknown> {
  const bindings: Record<string, unknown>[] = [
    { type: "d1", name: DB_BINDING, id: spec.dbId },
    { type: "plain_text", name: "APP_VERSION", text: spec.bundle.version },
    { type: "plain_text", name: "INSTALLER_URL", text: spec.installerUrl },
  ];
  if (spec.secrets) {
    bindings.push({ type: "secret_text", name: "APP_SECRET", text: spec.secrets.APP_SECRET });
    bindings.push({ type: "secret_text", name: "SETUP_TOKEN", text: spec.secrets.SETUP_TOKEN });
  }
  return {
    main_module: spec.bundle.mainModule,
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: COMPATIBILITY_FLAGS,
    bindings,
    ...(spec.secrets ? {} : { keep_bindings: ["secret_text"] }),
  };
}

export function uploadForm(spec: UploadSpec): FormData {
  const form = new FormData();
  form.append("metadata", JSON.stringify(uploadMetadata(spec)));
  for (const m of spec.bundle.modules) {
    const blob = new Blob([m.b64 ? decodeB64(m.content) : m.content], { type: m.type });
    form.append(m.name, blob, m.name);
  }
  return form;
}

async function uploadScript(cf: CfClient, accountId: string, spec: UploadSpec): Promise<void> {
  await cf.call("PUT", `${acct(accountId)}/workers/scripts/${SCRIPT_NAME}?excludeScript=true`, {
    action: "앱 올리기",
    form: uploadForm(spec),
    timeoutMs: 120_000,
  });
}

async function enableWorkersDev(cf: CfClient, accountId: string): Promise<void> {
  await cf.call("POST", `${acct(accountId)}/workers/scripts/${SCRIPT_NAME}/subdomain`, {
    action: "앱 주소 켜기",
    json: { enabled: true, previews_enabled: false },
    // wrangler와 같은 API 날짜(previews_enabled를 따로 다룸)
    headers: { "Cloudflare-Workers-Script-Api-Date": "2025-08-01" },
  });
}

async function putSecret(cf: CfClient, accountId: string, name: string, text: string): Promise<void> {
  await cf.call("PUT", `${acct(accountId)}/workers/scripts/${SCRIPT_NAME}/secrets`, {
    action: "설정 코드 바꾸기",
    json: { name, text, type: "secret_text" },
  });
}

// ── 순서 ───────────────────────────────────────────────────────

export function appUrlFor(subdomain: string): string {
  return `https://${SCRIPT_NAME}.${subdomain}.workers.dev`;
}

export function setupUrlFor(appUrl: string, setupToken: string): string {
  return `${appUrl}/teacher/setup#code=${setupToken}`;
}

export async function runInstall(o: InstallOptions): Promise<void> {
  const { cf, accountId, emit } = o;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const step = (s: StepKey, message: string) => emit({ type: "step", step: s, message });

  // 1) 이미 설치되어 있는지
  step("check", "이 계정에 이미 설치된 앱이 있는지 보고 있어요.");
  const exists = await scriptExists(cf, accountId);
  let dbId: string | null = null;
  let resumed = false;

  if (o.mode === "install" && exists) {
    dbId = (await boundDatabaseId(cf, accountId)) ?? (await databaseByName(cf, accountId));
    if (dbId && !(await databaseUnused(cf, accountId, dbId))) {
      throw new InstallStop(
        "이 계정에는 이미 앱이 설치되어 있고 교사 계정도 있어요. 새로 설치하지 않고 멈췄어요(학생 기록을 지키려고요). " +
          "새 버전을 받으려면 위쪽의 '업데이트' 탭에서 '업데이트 시작'을 누르세요.",
        "update",
      );
    }
    resumed = true;
    step("check", "지난번 설치가 끝나지 않은 앱이 있어요. 이어서 설치할게요.");
  }
  if (o.mode === "update" && !exists) {
    throw new InstallStop("이 계정에는 아직 설치된 앱이 없어요. 위쪽의 '처음 설치' 탭에서 설치해 주세요. (다른 계정에 설치했다면 그 계정을 고르세요.)", "install");
  }

  // 2) workers.dev 하위 도메인
  let subdomain: string;
  if (o.mode === "install") {
    step("subdomain", "앱 주소(workers.dev)를 준비하고 있어요.");
    const sd = await ensureSubdomain(cf, accountId, o.random);
    subdomain = sd.subdomain;
    step("subdomain", sd.created ? `새 주소 이름 '${subdomain}.workers.dev'를 만들었어요.` : `계정의 주소 이름 '${subdomain}.workers.dev'를 써요.`);
  } else {
    subdomain = (await ensureSubdomain(cf, accountId, o.random)).subdomain;
  }
  const appUrl = appUrlFor(subdomain);

  // 3) 데이터베이스
  step("database", o.mode === "install" ? "데이터베이스를 준비하고 있어요." : "앱의 데이터베이스를 찾고 있어요.");
  if (o.mode === "update") {
    dbId = (await boundDatabaseId(cf, accountId)) ?? (await databaseByName(cf, accountId));
    if (!dbId) {
      throw new InstallStop(`앱의 데이터베이스('${DB_NAME}')를 찾지 못해 업데이트를 멈췄어요. 강사에게 알려 주세요.`);
    }
    step("database", "데이터베이스를 찾았어요. 학생 글은 그대로 남아요.");
  } else if (!dbId) {
    const existing = await databaseByName(cf, accountId);
    if (existing) {
      if (!(await databaseUnused(cf, accountId, existing))) {
        throw new InstallStop(
          `이 계정에 예전에 쓰던 데이터베이스 '${DB_NAME}'(교사·학생 기록이 들어 있음)가 남아 있어서 설치를 멈췄어요. ` +
            "기록을 지우지 않으려고 멈춘 것이니 강사에게 알려 주세요.",
        );
      }
      dbId = existing;
      step("database", "지난번에 만들어 둔 빈 데이터베이스를 다시 써요.");
    } else {
      dbId = await createDatabase(cf, accountId);
      step("database", "데이터베이스를 만들었어요.");
    }
  } else {
    step("database", resumed ? "지난번에 만들어 둔 빈 데이터베이스를 다시 써요." : "데이터베이스를 찾았어요.");
  }

  // 4) 앱 올리기
  step("upload", o.mode === "install" ? "앱을 올리고 있어요. 1분쯤 걸릴 수 있어요." : "새 버전을 올리고 있어요. 1분쯤 걸릴 수 있어요.");
  let setupToken: string | undefined;
  if (o.mode === "install") {
    setupToken = makeSetupToken(o.random);
    await uploadScript(cf, accountId, {
      dbId,
      installerUrl: o.installerUrl,
      bundle: o.bundle,
      secrets: { APP_SECRET: makeAppSecret(o.random), SETUP_TOKEN: setupToken },
    });
  } else {
    await uploadScript(cf, accountId, { dbId, installerUrl: o.installerUrl, bundle: o.bundle });
  }
  step("upload", `앱 ${o.bundle.version} 버전을 올렸어요.`);

  if (o.mode === "update" && o.newSetupCode) {
    step("secret", "새 설정 코드를 넣고 있어요.");
    setupToken = makeSetupToken(o.random);
    await putSecret(cf, accountId, "SETUP_TOKEN", setupToken);
    step("secret", "새 설정 코드를 넣었어요. 예전 설정 코드는 이제 쓸 수 없어요.");
  }

  // 5) 주소 켜기
  step("route", "앱 주소를 켜고 있어요.");
  await enableWorkersDev(cf, accountId);
  step("route", `앱 주소: ${appUrl}`);

  // 6) 대답할 때까지 기다리기
  const limit = o.waitMs ?? (o.mode === "install" ? 60_000 : 30_000);
  const start = now();
  let ready = false;
  step("wait", "앱이 대답하는지 확인하고 있어요.");
  for (;;) {
    const r = await o.probe(appUrl).catch((): ProbeResult => ({ ok: false }));
    if (r.ok) {
      ready = true;
      step("wait", "앱이 대답해요.");
      break;
    }
    const elapsed = now() - start;
    if (elapsed >= limit) {
      step("wait", "새 주소가 인터넷에 퍼지는 데 몇 분(길면 10분쯤) 걸릴 수 있어요. 설치는 끝났으니 조금 뒤에 열어 보세요.");
      break;
    }
    step("wait", `앱이 대답하기를 기다리고 있어요(${Math.round(elapsed / 1000)}초). 새 주소는 처음에 조금 걸려요.`);
    await sleep(4_000);
  }

  emit({
    type: "done",
    url: appUrl,
    ready,
    version: o.bundle.version,
    ...(setupToken ? { setupUrl: setupUrlFor(appUrl, setupToken) } : {}),
  });
}
