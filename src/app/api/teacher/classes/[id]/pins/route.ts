import * as z from "zod";
import { sql } from "@/lib/db";
import { currentTeacher, json, ownsClass } from "@/lib/auth";
import { generatePin } from "@/lib/pin";

// studentId가 없으면: 이 학급에서 PIN이 없는 학생 모두에게 PIN을 만듭니다. → { ok, count }
// studentId가 있으면: 그 학생의 PIN을 새로 만듭니다(잊어버렸거나 친구가 알게 된 경우). 잠금도 함께 풉니다. → { ok, number, pin }
// PIN은 로그·기록에 남기지 않습니다(교사 화면에서만 봅니다).
const Body = z.object({ studentId: z.uuid().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsClass(t.id, id))) return json({ error: "not found" }, 404);
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "입력값을 확인해 주세요." }, 400);
  const { studentId } = parsed.data;

  if (studentId) {
    const pin = generatePin();
    // PIN을 바꾸면 잠금도 풀고, 잠금 단계를 처음부터 다시 셉니다('login_unlocked'). 기록에 PIN은 남기지 않습니다.
    const st = await sql.begin(async (tx) => {
      const [row] = await tx<{ number: number }[]>`
        update students set pin = ${pin}, failed_logins = 0, locked_until = null
        where id = ${studentId} and class_id = ${id} returning number`;
      if (row) await tx`insert into event_log (student_id, type, payload) values (${studentId}, 'login_unlocked', '{}'::jsonb)`;
      return row;
    });
    if (!st) return json({ error: "학생을 찾을 수 없습니다." }, 404);
    return json({ ok: true, number: st.number, pin });
  }

  const count = await sql.begin(async (tx) => {
    const targets = await tx<{ id: string }[]>`
      select id from students where class_id = ${id} and pin is null order by number for update`;
    for (const s of targets) await tx`update students set pin = ${generatePin()} where id = ${s.id}`;
    return targets.length;
  });
  return json({ ok: true, count });
}
