import "server-only";
import { NOW, sql } from "./db";
import { maybeRc } from "./request-context";
import { sessionSecret } from "./session";
import { envApiKey } from "./feedback/client";

// 교사 화면에서 넣는 OpenRouter 키(연수 운영자가 교사마다 나눠 줌). app_settings에 암호화해서 저장합니다.
// - 암호화: AES-256-GCM. 열쇠는 세션 비밀값(session.ts의 sessionSecret: APP_SECRET 또는 DB 자동값)에서 HKDF-SHA256으로 만듭니다.
//   그래서 DB 내용만으로는 키를 읽을 수 없습니다. 비밀값이 바뀌면(앱을 새로 설치 등) 저장한 키를 풀 수 없으므로 '키 없음'으로 보고
//   교사가 다시 넣으면 됩니다.
// - 저장 모양: v1.<IV base64>.<암호문+태그 base64>. 추가 인증 데이터(AAD)로 용도를 묶어 다른 값으로 바꿔치기할 수 없게 합니다.
// - 키 값은 화면·로그·오류 메시지·event_log 어디에도 내보내지 않습니다(교사 화면에는 끝 4자리만).
// - 환경 변수 OPENROUTER_API_KEY가 있으면 그쪽을 먼저 씁니다(feedback/client.ts의 aiConfig).

export const AI_KEY_SETTING = "openrouter_api_key";
const FORMAT = "v1";
const AAD = new TextEncoder().encode("mandalart:app_settings:openrouter_api_key:v1");
const HKDF_SALT = new TextEncoder().encode("mandalart-ai-key-salt-v1");
const HKDF_INFO = new TextEncoder().encode("mandalart ai-key aes-gcm v1");

/** OpenRouter 키 모양(sk-or-로 시작, 글자·숫자·-·_만, 길이 적당). 공백은 앞뒤만 지웁니다. */
export function normalizeAiKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return /^sk-or-[A-Za-z0-9_-]{16,200}$/.test(v) ? v : null;
}

export function last4(key: string): string {
  return key.slice(-4);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptAiKey(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await aesKey(secret), new TextEncoder().encode(plain));
  return `${FORMAT}.${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

/** 풀 수 없으면(모양이 다름, 비밀값이 바뀜, 값이 바뀜) null */
export async function decryptAiKey(stored: string, secret: string): Promise<string | null> {
  try {
    const [fmt, ivB64, ctB64, ...rest] = stored.split(".");
    if (fmt !== FORMAT || !ivB64 || !ctB64 || rest.length) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64), additionalData: AAD }, await aesKey(secret), fromB64(ctB64));
    return normalizeAiKey(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

/** DB에 저장한 키를 읽어 풉니다(없거나 풀 수 없으면 null). */
async function readStoredKey(): Promise<string | null> {
  const [row] = await sql<{ value: string }[]>`select value from app_settings where key = ${AI_KEY_SETTING}`;
  if (!row) return null;
  const key = await decryptAiKey(row.value, await sessionSecret());
  if (!key) console.warn("[AI 키] 저장된 AI 키를 풀 수 없습니다(앱 비밀값이 바뀌었을 수 있음). 교사 화면에서 키를 다시 넣어야 합니다.");
  return key;
}

/**
 * 이 요청에서 쓸 AI 키를 준비합니다(요청마다 DB를 한 번만 읽어 rc().aiKey에 둠). aiConfig·aiStatus·assertAiReady·checkAi보다 먼저 부르세요.
 * 환경 변수 OPENROUTER_API_KEY가 있거나 요청 문맥이 없으면(단위 테스트) 아무것도 하지 않습니다.
 */
export async function ensureAiKey(): Promise<void> {
  const c = maybeRc();
  if (!c || c.aiKey !== undefined || envApiKey()) return;
  c.aiKey = await readStoredKey();
}

export type AiKeyStatus = { configured: boolean; last4: string | null; fromEnv: boolean };

/** 교사 화면용 키 상태(키 값은 끝 4자리만). 환경 변수 키가 있으면 그것이 쓰입니다. */
export async function aiKeyStatus(): Promise<AiKeyStatus> {
  const fromEnv = envApiKey();
  if (fromEnv) return { configured: true, last4: last4(fromEnv), fromEnv: true };
  await ensureAiKey();
  const key = maybeRc()?.aiKey ?? null;
  return { configured: !!key, last4: key ? last4(key) : null, fromEnv: false };
}

/** 키를 암호화해 저장합니다(있으면 바꿈). key는 normalizeAiKey를 거친 값이어야 합니다. */
export async function saveAiKey(key: string): Promise<void> {
  const value = await encryptAiKey(key, await sessionSecret());
  await sql`insert into app_settings (key, value) values (${AI_KEY_SETTING}, ${value})
            on conflict (key) do update set value = excluded.value, updated_at = ${NOW}`;
  const c = maybeRc();
  if (c) c.aiKey = key;
}

export async function deleteAiKey(): Promise<void> {
  await sql`delete from app_settings where key = ${AI_KEY_SETTING}`;
  const c = maybeRc();
  if (c) c.aiKey = null;
}
