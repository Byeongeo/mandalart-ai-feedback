import { CONCERN_KINDS, type ConcernKind } from "@/lib/feedback/categories";

// 교사 화면의 안전 신호 표시에 함께 쓰는 문구(학생 화면과 CSV에는 나오지 않음).
// 신호는 두 가지입니다.
// - AI 신호: 학생이 AI 피드백을 받을 때 AI가 글을 읽고 붙인 표시(피드백 회차마다)
// - 표현 검사: AI와 상관없이, 저장할 때마다 정해진 걱정 표현(예: '죽고 싶', '왕따 당')이 있는지 앱이 직접 찾은 표시

export function concernLabel(kind: ConcernKind | null | undefined): string {
  return CONCERN_KINDS[kind ?? "other"] ?? CONCERN_KINDS.other;
}

/**
 * 표현 검사 표시 글자. 지금 글에서 걸리는 종류와, 기록된 가장 무거운 종류가 지금 글에 없으면 그 종류를 따로 돌려줍니다.
 * (예: 자해 표현을 지우고 따돌림 표현만 남음 → now '따돌림·괴롭힘 피해', gone '자해·자살 관련')
 */
export function ruleKindsText(r: { kind: ConcernKind; now: readonly { kind: ConcernKind }[]; kind_now: boolean }): {
  now: string | null;
  gone: string | null;
} {
  return {
    now: r.now.length ? r.now.map((g) => concernLabel(g.kind)).join(", ") : null,
    gone: r.kind_now ? null : concernLabel(r.kind),
  };
}

export const RULE_NOW_TEXT = "지금 글에 있음";
export const RULE_GONE_TEXT = "지금 글에는 없음";

export function SafetyHint({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-amber-950 ${className}`}>
      ⚠️ 표시는 선생님이 직접 살펴보라는 <b>힌트일 뿐 진단이 아닙니다.</b> AI와 표현 검사는 오해할 수 있고, 표시가 없다고 문제가 없다는 뜻도 아닙니다.
      학생의 글을 직접 읽어 보고, 필요하면 다른 학생이 없는 곳에서 조용히 이야기를 나눠 보세요. 걱정되는 내용이면 학교의 정해진 절차(담임, 상담교사 등)를 따르세요.
      학생 화면과 CSV 파일에는 이 표시가 나오지 않습니다.
    </p>
  );
}

export const RULE_SOURCE_NOTE = "표현 검사: 학생 글이 저장될 때마다(AI 피드백을 받지 않아도) 앱이 정해진 걱정 표현을 찾습니다.";
export const AI_SOURCE_NOTE = "AI 신호: 학생이 AI 피드백을 받을 때 AI가 글을 읽고 붙인 표시입니다. 같은 글이 남아 있으면 피드백을 받을 때마다 다시 표시될 수 있어, 횟수는 걱정의 크기가 아닙니다.";
