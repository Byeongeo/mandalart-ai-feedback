// 테스트용 D1 흉내: Node 내장 SQLite(node:sqlite)로 메모리 DB를 만들고 D1과 같은 모양(prepare/bind/all, batch)으로 씁니다.
// - D1처럼 외래 키 검사를 켭니다(on delete cascade가 실제로 동작).
// - batch는 BEGIN … COMMIT으로 감싸 D1 batch처럼 모두 되거나 하나도 안 됩니다(실패하면 ROLLBACK 뒤 오류).
// - 문장마다 실행 전에 한 번 양보(setImmediate)해서, 동시에 보낸 요청들의 문장이 서로 끼어들 수 있게 합니다.
//   (D1처럼 문장 하나는 통째로 실행되고, 문장 사이에는 다른 요청의 문장이 들어올 수 있음 → 트랜잭션 없는 코드의 경쟁을 시험)
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
type Result = { results: Row[]; meta: { changes: number; last_row_id: number } };

const tick = () => new Promise<void>((r) => setImmediate(r));

export class D1Sqlite {
  readonly db: DatabaseSync;
  /** 실행한 문장 수(문장마다 1) */
  statements = 0;

  private gate: { re: RegExp; need: number; waiting: (() => void)[] } | null = null;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /**
   * 경쟁 상황을 꼭 만들어 내기: 글이 re에 맞는 문장은 need개가 모일 때까지 실행하지 않고 기다렸다가 함께 풀려납니다.
   * 예) 두 요청이 모두 '읽기'를 마친 뒤에야 '쓰기'를 하게 해, 읽기와 쓰기 사이에 다른 요청이 끼어드는 경우를 확실히 시험합니다.
   */
  holdUntil(re: RegExp, need: number) {
    this.gate = { re, need, waiting: [] };
  }

  private async passGate(sqlText: string) {
    const g = this.gate;
    if (!g || !g.re.test(sqlText)) return;
    await new Promise<void>((resolve) => {
      g.waiting.push(resolve);
      if (g.waiting.length >= g.need) {
        this.gate = null;
        for (const w of g.waiting) w();
      }
    });
  }

  runNow(sqlText: string, params: unknown[]): Result {
    this.statements++;
    const before = Number((this.db.prepare("select total_changes() as c").get() as { c: number }).c);
    const st = this.db.prepare(sqlText);
    const rows = st.all(...(params as (string | number | null)[])) as Row[];
    const after = Number((this.db.prepare("select total_changes() as c").get() as { c: number }).c);
    const last = Number((this.db.prepare("select last_insert_rowid() as id").get() as { id: number }).id);
    return { results: rows.map((r) => ({ ...r })), meta: { changes: after - before, last_row_id: last } };
  }

  prepare(sqlText: string) {
    const self = this;
    const make = (params: unknown[]) => ({
      sqlText,
      params,
      bind: (...values: unknown[]) => make(values),
      all: async () => {
        await self.passGate(sqlText);
        await tick();
        return self.runNow(sqlText, params);
      },
    });
    return make([]);
  }

  async batch(stmts: { sqlText?: string; params?: unknown[] }[]): Promise<Result[]> {
    await tick();
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => this.runNow(s.sqlText!, s.params ?? []));
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 테스트에서 바로 읽기(양보 없음) */
  get<T = Row>(sqlText: string, ...params: unknown[]): T | undefined {
    const r = this.db.prepare(sqlText).get(...(params as (string | number | null)[]));
    return r ? ({ ...r } as T) : undefined;
  }
  all<T = Row>(sqlText: string, ...params: unknown[]): T[] {
    return (this.db.prepare(sqlText).all(...(params as (string | number | null)[])) as Row[]).map((r) => ({ ...r }) as T);
  }
  run(sqlText: string, ...params: unknown[]): void {
    this.db.prepare(sqlText).run(...(params as (string | number | null)[]));
  }
}
