"use client";

import { useState } from "react";

const TYPES = [
  ["mandalart", "만다라트"],
  ["cards", "피드백 카드"],
] as const;

// 무엇이 들어 있는지(서버의 내보내기와 같게: 안전 신호와 PIN은 넣지 않음)
const TITLES: Record<(typeof TYPES)[number][0], string> = {
  mandalart: "학생마다 한 줄: 번호, 이름, 상태, 제출·저장 시각, 피드백 횟수, 카드 수, 해 볼게요·안 할래요 수, 그리고 중심 목표·세부 목표 8개·실천 64칸의 글. 학생 이름이 들어 있으니 학교 개인정보 기준에 맞게 보관하세요(PIN과 안전 신호는 없음).",
  cards: "피드백 카드마다 한 줄: 번호, 이름, 단계, 카드 위치·내용, 학생의 선택(해 볼게요/안 할래요와 이유), 시각. 학생 이름이 들어 있으니 학교 개인정보 기준에 맞게 보관하세요(PIN과 안전 신호는 없음).",
};

// Content-Disposition에서 파일 이름을 읽습니다(한글 이름은 filename*=UTF-8''… 쪽에 있음).
function fileNameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch {
      // 아래로
    }
  }
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
}

// 학급 CSV 내려받기. 주소로 바로 이동하면 로그인이 끝났을 때 영어 오류 화면이 뜨므로,
// 파일을 받아 본 뒤 성공하면 저장하고, 실패하면 한국어 안내를 보여 줍니다.
export default function ExportButtons({ classId, compact = false }: { classId: string; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function download(type: string, label: string) {
    setMsg(null);
    setBusy(type);
    try {
      const res = await fetch(`/api/teacher/classes/${classId}/export?type=${type}`, { cache: "no-store" });
      if (!res.ok) {
        setMsg(
          res.status === 401
            ? "⚠ 로그인이 끝났습니다. 다시 로그인한 뒤 내려받으세요."
            : res.status === 404
              ? "⚠ 학급을 찾을 수 없습니다. 화면을 새로 고쳐 보세요."
              : `⚠ '${label}' 파일을 만들지 못했습니다(오류 ${res.status}). 잠시 뒤 다시 시도하세요.`,
        );
        return;
      }
      const blob = await res.blob();
      const name = fileNameFrom(res.headers.get("Content-Disposition"), `${type}.csv`);
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch {
      setMsg("⚠ 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {!compact && <span className="text-xs text-stone-500">CSV 내려받기</span>}
        {TYPES.map(([type, label]) => (
          <button key={type} type="button" disabled={busy !== null} onClick={() => download(type, label)}
            title={TITLES[type]}
            className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs hover:bg-stone-50 disabled:opacity-50">
            {busy === type ? "만드는 중…" : `${label} CSV`}
          </button>
        ))}
      </div>
      {msg && <p role="alert" className="text-xs text-red-700">{msg}</p>}
    </div>
  );
}
