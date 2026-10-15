// 진단 범주, 카드 수 제한, '안 할래요' 이유, 안전 신호 종류(서버·학생 화면·교사 화면 공용, 순수 값만)

export const CATEGORIES = {
  EMPTY: { label: "빈칸", priority: 1 },
  GOAL_VAGUE: { label: "중심 목표가 막연함", priority: 2 },
  SUB_MISALIGNED: { label: "세부 목표와 중심 목표의 연결 약함", priority: 3 },
  SUB_OVERLAP: { label: "세부 목표끼리 겹침", priority: 4 },
  ACTION_NOT_ACTIONABLE: { label: "실천이 행동이 아니라 다짐", priority: 5 },
  ACTION_NOT_MEASURABLE: { label: "실천했는지 확인하기 어려움", priority: 6 },
  ACTION_MISALIGNED: { label: "실천과 세부 목표의 연결 약함", priority: 7 },
  DUPLICATE: { label: "같은 내용 반복", priority: 8 },
  UNBALANCED: { label: "한쪽으로 치우침", priority: 9 },
} as const;

export type Category = keyof typeof CATEGORIES;

// 확인 피드백(2회차)에 새로 보여 줄 문제 카드 최대 수
export const NEW_CARDS_ON_RECHECK = 2;

// 단계별로 한 번의 피드백에서 보여 줄 최대 카드 수
export const CARDS_PER_STAGE = { core: 3, block: 3, whole: 2 } as const;

// '안 할래요'를 고를 때 붙일 수 있는 이유(선택)
export const REJECT_REASONS = {
  already_ok: "지금 그대로도 괜찮아요",
  not_my_goal: "내 목표와 맞지 않아요",
  dont_understand: "무슨 뜻인지 모르겠어요",
  other_way: "다른 방법으로 고칠래요",
  other: "기타",
} as const;
export type RejectReason = keyof typeof REJECT_REASONS;
export const REJECT_REASON_KEYS = Object.keys(REJECT_REASONS) as RejectReason[];

// 안전 신호 종류(교사 화면 전용). 진단이 아니라 '선생님이 직접 살펴보세요'라는 힌트입니다.
export const CONCERN_KINDS = {
  self_harm: "자해·자살 관련",
  abuse: "학대·폭력 피해",
  bullying: "따돌림·괴롭힘 피해",
  eating: "섭식 문제",
  violence: "타인에 대한 폭력",
  other: "기타 걱정되는 내용",
} as const;
export type ConcernKind = keyof typeof CONCERN_KINDS;
export const CONCERN_KIND_KEYS = Object.keys(CONCERN_KINDS) as ConcernKind[];

export type Concern = { flag: boolean; kind: ConcernKind | null };

// AI가 돌려준 안전 신호를 너그럽게 다듬습니다(실패로 보지 않음): 값이 없거나 모양이 이상하면 표시 없음,
// 표시가 없으면 종류도 없음, 표시는 있는데 종류가 없거나 낯설면 'other'.
export function normalizeConcern(raw: unknown): Concern {
  if (!raw || typeof raw !== "object") return { flag: false, kind: null };
  const r = raw as { flag?: unknown; kind?: unknown };
  if (r.flag !== true) return { flag: false, kind: null };
  const kind = typeof r.kind === "string" && Object.hasOwn(CONCERN_KINDS, r.kind) ? (r.kind as ConcernKind) : "other";
  return { flag: true, kind };
}
