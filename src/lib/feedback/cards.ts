import "server-only";
import * as z from "zod";
import { MOCK, structuredCall, type CallMeta } from "./client";
import { CATEGORIES } from "./categories";
import type { DiagnosisItem } from "./diagnose";
import { targetKey, targetLabel, toPromptText, type MandalartContent } from "../mandalart";
import type { SchoolLevel } from "../school-level";

export type CardKind = "issue" | "resolved" | "unresolved";

// 카드로 만들 항목. 2회차(확인 피드백)에서는 1회차 카드의 해결 여부(resolved/unresolved)도 카드가 됩니다.
export type CardPlan = {
  item: Pick<DiagnosisItem, "category" | "target" | "evidence">;
  kind: CardKind;
  prevCardId?: string;
  before?: string; // 1회차 때 그 칸의 글
  after?: string; // 지금 그 칸의 글
  // 그 칸은 그대로인데 짝 칸(중복·겹침·연결된 목표)을 고쳐 해결된 경우, 바뀐 칸 설명. AI 문구에만 씁니다.
  changedElsewhere?: string[];
};

export type CardDraft = {
  category: DiagnosisItem["category"];
  target: DiagnosisItem["target"];
  body: string;
  kind: CardKind;
  prevCardId?: string;
};

export const issuePlans = (items: DiagnosisItem[]): CardPlan[] => items.map((item) => ({ item, kind: "issue" }));

const TARGET_ORDER = { goal: 0, whole: 1, sub: 2, action: 3 } as const;
function targetRank(t: DiagnosisItem["target"]): number {
  const base = TARGET_ORDER[t.kind] * 100;
  if (t.kind === "sub") return base + t.sub;
  if (t.kind === "action") return base + t.sub * 8 + t.action;
  return base;
}

// 카드 선택 규칙: 심각도 → 범주 우선순위 → 위치 순.
// 같은 칸에는 카드 1장, 같은 범주는 최대 2장.
export function selectItems(items: DiagnosisItem[], n: number): DiagnosisItem[] {
  const sorted = [...items].sort(
    (a, b) =>
      b.severity - a.severity ||
      CATEGORIES[a.category].priority - CATEGORIES[b.category].priority ||
      targetRank(a.target) - targetRank(b.target),
  );
  const usedTargets = new Set<string>();
  const perCategory = new Map<string, number>();
  const picked: DiagnosisItem[] = [];
  for (const it of sorted) {
    if (picked.length >= n) break;
    const key = targetKey(it.target);
    const count = perCategory.get(it.category) ?? 0;
    if (usedTargets.has(key) || count >= 2) continue;
    usedTargets.add(key);
    perCategory.set(it.category, count + 1);
    picked.push(it);
  }
  return picked;
}

// ── 학생 내용을 반영한 맞춤 힌트(AI) ───────────────────────────
const AiCards = z.object({
  cards: z.array(z.object({ index: z.number().int(), body: z.string() })),
});

// 학교급(학급 설정, src/lib/school-level.ts)마다 다른 문구. 대상 학생, 질문의 깊이, 읽는 사람만 다르고 길이(두 문장, 60~110자),
// 답을 대신 써 주지 않기, 칭찬·인사말 빼기, 종류별 쓰는 방식은 같습니다.
// 중학교 문구는 학교급 설정이 생기기 전과 글자 하나까지 같습니다(tests/feedback.test.ts가 해시로 확인). 고치려면 테스트의 해시도 함께 고치세요.
const CARD_LEVEL: Record<SchoolLevel, { who: string; question: string }> = {
  middle: {
    who: "중학생",
    question: "학생이 실제로 쓴 표현을 짚어서, 그 학생의 목표에 맞는 질문이나 방향을 제시하세요.",
  },
  high: {
    who: "고등학생",
    // 더 깊은 질문은 새 문제·아직 해결 안 됨 카드에만(해결됨 카드는 새 지적을 하지 않음), 그 항목에 맞을 때만(빈칸·반복·치우침 등에는 억지로 넣지 않음).
    question:
      "학생이 실제로 쓴 표현을 짚어서, 그 학생의 목표에 맞는 질문이나 방향을 제시하세요. 새 문제·아직 해결 안 됨 카드에서는 그 항목에 맞을 때 기한, 잴 수 있는 기준, 점검 방법처럼 한 걸음 더 깊이 생각하게 하는 질문을 하세요(해결됨 카드에는 넣지 마세요).",
  },
};

/** 카드 시스템 프롬프트. 학교급만 받습니다(학생 이름·번호·학급은 넣지 않음). */
export function cardSystem(level: SchoolLevel): string {
  const t = CARD_LEVEL[level];
  return `당신은 ${t.who}이 만다라트(목표 설정 도구)를 스스로 고치도록 돕는 피드백 작성자입니다.
진단 결과 목록을 받으면, 항목마다 학생에게 보여 줄 피드백 카드 본문을 하나씩 씁니다.

반드시 지킬 것:
- 힌트만 주고 답을 대신 써 주지 마세요. 고친 문장을 완성해서 제시하지 마세요.
- ${t.question}
- 두 문장 이내, 공백 포함 60~110자. ${t.who}이 한눈에 읽을 수 있게 짧게 쓰세요.
- 친근한 존댓말(~해 보세요, ~일까요?)을 쓰고, 칭찬이나 인사말은 넣지 마세요.
- 위치(몇 번 칸인지)는 화면에 따로 표시되므로 본문에 번호를 쓰지 마세요.
- 빈칸 항목이면, 그 칸과 연결된 세부 목표나 중심 목표를 근거로 무엇을 떠올리면 좋을지 생각할 거리를 주세요.
- index는 입력 항목 번호를 그대로 쓰고, 모든 항목에 카드를 하나씩 쓰세요.
- 글에 힘든 마음이나 걱정되는 내용이 보여도 카드에서 그 내용을 지적하거나 평가하지 말고, 따뜻하고 차분한 말투를 지키세요(선생님이 따로 살핍니다).

항목의 '종류'에 따라 쓰는 방식이 다릅니다:
- 새 문제: 위 규칙대로 고칠 방향을 힌트로 줍니다.
- 해결됨: 학생이 앞의 피드백을 반영해 그 칸을 고친 경우입니다. 고치기 전과 후를 비교해, 무엇이 나아졌는지 학생이 쓴 표현을 짚어 구체적으로 알려 주세요. '대단해요' 같은 사람에 대한 칭찬이 아니라 글이 어떻게 나아졌는지를 말하세요. 새로운 지적은 하지 마세요.
- 아직 해결 안 됨: 학생이 고쳤지만(또는 고치지 않아서) 같은 문제가 남은 경우입니다. 처음보다 한 걸음 더 구체적인 힌트를 주세요. 그래도 완성 문장을 대신 써 주지는 마세요.`;
}

const KIND_LABEL: Record<CardKind, string> = { issue: "새 문제", resolved: "해결됨", unresolved: "아직 해결 안 됨" };

// 모든 항목(0..n-1)에 빈 문자열이 아닌 카드가 하나씩 있는지 확인합니다. 빠지면 같은 호출 안에서 다시 시도합니다.
function missingCard(parsed: z.infer<typeof AiCards>, n: number): string | null {
  const have = new Set(parsed.cards.filter((card) => card.body.trim()).map((card) => card.index));
  for (let i = 0; i < n; i++) if (!have.has(i)) return `카드 ${i}가 생성되지 않았습니다.`;
  return null;
}

/** level: 학급의 학교급(피드백을 요청할 때 round.ts가 학급에서 읽음). */
export async function aiCards(
  c: MandalartContent,
  plans: CardPlan[],
  level: SchoolLevel,
  deadline?: number,
): Promise<{ cards: CardDraft[]; meta: CallMeta | null }> {
  if (plans.length === 0) return { cards: [], meta: null };
  const done = (bodies: (string | undefined)[], meta: CallMeta | null) => ({
    cards: plans.map((p, i): CardDraft => {
      const body = bodies[i];
      if (!body) throw new Error(`카드 ${i}가 생성되지 않았습니다.`);
      return { category: p.item.category, target: p.item.target, body, kind: p.kind, prevCardId: p.prevCardId };
    }),
    meta,
  });
  if (MOCK) {
    return done(plans.map((p) => `[모의 피드백 · ${KIND_LABEL[p.kind]}] ${p.item.evidence}. 이 부분을 어떻게 바꾸면 더 분명해질지 생각해 보세요.`), null);
  }
  const list = plans
    .map((p, i) => {
      const head = `[${i}] 종류: ${KIND_LABEL[p.kind]} / 위치: ${targetLabel(p.item.target, c)} / 범주: ${CATEGORIES[p.item.category].label} / 진단 근거: ${p.item.evidence}`;
      if (p.kind === "issue") return head;
      const diff = `${head}\n    고치기 전: ${p.before || "(비어 있음)"}\n    지금: ${p.after || "(비어 있음)"}`;
      return p.changedElsewhere?.length ? `${diff}\n    이 칸 대신 고친 칸: ${p.changedElsewhere.join(" / ")}` : diff;
    })
    .join("\n");
  const { data: parsed, meta } = await structuredCall({
    name: "feedback_cards",
    system: cardSystem(level),
    user: `학생의 만다라트:\n${toPromptText(c)}\n\n피드백 항목:\n${list}`,
    schema: AiCards,
    maxTokens: 4000,
    deadline,
    validate: (d) => missingCard(d, plans.length),
  });
  const byIndex = new Map(parsed.cards.map((card) => [card.index, card.body.trim()]));
  return done(plans.map((_, i) => byIndex.get(i)), meta);
}
