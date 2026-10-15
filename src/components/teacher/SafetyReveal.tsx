"use client";

import { createContext, useContext, useState } from "react";
import type { MandalartContent, Target } from "@/lib/mandalart";
import MandalartView from "./MandalartView";

// 학생 상세 화면의 안전 신호(종류, 걸린 칸, 주황 테두리, AI 신호 표시)를 기본으로 숨깁니다.
// 학생의 만다라트를 예시로 칠판·TV에 띄워도 친구들이 보지 못하게. 학급 화면처럼 저장하지 않으므로 화면을 다시 열면 다시 숨겨집니다.
// 숨긴 동안의 한 줄은 신호가 있든 없든 같은 글이라, 그 줄만 보고는 이 학생에게 신호가 있는지 알 수 없습니다.
const SafetyShown = createContext<{ shown: boolean; setShown: (v: boolean) => void }>({ shown: false, setShown: () => {} });

/** 학생 상세 화면 전체를 감싸 '안전 신호 보기' 상태를 나눠 씁니다. */
export function SafetyReveal({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  return <SafetyShown.Provider value={{ shown, setShown }}>{children}</SafetyShown.Provider>;
}

/** 안전 신호 상자. 숨긴 동안은 중립적인 한 줄과 '안전 신호 보기' 버튼만, 누르면 children(신호 내용)을 보여 줍니다. */
export function SafetyBox({ signal, children }: { signal: boolean; children: React.ReactNode }) {
  const { shown, setShown } = useContext(SafetyShown);
  if (!shown) {
    return (
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5">
        <p className="text-sm text-stone-600">
          안전 신호는 숨겨 두었어요. 화면을 학생들에게 보여 주고 있지 않을 때 &lsquo;안전 신호 보기&rsquo;를 누르세요.
        </p>
        <button onClick={() => setShown(true)} className="rounded-lg border border-stone-400 bg-white px-3 py-1.5 text-sm text-stone-700">
          안전 신호 보기
        </button>
      </section>
    );
  }
  return (
    <section className={`flex flex-col gap-3 rounded-xl border p-4 ${signal ? "border-amber-300 bg-amber-50" : "border-stone-300 bg-white"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={`font-semibold ${signal ? "text-amber-950" : "text-stone-700"}`}>{signal ? "⚠️ 직접 살펴보세요" : "안전 신호"}</h2>
        <button onClick={() => setShown(false)}
          className={`rounded-lg border bg-white px-3 py-1.5 text-sm ${signal ? "border-amber-700 text-amber-900" : "border-stone-400 text-stone-700"}`}>
          안전 신호 숨기기
        </button>
      </div>
      {children}
    </section>
  );
}

/** '안전 신호 보기'를 누른 동안에만 children을 보여 줍니다(예: 피드백 회차의 AI 신호 표시). */
export function WhenSafetyShown({ children }: { children: React.ReactNode }) {
  return useContext(SafetyShown).shown ? children : null;
}

/** 지금 만다라트. 표현 검사에 걸린 칸의 주황 테두리는 '안전 신호 보기'를 누른 동안에만 그립니다. */
export function SafetyMandalart({ content, highlight }: { content: MandalartContent; highlight: Target[] }) {
  const { shown } = useContext(SafetyShown);
  return <MandalartView content={content} highlight={shown ? highlight : []} />;
}

/** 피드백 회차 상자. AI 신호가 붙은 회차의 주황 바탕은 '안전 신호 보기'를 누른 동안에만 칠합니다. */
export function RoundFrame({ concern, children }: { concern: boolean; children: React.ReactNode }) {
  const { shown } = useContext(SafetyShown);
  return (
    <div className={`flex flex-col gap-2 rounded-xl border p-3 ${shown && concern ? "border-amber-300 bg-amber-50/50" : "border-stone-300 bg-white"}`}>
      {children}
    </div>
  );
}
