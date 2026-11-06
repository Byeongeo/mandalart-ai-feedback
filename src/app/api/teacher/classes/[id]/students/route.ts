import * as z from "zod";
import { sql, type Query } from "@/lib/db";
import { currentTeacher, json, ownsClass } from "@/lib/auth";

// 학생 정보 고치기: 이름 고치기(그 학생의 열린 세션은 끝남), 로그인 잠금 풀기. 여러 명을 한 번에 보낼 수 있습니다.
const Body = z.object({
  updates: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(20).optional(),
        unlock: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(60),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsClass(t.id, id))) return json({ error: "not found" }, 404);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "입력값을 확인해 주세요. 이름은 20자까지 쓸 수 있습니다." }, 400);

  // 모든 고치기를 batch 하나(= 한 트랜잭션)로 보냅니다: 모두 되거나 하나도 안 됩니다(원래 트랜잭션과 같음).
  // 잠금 풀기 기록('login_unlocked')은 '그 학급의 그 학생이 있을 때만' 넣는 문장이라, 원래의 'if (r.length)'와 같습니다.
  const stmts: Query<unknown>[] = [];
  const counted: number[] = []; // updated에 셀 문장의 자리
  for (const u of parsed.data.updates) {
    if (u.name !== undefined) {
      counted.push(stmts.length);
      stmts.push(sql`update students set name = ${u.name} where id = ${u.id} and class_id = ${id} returning id`);
    }
    if (u.unlock) {
      // 잠금을 풀면 잠금 단계(10분 → 60분 → 선생님 해제)를 처음부터 다시 셉니다('login_unlocked' 뒤의 잠금만 셈).
      if (u.name === undefined) counted.push(stmts.length);
      stmts.push(sql`update students set failed_logins = 0, locked_until = null where id = ${u.id} and class_id = ${id} returning id`);
      stmts.push(sql`insert into event_log (student_id, type, payload)
                     select id, 'login_unlocked', '{}' from students where id = ${u.id} and class_id = ${id}`);
    }
  }
  const res = stmts.length ? await sql.batch(stmts) : [];
  const updated = counted.reduce((n, i) => n + res[i].length, 0);
  return json({ ok: true, updated });
}
