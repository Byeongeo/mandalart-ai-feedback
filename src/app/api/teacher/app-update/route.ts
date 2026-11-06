import { currentTeacher, json } from "@/lib/auth";
import { appUpdateInfo } from "@/lib/app-update";
import { rc } from "@/lib/request-context";

// 교사 화면의 '앱 업데이트' 카드: 지금 버전과 설치 페이지(INSTALLER_URL)에 있는 새 버전.
// 응답: { current: string | null, latest: string | null, updateUrl: string | null }
//   latest는 더 새 버전이 있을 때만, updateUrl은 그때의 설치 페이지 '업데이트' 화면(`${INSTALLER_URL}/#update`).
// 설치 페이지 확인은 최대 2.5초, 결과는 이 Worker 인스턴스에서 1시간(실패는 5분) 기억합니다. 실패해도 오류 없이 latest: null.
export async function GET() {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  return json(await appUpdateInfo(rc().env));
}
