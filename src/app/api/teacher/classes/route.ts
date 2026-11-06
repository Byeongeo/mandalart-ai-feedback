import * as z from "zod";
import { sql } from "@/lib/db";
import { currentTeacher, json } from "@/lib/auth";
import { randomCode } from "@/lib/password";
import { Roster } from "@/lib/roster";
import { generatePin } from "@/lib/pin";
import { listClasses } from "@/lib/queries";
import { DEFAULT_SCHOOL_LEVEL, SCHOOL_LEVEL_KEYS } from "@/lib/school-level";

const Body = z.object({
  name: z.string().trim().min(1, { message: "학급 이름을 써 주세요." }).max(40, { message: "학급 이름은 40자까지 쓸 수 있습니다." }),
  roster: Roster,
  // 학생 PIN 사용(기본 켬). 끄면 학급 코드·번호·이름만으로 들어오므로 시범 수업처럼 짧게 쓸 때만 끕니다.
  // 꺼도 학생 PIN은 만들어 둡니다(나중에 켜면 바로 그 PIN으로 들어옴).
  requirePin: z.boolean().default(true),
  // 학교급(기본 중학교). AI 진단 기준과 카드 질문 수준만 바뀝니다(src/lib/school-level.ts).
  schoolLevel: z.enum(SCHOOL_LEVEL_KEYS, { message: "학교급을 골라 주세요." }).default(DEFAULT_SCHOOL_LEVEL),
});

// 내 학급 목록
export async function GET() {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  return json({ classes: await listClasses(t.id) });
}

// 학급 만들기: 이름 + 명렬표(번호·이름) + 학생 PIN 사용 여부 + 학교급. 학급 코드(6자)와 학생마다 4자리 PIN을 자동으로 만듭니다.
export async function POST(req: Request) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요." }, 400);
  const { name, roster, requirePin, schoolLevel } = parsed.data;

  // 학급과 학생을 batch 하나(= 한 트랜잭션)로 만듭니다: 모두 만들어지거나 하나도 만들어지지 않습니다(학생 없는 학급이 남지 않음).
  // id·PIN은 미리 만들어 두고, 학생은 한 문장(json_each)으로 넣습니다(D1 문장 하나의 값 자리 100개 제한을 넘지 않게).
  // 학급 코드가 이미 있는 코드와 겹치면 학급 넣기가 아무것도 하지 않고(on conflict do nothing), 학생 넣기도 '그 학급이 있을 때만'이라
  // 아무것도 넣지 않습니다. 그때는 새 코드로 다시 시도합니다(5번까지).
  let cls: { id: string; class_code: string } | undefined;
  for (let attempt = 0; !cls && attempt < 5; attempt++) {
    const classId = crypto.randomUUID();
    const students = roster.map((r) => ({ id: crypto.randomUUID(), number: r.number, name: r.name, pin: generatePin() }));
    const [inserted] = await sql.batch([
      sql`insert into classes (id, teacher_id, name, class_code, require_pin, school_level)
          values (${classId}, ${t.id}, ${name}, ${randomCode(6)}, ${requirePin}, ${schoolLevel})
          on conflict (class_code) do nothing returning id, class_code`,
      sql`insert into students (id, class_id, number, name, pin)
          select json_extract(j.value, '$.id'), ${classId}, json_extract(j.value, '$.number'), json_extract(j.value, '$.name'),
                 json_extract(j.value, '$.pin')
          from json_each(${sql.json(students)}) j
          where exists (select 1 from classes where id = ${classId})`,
    ]);
    cls = inserted[0] as { id: string; class_code: string } | undefined;
  }
  if (!cls) throw new Error("학급 코드 생성 실패");
  return json({ id: cls.id, class_code: cls.class_code });
}
