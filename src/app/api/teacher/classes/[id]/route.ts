import * as z from "zod";
import { sql } from "@/lib/db";
import { currentTeacher, isUuid, json, ownsClass } from "@/lib/auth";
import { classOverview } from "@/lib/queries";
import { LOCK_LOOKBACK_HOURS, generatePin } from "@/lib/pin";
import { SCHOOL_LEVEL_KEYS } from "@/lib/school-level";

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
    // 학생 PIN 사용(classes.require_pin). 끄면 학급 코드·번호·이름만으로 들어옵니다(시범 수업처럼 짧게 쓸 때만).
    requirePin: z.boolean().optional(),
    // 학교급(classes.school_level). 바꾸면 그다음에 요청하는 AI 피드백부터 적용됩니다(로그아웃 없음, 이미 받은 카드는 그대로).
    schoolLevel: z.enum(SCHOOL_LEVEL_KEYS, { message: "학교급을 골라 주세요." }).optional(),
  })
  .refine((b) => b.name !== undefined || b.isOpen !== undefined || b.maxFeedbackRounds !== undefined || b.requirePin !== undefined || b.schoolLevel !== undefined, {
    message: "바꿀 내용이 없습니다.",
  });

// 학급 설정 바꾸기: 이름, 열기/닫기, 단계별 피드백 횟수(1 = 첫 피드백만, 2 = 확인 피드백까지), 학생 PIN 사용, 학교급
// 학교급은 피드백을 요청할 때 읽으므로(src/lib/feedback/round.ts) 바꾸면 그다음 피드백부터 적용되고, 학생 세션에는 영향이 없습니다.
// '학생 PIN 사용'을 실제로 바꾸면(켬 ↔ 끔):
// - 학생 세션 지문에 이 설정이 들어 있으므로(src/lib/pin.ts pinFingerprint) 이 학급 학생은 모두 로그아웃되고 다시 들어와야 합니다.
//   PIN을 끈 사이 친구가 다른 학생으로 들어와 있었다면, PIN을 켜는 순간 쫓겨납니다.
// - 학급의 로그인 잠금을 모두 풉니다(실패 횟수 0). 지금 잠겨 있거나, 잠금 단계를 셀 때 들어가는 잠금 기록이 있는 학생은
//   (최근 24시간 안의 'login_locked' 가운데 마지막 'login_unlocked' 뒤의 것, 이미 풀린 잠금 포함) 'login_unlocked'를 남겨
//   '잠금 해제'처럼 잠금 단계도 처음부터(다음 잠금은 10분) 셉니다. PIN을 끈 동안에는 잠금을 쓰지 않으므로, 다시 켰을 때
//   옛 잠금이나 옛 잠금 단계가 되살아나지 않게 합니다.
// - PIN을 켤 때 PIN이 없는 학생이 있으면(옛 버전에서 만든 학생 등) 그 자리에서 PIN을 만듭니다(켜자마자 못 들어오는 학생이 없게).
// 학생 PIN 자체는 끌 때도 지우지 않습니다. 다시 켜면 전에 쓰던 PIN으로 들어옵니다.
// → { ok, require_pin, pins_created }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsClass(t.id, id))) return json({ error: "not found" }, 404);
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요." }, 400);
  const b = parsed.data;
  const result = await sql.begin(async (tx) => {
    const [cur] = await tx<{ require_pin: boolean }[]>`
      select require_pin from classes where id = ${id} and teacher_id = ${t.id} for update`;
    if (!cur) return null;
    await tx`
      update classes set
        name = coalesce(${b.name ?? null}::text, name),
        is_open = coalesce(${b.isOpen ?? null}::boolean, is_open),
        max_feedback_rounds = coalesce(${b.maxFeedbackRounds ?? null}::smallint, max_feedback_rounds),
        require_pin = coalesce(${b.requirePin ?? null}::boolean, require_pin),
        school_level = coalesce(${b.schoolLevel ?? null}::text, school_level)
      where id = ${id} and teacher_id = ${t.id}`;
    const requirePin = b.requirePin ?? cur.require_pin;
    let pinsCreated = 0;
    if (requirePin !== cur.require_pin) {
      await tx`
        insert into event_log (student_id, type, payload)
        select s.id, 'login_unlocked', '{}'::jsonb from students s
        where s.class_id = ${id}
          and (s.locked_until > now() or exists (
            select 1 from event_log e
            where e.student_id = s.id and e.type = 'login_locked'
              and e.created_at > greatest(now() - make_interval(hours => ${LOCK_LOOKBACK_HOURS}),
                coalesce((select max(u.created_at) from event_log u where u.student_id = s.id and u.type = 'login_unlocked'), '-infinity'))))`;
      await tx`
        update students set failed_logins = 0, locked_until = null
        where class_id = ${id} and (failed_logins <> 0 or locked_until is not null)`;
      if (requirePin) {
        const targets = await tx<{ id: string }[]>`
          select id from students where class_id = ${id} and pin is null order by number for update`;
        for (const s of targets) await tx`update students set pin = ${generatePin()} where id = ${s.id}`;
        pinsCreated = targets.length;
      }
    }
    return { requirePin, pinsCreated };
  });
  if (!result) return json({ error: "not found" }, 404);
  return json({ ok: true, require_pin: result.requirePin, pins_created: result.pinsCreated });
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
