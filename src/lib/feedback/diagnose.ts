import "server-only";
import * as z from "zod";
import { MOCK, structuredCall, type CallMeta } from "./client";
import { CATEGORIES, CONCERN_KIND_KEYS, normalizeConcern, type Category, type Concern, type ConcernKind } from "./categories";
import { ruleConcern } from "../concern-rules";
import { categoryFits, inStage, normalize, toPromptText, type MandalartContent, type Stage, type Target } from "../mandalart";
import type { SchoolLevel } from "../school-level";

export type DiagnosisItem = {
  category: Category;
  target: Target;
  severity: 1 | 2 | 3;
  evidence: string;
  source: "rule" | "ai";
};

// ── 1) 규칙 기반 진단: 빈칸, 완전 중복 ─────────────────────────────
// 단계 범위 안의 항목만 돌려줍니다.
export function ruleDiagnose(c: MandalartContent, stage: Stage): DiagnosisItem[] {
  const items: DiagnosisItem[] = [];
  if (!c.goal.trim()) {
    items.push({ category: "EMPTY", target: { kind: "goal" }, severity: 3, evidence: "중심 목표가 비어 있음", source: "rule" });
  }
  c.subs.forEach((s, i) => {
    if (!s.trim()) {
      items.push({ category: "EMPTY", target: { kind: "sub", sub: i }, severity: 3, evidence: "세부 목표가 비어 있음", source: "rule" });
      return;
    }
    // 실천 빈칸은 블록 단계에서만 진단합니다. 전체 단계는 8개 블록의 피드백을 모두 마친 뒤에 받으므로(블록은 실천 6칸부터 받을 수 있어
    // 빈칸이 남을 수 있음) 남은 빈칸은 블록 단계에서 이미 다룬 것으로 보고, 전체 단계의 카드 2장은 전체 구조(균형·연결)에 씁니다.
    // 중심 목표·세부 목표가 비면(나중에 지운 경우) 전체 단계에서도 알려 줍니다.
    if (stage.kind !== "block") return;
    const empties = c.actions[i].map((a, j) => (a.trim() ? -1 : j)).filter((j) => j >= 0);
    for (const j of empties) {
      items.push({
        category: "EMPTY",
        target: { kind: "action", sub: i, action: j },
        severity: 2,
        evidence: `이 세부 목표의 실천 칸 ${empties.length}개가 비어 있음`,
        source: "rule",
      });
    }
  });

  const seenSubs = new Map<string, number>();
  c.subs.forEach((s, i) => {
    const k = normalize(s);
    if (!k) return;
    if (seenSubs.has(k)) {
      items.push({ category: "DUPLICATE", target: { kind: "sub", sub: i }, severity: 2, evidence: `세부 목표 '${s}' 반복`, source: "rule" });
    } else seenSubs.set(k, i);
  });
  const seenActs = new Set<string>();
  c.actions.forEach((row, i) =>
    row.forEach((a, j) => {
      const k = normalize(a);
      if (!k) return;
      if (seenActs.has(k)) {
        items.push({ category: "DUPLICATE", target: { kind: "action", sub: i, action: j }, severity: 2, evidence: `실천 '${a}' 반복`, source: "rule" });
      } else seenActs.add(k);
    }),
  );
  return items.filter((it) => inStage(it.target, stage));
}

// ── 2) AI 진단: 의미 판단이 필요한 범주 + 안전 신호 ───────────────────
// 프롬프트에는 만다라트 글(toPromptText)만 들어갑니다. 학생 이름·번호·학급은 넣지 않습니다.
const AI_CATEGORIES = [
  "GOAL_VAGUE",
  "SUB_MISALIGNED",
  "SUB_OVERLAP",
  "ACTION_NOT_ACTIONABLE",
  "ACTION_NOT_MEASURABLE",
  "ACTION_MISALIGNED",
  "UNBALANCED",
] as const;

const AiItem = z.object({
  category: z.enum(AI_CATEGORIES),
  target_kind: z.enum(["goal", "sub", "action", "whole"]),
  sub: z.number().int().nullable(),
  action: z.number().int().nullable(),
  severity: z.number().int(),
  evidence: z.string(),
});

// 모델에게 보내는 JSON 스키마: concern(안전 신호)은 반드시 쓰도록 요구합니다(교사 화면에만 표시, 학생 카드에는 쓰지 않음).
const AiDiagnosisWire = z.object({
  items: z.array(AiItem),
  concern: z.object({
    flag: z.boolean(),
    kind: z.enum(CONCERN_KIND_KEYS as [ConcernKind, ...ConcernKind[]]).nullable(),
  }),
});

// 받을 때는 concern을 너그럽게 읽습니다: 빠졌거나 모양이 이상해도 실패·재시도하지 않고 '신호 없음'으로 봅니다
// (normalizeConcern). 진단 항목은 그대로 엄격하게 검사합니다.
const AiDiagnosis = z.object({
  items: z.array(AiItem),
  concern: z.unknown().optional(),
});

// 학교급(학급 설정, src/lib/school-level.ts)마다 다른 문구. 대상 학생과 판단 기준 세 가지(GOAL_VAGUE, SUB_MISALIGNED,
// ACTION_NOT_MEASURABLE), 엄격함만 다르고 나머지(범주, 규칙, 안전 신호)는 같습니다.
// 중학교 문구는 학교급 설정이 생기기 전과 글자 하나까지 같습니다(tests/feedback.test.ts가 해시로 확인). 고치려면 테스트의 해시도 함께 고치세요.
const DIAGNOSIS_LEVEL: Record<SchoolLevel, { who: string; goalVague: string; subMisaligned: string; notMeasurable: string; strictness: string }> = {
  middle: {
    who: "중학생",
    goalVague: "중심 목표에 기간·수준·대상 중 어느 것도 드러나지 않아 이뤘는지 판단할 수 없을 때.",
    subMisaligned: "세부 목표가 중심 목표 달성에 기여한다고 보기 어려울 때.",
    notMeasurable: "행동은 맞지만 했는지 확인할 기준(횟수·시간·요일 등)이 전혀 없어 점검이 어려울 때.",
    strictness: "중학생 수준을 고려해 지나치게 엄격하게 판단하지 마세요.",
  },
  high: {
    who: "고등학생",
    goalVague: "중심 목표에 기한(언제까지)과 이뤘는지 잴 수 있는 기준(점수·등급·횟수 등) 중 하나라도 빠졌을 때.",
    // 진로·학업은 중심 목표가 그런 목표일 때만 봅니다. 받쳐 주는 영역(건강·관계 등)을 연결 약함으로 보면 UNBALANCED와 부딪힙니다.
    subMisaligned:
      "세부 목표가 중심 목표 달성에 어떻게 기여하는지 설명하기 어려울 때(중심 목표가 진로·학업에 관한 것이면 그 맥락에서 이어지는지도 봅니다. 건강·관계·마음 관리처럼 중심 목표를 받쳐 주는 영역은 기여하는 것으로 봅니다).",
    // 셋 중 하나라도 있으면 해당하지 않습니다(셋 모두를 요구하지 않음).
    notMeasurable:
      "행동은 맞지만 횟수·시간·점검 방법 중 어느 것도 드러나지 않아 했는지 점검하기 어려울 때('자주', '꾸준히'처럼 막연한 말만 있으면 드러나지 않은 것으로 봅니다).",
    strictness: "고등학생 수준에 맞게 위 기준을 분명히 적용하되, 맞춤법·띄어쓰기·말투 같은 사소한 표현은 지적하지 마세요.",
  },
};

/** 진단 시스템 프롬프트. 학교급만 받습니다(학생 이름·번호·학급은 넣지 않음). */
export function diagnosisSystem(level: SchoolLevel): string {
  const t = DIAGNOSIS_LEVEL[level];
  return `당신은 ${t.who}의 만다라트(목표 설정 도구)를 진단하는 교육 평가 보조자입니다.
만다라트는 중심 목표 1개, 세부 목표 8개, 세부 목표마다 실천 행동 8개로 이루어집니다.

진단만 하고 고쳐 쓰지 마세요. 진단 결과는 학생에게 보여 줄 피드백 카드를 고르는 데 쓰입니다.

진단 범주(이 외의 범주는 쓰지 마세요):
${AI_CATEGORIES.map((k) => `- ${k}: ${CATEGORIES[k].label}`).join("\n")}

판단 기준:
- GOAL_VAGUE: ${t.goalVague} target_kind는 goal.
- SUB_MISALIGNED: ${t.subMisaligned} target_kind는 sub.
- SUB_OVERLAP: 두 세부 목표가 사실상 같은 영역일 때. 뒤쪽 세부 목표를 target으로.
- ACTION_NOT_ACTIONABLE: '열심히 하기', '노력하기', '긍정적으로 생각하기'처럼 구체 행동이 아닌 다짐. target_kind는 action.
- ACTION_NOT_MEASURABLE: ${t.notMeasurable} 짧고 분명한 행동(예: '물 마시기 하루 8잔')은 해당하지 않습니다.
- ACTION_MISALIGNED: 실천이 해당 세부 목표와 관계가 약할 때.
- UNBALANCED: 세부 목표 대부분이 한 영역(예: 공부 과목만)에 몰려 있을 때. target_kind는 whole. 최대 1개.

규칙:
- 빈칸과 글자가 똑같은 중복은 다른 단계에서 이미 검사하므로 보고하지 마세요.
- sub, action은 입력에 표시된 0부터 시작하는 번호입니다. 해당 없으면 null.
- severity: 3 = 목표 달성을 크게 막음, 2 = 고치면 분명히 나아짐, 1 = 사소함.
- evidence는 학생이 쓴 표현을 인용해 한 문장으로, 왜 그 범주인지 씁니다.
- ${t.strictness} 문제가 없으면 items를 빈 배열로 둡니다.
- 최대 12개까지, 심각한 것부터 보고하세요.
- 사용자 메시지의 '진단 범위'에 해당하는 칸만 보고하세요. 다른 칸은 맥락을 이해하는 데만 쓰세요.

안전 신호(concern) — 진단 범위와 상관없이 만다라트의 모든 글을 보고 판단합니다:
- 목적: 글쓴 학생에게 위험할 수 있는 신호를 선생님이 놓치지 않게 하는 것입니다. 선생님이 학생을 직접 만나 확인하므로,
  분명한 신호뿐 아니라 그럴 수 있어 보이는(plausible) 신호도 flag를 true로 하세요. 애매하면 true 쪽으로 판단하세요.
- 종류(kind):
  - self_harm: 자해·자살 생각. 돌려 말한 표현도 포함합니다. 예: '죽고 싶다', '살기 싫다', '사라지고 싶다', '다 끝내고 싶다',
    '내가 없으면 다들 편할 텐데', '태어나지 말걸', '없어지고 싶다', 자해 행동 언급.
  - abuse: 집이나 어른에게 맞거나 학대·방임을 당한다는 언급(예: '아빠한테 맞지 않기', '집에 들어가기 무섭다').
  - bullying: 따돌림·괴롭힘·학교폭력 피해(예: '왕따 안 당하기', '애들이 나를 괴롭히지 않게', '빵셔틀 그만하기').
  - eating: 위험한 섭식 행동의 신호(예: 일부러 굶기, 먹고 토하기, 하루 한 끼만 먹기, 변비약·다이어트약으로 살 빼기).
  - violence: 다른 사람을 해치겠다는 생각(예: '걔를 죽여 버리고 싶다', '복수로 때리기').
  - other: 그 밖에 어른의 도움이 바로 필요해 보이는 내용.
- 표시하지 않을 평범한 목표: 운동부 체중 조절, 건강하게 살 빼기, 군것질 줄이기, 게임 시간 줄이기, '스트레스 줄이기', '잠 일찍 자기',
  성적 걱정, '시험 때문에 힘들다'만 있는 경우, 친구와 한 번 다툰 일. 이런 내용만 있으면 false입니다.
- flag가 false이면 kind는 null, true이면 kind에 위 여섯 가지 중 하나를 씁니다. concern은 항상 써야 합니다.
- 안전 신호는 학생에게 보이지 않고 선생님이 살펴보도록 알려 주는 데만 씁니다. evidence나 다른 항목에 이 내용을 쓰지 마세요.`;
}

function scopeText(stage: Stage, c: MandalartContent): string {
  if (stage.kind === "core") {
    return "진단 범위: 중심 목표와 세부 목표[0]~[7]만 (범주: GOAL_VAGUE, SUB_MISALIGNED, SUB_OVERLAP). 실천 칸은 보고하지 마세요.";
  }
  if (stage.kind === "block") {
    return `진단 범위: 세부 목표[${stage.index}] '${c.subs[stage.index]}'의 실천[${stage.index}][0]~[${stage.index}][7]만 (범주: ACTION_NOT_ACTIONABLE, ACTION_NOT_MEASURABLE, ACTION_MISALIGNED). 다른 칸은 보고하지 마세요.`;
  }
  return "진단 범위: 만다라트 전체의 균형과 연결 (범주: UNBALANCED, SUB_OVERLAP, SUB_MISALIGNED, ACTION_MISALIGNED 위주). 앞 단계에서 이미 다룬 사소한 표현 문제보다 전체 구조의 문제를 우선 보고하세요.";
}

function toTarget(i: z.infer<typeof AiItem>): Target | null {
  const inRange = (n: number | null): n is number => n !== null && n >= 0 && n <= 7;
  switch (i.target_kind) {
    case "goal":
    case "whole":
      return { kind: i.target_kind };
    case "sub":
      return inRange(i.sub) ? { kind: "sub", sub: i.sub } : null;
    case "action":
      return inRange(i.sub) && inRange(i.action) ? { kind: "action", sub: i.sub, action: i.action } : null;
  }
}

function isFilled(t: Target, c: MandalartContent): boolean {
  if (t.kind === "goal") return !!c.goal.trim();
  if (t.kind === "sub") return !!c.subs[t.sub].trim();
  if (t.kind === "action") return !!c.actions[t.sub][t.action].trim();
  return true;
}

function mockDiagnose(c: MandalartContent, stage: Stage): DiagnosisItem[] {
  const items: DiagnosisItem[] = [];
  if (c.goal.trim() && !/\d/.test(c.goal)) {
    items.push({ category: "GOAL_VAGUE", target: { kind: "goal" }, severity: 2, evidence: `'${c.goal}'에 기간이나 기준이 없음`, source: "ai" });
  }
  c.actions.forEach((row, i) =>
    row.forEach((a, j) => {
      if (/열심히|노력|최선/.test(a)) {
        items.push({ category: "ACTION_NOT_ACTIONABLE", target: { kind: "action", sub: i, action: j }, severity: 2, evidence: `'${a}'는 다짐에 가까움`, source: "ai" });
      }
    }),
  );
  return items.filter((it) => inStage(it.target, stage));
}

/** level: 학급의 학교급(피드백을 요청할 때 round.ts가 학급에서 읽음). AI에는 만다라트 글과 학교급에 맞춘 지시만 보냅니다. */
export async function aiDiagnose(
  c: MandalartContent,
  stage: Stage,
  level: SchoolLevel,
  note?: string,
  deadline?: number,
): Promise<{ items: DiagnosisItem[]; concern: Concern; meta: CallMeta | null }> {
  if (MOCK) {
    // 모의 모드: 안전 신호 흐름은 규칙 검사(concern-rules.ts)로 흉내 냅니다.
    const rule = ruleConcern(c);
    return { items: mockDiagnose(c, stage), concern: rule ? { flag: true, kind: rule.kind } : { flag: false, kind: null }, meta: null };
  }
  const { data: parsed, meta } = await structuredCall({
    name: "mandalart_diagnosis",
    system: diagnosisSystem(level),
    user: `다음 만다라트를 진단하세요.\n${scopeText(stage, c)}${note ? `\n${note}` : ""}\n\n${toPromptText(c)}`,
    schema: AiDiagnosis,
    responseSchema: AiDiagnosisWire,
    maxTokens: 8000,
    deadline,
  });

  const items: DiagnosisItem[] = [];
  for (const raw of parsed.items) {
    const target = toTarget(raw);
    // 범위를 벗어나거나, 빈칸을 가리키거나(빈칸은 규칙 진단 담당), 범주와 칸 종류·단계가 맞지 않는 항목은 버립니다.
    if (!target || !isFilled(target, c) || !categoryFits(raw.category, target, stage)) continue;
    const severity = Math.min(3, Math.max(1, raw.severity)) as 1 | 2 | 3;
    items.push({ category: raw.category, target, severity, evidence: raw.evidence, source: "ai" });
  }
  return { items, concern: normalizeConcern(parsed.concern), meta };
}
