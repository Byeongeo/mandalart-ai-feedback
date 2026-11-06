import { CLASS_CLOSED_MESSAGE, currentStudent, json } from "@/lib/auth";
import { studentHome } from "@/lib/queries";

// 학생 첫 화면 자료: 학생·학급 정보, 내 만다라트(없으면 빈 것을 만듦), 받은 피드백 회차, AI 준비 여부.
export async function GET() {
  const st = await currentStudent();
  if (!st) return json({ error: "다시 로그인해 주세요." }, 401);
  const home = await studentHome(st);
  return json({ ...home, closedMessage: st.is_open ? null : CLASS_CLOSED_MESSAGE });
}
