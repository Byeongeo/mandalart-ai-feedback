import * as z from "zod";
import { sql } from "@/lib/db";
import { currentTeacher, isUuid, json } from "@/lib/auth";
import { studentDetail } from "@/lib/queries";

// 학생 한 명의 만다라트, 받은 피드백 카드 전체와 반응, 회차별 안전 신호
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id, sid } = await params;
  if (!isUuid(id) || !isUuid(sid)) return json({ error: "not found" }, 404);
  const detail = await studentDetail(t.id, id, sid);
  if (!detail) return json({ error: "not found" }, 404);
  return json(detail);
}

const Patch = z.object({
  // true = '확인했어요'(화면에 보인 신호까지 확인함으로 적음), false = 확인 취소(모든 신호를 다시 '살펴볼 학생'으로 셈)
  reviewConcern: z.boolean(),
  // 교사 화면에 보인 가장 늦은 신호 시각. 그 뒤에 새 신호가 생겼으면 확인으로 덮지 않고 409로 알립니다.
  // 화면에 보인 신호가 없으면(보내지 않으면) 누른 시각까지로 적습니다.
  seenUntil: z.iso.datetime().optional(),
});

// 안전 신호 '확인했어요'(students.concern_reviewed_at). 교사의 학급·학생만 바꿀 수 있습니다.
// 확인한 뒤 새로 생긴 신호(표현 검사에 새로 걸림, AI 신호 회차)가 있으면 다시 '살펴볼 학생'이 됩니다(src/lib/queries.ts).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id, sid } = await params;
  if (!isUuid(id) || !isUuid(sid)) return json({ error: "not found" }, 404);
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "입력값을 확인해 주세요." }, 400);
  const [own] = await sql`
    select s.id from students s join classes c on c.id = s.class_id
    where s.id = ${sid} and c.id = ${id} and c.teacher_id = ${t.id}`;
  if (!own) return json({ error: "not found" }, 404);

  if (!parsed.data.reviewConcern) {
    await sql`update students set concern_reviewed_at = null where id = ${sid}`;
    return json({ ok: true, reviewed_at: null });
  }
  // 화면의 시각은 밀리초까지라 DB 시각(마이크로초)과 1밀리초 안쪽 차이는 같은 신호로 봅니다.
  // 확인한 시각으로는 누른 시각(now()) 대신 '본 신호 + 1밀리초'를 적습니다. 누르기 전에 시작해 누른 뒤에 저장된 신호
  // (트랜잭션 시작 시각이 찍혀 누른 시각보다 이를 수 있음)가 확인한 것으로 묻히지 않게 하려는 것입니다.
  // 앞서 더 늦은 시각까지 확인했으면 그대로 두고(되돌리지 않음), 지금보다 늦은 시각은 받지 않습니다.
  const seen = parsed.data.seenUntil ?? null;
  const [row] = await sql<{ concern_reviewed_at: Date }[]>`
    update students s set concern_reviewed_at = case
        when ${seen}::timestamptz is null then now()
        else greatest(coalesce(s.concern_reviewed_at, '-infinity'), least(${seen}::timestamptz + interval '1 millisecond', now()))
      end
    where s.id = ${sid} and (${seen}::timestamptz is null or not exists (
      select 1 from mandalarts m where m.student_id = s.id
        and m.rule_concern_at >= ${seen}::timestamptz + interval '1 millisecond'
      union all
      select 1 from feedback_rounds r join mandalarts m on m.id = r.mandalart_id
      where m.student_id = s.id and r.concern and r.created_at >= ${seen}::timestamptz + interval '1 millisecond'))
    returning s.concern_reviewed_at`;
  if (!row) return json({ error: "그사이 새 안전 신호가 생겼어요. 화면을 새로 고쳤으니 새 신호를 먼저 살펴봐 주세요." }, 409);
  return json({ ok: true, reviewed_at: row.concern_reviewed_at });
}
