"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RosterRow } from "@/lib/roster";
import RosterInput from "./RosterInput";
import { DEFAULT_SCHOOL_LEVEL, SCHOOL_LEVELS, SCHOOL_LEVEL_KEYS, type SchoolLevel } from "@/lib/school-level";

// 학급 만들기: 이름 + 학교급(기본 중학교) + 명렬표 + 학생 PIN 사용(기본 켬). 학급 코드와 학생마다 4자리 PIN은 자동으로 만들어집니다(PIN을 꺼도 만들어 둠).
export default function CreateClassForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [pending, setPending] = useState(false);
  const [requirePin, setRequirePin] = useState(true);
  const [schoolLevel, setSchoolLevel] = useState<SchoolLevel>(DEFAULT_SCHOOL_LEVEL);
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-stone-300 bg-white p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending) return;
        if (!roster) return setError("명렬표를 먼저 넣어 주세요.");
        setPending(true);
        setError(null);
        const f = new FormData(e.currentTarget);
        let moving = false;
        try {
          const res = await fetch("/api/teacher/classes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: f.get("name"), roster, requirePin, schoolLevel }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.id) {
            moving = true;
            router.push(`/teacher/class/${data.id}`);
          } else {
            setError(res.status === 401 ? "로그인이 끝났습니다. 다시 로그인하세요." : data.error ?? "만들지 못했습니다.");
          }
        } catch {
          setError("서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.");
        } finally {
          if (!moving) setPending(false);
        }
      }}
    >
      <label className="flex flex-col text-xs font-medium">
        학급 이름
        <input name="name" required maxLength={40} placeholder="예: 2학년 3반" className="mt-1 max-w-xs rounded border border-stone-300 bg-white px-2 py-1.5 text-sm" />
      </label>
      <div className="flex flex-col gap-0.5">
        <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
          학교급
          <select value={schoolLevel} onChange={(e) => setSchoolLevel(e.target.value as SchoolLevel)} aria-describedby="create-level-hint"
            className="rounded border border-stone-300 bg-white px-2 py-1 font-normal">
            {SCHOOL_LEVEL_KEYS.map((k) => <option key={k} value={k}>{SCHOOL_LEVELS[k]}</option>)}
          </select>
        </label>
        <p id="create-level-hint" className="text-xs text-stone-500">AI 피드백의 진단 기준과 카드 질문 수준이 학교급에 맞춰집니다. 학급 화면에서 언제든 바꿀 수 있습니다.</p>
      </div>
      <RosterInput onChange={setRoster} />
      <div className="flex flex-col gap-0.5">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={requirePin} onChange={(e) => setRequirePin(e.target.checked)} aria-describedby="create-pin-hint" />
          학생 PIN 사용
        </label>
        <p id="create-pin-hint" className={`text-xs ${requirePin ? "text-stone-500" : "font-medium text-amber-900"}`}>
          PIN을 끄면 같은 반 친구가 다른 학생으로 들어갈 수 있습니다. 시범 수업처럼 짧게 쓸 때만 끄세요.
        </p>
      </div>
      <p className="text-xs text-stone-500">만들면 학급 코드(6자리)와 학생마다 4자리 PIN이 자동으로 생깁니다. 학급 화면에서 안내 카드를 인쇄해 나눠 주세요.</p>
      <button disabled={!roster || pending} className="self-start rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
        {pending ? "만드는 중…" : "학급 만들기"}
      </button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
