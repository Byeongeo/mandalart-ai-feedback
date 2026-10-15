import * as z from "zod";
import { sql } from "@/lib/db";
import { currentTeacher, isUuid, json, ownsClass } from "@/lib/auth";
import { classOverview } from "@/lib/queries";

// 학급 화면 자료: 학급 정보, 학생별 진행 상황(PIN 포함), 안전 신호 목록, AI 설정 상태
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "not found" }, 404);
  const overview = await classOverview(t.id, id);
  if (!overview) return json({ error: "not found" }, 404);
  return json(overview);
}

const Patch = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    isOpen: z.boolean().optional(),
    maxFeedbackRounds: z.coerce.number().int().min(1).max(2).optional(),
  })
  .refine((b) => b.name !== undefined || b.isOpen !== undefined || b.maxFeedbackRounds !== undefined, { message: "바꿀 내용이 없습니다." });

// 학급 설정 바꾸기: 이름, 열기/닫기, 단계별 피드백 횟수(1 = 첫 피드백만, 2 = 확인 피드백까지)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsClass(t.id, id))) return json({ error: "not found" }, 404);
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요." }, 400);
  const b = parsed.data;
  await sql`
    update classes set
      name = coalesce(${b.name ?? null}::text, name),
      is_open = coalesce(${b.isOpen ?? null}::boolean, is_open),
      max_feedback_rounds = coalesce(${b.maxFeedbackRounds ?? null}::smallint, max_feedback_rounds)
    where id = ${id} and teacher_id = ${t.id}`;
  return json({ ok: true });
}

// 학급 지우기: 학생·만다라트·피드백이 모두 지워지고 되돌릴 수 없습니다.
// 실수로 지우지 않도록 본문에 그 학급의 학급 코드를 confirmCode로 함께 보내야 합니다.
const Delete = z.object({ confirmCode: z.string().trim().min(1).max(20) });

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsClass(t.id, id))) return json({ error: "not found" }, 404);
  const parsed = Delete.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "확인을 위해 학급 코드를 입력해 주세요." }, 400);
  const rows = await sql`
    delete from classes where id = ${id} and teacher_id = ${t.id} and class_code = ${parsed.data.confirmCode.toUpperCase()}
    returning id`;
  if (!rows.length) return json({ error: "학급 코드가 맞지 않습니다. 지우지 않았습니다." }, 400);
  return json({ ok: true });
}
