import * as z from "zod";
import { sql } from "@/lib/db";
import { currentTeacher, json, ownsClass } from "@/lib/auth";
import { Roster, rosterRenames, type Rename } from "@/lib/roster";
import { generatePin } from "@/lib/pin";
import { classHasWork } from "@/lib/queries";

const Body = z.object({
  roster: Roster,
  // 만다라트를 쓰기 시작한 학생이 있는 학급에서 이름이 바뀌는 번호를 교사가 확인했는지
  confirmRenames: z.boolean().optional(),
});

// 이름은 교사에게 돌려주는 409 응답에만 담습니다(로그에는 넣지 않음).
class RenamesNotConfirmed extends Error {
  constructor(readonly renames: Rename[], readonly missing: number[]) {
    super("renames not confirmed");
  }
}

// 명렬표 다시 올리기: 번호 기준으로 이름을 고치고, 없는 번호는 새로 추가합니다(새 학생은 PIN도 만듦). 삭제는 하지 않습니다.
// 만다라트를 쓰기 시작한 학생이 있는 학급에서 이름이 바뀌는 번호가 있으면 confirmRenames: true가 있어야 반영합니다
// (번호가 밀린 명렬표로 글이 다른 학생에게 넘어가지 않게). → 409 { error, renames, missing }
// 성공: { ok, added, renamed }
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsClass(t.id, id))) return json({ error: "not found" }, 404);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "명렬표를 확인해 주세요." }, 400);
  const { roster } = parsed.data;
  const confirmRenames = parsed.data.confirmRenames === true;

  try {
    const result = await sql.begin(async (tx) => {
      const existing = await tx<{ id: string; number: number; name: string }[]>`
        select id, number, name from students where class_id = ${id} order by number for update`;
      const byNumber = new Map(existing.map((s) => [s.number, s]));
      const renames = rosterRenames(roster, existing);
      if (renames.length && !confirmRenames) {
        if (await classHasWork(id)) {
          const uploaded = new Set(roster.map((r) => r.number));
          const missing = existing.map((s) => s.number).filter((n) => !uploaded.has(n)).sort((a, b) => a - b);
          throw new RenamesNotConfirmed(renames, missing);
        }
      }
      let added = 0;
      for (const r of roster) {
        const ex = byNumber.get(r.number);
        if (!ex) {
          await tx`insert into students (class_id, number, name, pin) values (${id}, ${r.number}, ${r.name}, ${generatePin()})`;
          added++;
        }
      }
      for (const rn of renames) {
        await tx`update students set name = ${rn.to} where class_id = ${id} and number = ${rn.number}`;
      }
      return { added, renamed: renames.length };
    });
    return json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof RenamesNotConfirmed) {
      return json({
        error: `이미 만다라트를 쓴 학급에서 이름이 바뀌는 번호(${e.renames.map((r) => r.number).join(", ")})가 있습니다. 화면에서 확인한 뒤 다시 반영하세요.`,
        renames: e.renames,
        missing: e.missing,
      }, 409);
    }
    throw e;
  }
}
