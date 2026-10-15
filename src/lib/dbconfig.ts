// DB 연결 설정 중 순수 함수(서버·단위 테스트 공용). 실제 연결은 db.ts에서 합니다.

export const DB_URL_MISSING =
  "[설정 오류] 데이터베이스 주소(DATABASE_URL)가 없습니다. Vercel 프로젝트 > Storage 에서 Neon 데이터베이스를 연결한 뒤 " +
  "Deployments 에서 다시 배포(Redeploy)하세요.";

// Vercel의 Neon 연동은 DATABASE_URL(연결 풀 주소)과 예전 이름 POSTGRES_URL을 함께 넣습니다. 빈 값은 없는 것으로 봅니다.
export function pickDbUrl(env: Record<string, string | undefined>): string | null {
  const v = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim();
  return v || null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** 내 컴퓨터의 DB인지(localhost, 127.0.0.1, ::1, 유닉스 소켓). 이런 주소는 TLS 없이 접속합니다. */
export function isLocalDb(url: URL): boolean {
  const socketHost = url.searchParams.get("host");
  if (socketHost?.startsWith("/")) return true; // ?host=/var/run/postgresql 같은 유닉스 소켓
  if (!url.hostname) return true; // postgres:///db 처럼 호스트가 없으면 기본 유닉스 소켓
  return LOCAL_HOSTS.has(url.hostname);
}

// postgres.js에 넘기기 전에 연결 문자열을 다듬습니다.
// - channel_binding: Neon 주소에 붙어 오는데 postgres.js는 이 옵션을 모르고 서버 설정값으로 그대로 보내 접속이 실패할 수 있어 뺍니다.
// - 내 컴퓨터가 아닌 DB(Neon 등)는 sslmode를 항상 verify-full로 바꿉니다. postgres.js는 sslmode=require이면 암호화만 하고
//   서버 인증서는 확인하지 않습니다(rejectUnauthorized=false). verify-full이면 시스템 CA로 인증서와 호스트 이름을 확인합니다.
//   Neon은 공인 인증서를 쓰므로 그대로 접속됩니다. 다른 TLS 설정(ssl, sslrootcert 등)은 섞이지 않게 뺍니다.
// - 내 컴퓨터 DB는 주소를 그대로 둡니다(TLS 없음).
export function normalizeDbUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // 형식이 이상하면 그대로 넘겨 postgres.js가 오류를 내게 합니다.
  }
  url.searchParams.delete("channel_binding");
  if (!isLocalDb(url)) {
    for (const k of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslnegotiation"]) url.searchParams.delete(k);
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}
