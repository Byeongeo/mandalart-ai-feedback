import "server-only";
import { rc, type D1Like, type D1StatementLike } from "./request-context";
import { SCHEMA_SQL } from "./schema-sql";
import { MIGRATIONS_TABLE_SQL, allMigrations, changedMigrations, meaningfulSql, migrationHash, migrationProblems, pendingMigrations } from "./migrations";

// Cloudflare D1(SQLite)용 sql 태그. 원래 앱(postgres.js)의 sql`...` 모양을 최대한 그대로 쓸 수 있게 흉내 냅니다.
//
//   const rows = await sql<{ id: string }[]>`select id from teachers where login_id = ${id}`;
//   rows.count  // 바뀐 행 수(update/insert/delete) 또는 읽은 행 수
//
// - ${값}은 모두 '?' 자리표시로 바뀌어 bind됩니다(SQL 조각 끼워 넣기는 지원하지 않음: sql`... ${sql`...`}` 금지).
// - 보낼 때: true/false → 1/0, Date → ISO 문자열, sql.json(x) → JSON 글, undefined → null.
// - 읽을 때(열 이름으로 판단): BOOL_COLS → boolean, JSON_COLS → 객체, DATE_COLS·'_at'으로 끝나는 열 → Date.
//   (Postgres판 코드가 Date·boolean·객체를 받던 것과 같게 하려는 것입니다.)
// - 트랜잭션: D1은 'begin … commit'을 쓸 수 없습니다. 여러 문장을 한꺼번에(원자적으로) 하려면 sql.batch([q1, q2, …])를 쓰세요.
//   batch 안의 쿼리는 미리 실행되지 않도록 await하지 않은 채로 넘깁니다(Query는 await할 때 실행됨).
// - 지금 시각은 SQL 안에서 ${NOW} 대신 NOW_SQL 글자를 직접 넣어 씁니다: sql`update … set updated_at = ${sql.now()}` 또는
//   문장 안에 strftime('%Y-%m-%dT%H:%M:%fZ','now')를 그대로 쓰세요(NOW_SQL 상수 참고).

/** SQLite에서 '지금'(ISO-8601 UTC, 밀리초까지). 이 모양의 문자열은 글자 비교 = 시각 비교입니다. */
export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// 읽을 때 boolean으로 바꿀 열(0/1로 저장)
const BOOL_COLS = new Set([
  "is_open", "require_pin", "concern", "rule_concern_current",
  // 쿼리에서 별칭으로 만든 참/거짓 값(필요하면 여기에 더하세요)
  "pending", "exists", "ok", "locked", "has_concern", "taken", "known",
]);
// 읽을 때 JSON.parse할 열(JSON 글로 저장)
const JSON_COLS = new Set(["content", "content_snapshot", "diagnosis", "target", "payload"]);
// 읽을 때 Date로 바꿀 열('_at'으로 끝나는 열은 자동, 그 밖의 시각 열은 여기)
const DATE_COLS = new Set(["locked_until", "feedback_pending_until"]);

export class JsonParam {
  constructor(public value: unknown) {}
}

export type Rows<T> = T & { count: number };

function toParam(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof JsonParam) return v.value === undefined ? null : JSON.stringify(v.value);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") throw new Error("[DB] 객체는 sql.json(값)으로 감싸서 넘기세요.");
  return v;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function convertRow(r: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (v === null || v === undefined) continue;
    if (BOOL_COLS.has(k) && typeof v === "number") r[k] = v !== 0;
    else if (JSON_COLS.has(k) && typeof v === "string") {
      try {
        r[k] = JSON.parse(v);
      } catch {
        /* 그대로 둠 */
      }
    } else if ((DATE_COLS.has(k) || k.endsWith("_at")) && typeof v === "string" && ISO_RE.test(v)) r[k] = new Date(v);
  }
  return r;
}

let dbOverride: D1Like | null = null;
/** 테스트에서 요청 문맥 없이 DB를 바꿔 끼울 때만 씁니다. */
export function setDbForTests(db: D1Like | null) {
  dbOverride = db;
}
function d1(): D1Like {
  return dbOverride ?? rc().env.DB;
}

export class Query<T = Record<string, unknown>[]> implements PromiseLike<Rows<T>> {
  constructor(public text: string, public params: unknown[]) {}
  statement(db: D1Like = d1()): D1StatementLike {
    const st = db.prepare(this.text);
    return this.params.length ? st.bind(...this.params) : st;
  }
  async execute(): Promise<Rows<T>> {
    await ensureSchema();
    return toRows<T>(await this.statement().all());
  }
  then<A = Rows<T>, B = never>(onOk?: ((v: Rows<T>) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.execute().then(onOk, onErr);
  }
  catch<B = never>(onErr: (e: unknown) => B | PromiseLike<B>): Promise<Rows<T> | B> {
    return this.execute().catch(onErr);
  }
}

function toRows<T>(res: { results?: Record<string, unknown>[]; meta?: { changes?: number } }): Rows<T> {
  const rows = (res.results ?? []).map(convertRow);
  Object.defineProperty(rows, "count", { value: Math.max(rows.length, res.meta?.changes ?? 0), enumerable: false });
  return rows as unknown as Rows<T>;
}

type SqlTag = {
  <T = Record<string, unknown>[]>(strings: TemplateStringsArray, ...values: unknown[]): Query<T>;
  json(v: unknown): JsonParam;
  /** 여러 쿼리를 한 트랜잭션으로(모두 되거나 모두 안 되거나). 각 쿼리의 결과 행 배열을 순서대로 돌려줍니다. */
  batch(queries: Query<unknown>[]): Promise<Rows<Record<string, unknown>[]>[]>;
  /** 'in (…)'에 넣을 목록: sql`… where id in (select value from json_each(${sql.list(ids)}))` */
  list(values: unknown[]): JsonParam;
};

function tag<T>(strings: TemplateStringsArray, ...values: unknown[]): Query<T> {
  let text = strings[0];
  for (let i = 1; i < strings.length; i++) {
    const v = values[i - 1];
    if (v instanceof Query) throw new Error("[DB] SQL 조각 끼워 넣기는 지원하지 않습니다.");
    text += "?" + strings[i];
  }
  return new Query<T>(text, values.map(toParam));
}

export const sql: SqlTag = Object.assign(tag, {
  json: (v: unknown) => new JsonParam(v),
  list: (values: unknown[]) => new JsonParam(values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v))),
  async batch(queries: Query<unknown>[]) {
    await ensureSchema();
    const db = d1();
    if (!queries.length) return [];
    const res = await db.batch(queries.map((q) => q.statement(db)));
    return res.map((r) => toRows<Record<string, unknown>[]>(r));
  },
}) as SqlTag;

// ── 마이그레이션 ──
const MIGRATIONS = allMigrations(SCHEMA_SQL);
{
  const problems = migrationProblems(MIGRATIONS);
  if (problems.length) throw new Error(`[스키마] 마이그레이션 목록 오류: ${problems.join(", ")}`);
}

/** SQL 글을 문장 단위로 나눕니다(주석 제거. 문자열 안에 ';'나 '--'를 쓰지 마세요). */
export function splitStatements(text: string): string[] {
  return meaningfulSql(text)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const g = globalThis as unknown as { __mandalartSchema?: { ready?: boolean; pending?: Promise<void> | null } };
const state = (g.__mandalartSchema ??= {});

async function raw(db: D1Like, text: string, ...params: unknown[]) {
  const st = db.prepare(text);
  return (await (params.length ? st.bind(...params) : st).all()).results ?? [];
}

async function migrate(): Promise<void> {
  const db = d1();
  for (const s of splitStatements(MIGRATIONS_TABLE_SQL)) await raw(db, s);
  const applied = (await raw(db, "select id, hash from schema_migrations order by id")) as { id: string; hash: string }[];
  const changed = changedMigrations(MIGRATIONS, applied);
  if (changed.length) console.warn(`[스키마] 이미 적용한 마이그레이션의 SQL이 바뀌었습니다(다시 실행하지 않음): ${changed.join(", ")}`);
  for (const m of pendingMigrations(MIGRATIONS, applied.map((a) => a.id))) {
    const stmts = splitStatements(m.sql).map((s) => db.prepare(s));
    stmts.push(db.prepare("insert or ignore into schema_migrations (id, hash) values (?, ?)").bind(m.id, migrationHash(m)));
    try {
      await db.batch(stmts);
    } catch (e) {
      // 다른 Worker가 같은 열을 먼저 더한 경우('duplicate column')만 적용된 것으로 기록하고 넘어갑니다.
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await raw(db, "insert or ignore into schema_migrations (id, hash) values (?, ?)", m.id, migrationHash(m));
    }
  }
}

/** 표가 준비됐는지 확인하고, 없으면 만듭니다. Worker(isolate)마다 처음 한 번만 DB에 묻습니다. */
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

export const DB_UNREACHABLE = "데이터베이스에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요. 계속 안 되면 설치 페이지에서 앱을 다시 설치(업데이트)해 보세요.";

/** DB 오류를 설정 화면용 결과로 바꿉니다(오류 문구는 교사용 한국어, 자세한 내용은 서버 로그에만). */
export function dbFailure(e: unknown): { ok: false; error: string } {
  console.error("[DB] 연결 또는 표 만들기 실패:", e instanceof Error ? e.message : e);
  return { ok: false, error: DB_UNREACHABLE };
}

export async function checkDb(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await ensureSchema();
    await sql`select 1 as one`;
    return { ok: true };
  } catch (e) {
    return dbFailure(e);
  }
}
