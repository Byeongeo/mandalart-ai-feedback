import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

// 교사 비밀번호 해시: PBKDF2-SHA256(WebCrypto, crypto.subtle). 저장 모양: pbkdf2$<반복 횟수>$<솔트 base64>$<해시 base64>
//
// 반복 횟수(PBKDF2_ITERATIONS = 20,000)를 정한 까닭:
// Cloudflare Workers 무료 플랜은 요청 하나에 CPU 10ms까지만 씁니다(넘으면 요청이 실패). 로그인 요청에는 해시 확인 말고도
// 토큰 서명·입력 검사 등이 들어가므로 해시 확인 한 번을 5ms 안쪽으로 잡았습니다.
// wrangler dev(workerd, Intel Xeon 2.1GHz)에서 잰 값: 10,000회 ≈ 1.8ms, 20,000회 ≈ 3.1ms, 50,000회 ≈ 7.5ms, 100,000회 ≈ 15ms.
// 그래서 20,000회(≈3ms)를 씁니다. 온라인으로 맞히기는 교사 로그인 늦추기(loginDelayMs, 아이디마다 10분에 100번 상한)가 막고,
// 이 해시는 DB가 통째로 새어 나간 경우를 늦추는 역할입니다. 저장한 해시에 반복 횟수가 들어 있으므로 나중에 값을 바꿔도
// 옛 해시는 그대로 확인됩니다.
export const PBKDF2_ITERATIONS = 20_000;
// 이상한 저장값으로 CPU를 오래 쓰지 않게 받는 범위(새로 만드는 해시는 위 값)
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const enc = new TextEncoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function pbkdf2(pw: string, salt: Uint8Array<ArrayBuffer>, iterations: number, bits: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const out = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, bits);
  return new Uint8Array(out);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(pw, salt, PBKDF2_ITERATIONS, HASH_BITS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

/** 저장 모양이 맞으면 [반복 횟수, 솔트, 해시], 아니면 null */
function parseHash(stored: string): [number, Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>] | null {
  const [algo, iterStr, saltB64, hashB64, ...rest] = stored.split("$");
  if (algo !== "pbkdf2" || rest.length || !/^\d+$/.test(iterStr ?? "")) return null;
  const iterations = Number(iterStr);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  const salt = fromB64(saltB64 ?? "");
  const hash = fromB64(hashB64 ?? "");
  if (!salt || !hash || salt.length < 8 || hash.length < 16 || hash.length > 64) return null;
  return [iterations, salt, hash];
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const [iterations, salt, expected] = parsed;
  const actual = await pbkdf2(pw, salt, iterations, expected.length * 8);
  return timingSafeEqual(actual, expected);
}

// 없는 아이디도 같은 시간이 걸리도록, 저장된 해시가 없으면 임시 해시로 똑같이(같은 반복 횟수로 한 번) 계산한 뒤 false를 돌려줍니다.
// 임시 해시는 고정값(무작위로 만든 솔트·해시, 맞는 비밀번호 없음)이라 처음 한 번 더 계산하는 일도 없습니다.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$3q0Y8cWm1t4oZ2bL9xKc7w==$Vh2yq3Xr1m0p8ZkL4dT6sJ9wQe5nB7cF2gH1aK3uM8o=`;
export async function verifyPasswordOrDummy(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (stored) return verifyPassword(pw, stored);
  await verifyPassword(pw, DUMMY_HASH);
  return false;
}

// 교사 로그인 시도 기록의 열쇠: 아이디(앞뒤 공백 제거·소문자)의 해시. 아이디 칸에 비밀번호를 잘못 넣어도
// 원문이 DB에 남지 않습니다. secret(세션 비밀값)이 있으면 HMAC-SHA256, 없으면 SHA-256.
export function loginIdKey(loginId: string, secret?: string): string {
  const id = loginId.trim().toLowerCase();
  return secret ? createHmac("sha256", secret).update(id).digest("hex") : createHash("sha256").update(id).digest("hex");
}

// 교사 로그인 늦추기: 같은 아이디로 최근 10분 안에 n번째 시도(실패와 진행 중인 시도)이면 확인 전에 기다릴 시간(밀리초).
// 10번까지는 바로, 그다음부터 2초씩 늘어 최대 15초. 맞는 비밀번호를 막지는 않습니다.
// (기다리는 동안은 CPU를 쓰지 않으므로 Workers의 CPU 한도와 상관없습니다.)
export const LOGIN_FREE_ATTEMPTS = 10;
export const LOGIN_MAX_DELAY_MS = 15_000;
export function loginDelayMs(n: number): number {
  if (!Number.isFinite(n) || n <= LOGIN_FREE_ATTEMPTS) return 0;
  return Math.min(2000 * (n - LOGIN_FREE_ATTEMPTS), LOGIN_MAX_DELAY_MS);
}

// 헷갈리는 글자(0/O, 1/I/L)를 뺀 코드 문자
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function randomCode(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
