import { sql } from "@/lib/db";
import { CLASS_CLOSED_MESSAGE, currentStudent, isUuid, json } from "@/lib/auth";
import { MandalartContent } from "@/lib/mandalart";
import { tooLongCell, tooLongMessage } from "@/lib/student";
import { STALE_MESSAGE, parseSaveMeta } from "@/lib/save-rules";
import { saveMandalart } from "@/lib/save-mandalart";

// 학생 화면은 저장을 15초 기다리다 끊고 2초쯤 뒤 다시 보냅니다(src/lib/student.ts의 SAVE_TIMEOUT_MS).
// 끊긴 요청이 그 뒤에 늦게 반영되어 새 글을 덮어쓰지 않도록, 이 함수는 12초 안에 끝나고
// DB 문장은 하나에 4초를 넘기면 취소됩니다(끝나지 못한 저장은 반영되지 않고, 화면은 실패로 보고 다시 저장).
// 늦게 도착하더라도 저장 번호(revision)가 이미 올라가 있으면 반영되지 않습니다(src/lib/save-rules.ts의 saveDecision).
export const maxDuration = 12;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const st = await currentStudent();
  if (!st) return json({ error: "다시 로그인해 주세요." }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "만다라트를 찾을 수 없어요." }, 404);
  const [m] = await sql<{ id: string; content: unknown; status: string; submitted_at: Date | null; updated_at: Date; revision: number }[]>`
    select id, content, status, submitted_at, updated_at, revision from mandalarts where id = ${id} and student_id = ${st.id}`;
  if (!m) return json({ error: "만다라트를 찾을 수 없어요." }, 404);
  return json({ mandalart: { ...m, content: MandalartContent.parse(m.content) } });
}

// 자동 저장. 본문: { content, revision(화면이 아는 저장 번호), prev?(결과를 모르는 앞선 저장의 내용 지문), sends?(그 저장을 보낸 횟수) }
// 성공: { ok, savedAt, revision(새 번호. 서버의 지금 글을 모르는 화면이 서버 글과 똑같은 글을 보냈으면 지금 번호) }.
// 다른 탭·기기가 더 나중에 고쳤으면 409 { stale: true }, 이미 제출했으면 409 { submitted: true }.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const st = await currentStudent();
  if (!st) return json({ error: "다시 로그인해 주세요." }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "만다라트를 찾을 수 없어요." }, 404);
  const body = await req.json().catch(() => null);
  const parsed = MandalartContent.safeParse(body?.content);
  if (!parsed.success) {
    // 글자 수가 넘친 칸이 있으면 어느 칸인지 알려 줍니다(학생 화면이 그 칸으로 이동).
    const target = tooLongCell(body?.content);
    if (target) return json({ error: tooLongMessage(target), target }, 400);
    return json({ error: "내용 형식이 올바르지 않아요." }, 400);
  }
  if (!st.is_open) return json({ error: CLASS_CLOSED_MESSAGE, closed: true }, 409);

  const saved = await saveMandalart({ id, studentId: st.id, content: parsed.data, meta: parseSaveMeta(body), submit: false });
  if (!saved.ok) {
    if (saved.reason === "not_found") return json({ error: "만다라트를 찾을 수 없어요." }, 404);
    if (saved.reason === "stale") return json({ error: STALE_MESSAGE, stale: true }, 409);
    return json({ error: "이미 제출한 만다라트예요. 더 고칠 수 없어요.", submitted: true }, 409);
  }
  return json({ ok: true, savedAt: new Date().toISOString(), revision: saved.revision });
}
