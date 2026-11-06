import * as z from "zod";
import { sql, type Query } from "@/lib/db";
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
  readonly renames: Rename[];
  readonly missing: number[];
  constructor(renames: Rename[], missing: number[]) {
    super("renames not confirmed");
    this.renames = renames;
    this.missing = missing;
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
    // 트랜잭션 없이(원래는 학생 행 잠금 for update): 지금 명단을 읽어 판단한 뒤, 새 학생 넣기와 이름 고치기를 batch 하나
    // (= 한 트랜잭션)로 함께 합니다(모두 되거나 하나도 안 됨). 새 학생은 한 문장(json_each)으로 넣고, 그사이 다른 요청이 같은 번호를
    // 먼저 넣었으면 건너뜁니다(on conflict do nothing, added는 실제로 넣은 수). '이름이 바뀌는 번호' 확인(classHasWork)은
    // 원래도 만다라트 행을 잠그지 않고 읽었으므로 같은 방식입니다.
    const result = await (async () => {
      const existing = await sql<{ id: string; number: number; name: string }[]>`
        select id, number, name from students where class_id = ${id} order by number`;
      const byNumber = new Map(existing.map((s) => [s.number, s]));
      const renames = rosterRenames(roster, existing);
      if (renames.length && !confirmRenames) {
        if (await classHasWork(id)) {
          const uploaded = new Set(roster.map((r) => r.number));
          const missing = existing.map((s) => s.number).filter((n) => !uploaded.has(n)).sort((a, b) => a - b);
          throw new RenamesNotConfirmed(renames, missing);
        }
      }
      const toAdd = roster
        .filter((r) => !byNumber.has(r.number))
        .map((r) => ({ id: crypto.randomUUID(), number: r.number, name: r.name, pin: generatePin() }));
      const stmts: Query<unknown>[] = [];
      if (toAdd.length) {
        stmts.push(sql`
          insert into students (id, class_id, number, name, pin)
          select json_extract(j.value, '$.id'), ${id}, json_extract(j.value, '$.number'), json_extract(j.value, '$.name'),
                 json_extract(j.value, '$.pin')
          from json_each(${sql.json(toAdd)}) j where true
          on conflict (class_id, number) do nothing`);
      }
      for (const rn of renames) {
        stmts.push(sql`update students set name = ${rn.to} where class_id = ${id} and number = ${rn.number}`);
      }
      const res = await sql.batch(stmts);
      return { added: toAdd.length ? res[0].count : 0, renamed: renames.length };
    })();
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
