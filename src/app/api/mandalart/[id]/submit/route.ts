import { CLASS_CLOSED_MESSAGE, currentStudent, isUuid, json } from "@/lib/auth";
import { MandalartContent } from "@/lib/mandalart";
import { FEEDBACK_PENDING_MESSAGE, STALE_MESSAGE, parseSaveMeta } from "@/lib/save-rules";
import { saveMandalart } from "@/lib/save-mandalart";

// 제출: 마지막 내용을 함께 받아 저장하고 '제출함'으로 바꿉니다. 피드백을 다 받지 않아도 제출할 수 있습니다.
// 자동 저장과 같은 확인(저장 번호, 규칙 기반 안전 신호)을 거치고(src/lib/save-mandalart.ts), 피드백을 만드는 중이면 받지 않습니다.
// 성공: { ok, revision, submitted: true }. 이미 제출한 글과 똑같은 글로 다시 제출해도(응답이 끊겨 다시 누름 등) 성공으로 답합니다.
// 다른 글로 이미 제출돼 있으면 409 { submitted: true }(학생 화면은 서버의 제출한 글을 불러와 '다 했어요' 화면을 보여 줌).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const st = await currentStudent();
  if (!st) return json({ error: "다시 로그인해 주세요." }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "만다라트를 찾을 수 없어요." }, 404);
  const body = await req.json().catch(() => null);
  const parsed = MandalartContent.safeParse(body?.content);
  if (!parsed.success) return json({ error: "내용 형식이 올바르지 않아요." }, 400);
  if (!st.is_open) return json({ error: CLASS_CLOSED_MESSAGE, closed: true }, 409);

  const saved = await saveMandalart({ id, studentId: st.id, content: parsed.data, meta: parseSaveMeta(body), submit: true });
  if (!saved.ok) {
    if (saved.reason === "not_found") return json({ error: "만다라트를 찾을 수 없어요." }, 404);
    if (saved.reason === "stale") return json({ error: STALE_MESSAGE, stale: true }, 409);
    if (saved.reason === "feedback_pending") return json({ error: FEEDBACK_PENDING_MESSAGE, code: "feedback_pending" }, 409);
    return json({ error: "이미 제출한 만다라트예요. 더 고칠 수 없어요.", submitted: true }, 409);
  }
  return json({ ok: true, revision: saved.revision, submitted: true });
}
