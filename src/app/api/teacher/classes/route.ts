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

  const cls = await sql.begin(async (tx) => {
    let row: { id: string; class_code: string } | undefined;
    for (let attempt = 0; !row && attempt < 5; attempt++) {
      [row] = await tx<{ id: string; class_code: string }[]>`
        insert into classes (teacher_id, name, class_code, require_pin, school_level)
        values (${t.id}, ${name}, ${randomCode(6)}, ${requirePin}, ${schoolLevel})
        on conflict (class_code) do nothing returning id, class_code`;
    }
    if (!row) throw new Error("학급 코드 생성 실패");
    for (const r of roster) {
      await tx`insert into students (class_id, number, name, pin) values (${row.id}, ${r.number}, ${r.name}, ${generatePin()})`;
    }
    return row;
  });
  return json({ id: cls.id, class_code: cls.class_code });
}
