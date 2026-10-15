import * as z from "zod";
import { sql } from "@/lib/db";
import { createSession, studentPinTag } from "@/lib/session";
import { json } from "@/lib/auth";
import { normName } from "@/lib/roster";
import { LOCK_LOOKBACK_HOURS, MAX_FAILS, isPin, lockMinutes, lockedMessage, pinMatches } from "@/lib/pin";

const Body = z.object({
  classCode: z.string().trim().toUpperCase().min(4).max(10),
  number: z.coerce.number().int().min(1).max(99),
  name: z.string().trim().min(1).max(20),
  // 학생 PIN(4자리). 공백·하이픈은 무시합니다.
  pin: z.string().max(20),
});

// 학급 코드·번호·이름·PIN 중 무엇이 틀렸을 때도(아직 PIN이 없는 학생 포함) 같은 문구를 씁니다.
// 무엇이 틀렸는지, 그 번호의 학생이 있는지, PIN이 있는 학생인지 드러나지 않게 합니다.
const WRONG = "학급 코드, 번호, 이름, PIN을 확인해 주세요.";

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "입력값을 확인해 주세요." }, 400);
  const { classCode, number, name, pin } = parsed.data;

  // recent_locks: 최근 24시간 안에 이 학생이 잠긴 횟수(event_log 'login_locked'). 이번에 잠그게 되면 이 횟수로 잠금 시간을 정합니다.
  // 선생님이 잠금을 풀거나 PIN을 다시 만들면('login_unlocked') 그 뒤의 잠금만 셉니다.
  const [st] = await sql<{ id: string; name: string; pin: string | null; recent_locks: number }[]>`
    select s.id, s.name, s.pin,
      (select count(*)::int from event_log e
        where e.student_id = s.id and e.type = 'login_locked'
          and e.created_at > greatest(now() - make_interval(hours => ${LOCK_LOOKBACK_HOURS}),
            coalesce((select max(u.created_at) from event_log u where u.student_id = s.id and u.type = 'login_unlocked'), '-infinity'))
      ) as recent_locks
    from students s join classes c on c.id = s.class_id
    where c.class_code = ${classCode} and s.number = ${number}`;
  // 학급 코드나 번호가 없으면 같은 문구로 돌려줍니다(시도 횟수에는 넣지 않음: 셀 학생이 없음).
  if (!st) return json({ error: WRONG }, 401);
  const lockMins = lockMinutes(st.recent_locks);

  // 이름을 확인하기 전에 시도 횟수를 한 번의 UPDATE로 먼저 올립니다(동시에 여러 번 보내도 횟수가 빠지지 않음).
  // 잠겨 있으면 행이 갱신되지 않습니다. 잠금이 풀린 뒤 첫 시도는 1부터 다시 셉니다. 맞히면 아래에서 0으로 되돌립니다.
  // 잠금 시간: 24시간 안에 첫 잠금 10분, 두 번째 60분, 세 번째부터는 선생님이 풀 때까지(30일).
  const [attempt] = await sql<{ failed_logins: number }[]>`
    update students set
      failed_logins = case when locked_until is not null then 1 else failed_logins + 1 end,
      locked_until = case when (case when locked_until is not null then 1 else failed_logins + 1 end) >= ${MAX_FAILS}
        then now() + make_interval(mins => ${lockMins}) else null end
    where id = ${st.id} and (locked_until is null or locked_until <= now())
    returning failed_logins`;
  if (!attempt) {
    const [left] = await sql<{ mins: number | null }[]>`
      select ceil(extract(epoch from (locked_until - now())) / 60)::int as mins
      from students where id = ${st.id} and locked_until > now()`;
    return json({ error: lockedMessage(left?.mins) }, 429);
  }
  // 이름과 PIN이 모두 맞아야 합니다. 틀린 PIN·빈 PIN도 틀린 이름과 똑같이 실패 횟수에 들어가고,
  // 무엇이 틀렸는지는 알려 주지 않습니다. PIN이 아직 없는 학생도 같은 문구를 받고, 선생님이 PIN을 만든 뒤에 들어올 수 있습니다.
  const ok = isPin(st.pin) && normName(st.name) === normName(name) && pinMatches(pin, st.pin);
  if (!ok) {
    // 이번 실패로 잠겼으면 잠금을 기록하고(내용은 비움: PIN·이름을 남기지 않음) 바로 잠김 안내(429)를 보여 줍니다.
    // 8번째에 맞게 입력한 경우는 아래에서 잠금을 지우므로 기록하지 않습니다.
    if (attempt.failed_logins >= MAX_FAILS) {
      await sql`insert into event_log (student_id, type, payload) values (${st.id}, 'login_locked', '{}'::jsonb)`;
      return json({ error: lockedMessage(lockMins) }, 429);
    }
    return json({ error: WRONG }, 401);
  }
  await sql`update students set failed_logins = 0, locked_until = null where id = ${st.id}`;
  await sql`insert into event_log (student_id, type) values (${st.id}, 'login')`;
  // 토큰에는 지금 PIN·이름의 지문만 넣습니다(PIN 자체는 넣지 않음). 'PIN 다시 만들기'나 이름 고치기를 하면 이 세션은 끝납니다.
  await createSession({ role: "student", id: st.id, pf: await studentPinTag(st.pin, st.name) });
  return json({ ok: true });
}
