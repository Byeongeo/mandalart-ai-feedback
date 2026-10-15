import * as z from "zod";

// 칸 글자 수 검사. 학생 화면(textarea의 maxLength, student.ts의 clampText·tooLongCell)과 같은 UTF-16 셈(s.length)으로 셉니다
// (이모지 하나 = 2칸). zod의 max()는 코드 포인트로 세어 이모지가 있으면 화면보다 더 많이 받으므로 쓰지 않습니다.
// 한도(60/40)는 student.ts의 GOAL_MAX·CELL_MAX와 같아야 합니다.
const text = (max: number) => z.string().refine((s) => s.length <= max);

// 만다라트 내용: 중심 목표 1 + 세부 목표 8 + 실천 행동 8×8
export const MandalartContent = z.object({
  goal: text(60),
  subs: z.array(text(40)).length(8),
  actions: z.array(z.array(text(40)).length(8)).length(8),
});
export type MandalartContent = z.infer<typeof MandalartContent>;

export function emptyContent(): MandalartContent {
  return {
    goal: "",
    subs: Array(8).fill(""),
    actions: Array.from({ length: 8 }, () => Array(8).fill("")),
  };
}

// 피드백이 가리키는 위치
export const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal") }),
  z.object({ kind: z.literal("sub"), sub: z.number().int().min(0).max(7) }),
  z.object({
    kind: z.literal("action"),
    sub: z.number().int().min(0).max(7),
    action: z.number().int().min(0).max(7),
  }),
  z.object({ kind: z.literal("whole") }),
]);
export type Target = z.infer<typeof Target>;

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

export function targetLabel(t: Target, c: MandalartContent): string {
  switch (t.kind) {
    case "goal":
      return "중심 목표";
    case "sub":
      return `세부 목표 ${CIRCLED[t.sub]}${c.subs[t.sub] ? ` '${c.subs[t.sub]}'` : ""}`;
    case "action": {
      const sub = c.subs[t.sub] ? ` '${c.subs[t.sub]}'` : "";
      const act = c.actions[t.sub][t.action];
      return `세부 목표 ${CIRCLED[t.sub]}${sub}의 실천 ${t.action + 1}${act ? ` '${act}'` : ""}`;
    }
    case "whole":
      return "만다라트 전체";
  }
}

export function targetKey(t: Target): string {
  switch (t.kind) {
    case "goal":
    case "whole":
      return t.kind;
    case "sub":
      return `sub:${t.sub}`;
    case "action":
      return `action:${t.sub}:${t.action}`;
  }
}

export function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

// 만다라트를 프롬프트용 텍스트로 직렬화합니다. 번호는 0부터 시작하는 인덱스를 그대로 씁니다.
export function toPromptText(c: MandalartContent): string {
  const lines = [`중심 목표: ${c.goal || "(비어 있음)"}`];
  c.subs.forEach((s, i) => {
    lines.push(`세부 목표[${i}]: ${s || "(비어 있음)"}`);
    c.actions[i].forEach((a, j) => {
      lines.push(`  실천[${i}][${j}]: ${a || "(비어 있음)"}`);
    });
  });
  return lines.join("\n");
}

// ── 단계별 피드백 ─────────────────────────────────────────────
// core: 중심 목표 + 세부 목표 8개 / block: 세부 목표 하나의 실천 8칸 / whole: 전체 균형
export type Stage = { kind: "core" } | { kind: "block"; index: number } | { kind: "whole" };

export const BLOCK_MIN_ACTIONS = 6;

export function stageLabel(s: Stage): string {
  if (s.kind === "core") return "중심·세부 목표";
  if (s.kind === "block") return `세부 목표 ${CIRCLED[s.index]} 블록`;
  return "전체";
}

export function stageKey(s: Stage): string {
  return s.kind === "block" ? `block:${s.index}` : s.kind;
}

// 학생 화면에서 보여 줄 '아직 받을 수 없는 이유'. 받을 수 있으면 null.
export function stageNotReady(s: Stage, c: MandalartContent): string | null {
  if (s.kind === "core") {
    if (!c.goal.trim()) return "중심 목표를 먼저 써 주세요.";
    const n = c.subs.filter((x) => x.trim()).length;
    return n < 8 ? `세부 목표 8개를 모두 써 주세요. (지금 ${n}개)` : null;
  }
  if (s.kind === "block") {
    if (!c.subs[s.index].trim()) return "이 블록의 세부 목표를 먼저 써 주세요.";
    const n = c.actions[s.index].filter((x) => x.trim()).length;
    return n < BLOCK_MIN_ACTIONS ? `실천을 ${BLOCK_MIN_ACTIONS}개 이상 써 주세요. (지금 ${n}개)` : null;
  }
  return null;
}

export function inStage(t: Target, s: Stage): boolean {
  if (s.kind === "core") return t.kind === "goal" || t.kind === "sub";
  if (s.kind === "block") return t.kind === "action" && t.sub === s.index;
  return true;
}

// ── 피드백 판정 공통 규칙(서버·학생 화면·교사 화면 공용) ─────────────
// 칸 글 비교용: 앞뒤 공백을 지우고 연속 공백을 하나로 봅니다(띄어쓰기만 바꾼 것은 고친 것으로 보지 않음).
export function normalizeCell(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function cellText(c: MandalartContent, t: Target): string {
  if (t.kind === "goal") return c.goal;
  if (t.kind === "sub") return c.subs[t.sub];
  if (t.kind === "action") return c.actions[t.sub][t.action];
  return [c.goal, ...c.subs, ...c.actions.flat()].map(normalizeCell).join("\n");
}

// 띄어쓰기·대소문자만 바꾼 것은 고친 것으로 보지 않습니다(반복 진단과 같은 normalize 기준).
export function cellChanged(before: MandalartContent, after: MandalartContent, t: Target): boolean {
  return normalize(cellText(before, t)) !== normalize(cellText(after, t));
}

// 한 단계가 끝났는지: 첫 피드백에 카드가 없었거나, 첫 피드백 카드를 모두 '안 할래요'로 골랐거나(다시 확인할 것이 없음),
// 확인 피드백까지 받았거나, 횟수를 다 썼을 때. n_cards·n_rejected는 'issue' 카드 수와 그중 마지막 응답이 거부인 수.
export function stageDone(rounds: { attempt: number; n_cards: number; n_rejected: number }[], max: number): boolean {
  if (rounds.length === 0) return false;
  const first = rounds.find((r) => r.attempt === 1);
  const n = first?.n_cards ?? 0;
  return n === 0 || (first?.n_rejected ?? 0) >= n || rounds.some((r) => r.attempt >= 2) || rounds.length >= Math.min(max, 2);
}

// 1회차 카드의 '짝 칸': 카드가 가리킨 칸 대신 고쳐도 같은 문제가 풀릴 수 있는 칸(1회차 내용 기준)
// - 중복: 1회차 때 같은 글이었던 다른 칸(세부 목표끼리, 실천끼리)  - 세부 목표 겹침: 다른 세부 목표
// - 세부 목표 연결 약함: 중심 목표  - 실천 연결 약함: 그 블록의 세부 목표  - 그 밖의 범주: 없음
export function partnerTargets(category: string, t: Target, first: MandalartContent): Target[] {
  if (category === "DUPLICATE" && (t.kind === "sub" || t.kind === "action")) {
    const key = normalize(cellText(first, t));
    if (!key) return [];
    const same = t.kind === "sub"
      ? Array.from({ length: 8 }, (_, i) => ({ kind: "sub", sub: i }) as const).filter((x) => x.sub !== t.sub)
      : Array.from({ length: 64 }, (_, k) => ({ kind: "action", sub: Math.floor(k / 8), action: k % 8 }) as const)
          .filter((x) => x.sub !== t.sub || x.action !== t.action);
    return same.filter((x) => normalize(cellText(first, x)) === key);
  }
  if (category === "SUB_OVERLAP" && t.kind === "sub") {
    return Array.from({ length: 8 }, (_, i) => ({ kind: "sub", sub: i }) as const).filter((x) => x.sub !== t.sub);
  }
  if (category === "SUB_MISALIGNED" && t.kind === "sub") return [{ kind: "goal" }];
  if (category === "ACTION_MISALIGNED" && t.kind === "action") return [{ kind: "sub", sub: t.sub }];
  return [];
}

// 고친 짝 칸: 1회차보다 바뀌었고 비어 있지 않은 짝 칸(짝 칸을 지우기만 한 것은 고친 것으로 보지 않음)
export function changedPartners(category: string, t: Target, first: MandalartContent, now: MandalartContent): Target[] {
  return partnerTargets(category, t, first).filter((p) => cellChanged(first, now, p) && normalize(cellText(now, p)) !== "");
}

// 반복이 아직 남았는지: 그 칸의 지금 글이 같은 종류의 다른 칸(세부 목표끼리, 실천은 64칸 전체)과 같은지.
// 규칙 진단은 뒤에 나온 칸에만 표시하므로, 칸 위치가 아니라 글로 판단합니다(셋 이상 같을 때 등).
export function duplicateRemains(c: MandalartContent, t: Target): boolean {
  if (t.kind !== "sub" && t.kind !== "action") return false;
  const key = normalize(cellText(c, t));
  if (!key) return false;
  if (t.kind === "sub") return c.subs.some((x, i) => i !== t.sub && normalize(x) === key);
  return c.actions.some((row, i) => row.some((x, j) => (i !== t.sub || j !== t.action) && normalize(x) === key));
}

// 확인 피드백에서 1회차 카드 하나의 판정. null이면 이번에는 카드로 보여 주지 않습니다.
// - 그 칸(또는 짝 칸)을 고쳤고 같은 문제가 다시 진단되지 않으면 해결
// - 그 칸(또는 짝 칸)을 고쳤는데 문제가 남았거나, 고치지 않았지만 '해 볼게요'를 골랐으면 아직 해결 안 됨
//   (손대지 않은 칸이 진단에서 우연히 빠진 것을 '잘 고쳤어요'로 칭찬하지 않기 위함)
export function recheckKind(o: { targetChanged: boolean; partnerChanged: boolean; stillThere: boolean; accepted: boolean }): "resolved" | "unresolved" | null {
  const fixed = o.targetChanged || o.partnerChanged;
  if (fixed && !o.stillThere) return "resolved";
  if (fixed || o.accepted) return "unresolved";
  return null;
}

// AI 진단 범주가 가리킬 수 있는 칸 종류와, 단계마다 보여 줄 수 있는 범주
const CATEGORY_TARGETS: Record<string, readonly Target["kind"][]> = {
  EMPTY: ["goal", "sub", "action"],
  DUPLICATE: ["sub", "action"],
  GOAL_VAGUE: ["goal"],
  SUB_MISALIGNED: ["sub"],
  SUB_OVERLAP: ["sub"],
  ACTION_NOT_ACTIONABLE: ["action"],
  ACTION_NOT_MEASURABLE: ["action"],
  ACTION_MISALIGNED: ["action"],
  UNBALANCED: ["whole"],
};
const STAGE_CATEGORIES: Record<Stage["kind"], readonly string[] | null> = {
  core: ["EMPTY", "DUPLICATE", "GOAL_VAGUE", "SUB_MISALIGNED", "SUB_OVERLAP"],
  block: ["EMPTY", "DUPLICATE", "ACTION_NOT_ACTIONABLE", "ACTION_NOT_MEASURABLE", "ACTION_MISALIGNED"],
  whole: null, // 전체 단계는 모든 범주
};

export function categoryFits(category: string, t: Target, s: Stage): boolean {
  const kinds = CATEGORY_TARGETS[category];
  const allowed = STAGE_CATEGORIES[s.kind];
  return !!kinds && kinds.includes(t.kind) && (!allowed || allowed.includes(category)) && inStage(t, s);
}

// 단계별 진행 상황(교사 화면·서버 공용). rounds는 한 만다라트의 회차들(issue 카드 수·마지막 응답이 거부인 수 포함).
export type RoundSummary = { stage: "core" | "block" | "whole"; block_index: number | null; attempt: number; n_cards: number; n_rejected: number };
export function stageProgress(rounds: RoundSummary[], max: number): { coreDone: boolean; blocksDone: number; wholeDone: boolean } {
  const of = (stage: RoundSummary["stage"], block: number | null) => rounds.filter((r) => r.stage === stage && r.block_index === block);
  return {
    coreDone: stageDone(of("core", null), max),
    blocksDone: Array.from({ length: 8 }, (_, i) => stageDone(of("block", i), max)).filter(Boolean).length,
    wholeDone: stageDone(of("whole", null), max),
  };
}
