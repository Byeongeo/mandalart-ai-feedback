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

// 엑셀에서 복사한 표(탭) 또는 CSV(쉼표)를 읽습니다. 첫 줄이 머리글이면 건너뜁니다.
// 열 순서: 번호, 이름 (그 뒤의 열은 무시)
export function parseRoster(text: string): { rows: RosterRow[]; errors: string[] } {
  const rows: RosterRow[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cells = (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) => c.trim().replace(/^"|"$/g, ""));
    const num = Number(cells[0]);
    if (!cells[0] || !Number.isInteger(num)) {
      if (i > 0) errors.push(`${i + 1}번째 줄: 번호가 숫자가 아닙니다 (${cells[0] ?? ""})`);
      return; // 첫 줄은 머리글로 보고 건너뜀
    }
    const name = cells[1] ?? "";
    if (!name) return void errors.push(`${i + 1}번째 줄: 이름이 비어 있습니다`);
    rows.push({ number: num, name });
  });
  const parsed = Roster.safeParse(rows);
  if (!parsed.success && rows.length) errors.push(parsed.error.issues[0].message);
  return { rows, errors };
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
