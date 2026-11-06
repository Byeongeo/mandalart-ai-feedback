import "server-only";
import { NOW, sql } from "./db";
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

// 읽은 행이 쓰기 전에 바뀌었을 때 다시 읽어 판단하는 최대 횟수. 같은 학생의 탭·기기끼리만 겹치므로 거의 쓰이지 않습니다.
const MAX_TRIES = 4;

/**
 * 자동 저장(PUT)과 제출(submit)이 함께 쓰는 저장.
 *
 * 트랜잭션 없이(D1은 'begin … commit'을 못 씀) 원래(행 잠금 for update)와 같은 보장을 지키는 방법: 낙관적 잠금(compare-and-set).
 * 1) 행을 읽고(번호 revision, 글, 규칙 신호 종류, 피드백 만드는 중인지) 아래 규칙으로 판단합니다.
 * 2) 바꿀 때는 '읽은 번호가 그대로이고 아직 작성 중이며, 제출이면 피드백을 만드는 중이 아닐 때만' 바꾸는 한 문장(update … where
 *    revision = 읽은 번호 …)을 씁니다. D1은 한 DB의 문장을 하나씩 차례로 실행하므로 확인과 쓰기가 이 문장 안에서 한꺼번에 일어납니다.
 * 3) 바뀐 행이 없으면 그사이 다른 저장·제출·피드백 표시가 끼어든 것이므로, 처음부터 다시 읽어 판단합니다(MAX_TRIES번까지,
 *    그래도 안 되면 'stale': 화면은 서버 글을 다시 읽어 맞춤).
 * 글(content)과 규칙 신호(rule_concern_*)를 바꾸는 곳은 이 함수뿐이고 바꿀 때마다 번호가 반드시 커지므로(nextRevision),
 * 번호가 같으면 글과 신호 종류도 읽은 그대로입니다. 그래서 규칙 신호(rule-concern-state.ts의 nextRuleConcern)는 실제로 덮어쓰는
 * 바로 그 행의 저장 전 글과 비교해 계산됩니다. 오래된 탭·다른 기기가 더 새 글을 덮어쓸 수 없는 것도 같은 번호 확인 덕분입니다.
 *
 * - 제출한 만다라트는 고치지 않습니다(늦게 도착한 자동 저장이 제출한 내용을 덮어쓰지 않게). 다만 제출한 글과 똑같은 글로
 *   다시 제출하면(제출 응답이 끊겨 다시 누름, 같은 제출 요청이 두 번 도착) 이미 제출된 것이므로 성공으로 답합니다.
 * - 화면이 서버의 지금 글을 알 때만 저장하고(save-rules.ts의 saveDecision), 올린 새 번호(nextRevision)를 돌려줍니다.
 *   모르는 화면이 서버 글과 똑같은 글을 보냈으면(같은 요청이 두 번 도착 등) 자동 저장은 고치지 않고 지금 번호를 돌려줍니다.
 * - 짝이 없는 반쪽 글자(이모지를 반으로 자른 것 등)는 '�'로 바꿔 저장합니다.
 * - 규칙 기반 안전 신호(교사 화면 전용)를 함께 적습니다(rule-concern-state.ts의 nextRuleConcern, 저장 전·후 칸 글 비교).
 * - 제출은 AI 피드백을 만드는 중이면 받지 않습니다(만든 피드백이 제출 뒤에 저장되어 답할 수 없게 되지 않도록).
 *   피드백 요청(feedback/round.ts)도 '작성 중이고 만드는 중이 아닐 때만' 표시를 잡는 한 문장을 쓰므로 둘은 엇갈리지 않습니다.
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
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const [row] = await sql<{
      status: string; revision: number; content: unknown; rule_concern_kind: ConcernKind | null; feedback_pending: boolean;
    }[]>`
      select status, revision, content, rule_concern_kind,
        coalesce(feedback_pending_until > ${NOW}, 0) as feedback_pending
      from mandalarts where id = ${input.id} and student_id = ${input.studentId}`;
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
    // 시각(NOW)은 이 문장을 실행하는 때의 DB 시각입니다(교사의 '확인했어요' 시각과 같은 시계로 비교됨).
    const saved = await sql<{ revision: number }[]>`
      update mandalarts set content = ${sql.json(content)}, revision = ${nextRevision(row.revision, input.meta)}, updated_at = ${NOW},
        status = case when ${input.submit} then 'submitted' else status end,
        submitted_at = case when ${input.submit} then ${NOW} else submitted_at end,
        rule_concern_kind = ${rule.kind},
        rule_concern_current = ${rule.current},
        rule_concern_at = case when ${rule.touch} then ${NOW} else rule_concern_at end
      where id = ${input.id} and student_id = ${input.studentId}
        and revision = ${row.revision} and status = 'draft'
        and (${!input.submit} or feedback_pending_until is null or feedback_pending_until <= ${NOW})
      returning revision`;
    if (saved.length) return { ok: true, revision: saved[0].revision };
    // 읽은 뒤 다른 요청이 행을 바꿨습니다(번호·상태·피드백 표시). 다시 읽어 처음부터 판단합니다.
  }
  return { ok: false, reason: "stale" };
}
