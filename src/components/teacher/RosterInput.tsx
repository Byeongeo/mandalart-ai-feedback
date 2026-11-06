"use client";

import { useState } from "react";
import { parseRoster, rosterTemplateCsv, type RosterRow } from "@/lib/roster";

// 한국어 엑셀의 'CSV(쉼표로 분리)'는 CP949(EUC-KR)로 저장되므로, UTF-8로 읽다가 깨지면 EUC-KR로 다시 읽습니다.
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

// 양식 내려받기: 엑셀에서 바로 열리는 CSV(번호 1~35, 이름 칸은 비움)
function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([rosterTemplateCsv()], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "명렬표_양식.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 명렬표 입력: ① 양식을 내려받아 채운 뒤 올리거나, ② 아래 칸에 직접 쓰거나 엑셀에서 두 열을 복사해 붙여 넣습니다.
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
        <b>① 양식 내려받기</b> → 엑셀에서 이름 칸을 채우고 저장 → <b>② 작성한 명렬표 올리기</b>.
        또는 아래 칸에 <b>&lsquo;1 홍길동&rsquo;</b>처럼 한 줄에 한 명씩 직접 써도 됩니다(엑셀에서 번호·이름 두 열을 복사해 붙여 넣어도 돼요).
      </p>
      {/* 브라우저 기본 파일 버튼은 영어('Choose File')로 나올 수 있어 한국어 버튼으로 감쌉니다. */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" onClick={downloadTemplate}
          className="rounded-lg border border-emerald-700 bg-emerald-50 px-3 py-1.5 font-medium text-emerald-900 hover:bg-emerald-100">
          ① 명렬표 양식 내려받기
        </button>
      <label className="flex flex-wrap items-center gap-2">
        <span className="cursor-pointer rounded-lg border border-stone-300 bg-white px-3 py-1.5 font-medium hover:bg-stone-50 has-[:focus-visible]:ring-2">
          ② 작성한 명렬표 올리기
          <input type="file" accept=".csv,.txt,text/csv" className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setFileName(f?.name ?? null);
              if (f) update(await readText(f));
            }} />
        </span>
        <span className="text-stone-500">{fileName ?? "고른 파일 없음"}</span>
      </label>
      </div>
      <p className="text-[11px] text-stone-500">
        엑셀에서 저장할 때는 파일 형식을 <b>CSV</b>로 그대로 두세요(&lsquo;CSV UTF-8&rsquo;이든 그냥 &lsquo;CSV&rsquo;든 괜찮아요). 양식에서 이름을 채우지 않은 끝 번호는 빼고 읽어요.
      </p>
      <textarea value={text} onChange={(e) => update(e.target.value)} rows={6} aria-label="명렬표"
        placeholder={"1 김민준\n2 이서연\n3 박지호"}
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
