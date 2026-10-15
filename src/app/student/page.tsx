import { CLASS_CLOSED_MESSAGE, requireStudentPage } from "@/lib/auth";
import { studentHome } from "@/lib/queries";
import Editor from "@/components/Editor";

// 학생 화면: 만다라트 쓰기 + 단계별 AI 피드백 + 제출.
// 학급이 닫혀 있으면 볼 수만 있고, 제출한 뒤에는 '다 했어요' 화면을 먼저 보여 줍니다(Editor 안에서).
export default async function StudentPage() {
  const st = await requireStudentPage();
  const home = await studentHome(st);
  return (
    <Editor
      mandalartId={home.mandalart.id}
      initialContent={home.mandalart.content}
      initialRevision={home.mandalart.revision}
      submitted={home.mandalart.status === "submitted"}
      header={`${st.class_name} ${st.number}번 ${st.name}`}
      maxRounds={st.max_feedback_rounds}
      // Date를 문자열로 바꿔 클라이언트 컴포넌트로 넘깁니다.
      initialRounds={JSON.parse(JSON.stringify(home.rounds))}
      aiReady={home.aiReady}
      closedMessage={st.is_open ? null : CLASS_CLOSED_MESSAGE}
    />
  );
}
