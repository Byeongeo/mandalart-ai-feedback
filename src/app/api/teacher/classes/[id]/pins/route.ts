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
    // PIN 바꾸기와 'login_unlocked' 기록을 batch 하나(= 한 트랜잭션)로 함께 합니다. 기록은 '그 학급의 그 학생이 있을 때만' 넣으므로
    // 학생이 없으면(바꾼 행 없음) 기록도 생기지 않습니다(원래 트랜잭션의 'if (row)'와 같음).
    const [updated] = await sql.batch([
      sql`update students set pin = ${pin}, failed_logins = 0, locked_until = null
          where id = ${studentId} and class_id = ${id} returning number`,
      sql`insert into event_log (student_id, type, payload)
          select id, 'login_unlocked', '{}' from students where id = ${studentId} and class_id = ${id}`,
    ]);
    const st = updated[0] as { number: number } | undefined;
    if (!st) return json({ error: "학생을 찾을 수 없습니다." }, 404);
    return json({ ok: true, number: st.number, pin });
  }

  // PIN이 없는 학생을 읽어 PIN을 미리 만든 뒤, 한 문장으로 '아직 PIN이 없는 학생에게만' 넣습니다(원래는 행 잠금 for update).
  // 동시에 두 번 눌러도 먼저 실행된 문장이 넣은 PIN을 뒤 문장이 덮어쓰지 않습니다(pin is null). count는 실제로 넣은 수입니다.
  const targets = await sql<{ id: string }[]>`select id from students where class_id = ${id} and pin is null order by number`;
  if (!targets.length) return json({ ok: true, count: 0 });
  const pins = sql.json(targets.map((s) => ({ id: s.id, pin: generatePin() })));
  const res = await sql`
    update students set pin = (select json_extract(j.value, '$.pin') from json_each(${pins}) j where json_extract(j.value, '$.id') = students.id)
    where class_id = ${id} and pin is null and id in (select json_extract(j.value, '$.id') from json_each(${pins}) j)`;
  return json({ ok: true, count: res.count });
}
