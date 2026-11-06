import * as z from "zod";
import { randomInt } from "node:crypto";
import { sql } from "@/lib/db";
import { createSession, sessionSecret, teacherPasswordTag } from "@/lib/session";
import { loginDelayMs, loginIdKey, verifyPasswordOrDummy } from "@/lib/password";
import { json } from "@/lib/auth";

// 늦추기(최대 15초) + 비밀번호 확인 + 지연을 넉넉히 담을 수 있게 합니다.
export const maxDuration = 60;

const Body = z.object({ loginId: z.string().trim().min(1).max(50), password: z.string().min(1).max(200) });

const WINDOW_MINUTES = 10;
// 같은 key로 10분 안에 이보다 많이 시도하면(동시에 몰아 보내는 공격) 비밀번호를 확인하지도, 기다리지도 않고 바로 429를 돌려줍니다.
// 보통 교사는 10분에 100번을 넘게 틀리지 않으므로 막히지 않습니다.
const LOGIN_FLOOD_CEILING = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 교사 로그인은 막지 않고 늦춥니다(학생이 아이디만 알아도 선생님을 잠가 버리지 못하게).
// 1) 확인하기 전에 시도 기록을 먼저 남깁니다: event_log(student_id 없음, type 'teacher_login_fail', payload {key}).
//    key는 아이디의 해시(loginIdKey)라서 아이디 칸에 비밀번호를 넣어도 원문이 남지 않습니다. 비밀번호도 남기지 않습니다.
// 2) 같은 key로 최근 10분 안에 남은 기록 중 내 기록 id 이하의 개수(n)를 셉니다. 동시에 들어온 요청도 저마다 다른 n을 받습니다.
// 3) n이 10을 넘으면 확인 전에 min(2×(n−10), 15)초 기다립니다(트랜잭션·연결을 잡지 않은 채).
// 4) 맞으면 내 기록을 지우고 같은 key의 이전 실패를 'teacher_login_fail_cleared'로 바꿔 더는 세지 않습니다.
//    틀리면 기록을 실패로 그대로 둡니다. 그래서 세는 것은 실패와 아직 끝나지 않은 시도뿐입니다.
// 5) n이 100(LOGIN_FLOOD_CEILING)을 넘으면 scrypt·기다리기 없이 내 기록을 지우고 곧바로 429를 돌려줍니다.
//    내 기록을 지우므로 몰아 보내도 기록은 key마다 10분에 100개 남짓으로 묶이고, 10분이 지나 앞 기록이 빠지면 다시 시도할 수 있습니다.
//    세는 쿼리는 student_id is null·type·key·내 id 이하·최근 10분으로 좁혀 셉니다.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "입력값을 확인해 주세요." }, 400);
  const { loginId, password } = parsed.data;
  const key = loginIdKey(loginId, await sessionSecret());

  const [{ id: attemptId }] = await sql<{ id: string }[]>`
    insert into event_log (student_id, type, payload)
    values (null, 'teacher_login_fail', ${sql.json({ key })})
    returning id`;
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from event_log
    where student_id is null and type = 'teacher_login_fail' and payload->>'key' = ${key}
      and id <= ${attemptId} and created_at > now() - make_interval(mins => ${WINDOW_MINUTES})`;
  if (n > LOGIN_FLOOD_CEILING) {
    await sql`delete from event_log where id = ${attemptId}`;
    return json({ error: "로그인 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." }, 429);
  }
  const wait = loginDelayMs(n);
  if (wait > 0) await sleep(wait);

  const [t] = await sql<{ id: string; password_hash: string }[]>`
    select id, password_hash from teachers where login_id = ${loginId}`;
  // 아이디가 없어도 같은 계산을 거쳐 응답 시간으로 아이디 존재 여부를 알 수 없게 합니다.
  const ok = await verifyPasswordOrDummy(password, t?.password_hash);
  if (!t || !ok) {
    await sleep(400 + randomInt(300));
    return json({ error: "아이디나 비밀번호가 맞지 않습니다." }, 401);
  }
  await sql`delete from event_log where id = ${attemptId}`;
  await sql`
    update event_log set type = 'teacher_login_fail_cleared'
    where student_id is null and type = 'teacher_login_fail' and payload->>'key' = ${key} and id < ${attemptId}
      and created_at > now() - make_interval(mins => ${WINDOW_MINUTES})`;
  await createSession({ role: "teacher", id: t.id, pf: await teacherPasswordTag(t.password_hash) });
  return json({ ok: true });
}
