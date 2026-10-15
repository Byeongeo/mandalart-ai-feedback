"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtKst } from "../format";

const NET_ERROR = "⚠ 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 시도하세요.";

// 학생 상세 화면의 안전 신호 '확인했어요'. 누르면 새 신호가 생길 때까지 첫 화면 배지와 학급 화면의 '살펴볼 학생'에서 빠집니다.
// 이 화면의 기록은 그대로 남고, '확인 취소'로 되돌릴 수 있습니다.
export default function ConcernReviewButton({ url, needsReview, reviewedAt, seenUntil }: {
  url: string;
  needsReview: boolean;
  /** 어느 시각의 신호까지 확인했는지(students.concern_reviewed_at: 누를 때 화면에 보인 가장 늦은 신호 + 1밀리초) */
  reviewedAt: string | null;
  /** 화면에 보인 가장 늦은 신호 시각(그사이 새로 생긴 신호를 놓치지 않게 함께 보냄) */
  seenUntil: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function send(review: boolean) {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(review ? { reviewConcern: true, ...(seenUntil ? { seenUntil } : {}) } : { reviewConcern: false }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        setMsg(res.status === 401 ? "⚠ 로그인이 끝났습니다. 다시 로그인하세요." : `⚠ ${typeof data.error === "string" && res.status !== 404 ? data.error : "실패했습니다. 화면을 새로 고쳐 보세요."}`);
      }
      router.refresh();
    } catch {
      setMsg(NET_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {needsReview ? (
        <>
          {reviewedAt && <p className="text-xs text-amber-900">지난번 확인({fmtKst(reviewedAt)}까지의 신호) 뒤에 새 신호가 생겼습니다.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => send(true)} disabled={busy}
              className="rounded-lg bg-amber-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              확인했어요
            </button>
            <span className="text-xs text-amber-900">
              살펴본 뒤 누르면 새 신호가 생길 때까지 첫 화면과 학급 화면의 &lsquo;살펴볼 학생&rsquo;에서 빠집니다. 이 화면의 기록은 그대로 남습니다.
            </span>
          </div>
        </>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-amber-950">
          <span className="font-semibold">✓ 확인함{reviewedAt ? ` (${fmtKst(reviewedAt)}까지의 신호)` : ""}</span>
          <button onClick={() => send(false)} disabled={busy} className="text-xs text-stone-500 underline disabled:opacity-40">
            확인 취소
          </button>
        </p>
      )}
      {msg && <p role="status" className="text-sm text-rose-800">{msg}</p>}
    </div>
  );
}
