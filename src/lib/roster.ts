import * as z from "zod";

// 명렬표 한 줄: 번호 + 이름
export const RosterRow = z.object({
  number: z.number().int().min(1).max(99),
  name: z.string().trim().min(1).max(20),
});
export type RosterRow = z.infer<typeof RosterRow>;

export const ROSTER_MAX = 45;

export const Roster = z
  .array(RosterRow)
  .min(1, { message: "명렬표에 학생이 한 명 이상 있어야 합니다." })
  .max(ROSTER_MAX, { message: `한 학급에는 ${ROSTER_MAX}명까지 넣을 수 있습니다.` })
  .refine((rows) => new Set(rows.map((r) => r.number)).size === rows.length, { message: "번호가 중복되었습니다." });

// 이름 비교용: 공백 제거
export function normName(s: string): string {
  return s.replace(/\s+/g, "");
}

// 한 줄을 [번호, 이름]으로 나눕니다.
// - 탭(엑셀에서 복사)이나 쉼표(CSV)가 있으면 그것으로 나눕니다(그 뒤의 열은 무시).
// - 없으면 직접 쓴 줄로 봅니다: '1 홍길동', '1번 홍길동', '1. 홍길동', '1) 홍길동'(번호 뒤의 이름 전체가 이름).
function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  if (line.includes(",")) return line.split(",");
  const m = /^(\d+)\s*(?:번|\.|\))?\s*(.*)$/.exec(line);
  return m ? [m[1], m[2]] : [line];
}

// 명렬표를 읽습니다: 엑셀에서 복사한 표(탭), CSV(쉼표), 직접 쓴 줄('1 홍길동') 모두 됩니다.
// - 첫 줄이 숫자로 시작하지 않으면 머리글(번호, 이름)로 보고 건너뜁니다. 숫자로 시작하는 첫 줄은 학생으로 읽습니다
//   (예전에는 '1 홍길동'처럼 띄어 쓴 첫 줄을 머리글로 보고 말없이 빼 버렸습니다).
// - 양식(명렬표_양식.csv)에 미리 적어 둔 번호 중 이름을 채우지 않은 끝부분 줄은 건너뜁니다.
//   중간에 이름이 빈 줄은 오류로 알려 줍니다(학생이 빠지지 않게).
export function parseRoster(text: string): { rows: RosterRow[]; errors: string[] } {
  const rows: RosterRow[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cellsOf = lines.map((line) => splitLine(line).map((c) => c.trim().replace(/^"|"$/g, "").trim()));
  // 이름이 있는 마지막 줄(그 뒤의 '번호만 있는 줄'은 양식에서 남은 칸으로 보고 건너뜀)
  let lastNamed = -1;
  cellsOf.forEach((cells, i) => {
    if (cells[1]) lastNamed = i;
  });
  cellsOf.forEach((cells, i) => {
    const num = Number(cells[0]);
    if (!cells[0] || !/^\d+$/.test(cells[0]) || !Number.isInteger(num)) {
      if (i === 0 && !/^\d/.test(cells[0] ?? "")) return; // 첫 줄은 머리글로 보고 건너뜀
      errors.push(`${i + 1}번째 줄: 번호를 읽지 못했습니다 (${lines[i]}). '1 홍길동'처럼 번호를 먼저 쓰세요.`);
      return;
    }
    const name = cells[1] ?? "";
    if (!name) {
      if (i > lastNamed) return; // 양식의 남은 칸
      return void errors.push(`${i + 1}번째 줄: 이름이 비어 있습니다 (${num}번)`);
    }
    rows.push({ number: num, name });
  });
  const parsed = Roster.safeParse(rows);
  if (!parsed.success && rows.length) errors.push(parsed.error.issues[0].message);
  if (lines.length && !rows.length && !errors.length) {
    errors.push("아직 읽은 학생이 없습니다. '1 홍길동'처럼 한 줄에 한 명씩 번호와 이름을 쓰거나, 양식에 이름을 채워 올리세요.");
  }
  return { rows, errors };
}

/** 내려받는 명렬표 양식(엑셀에서 열리는 CSV, UTF-8 BOM): 머리글 + 번호 1~n(이름 칸은 비움) */
export function rosterTemplateCsv(n = 35): string {
  const lines = ["번호,이름"];
  for (let i = 1; i <= n; i++) lines.push(`${i},`);
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export type Rename = { number: number; from: string; to: string };

// 이름이 바뀌는 번호(공백을 뺀 이름이 다른 번호). 화면(rosterDiff)과 서버(명렬표 PUT)가 같은 규칙을 씁니다.
export function rosterRenames(rows: RosterRow[], current: { number: number; name: string | null }[]): Rename[] {
  const byNumber = new Map(current.map((s) => [s.number, s]));
  const renames: Rename[] = [];
  for (const r of rows) {
    const s = byNumber.get(r.number);
    if (s && normName(s.name ?? "") !== normName(r.name)) renames.push({ number: r.number, from: s.name ?? "", to: r.name });
  }
  return renames;
}

// 서버가 돌려준 409 본문의 renames를 안전하게 읽습니다(모양이 맞지 않는 항목은 버림).
export function readRenames(v: unknown): Rename[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Rename =>
    !!x && typeof x === "object" && typeof (x as Rename).number === "number" &&
    typeof (x as Rename).from === "string" && typeof (x as Rename).to === "string");
}

// 명렬표 다시 올리기 전에 지금 학생 명단과 비교합니다(서버도 번호로 맞춥니다).
// classHasWork: 만다라트를 쓰기 시작한 학생이 있는 학급. 이때 이름이 바뀌는 번호는 따로 확인을 받아야 합니다
//   (글·피드백은 번호에 남으므로, 번호가 밀린 명렬표면 한 학생의 글이 다른 학생에게 넘어갑니다).
//   서버(명렬표 PUT)도 같은 조건에서 confirmRenames: true가 없으면 409 {renames, missing}으로 되돌려 보냅니다.
export function rosterDiff(rows: RosterRow[], current: { number: number; name: string | null }[], opts: { classHasWork?: boolean } = {}) {
  const existing = new Set(current.map((s) => s.number));
  const uploaded = new Set(rows.map((r) => r.number));
  const added = rows.map((r) => r.number).filter((n) => !existing.has(n));
  const renames = rosterRenames(rows, current);
  const renamed = renames.map((r) => r.number);
  // 학급에는 있는데 올린 명렬표에는 없는 번호(지우지 않고 그대로 둡니다)
  const missing = current.map((s) => s.number).filter((n) => !uploaded.has(n)).sort((a, b) => a - b);
  const renameNeedsConfirm = !!opts.classHasWork && renamed.length > 0;
  return { added, renamed, renames, missing, renameNeedsConfirm };
}

// 이미 글을 쓴 학급에서 이름이 바뀌는 번호가 있을 때 따로 받는 확인 문구
export function renameWarning(renames: Rename[], missing: number[]): string {
  const list = renames.slice(0, 10).map((r) => `${r.number}번: ${r.from || "(이름 없음)"} → ${r.to}`).join("\n");
  const more = renames.length > 10 ? `\n… 외 ${renames.length - 10}명` : "";
  const shift = missing.length
    ? `\n\n명렬표에 없는 번호(${missing.join(", ")})도 있습니다. 전출 등으로 번호가 앞당겨진 명렬표라면 반영하지 말고, 바뀐 학생만 '이름 고치기'로 고치세요.`
    : "";
  return (
    `⚠ 이름이 바뀌는 번호가 있습니다.\n${list}${more}\n\n` +
    "이 앱은 학생을 번호로 구분합니다. 이미 쓴 만다라트와 받은 피드백은 이름이 아니라 번호에 그대로 남습니다. " +
    "번호가 밀린 명렬표를 올리면 한 학생의 글이 다른 학생에게 넘어갑니다." +
    shift +
    "\n\n같은 학생의 이름을 바로잡는 것이 맞을 때만 '확인'을 누르세요."
  );
}
