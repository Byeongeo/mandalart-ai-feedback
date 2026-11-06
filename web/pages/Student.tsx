import { useView } from "../nav";
import Editor from "@/components/Editor";

/** GET /api/view/student: Editor에 넘길 값 그대로(로그인이 안 되어 있으면 401 {redirect:"/"}) */
export type StudentView = Parameters<typeof Editor>[0];

// 학생 화면: 만다라트 쓰기 + 단계별 AI 피드백 + 제출(원래 src/app/student/page.tsx).
// 학급이 닫혀 있으면 볼 수만 있고, 제출한 뒤에는 '다 했어요' 화면을 먼저 보여 줍니다(Editor 안에서).
export default function StudentPage() {
  const v = useView<StudentView>();
  return <Editor {...v} />;
}
