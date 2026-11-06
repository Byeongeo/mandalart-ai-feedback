// 로그인 세션 비밀값 고르기(순수 함수, 서버·단위 테스트 공용). DB에 저장·읽기는 session.ts에서 합니다.
import { randomBytes } from "node:crypto";

export const SESSION_SECRET_MIN = 32;
// app_settings에 자동으로 만든 비밀값을 저장하는 열쇠
export const SESSION_SECRET_KEY = "session_secret";

// 환경 변수 SESSION_SECRET이 32자 이상이면 그 값을, 아니면 null(→ DB에 저장한 자동 비밀값을 씀).
export function envSessionSecret(env: Record<string, string | undefined>): string | null {
  const v = env.SESSION_SECRET?.trim();
  return v && v.length >= SESSION_SECRET_MIN ? v : null;
}

// 환경 변수가 있는데 너무 짧으면 경고 문구(값은 넣지 않음), 없거나 충분하면 null
export function sessionSecretWarning(env: Record<string, string | undefined>): string | null {
  const v = env.SESSION_SECRET?.trim();
  if (!v || v.length >= SESSION_SECRET_MIN) return null;
  return `[설정 경고] SESSION_SECRET이 ${SESSION_SECRET_MIN}자보다 짧아 쓰지 않습니다. 앱이 자동으로 만든 비밀값을 대신 씁니다.`;
}

// 새 비밀값: 32바이트 무작위(16진수 64자)
export function newSessionSecret(): string {
  return randomBytes(32).toString("hex");
}

// DB에서 읽은 값이 쓸 만한지(다른 사람이 손으로 짧게 바꿔 놓은 경우 등)
export function usableStoredSecret(v: string | null | undefined): v is string {
  return typeof v === "string" && v.length >= SESSION_SECRET_MIN;
}
