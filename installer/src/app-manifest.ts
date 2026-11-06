// 선생님 계정에 만드는 것들의 이름과 설정. 앱의 wrangler.jsonc(저장소 루트)와 맞아야 합니다.
// scripts/embed-app.mjs가 빌드 때 COMPATIBILITY_DATE·FLAGS를 루트 wrangler.jsonc와 비교해 다르면 멈춥니다.

/** 선생님 계정에 올리는 Worker 이름(주소: https://mandalart.<계정 하위 도메인>.workers.dev) */
export const SCRIPT_NAME = "mandalart";
/** 앱 데이터베이스(D1) 이름 */
export const DB_NAME = "mandalart-db";
/** D1을 처음 만들 때 위치 힌트(아시아·태평양) */
export const DB_LOCATION_HINT = "apac";
/** 앱이 쓰는 D1 바인딩 이름 */
export const DB_BINDING = "DB";

export const COMPATIBILITY_DATE = "2026-10-01";
export const COMPATIBILITY_FLAGS: string[] = ["nodejs_compat"];

/** 계정에 workers.dev 하위 도메인이 없을 때 만드는 이름의 앞부분(뒤에 소문자·숫자 6자) */
export const SUBDOMAIN_PREFIX = "mandalart-";

/** 설치 토큰 이름(Cloudflare API Tokens 목록에서 지울 때 찾기 쉽게) */
export const TOKEN_NAME = "AI Mandalart install (temporary)";

/**
 * 설치 토큰 권한. Cloudflare 대시보드의 토큰 만들기 화면에 미리 채웁니다.
 * - account_settings 읽기: 토큰으로 볼 수 있는 계정 목록(GET /accounts)
 * - workers_scripts 편집: Worker 올리기, workers.dev 하위 도메인 만들기·켜기, 비밀값(설정 코드) 바꾸기
 * - d1 편집: 데이터베이스 만들기·찾기, 비어 있는지 확인(query)
 * R2·Queues는 쓰지 않습니다(R2는 결제 수단 등록이 필요).
 */
export const TOKEN_PERMISSIONS = [
  { key: "account_settings", type: "read" },
  { key: "workers_scripts", type: "edit" },
  { key: "d1", type: "edit" },
] as const;

/** 미리 채운 토큰 만들기 화면 주소 */
export function tokenTemplateUrl(): string {
  const u = new URL("https://dash.cloudflare.com/profile/api-tokens");
  u.search = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
    accountId: "*",
    zoneId: "all",
    name: TOKEN_NAME,
  }).toString();
  return u.toString();
}

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
