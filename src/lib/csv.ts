export type Cell = string | number | boolean | null | undefined;

// 엑셀에서 한글이 깨지지 않도록 파일 맨 앞에 붙이는 BOM
export const BOM = "﻿";

// 칸 하나. 학생 글이 = + - @ (또는 탭·CR)로 시작하면 엑셀이 수식으로 읽어 #NAME?이 되거나
// 수식이 실행될 수 있어, 글자 칸에만 작은따옴표를 앞에 붙입니다. 숫자 칸은 그대로 둡니다.
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  const formula = typeof v === "string" && /^[=+\-@\t\r]/.test(s);
  if (formula) s = "'" + s;
  return formula || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(row: Cell[]): string {
  return row.map(csvCell).join(",");
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return BOM + [header, ...rows].map(csvLine).join("\r\n");
}

// 한국 시간(KST, UTC+9, 서머타임 없음) 'YYYY-MM-DD HH:MM:SS'
export function kst(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}
