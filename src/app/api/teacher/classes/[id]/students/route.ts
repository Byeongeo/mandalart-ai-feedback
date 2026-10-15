import * as z from "zod";
import { sql } from "@/lib/db";
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

  let updated = 0;
  await sql.begin(async (tx) => {
    for (const u of parsed.data.updates) {
      if (u.name !== undefined) {
        const r = await tx`update students set name = ${u.name} where id = ${u.id} and class_id = ${id} returning id`;
        updated += r.length;
      }
      if (u.unlock) {
        // 잠금을 풀면 잠금 단계(10분 → 60분 → 선생님 해제)를 처음부터 다시 셉니다('login_unlocked' 뒤의 잠금만 셈).
        const r = await tx`update students set failed_logins = 0, locked_until = null where id = ${u.id} and class_id = ${id} returning id`;
        if (r.length) await tx`insert into event_log (student_id, type, payload) values (${u.id}, 'login_unlocked', '{}'::jsonb)`;
        if (u.name === undefined) updated += r.length;
      }
    }
  });
  return json({ ok: true, updated });
}
