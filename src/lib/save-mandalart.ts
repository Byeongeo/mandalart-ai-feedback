import "server-only";
import { sql } from "./db";
import { CONCERN_RULES, compactText, matchConcernText } from "./concern-rules";
import type { ConcernKind } from "./feedback/categories";
import type { MandalartContent } from "./mandalart";
import { isContent, nextRevision, sameContent, saveDecision, type SaveMeta } from "./save-rules";
import { cellMatches, nextRuleConcern, type CellMatches } from "./rule-concern-state";
import { wellFormedContent } from "./student";

// 규칙 신호 종류의 무게 순서(앞일수록 무거움): concern-rules.ts가 여러 칸이 걸렸을 때 대표 종류를 고르는 순서와 같게 둡니다.
const RULE_CONCERN_ORDER: readonly ConcernKind[] = CONCERN_RULES.map((r) => r.kind);

export type SaveOutcome =
  | { ok: true; revision: number }
  | { ok: false; reason: "not_found" | "submitted" | "stale" | "feedback_pending" };

/**
 * 자동 저장(PUT)과 제출(submit)이 함께 쓰는 저장. 한 트랜잭션에서 행을 잠근 뒤(for update) 확인하고 고칩니다.
 * - 제출한 만다라트는 고치지 않습니다(늦게 도착한 자동 저장이 제출한 내용을 덮어쓰지 않게). 다만 제출한 글과 똑같은 글로
 *   다시 제출하면(제출 응답이 끊겨 다시 누름, 같은 제출 요청이 두 번 도착) 이미 제출된 것이므로 성공으로 답합니다.
 * - 화면이 서버의 지금 글을 알 때만 저장하고(save-rules.ts의 saveDecision), 올린 새 번호(nextRevision)를 돌려줍니다.
 *   모르는 화면이 서버 글과 똑같은 글을 보냈으면(같은 요청이 두 번 도착 등) 자동 저장은 고치지 않고 지금 번호를 돌려줍니다.
 * - 짝이 없는 반쪽 글자(이모지를 반으로 자른 것 등)는 '�'로 바꿔 저장합니다(DB가 받지 않아 저장이 계속 실패하지 않게).
 * - 규칙 기반 안전 신호(교사 화면 전용)를 함께 적습니다(rule-concern-state.ts의 nextRuleConcern, 저장 전·후 칸 글 비교).
 * - 제출은 AI 피드백을 만드는 중이면 받지 않습니다(만든 피드백이 제출 뒤에 저장되어 답할 수 없게 되지 않도록).
 */
export async function saveMandalart(input: {
  id: string;
  studentId: string;
  content: MandalartContent;
  meta: SaveMeta;
  submit: boolean;
}): Promise<SaveOutcome> {
  const content = wellFormedContent(input.content);
  // 칸 글 비교는 표현 검사와 같은 방법(compactText)으로 다듬어서 합니다('죽고 싶다' 뒤에 '!'만 붙여도 새로 걸린 것으로 보지 않게).
  const after = cellMatches(content, matchConcernText, compactText);
  return sql.begin(async (tx): Promise<SaveOutcome> => {
    // 자동 저장 함수의 시간 제한(route.ts의 maxDuration 12초) 안에 끝나도록 문장 하나는 4초까지만 기다립니다.
    await tx`set local statement_timeout = '4s'`;
    const [row] = await tx<{
      status: string; revision: number; content: unknown; rule_concern_kind: ConcernKind | null; feedback_pending: boolean;
    }[]>`
      select status, revision, content, rule_concern_kind,
        coalesce(feedback_pending_until > now(), false) as feedback_pending
      from mandalarts where id = ${input.id} and student_id = ${input.studentId}
      for update`;
    if (!row) return { ok: false, reason: "not_found" };
    if (row.status !== "draft") {
      return input.submit && sameContent(content, row.content) ? { ok: true, revision: row.revision } : { ok: false, reason: "submitted" };
    }
    const decision = saveDecision(row, input.meta, content);
    if (decision === "stale") return { ok: false, reason: "stale" };
    if (input.submit && row.feedback_pending) return { ok: false, reason: "feedback_pending" };
    if (decision === "same" && !input.submit) return { ok: true, revision: row.revision };
    const before: CellMatches = isContent(row.content) ? cellMatches(row.content, matchConcernText, compactText) : new Map();
    const rule = nextRuleConcern(row.rule_concern_kind, before, after, RULE_CONCERN_ORDER);
    // 시각은 이 문장을 실행하는 때(clock_timestamp)로 적습니다. now()는 트랜잭션을 시작한 때라, 행 잠금을 기다리는 사이
    // 교사가 '확인했어요'를 누르면 새 신호가 확인 시각보다 앞선 것으로 적혀 다시 '살펴볼 학생'이 되지 않을 수 있습니다.
    const [saved] = await tx<{ revision: number }[]>`
      update mandalarts set content = ${tx.json(content)}, revision = ${nextRevision(row.revision, input.meta)}, updated_at = now(),
        status = case when ${input.submit}::boolean then 'submitted' else status end,
        submitted_at = case when ${input.submit}::boolean then now() else submitted_at end,
        rule_concern_kind = ${rule.kind}::text,
        rule_concern_current = ${rule.current}::boolean,
        rule_concern_at = case when ${rule.touch}::boolean then clock_timestamp() else rule_concern_at end
      where id = ${input.id}
      returning revision`;
    return { ok: true, revision: saved.revision };
  });
}
