// 규칙 기반 안전 신호 기록(mandalarts.rule_concern_kind·rule_concern_at·rule_concern_current)을 저장 한 번마다 어떻게 바꿀지
// (순수 함수, 서버·단위 테스트 공용). 실제로 적는 곳은 save-mandalart.ts입니다(표현 검사 matchConcernText와, 그 검사가 칸 글을
// 다듬는 compactText를 넘겨 줌). 이 파일은 concern-rules.ts를 가져오지 않습니다(검사 방법은 넘겨받기만 함).
import type { ConcernKind } from "./feedback/categories";
import type { MandalartContent } from "./mandalart";

/** 칸마다 걸린 표현: '종류 + 다듬은 칸 글'을 열쇠로, 값은 종류와 그 글이 걸린 칸 수 */
export type CellMatches = Map<string, { kind: ConcernKind; count: number }>;

/**
 * 칸마다 검사해 걸린 (종류, 다듬은 칸 글) 쌍을 모읍니다. 같은 글이 여러 칸에 있으면 칸 수(count)를 셉니다.
 * compact는 표현 검사가 칸 글을 다듬는 방법(서버는 concern-rules.ts의 compactText: 공백·문장부호·기호·이모지 등을 지움)입니다.
 * 그래서 검사가 보지 않는 글자만 바꾼 것('죽고 싶다' → '죽고 싶다!')은 같은 글로 봅니다.
 */
export function cellMatches(
  c: MandalartContent, match: (text: string) => ConcernKind | null, compact: (text: string) => string,
): CellMatches {
  const out: CellMatches = new Map();
  for (const text of [c.goal, ...c.subs, ...c.actions.flat()]) {
    const kind = match(text);
    if (!kind) continue;
    const key = `${kind}\u0000${compact(text)}`;
    out.set(key, { kind, count: (out.get(key)?.count ?? 0) + 1 });
  }
  return out;
}

export type RuleConcernUpdate = { kind: ConcernKind | null; current: boolean; touch: boolean };

/**
 * 저장 한 번 뒤의 기록. stored는 지금 적힌 종류, before·after는 저장 전·후 내용의 cellMatches.
 * order는 종류의 무게 순서(앞일수록 무거움, 목록에 없는 종류는 가장 가벼움). 서버는 concern-rules.ts의 CONCERN_RULES 순서
 * (여러 칸이 걸렸을 때 대표 종류를 고르는 순서)를 넘깁니다(save-mandalart.ts의 RULE_CONCERN_ORDER).
 * - 종류는 지금까지 걸린 것 중 가장 무거운 것을 남깁니다(더 무거운 것이 걸리면 올리고, 가벼운 것으로 내리지 않음).
 * - current는 이번 저장 내용에 걸린 칸이 있는지입니다. 걸리지 않아도 종류는 지우지 않습니다.
 * - touch면 시각(rule_concern_at)을 지금으로 새로 적습니다(교사가 '확인했어요'를 누른 뒤라면 다시 '살펴볼 학생'이 됨).
 *   어떤 (종류, 칸 글) 쌍이 걸린 칸 수가 저장 전보다 늘면 새로 적습니다: 처음 걸림, 지웠다가 다시 씀, 다른 칸에 새 표현,
 *   걸린 표현을 고쳐 씀, 걸린 글을 다른 칸에 한 번 더 씀(복사).
 *   같은 글을 다시 저장하거나 걸린 글을 다른 칸으로 옮기기만 한 것(칸 수 그대로), 띄어쓰기·문장부호·기호·이모지처럼 검사가 보지 않는
 *   글자만 바꾼 것(cellMatches의 compact)은 새로 적지 않습니다.
 *   쌍은 그대로여도 처음 기록되거나 더 무거운 종류로 올라가면 새로 적습니다(표현 목록이 바뀌어 같은 글이 새로 걸린 경우 등).
 */
export function nextRuleConcern(
  stored: ConcernKind | null, before: CellMatches, after: CellMatches, order: readonly ConcernKind[],
): RuleConcernUpdate {
  const weight = (k: ConcernKind) => (order.includes(k) ? order.indexOf(k) : order.length);
  let kind = stored;
  for (const { kind: k } of after.values()) if (kind === null || weight(k) < weight(kind)) kind = k;
  const fresh = [...after].some(([key, m]) => m.count > (before.get(key)?.count ?? 0));
  return { kind, current: after.size > 0, touch: fresh || kind !== stored };
}
