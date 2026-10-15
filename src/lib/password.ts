import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, randomInt } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// 없는 아이디도 같은 시간이 걸리도록, 저장된 해시가 없으면 임시 해시로 똑같이 계산한 뒤 false를 돌려줍니다.
let dummyHash: Promise<string> | null = null;
export async function verifyPasswordOrDummy(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (stored) return verifyPassword(pw, stored);
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(pw, await dummyHash);
  return false;
}

// 교사 로그인 시도 기록의 열쇠: 아이디(앞뒤 공백 제거·소문자)의 해시. 아이디 칸에 비밀번호를 잘못 넣어도
// 원문이 DB에 남지 않습니다. secret(SESSION_SECRET)이 있으면 HMAC-SHA256, 없으면 SHA-256.
export function loginIdKey(loginId: string, secret?: string): string {
  const id = loginId.trim().toLowerCase();
  return secret ? createHmac("sha256", secret).update(id).digest("hex") : createHash("sha256").update(id).digest("hex");
}

// 교사 로그인 늦추기: 같은 아이디로 최근 10분 안에 n번째 시도(실패와 진행 중인 시도)이면 확인 전에 기다릴 시간(밀리초).
// 10번까지는 바로, 그다음부터 2초씩 늘어 최대 15초. 맞는 비밀번호를 막지는 않습니다.
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
