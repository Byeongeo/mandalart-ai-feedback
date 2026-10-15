import "server-only";
import postgres from "postgres";
import { DB_URL_MISSING, normalizeDbUrl, pickDbUrl } from "./dbconfig";
import { SCHEMA_SQL } from "./schema-sql";
import { MIGRATIONS_TABLE_SQL, allMigrations, changedMigrations, migrationHash, migrationProblems, pendingMigrations } from "./migrations";

// Neon(Vercel Marketplace 연동)이 넣어 주는 DATABASE_URL(연결 풀 = PgBouncer transaction mode)로 접속합니다.
// - PgBouncer transaction mode는 prepared statement를 지원하지 않으므로 prepare: false.
// - 내 컴퓨터가 아닌 DB는 sslmode=verify-full로 바꿔 서버 인증서까지 확인합니다(dbconfig.ts의 normalizeDbUrl 참고).
// - 서버리스 함수 하나가 여는 연결은 적게(최대 3개), 놀고 있는 연결은 20초 뒤 닫습니다.
// - Neon은 한동안 쓰지 않으면 잠들었다가 첫 접속 때 저절로 깨어납니다(몇 초 걸릴 수 있음).
//
// 처음 쿼리 전에 아직 적용하지 않은 마이그레이션(기본 스키마 포함)을 자동으로 실행합니다(ensureSchema).
// 함수 인스턴스마다 한 번만 확인하고, 그다음부터는 메모리의 표시만 봅니다.

export class DbConfigError extends Error {}

type State = { raw?: postgres.Sql; ready?: boolean; pending?: Promise<void> | null };
const g = globalThis as unknown as { __mandalartDb?: State };
const state: State = (g.__mandalartDb ??= {});

function client(): postgres.Sql {
  if (state.raw) return state.raw;
  const url = pickDbUrl(process.env);
  if (!url) {
    console.error(DB_URL_MISSING);
    throw new DbConfigError(DB_URL_MISSING);
  }
  state.raw = postgres(normalizeDbUrl(url), {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    max_lifetime: 60 * 10,
    connect_timeout: 20,
    // 'already exists, skipping' 같은 안내(NOTICE)는 로그에 남기지 않습니다.
    onnotice: () => {},
  });
  return state.raw;
}

// 마이그레이션(src/lib/migrations.ts): 기본 스키마(0001_base = db/schema.sql) + 이후 버전의 변경을 순서대로 한 번씩 적용합니다.
const MIGRATIONS = allMigrations(SCHEMA_SQL);
{
  const problems = migrationProblems(MIGRATIONS);
  if (problems.length) throw new Error(`[스키마] 마이그레이션 목록 오류: ${problems.join(", ")}`);
}

async function appliedMigrations(db: postgres.Sql | postgres.TransactionSql): Promise<{ id: string; hash: string }[] | null> {
  const [{ exists }] = await db<{ exists: boolean }[]>`select to_regclass('schema_migrations') is not null as exists`;
  if (!exists) return null;
  return db<{ id: string; hash: string }[]>`select id, hash from schema_migrations order by id`;
}

async function migrate(): Promise<void> {
  const db = client();
  // 빠른 길: 모두 적용되어 있으면 잠금 없이 끝냅니다(인스턴스마다 처음 한 번).
  const before = await appliedMigrations(db);
  if (before && pendingMigrations(MIGRATIONS, before.map((a) => a.id)).length === 0) {
    warnChanged(before);
    return;
  }
  // 여러 함수 인스턴스가 동시에 처음 뜨더라도 한 곳만 실행하도록 트랜잭션 잠금을 겁니다.
  // 잠금을 기다린 쪽은 기록을 다시 보고, 이미 끝났으면 그냥 지나갑니다.
  await db.begin(async (tx) => {
    await tx`set local statement_timeout = '60s'`;
    await tx`select pg_advisory_xact_lock(hashtext('mandalart-train:schema'))`;
    // 표 잠금은 5초까지만 기다립니다(수업 중 다른 요청을 오래 막지 않도록). 넘으면 실패하고 다음 요청에서 다시 시도합니다.
    await tx`set local lock_timeout = '5s'`;
    await tx.unsafe(MIGRATIONS_TABLE_SQL);
    const applied = (await appliedMigrations(tx)) ?? [];
    for (const m of pendingMigrations(MIGRATIONS, applied.map((a) => a.id))) {
      await tx.unsafe(m.sql); // 인자가 없으면 simple query라 여러 문장을 한 번에 보냅니다.
      await tx`insert into schema_migrations (id, hash) values (${m.id}, ${migrationHash(m)})`;
    }
  });
}

let warnedChanged = false;
function warnChanged(applied: { id: string; hash: string }[]) {
  const changed = changedMigrations(MIGRATIONS, applied);
  if (changed.length && !warnedChanged) {
    warnedChanged = true;
    console.warn(`[스키마] 이미 적용한 마이그레이션의 SQL이 바뀌었습니다(다시 실행하지 않음): ${changed.join(", ")}. 새 마이그레이션으로 추가하세요.`);
  }
}

/** 표가 준비됐는지 확인하고, 없으면 만듭니다. 인스턴스마다 처음 한 번만 DB에 묻습니다. */
export function ensureSchema(): Promise<void> {
  if (state.ready) return Promise.resolve();
  state.pending ??= migrate().then(
    () => {
      state.ready = true;
    },
    (e) => {
      state.pending = null; // 실패하면 다음 요청에서 다시 시도
      throw e;
    },
  );
  return state.pending;
}

function isTemplate(a: unknown): a is TemplateStringsArray {
  return Array.isArray(a) && Object.prototype.hasOwnProperty.call(a, "raw");
}

// 쿼리를 보내는 메서드: 스키마가 준비되기 전이면 ensureSchema()를 먼저 기다립니다.
const QUERYING = new Set<PropertyKey>(["begin", "unsafe", "reserve", "file"]);

/**
 * postgres.js의 sql과 똑같이 씁니다(sql`...`, sql.begin, sql.json …).
 * 인스턴스의 첫 쿼리는 자동으로 ensureSchema()를 먼저 기다립니다.
 * 주의: 스키마 준비 전에는 sql`...`이 일반 Promise를 돌려주므로, 다른 쿼리 안에 조각(fragment)으로 끼워 넣지 마세요.
 */
export const sql: postgres.Sql = new Proxy(function () {} as unknown as postgres.Sql, {
  apply(_target, _this, args: unknown[]) {
    const db = client() as unknown as (...a: unknown[]) => unknown;
    if (state.ready || !isTemplate(args[0])) return db(...args);
    return ensureSchema().then(() => db(...args));
  },
  get(_target, prop) {
    const db = client();
    const v: unknown = Reflect.get(db, prop);
    if (typeof v !== "function") return v;
    const fn = v as (...a: unknown[]) => unknown;
    if (!state.ready && QUERYING.has(prop)) return (...a: unknown[]) => ensureSchema().then(() => fn.apply(db, a));
    return fn.bind(db);
  },
});

export const DB_UNREACHABLE =
  "데이터베이스에 연결하지 못했습니다. 잠시 뒤 다시 시도하고, 계속 안 되면 Vercel의 Storage(Neon) 연결을 확인하세요.";

/** DB 오류를 설정 화면용 결과로 바꿉니다(오류 문구는 교사용 한국어, 자세한 내용은 서버 로그에만). */
export function dbFailure(e: unknown): { ok: false; error: string } {
  if (e instanceof DbConfigError) return { ok: false, error: e.message };
  console.error("[DB] 연결 또는 표 만들기 실패:", e instanceof Error ? e.message : e);
  return { ok: false, error: DB_UNREACHABLE };
}

/**
 * 설정 화면 등에서 DB 연결 상태를 알려 줄 때 씁니다(오류 문구는 교사용 한국어).
 * 표 준비는 인스턴스마다 한 번만 확인하므로(ensureSchema), 그 뒤에 DB가 멈춘 경우도 알 수 있도록 매번 실제로 한 번 묻습니다.
 */
export async function checkDb(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await ensureSchema();
    await sql`select 1`;
    return { ok: true };
  } catch (e) {
    return dbFailure(e);
  }
}
