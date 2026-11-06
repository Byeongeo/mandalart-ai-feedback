"use client";

import { useState } from "react";
import { parseRoster, type RosterRow } from "@/lib/roster";

// 한국어 엑셀의 'CSV(쉼표로 분리)'는 CP949(EUC-KR)로 저장되므로, UTF-8로 읽다가 깨지면 EUC-KR로 다시 읽습니다.
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

// 명렬표 입력: 엑셀에서 번호·이름 두 열을 복사해 붙여 넣거나 CSV 파일을 고릅니다.
export default function RosterInput({ onChange }: { onChange: (rows: RosterRow[] | null) => void }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);

  function update(t: string) {
    setText(t);
    const r = parseRoster(t);
    setRows(r.rows);
    setErrors(r.errors);
    onChange(r.rows.length && !r.errors.length ? r.rows : null);
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-stone-600">
        엑셀에서 <b>번호 · 이름</b> 두 열을 복사해 아래 칸에 붙여 넣거나, CSV 파일을 고르세요. 첫 줄이 머리글(번호, 이름)이어도 괜찮습니다.
      </p>
      {/* 브라우저 기본 파일 버튼은 영어('Choose File')로 나올 수 있어 한국어 버튼으로 감쌉니다. */}
      <label className="flex flex-wrap items-center gap-2 text-xs">
        <span className="cursor-pointer rounded-lg border border-stone-300 bg-white px-3 py-1.5 font-medium hover:bg-stone-50 has-[:focus-visible]:ring-2">
          CSV 파일 고르기
          <input type="file" accept=".csv,.txt,text/csv" className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setFileName(f?.name ?? null);
              if (f) update(await readText(f));
            }} />
        </span>
        <span className="text-stone-500">{fileName ?? "고른 파일 없음"}</span>
      </label>
      <textarea value={text} onChange={(e) => update(e.target.value)} rows={6} aria-label="명렬표"
        placeholder={"번호\t이름\n1\t김민준\n2\t이서연\n3\t박지호"}
        className="rounded border border-stone-300 bg-white p-2 font-mono text-xs" />
      {errors.length > 0 && (
        <ul className="text-xs text-red-700">{errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      {rows.length > 0 && (
        <p className="text-xs text-stone-700">
          읽은 학생 <b>{rows.length}</b>명
          <span className="text-stone-500"> (예: {rows.slice(0, 3).map((r) => `${r.number}번 ${r.name}`).join(", ")})</span>
        </p>
      )}
    </div>
  );
}
