import * as z from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { checkDb, dbFailure, sql } from "@/lib/db";
import { hashPassword, loginIdKey } from "@/lib/password";
import { createSession, sessionSecret, teacherPasswordTag } from "@/lib/session";
import { json } from "@/lib/auth";

// 첫 교사 계정 만들기와 교사 비밀번호 다시 정하기. 둘 다 환경 변수 SETUP_TOKEN(16자 이상)을 알아야 합니다.
// - 만들기(mode 없음 또는 'create'): 교사 계정이 하나도 없을 때만. { token, loginId, displayName, password }
// - 다시 정하기(mode 'reset'): 교사 계정이 있을 때. { token, mode: 'reset', loginId, password }
//   비밀번호를 바꾸고(그 전 로그인 세션은 끝남), 그 아이디의 로그인 늦추기 기록을 지우고, 'teacher_password_reset'을 남깁니다(비밀값 없음).
// DB 표가 아직 없으면 여기서 먼저 만듭니다(checkDb → ensureSchema).
// 오류: { error, code } code = bad_input | no_token | wrong_token | too_many | db | exists | no_teacher | unknown_login
const Create = z.object({
  mode: z.literal("create").optional(),
  token: z.string().min(1).max(200),
  loginId: z.string().trim().min(3).max(50),
  displayName: z.string().trim().min(1).max(30),
  password: z.string().min(10).max(200),
});
const Reset = z.object({
  mode: z.literal("reset"),
  token: z.string().min(1).max(200),
  loginId: z.string().trim().min(1).max(50),
  password: z.string().min(10).max(200),
});

const TOKEN_MIN = 16;

function tokenConfigured(): boolean {
  return (process.env.SETUP_TOKEN?.trim().length ?? 0) >= TOKEN_MIN;
}

// 설정 코드 맞히기 막기: 틀린 시도를 event_log('setup_token_fail', student_id 없음, 내용 없음)에 남기고,
// 최근 15분 안에 10번을 넘으면 확인하지 않고 429를 돌려줍니다(계정을 만든 뒤에도 '비밀번호 다시 정하기'에 쓰이기 때문).
const TOKEN_WINDOW_MINUTES = 15;
const TOKEN_MAX_FAILS = 10;

async function tokenCheck(given: string): Promise<Response | null> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from event_log
    where student_id is null and type = 'setup_token_fail' and created_at > now() - make_interval(mins => ${TOKEN_WINDOW_MINUTES})`;
  if (n >= TOKEN_MAX_FAILS) {
    return json({ error: "설정 코드를 너무 많이 틀렸습니다. 15분 뒤에 다시 시도하세요.", code: "too_many" }, 429);
  }
  if (tokenOk(given)) return null;
  await sql`insert into event_log (student_id, type, payload) values (null, 'setup_token_fail', '{}'::jsonb)`;
  return json({ error: "설정 코드가 맞지 않습니다.", code: "wrong_token" }, 403);
}

// 길이가 달라도 같은 시간이 걸리도록 해시끼리 비교합니다.
function tokenOk(given: string): boolean {
  const expected = process.env.SETUP_TOKEN?.trim();
  if (!expected || expected.length < TOKEN_MIN) return false;
  const a = createHash("sha256").update(given.trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// 설정 화면이 처음 열릴 때: DB 연결, 설정 코드 준비, 교사 계정 유무를 알려 줍니다(비밀값은 돌려주지 않음).
// canReset: 교사 계정이 있고 설정 코드가 준비되어 '비밀번호 다시 정하기'를 할 수 있음
// DB 연결이 확인 직후에 끊겨도(쿼리 오류) 500 대신 같은 DB 오류 안내를 돌려줍니다.
export async function GET() {
  const failed = (db: { ok: false; error: string }) => json({ db, tokenConfigured: tokenConfigured(), needsSetup: null, canReset: false });
  const db = await checkDb();
  if (!db.ok) return failed(db);
  let n: number;
  try {
    [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from teachers`;
  } catch (e) {
    return failed(dbFailure(e));
  }
  return json({ db, tokenConfigured: tokenConfigured(), needsSetup: n === 0, canReset: n > 0 && tokenConfigured() });
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const isReset = (raw as { mode?: unknown } | null)?.mode === "reset";
  if (!tokenConfigured()) {
    return json({ error: "SETUP_TOKEN이 설정되지 않았거나 16자보다 짧습니다. Vercel 환경 변수에 넣고 다시 배포(Redeploy)하세요.", code: "no_token" }, 403);
  }
  if (isReset) return reset(raw);

  const parsed = Create.safeParse(raw);
  if (!parsed.success) return json({ error: "입력값을 확인하세요. 아이디는 3자 이상, 비밀번호는 10자 이상입니다.", code: "bad_input" }, 400);
  const db = await checkDb();
  if (!db.ok) return json({ error: db.error, code: "db" }, 503);
  const denied = await tokenCheck(parsed.data.token);
  if (denied) return denied;

  const hash = await hashPassword(parsed.data.password);
  const id = await sql.begin(async (tx) => {
    // 두 사람이 동시에 만들어도 한 계정만 생기도록 잠급니다.
    await tx`select pg_advisory_xact_lock(hashtext('mandalart-train:setup'))`;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from teachers`;
    if (n > 0) return null;
    const [t] = await tx<{ id: string }[]>`
      insert into teachers (login_id, display_name, password_hash)
      values (${parsed.data.loginId}, ${parsed.data.displayName}, ${hash})
      returning id`;
    return t.id;
  });
  if (!id) return json({ error: "이미 교사 계정이 있습니다. 교사 로그인을 이용하세요. 비밀번호를 잊었다면 '비밀번호 다시 정하기'를 쓰세요.", code: "exists" }, 409);
  await createSession({ role: "teacher", id, pf: await teacherPasswordTag(hash) });
  return json({ ok: true });
}

async function reset(raw: unknown) {
  const parsed = Reset.safeParse(raw);
  if (!parsed.success) return json({ error: "입력값을 확인하세요. 새 비밀번호는 10자 이상입니다.", code: "bad_input" }, 400);
  const db = await checkDb();
  if (!db.ok) return json({ error: db.error, code: "db" }, 503);
  const denied = await tokenCheck(parsed.data.token);
  if (denied) return denied;

  const { loginId, password } = parsed.data;
  const hash = await hashPassword(password);
  const result = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('mandalart-train:setup'))`;
    const teachers = await tx<{ id: string; login_id: string }[]>`select id, login_id from teachers order by created_at`;
    if (!teachers.length) return { kind: "no_teacher" as const };
    const t = teachers.find((x) => x.login_id === loginId);
    // 설정 코드를 아는 사람(= 앱 주인)에게만 이 응답이 가므로, 아이디를 잊은 경우를 위해 있는 아이디를 알려 줍니다.
    if (!t) return { kind: "unknown_login" as const, ids: teachers.map((x) => x.login_id) };
    await tx`update teachers set password_hash = ${hash} where id = ${t.id}`;
    await tx`insert into event_log (student_id, type, payload) values (null, 'teacher_password_reset', '{}'::jsonb)`;
    return { kind: "ok" as const, id: t.id };
  });
  if (result.kind === "no_teacher") {
    return json({ error: "아직 교사 계정이 없습니다. 먼저 교사 계정을 만드세요.", code: "no_teacher" }, 409);
  }
  if (result.kind === "unknown_login") {
    return json({ error: `그 아이디의 교사 계정이 없습니다. 이 앱의 교사 아이디: ${result.ids.join(", ")}`, code: "unknown_login" }, 404);
  }
  // 이 아이디의 로그인 늦추기 기록(최근 실패)을 지워, 새 비밀번호로 바로 로그인할 수 있게 합니다.
  const key = loginIdKey(loginId, await sessionSecret());
  await sql`delete from event_log
            where student_id is null and type in ('teacher_login_fail', 'teacher_login_fail_cleared') and payload->>'key' = ${key}`;
  await createSession({ role: "teacher", id: result.id, pf: await teacherPasswordTag(hash) });
  return json({ ok: true, reset: true });
}
