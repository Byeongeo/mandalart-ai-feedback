import { sql } from "@/lib/db";
import { currentTeacher, json } from "@/lib/auth";
import { aiStatus, checkAi, type AiCheck } from "@/lib/feedback/client";
import { sanitizeErrorEvent } from "@/lib/feedback/ai-errors";

// 연결 확인(실제 호출 최대 20초와 키 정보 조회를 함께, 실패하면 모델 정보 조회 최대 8초)을 넉넉히 담습니다.
export const maxDuration = 60;

// 교사 화면의 AI 상태: 키가 들어 있는지, (?check=1일 때만) 피드백과 같은 조건으로 AI를 실제로 한 번 짧게 불러 본 결과,
// 최근 24시간의 피드백 오류(최대 10개, 짧은 한국어 설명만: 학생 이름·글·AI 원문 없음).
// 확인 호출에는 학생 글을 넣지 않으며, 요금은 아주 조금 듭니다(checkAi 참고). check.status는 실패한 단계의 응답 상태 코드입니다.
// 응답: { keyConfigured, mock, model, check: AiCheck | null, recentErrors: [{ at, code, message_ko }] }
export async function GET(req: Request) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const wantCheck = new URL(req.url).searchParams.get("check") === "1";

  const status = aiStatus();
  const [check, events] = await Promise.all([
    wantCheck ? checkAi() : Promise.resolve<AiCheck | null>(null),
    sql<{ created_at: Date; payload: unknown }[]>`
      select e.created_at, e.payload from event_log e
      join students s on s.id = e.student_id join classes c on c.id = s.class_id
      where c.teacher_id = ${t.id} and e.type = 'feedback_error' and e.created_at > now() - interval '24 hours'
      order by e.created_at desc limit 10`,
  ]);
  return json({
    keyConfigured: status.keyConfigured,
    mock: status.mock,
    model: status.model,
    check,
    recentErrors: events.map(sanitizeErrorEvent),
  });
}
