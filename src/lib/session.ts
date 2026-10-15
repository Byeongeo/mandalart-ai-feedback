import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { createHmac } from "node:crypto";
import { sql } from "./db";
import { pinFingerprint } from "./pin";
import { SESSION_SECRET_KEY, envSessionSecret, newSessionSecret, sessionSecretWarning, usableStoredSecret } from "./secret";

// pf: 로그인할 때의 지문. 학생은 PIN·이름의 지문(PIN 자체는 넣지 않음), 교사는 비밀번호 해시의 지문.
// currentStudent·currentTeacher가 지금 DB 값의 지문과 비교합니다.
export type Session = { role: "student" | "teacher"; id: string; pf?: string };

const COOKIE = "mdl_session";
// 교사: 8시간(수업일 하루) 유지되는 쿠키.
// 학생: 공용 기기에서 다음 학생에게 넘어가지 않도록 브라우저를 닫으면 사라지는 쿠키 + 토큰 3시간.
const TEACHER_MAX_AGE = 60 * 60 * 8;
const STUDENT_TTL = 60 * 60 * 3;

// 로그인 비밀값: 환경 변수 SESSION_SECRET(32자 이상)이 있으면 그 값, 없으면 DB(app_settings)에 한 번 만들어 둔 값.
// 여러 인스턴스가 동시에 만들려 해도 'on conflict do nothing' 뒤 다시 읽으므로 모두 같은 값을 씁니다. 메모리에 기억합니다.
const g = globalThis as unknown as { __mandalartSecret?: Promise<string> | null };
let warned = false;

async function loadSecret(): Promise<string> {
  const fromEnv = envSessionSecret(process.env);
  if (fromEnv) return fromEnv;
  const warning = sessionSecretWarning(process.env);
  if (warning && !warned) {
    warned = true;
    console.warn(warning);
  }
  await sql`insert into app_settings (key, value) values (${SESSION_SECRET_KEY}, ${newSessionSecret()})
            on conflict (key) do nothing`;
  const [row] = await sql<{ value: string }[]>`select value from app_settings where key = ${SESSION_SECRET_KEY}`;
  if (usableStoredSecret(row?.value)) return row.value;
  // 누군가 DB 값을 짧게 바꿔 놓았다면 새로 만들어 덮어씁니다(모두 다시 로그인).
  const fresh = newSessionSecret();
  await sql`update app_settings set value = ${fresh}, updated_at = now() where key = ${SESSION_SECRET_KEY}`;
  return fresh;
}

/** 세션 서명에 쓰는 비밀값(문자열). 교사 로그인 시도 기록의 열쇠(loginIdKey)에도 씁니다. */
export function sessionSecret(): Promise<string> {
  g.__mandalartSecret ??= loadSecret().catch((e) => {
    g.__mandalartSecret = null; // 실패하면 다음 요청에서 다시 시도
    throw e;
  });
  return g.__mandalartSecret;
}

async function key(): Promise<Uint8Array> {
  return new TextEncoder().encode(await sessionSecret());
}

// 학생의 지금 PIN과 이름의 지문(src/lib/pin.ts pinFingerprint). PIN을 다시 만들거나 이름이 바뀌면 값이 달라집니다.
export async function studentPinTag(pin: string | null | undefined, name: string): Promise<string> {
  return pinFingerprint(await key(), pin, name);
}

// 교사 비밀번호 지문: 비밀번호를 다시 정하면(password_hash가 바뀌면) 그 전에 로그인한 교사 세션이 끝납니다.
export async function teacherPasswordTag(passwordHash: string): Promise<string> {
  return createHmac("sha256", await key()).update(`teacher-pw:${passwordHash}`).digest("hex").slice(0, 16);
}

export async function createSession(s: Session) {
  const ttl = s.role === "student" ? STUDENT_TTL : TEACHER_MAX_AGE;
  const claims: Record<string, string> = { role: s.role };
  if (s.pf) claims.pf = s.pf;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.id)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(await key());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // 학생은 maxAge를 두지 않아 브라우저 세션 쿠키가 됩니다.
    ...(s.role === "teacher" ? { maxAge: TEACHER_MAX_AGE } : {}),
  });
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const k = await key(); // DB 오류는 '로그아웃된 것처럼' 숨기지 않고 그대로 드러냅니다.
  try {
    const { payload } = await jwtVerify(token, k, { algorithms: ["HS256"] });
    const role = payload.role;
    if ((role !== "student" && role !== "teacher") || !payload.sub) return null;
    const pf = typeof payload.pf === "string" ? payload.pf : undefined;
    return { role, id: payload.sub, ...(pf ? { pf } : {}) };
  } catch {
    return null;
  }
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}
