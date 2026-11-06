import { currentTeacher, json } from "@/lib/auth";
import { aiStatus } from "@/lib/feedback/client";

// 교사 화면 위쪽 안내용: AI 키가 들어 있는지(키 값은 돌려주지 않음), 쓰는 모델 이름.
export async function GET() {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  return json({ teacher: { display_name: t.display_name, login_id: t.login_id }, ai: aiStatus() });
}
