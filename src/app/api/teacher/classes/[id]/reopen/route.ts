import * as z from "zod";
import { sql } from "@/lib/db";
import { currentTeacher, json, ownsClass } from "@/lib/auth";

const Body = z.object({ studentId: z.uuid() });

// 제출 취소(다시 쓰게 하기): 제출한 만다라트를 다시 '작성 중'으로 돌립니다. 받은 피드백은 그대로 남습니다.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsClass(t.id, id))) return json({ error: "not found" }, 404);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "입력값을 확인해 주세요." }, 400);
  const { studentId } = parsed.data;

  const [m] = await sql<{ status: string; number: number }[]>`
    select m.status, s.number from mandalarts m join students s on s.id = m.student_id
    where m.student_id = ${studentId} and s.class_id = ${id}`;
  if (!m) return json({ error: "이 학생은 아직 만다라트가 없습니다." }, 404);
  if (m.status !== "submitted") return json({ error: "아직 제출하지 않은 만다라트입니다." }, 409);
  await sql`update mandalarts set status = 'draft', submitted_at = null, updated_at = now()
            where student_id = ${studentId} and status = 'submitted'`;
  return json({ ok: true, number: m.number });
}
