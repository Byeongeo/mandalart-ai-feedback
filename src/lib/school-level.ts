// 학급의 학교급(classes.school_level, 마이그레이션 0003_class_school_level). 서버·교사 화면 공용, 순수 값만.
// 학교급은 AI 피드백의 진단 기준과 카드 질문 수준만 바꿉니다(src/lib/feedback/diagnose.ts의 diagnosisSystem, cards.ts의 cardSystem).
// 카드 수, 단계, 비용, 안전 신호, 학생 화면은 학교급과 상관없이 같습니다. 기본은 중학교이고, 중학교 프롬프트는 이 설정 전과 같습니다.

export const SCHOOL_LEVELS = { middle: "중학교", high: "고등학교" } as const;
export type SchoolLevel = keyof typeof SCHOOL_LEVELS;
/** zod enum 등에 쓰는 순서 있는 목록(화면의 선택지 순서와 같음) */
export const SCHOOL_LEVEL_KEYS = ["middle", "high"] as const satisfies readonly SchoolLevel[];
export const DEFAULT_SCHOOL_LEVEL: SchoolLevel = "middle";

/** DB 값 등을 학교급으로 읽습니다. 모르는 값이면 기본(중학교). */
export function toSchoolLevel(v: unknown): SchoolLevel {
  return v === "high" ? "high" : "middle";
}

/**
 * 한 회차에 쓸 학교급. 첫 피드백은 지금 학급 설정을 따르고, 확인 피드백(2회차)은 그 단계 첫 피드백에 기록된 학교급
 * (feedback_rounds.diagnosis.school_level)을 따릅니다. 확인 피드백은 첫 카드와 같은 기준으로 고쳤는지 보기 때문입니다
 * (단계 중간에 교사가 바꿔도 확인 피드백의 기준은 바뀌지 않음). 기록이 없는 첫 피드백은 학교급 설정 전에 중학교 프롬프트로 만든 것이므로 중학교.
 */
export function roundSchoolLevel(classLevel: SchoolLevel, firstRound?: { school_level: unknown }): SchoolLevel {
  return firstRound ? toSchoolLevel(firstRound.school_level) : classLevel;
}
