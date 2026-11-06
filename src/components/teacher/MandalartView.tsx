import { targetKey, type MandalartContent, type Target } from "@/lib/mandalart";

const GRID_POS = [0, 1, 2, 3, 5, 6, 7, 8];

// 9×9 읽기 전용 표시. highlight에 든 칸은 ⚠️ 테두리로 표시합니다(교사 화면의 표현 검사 칸).
// 좁은 화면(휴대폰)에서는 칸 글자가 잘리지 않도록 표를 일정 너비 아래로 줄이지 않고 옆으로 밀어 보게 하고,
// 칸은 글이 길면 세로로 늘어납니다(글자를 숨기지 않음). 중심 목표는 표 위에 한 번 더 그대로 보여 줍니다.
export default function MandalartView({ content: c, highlight = [] }: { content: MandalartContent; highlight?: Target[] }) {
  const marked = new Set(highlight.map(targetKey));
  const keyOf = (b: number, p: number): string => {
    if (b === 4) return p === 4 ? targetKey({ kind: "goal" }) : targetKey({ kind: "sub", sub: GRID_POS.indexOf(p) });
    const sub = GRID_POS.indexOf(b);
    return p === 4 ? targetKey({ kind: "sub", sub }) : targetKey({ kind: "action", sub, action: GRID_POS.indexOf(p) });
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm">
        <span className="text-xs text-stone-500">중심 목표</span>
        <b className="block break-words">{c.goal.trim() || "(아직 비어 있음)"}</b>
      </p>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="grid min-w-[36rem] max-w-3xl grid-cols-3 items-start gap-1.5">
          {Array.from({ length: 9 }, (_, b) => {
            const isCenter = b === 4;
            const sub = GRID_POS.indexOf(b);
            return (
              <div key={b} className="grid grid-cols-3 gap-px rounded border border-stone-400 bg-stone-300 p-px">
                {Array.from({ length: 9 }, (_, p) => {
                  const v = isCenter ? (p === 4 ? c.goal : c.subs[GRID_POS.indexOf(p)]) : p === 4 ? c.subs[sub] : c.actions[sub][GRID_POS.indexOf(p)];
                  const bg = p === 4 ? (isCenter ? "bg-amber-100 font-bold" : "bg-sky-50 font-semibold") : isCenter ? "bg-sky-50" : "bg-white";
                  const hit = marked.has(keyOf(b, p));
                  return (
                    // 칸은 최소 정사각형(아래 빈 span의 padding이 칸 너비만큼 높이를 줌)이고, 글이 길면 그 줄 전체가 함께 늘어납니다.
                    <div key={p}
                      className={`flex min-w-0 items-center p-0.5 text-[10px] leading-tight sm:text-xs ${bg} ${hit ? "outline outline-2 -outline-offset-2 outline-amber-500" : ""}`}>
                      <span aria-hidden="true" className="w-0 shrink-0 pb-[100%]" />
                      <span className="min-w-0 flex-1 text-center [overflow-wrap:anywhere]">{v}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
