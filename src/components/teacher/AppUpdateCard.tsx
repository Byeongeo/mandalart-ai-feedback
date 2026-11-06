"use client";

import { useEffect, useState } from "react";
import { subjectParticle } from "@/lib/app-update";

// 교사 화면의 '앱 업데이트' 카드(받는 값 없음: <AppUpdateCard />).
// 화면이 열린 뒤 GET /api/teacher/app-update로 지금 버전과 설치 페이지의 새 버전을 따로 묻습니다(최대 2.5초).
// 확인이 실패하거나 늦어도 화면의 다른 부분에는 영향이 없고, 실패하면 카드를 그리지 않습니다.
type Reply = { current: string | null; latest: string | null; updateUrl: string | null };

function isReply(v: unknown): v is Reply {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const strOrNull = (x: unknown) => x === null || typeof x === "string";
  return strOrNull(r.current) && strOrNull(r.latest) && strOrNull(r.updateUrl);
}

// 서버가 만든 주소지만, 링크로 쓰기 전에 http(s)인지 한 번 더 봅니다.
function safeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : null;
  } catch {
    return null;
  }
}

export default function AppUpdateCard() {
  const [info, setInfo] = useState<Reply | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/teacher/app-update", { cache: "no-store" })
      .then(async (res) => {
        const data: unknown = res.ok ? await res.json().catch(() => null) : null;
        if (alive && isReply(data)) setInfo(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!info || (!info.current && !info.latest)) return null;
  const latest = info.latest;
  const updateUrl = safeUrl(info.updateUrl);

  return (
    <div className="rounded-xl border border-stone-300 bg-white text-sm print:hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3">
        <span className="font-bold">앱 버전</span>
        {info.current && <span className="text-xs text-stone-500">지금 {info.current}</span>}
        {latest ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
            새 버전 {latest}{subjectParticle(latest)} 있어요
          </span>
        ) : (
          <span className="text-xs text-stone-500">· 최신 버전이에요</span>
        )}
      </div>
      {latest && updateUrl && (
        <div className="flex flex-col gap-2 border-t border-stone-200 px-4 py-3">
          <p>
            새 버전 {latest}{subjectParticle(latest)} 있어요. 설치 페이지에서 ‘업데이트’를 누르면 받을 수 있어요(학생 글은 그대로 남아요).
          </p>
          <a
            href={updateUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start rounded-lg border border-stone-400 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-stone-50"
          >
            설치 페이지에서 업데이트하기 ↗
          </a>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950">
            수업 중에는 하지 마세요. 업데이트하는 1~2분 동안 학생 화면이 저장을 못 할 수 있어요.
            처음 설치할 때처럼 Cloudflare 설치 토큰을 새로 만들어 붙여 넣으면 돼요.
          </p>
        </div>
      )}
    </div>
  );
}
