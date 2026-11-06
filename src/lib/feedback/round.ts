import "server-only";
import { sql } from "../db";
import {
  MandalartContent, cellChanged, cellText, changedPartners, duplicateRemains, normalizeCell, recheckKind, stageDone, stageNotReady, targetKey, targetLabel,
  type Stage, type Target,
} from "../mandalart";
import { CLASS_CLOSED_MESSAGE, type StudentRow } from "../auth";
import { STALE_MESSAGE, knowsLatest, type SaveMeta } from "../save-rules";
import { AiCallError, AiKeyMissingError, aiErrorCode, assertAiReady, metaLabel, type CallMeta } from "./client";
import { aiDiagnose, ruleDiagnose, type DiagnosisItem } from "./diagnose";
import { aiCards, issuePlans, selectItems, type CardDraft, type CardPlan } from "./cards";
import { CARDS_PER_STAGE, NEW_CARDS_ON_RECHECK, type Category, type Concern, type RejectReason } from "./categories";
import type { AiErrorCode } from "./ai-errors";
import { roundSchoolLevel, toSchoolLevel, type SchoolLevel } from "../school-level";

/**
 * 학생에게 그대로 보여 줄 수 있는 오류. code(화면 분기용):
 * no_ai_key | closed | submitted | stale | not_ready | used_up | not_needed | wait | busy | too_many_failures | conflict | failed
 */
export class FeedbackError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

export const MIN_INTERVAL_MS = 30_000;
// 요청 하나가 AI 호출(진단 + 카드)에 쓸 수 있는 전체 시간. 라우트 maxDuration(300초)보다 짧게 잡아,
// AI가 느린 날에도 함수가 강제 종료되기 전에 오류를 기록하고 학생에게 다시 시도하라고 알립니다.
const REQUEST_BUDGET_MS = 240_000;
// 피드백을 만드는 중 표시(mandalarts.feedback_pending_until)를 얼마나 잡아 둘지. 함수가 강제로 끝나 표시를 지우지 못해도
// 이 시간이 지나면 다시 요청할 수 있습니다. 라우트 maxDuration(300초)과 같게 둡니다.
const PENDING_LEASE_MS = 300_000;
// 최근 5분 안에 피드백 오류가 3번 이상이면 더 부르지 않습니다(같은 오류로 크레딧이 계속 나가는 것을 막음).
export const FAILURE_WINDOW_MINUTES = 5;
export const MAX_RECENT_FAILURES = 3;

export const BUSY_MESSAGE = "이미 피드백을 만들고 있어요. 잠시 뒤 화면에 나타나요.";
export const TOO_MANY_FAILURES_MESSAGE =
  "피드백을 만드는 데 여러 번 실패했어요. 선생님께 말씀드려 주세요. (몇 분 뒤에 다시 해 볼 수 있어요)";

// 피드백 오류 기록. 학생 이름·만다라트 내용·AI 원문(거절 문구 등)은 남기지 않고, 코드와 상태만 남깁니다.
async function logFeedbackError(studentId: string, info: { stage: string; block_index: number | null; attempt: number; elapsed_ms: number; error: unknown; code?: AiErrorCode }) {
  const e = info.error;
  const payload = {
    stage: info.stage, block_index: info.block_index, attempt: info.attempt, elapsed_ms: info.elapsed_ms,
    code: info.code ?? aiErrorCode(e),
    status: e instanceof AiCallError ? e.status ?? null : null,
  };
  await sql`insert into event_log (student_id, type, payload) values (${studentId}, 'feedback_error', ${sql.json(payload)})`.catch(() => {});
}

type PrevRound = {
  id: string; round_no: number; stage: string; block_index: number | null; attempt: number; created_at: Date;
  content_snapshot: unknown; n_cards: number; n_rejected: number; school_level: string | null;
};

/** meta: 학생 화면의 저장 번호 정보(save-rules.ts). 다른 탭·기기가 더 나중에 고친 글로 피드백을 만들지 않으려고 봅니다. */
export async function requestFeedback(student: StudentRow, mandalartId: string, stage: Stage, meta: SaveMeta) {
  const requestedAt = new Date();
  const deadline = requestedAt.getTime() + REQUEST_BUDGET_MS;
  if (!student.is_open) throw new FeedbackError(CLASS_CLOSED_MESSAGE, 409, "closed");
  try {
    assertAiReady();
  } catch (e) {
    if (e instanceof AiKeyMissingError) throw new FeedbackError(e.message, 503, "no_ai_key");
    throw e;
  }

  // AI를 부르기 전에 행을 잠그고 확인한 뒤 '만드는 중' 표시를 잡습니다. 두 번 누르기·두 기기·여러 단계 동시 요청은
  // 하나만 통과하고 나머지는 409 busy로 돌려보내 유료 호출이 겹치지 않게 합니다. 표시는 끝나면(성공·실패 모두) 지웁니다.
  // 피드백은 이때 확인한 글로 만듭니다(확인과 표시 사이에 다른 기기가 저장한 글로 만들지 않게).
  // 학급의 학교급(AI 진단 기준·카드 질문 수준)도 이때 읽습니다. 교사가 바꾸면 그다음 첫 피드백부터 적용됩니다(학급 행은 잠그지 않음).
  // 확인 피드백은 그 단계 첫 피드백의 학교급을 따릅니다(claimedFeedback의 roundSchoolLevel).
  const pendingUntil = new Date(Date.now() + PENDING_LEASE_MS);
  const { content, level } = await sql.begin(async (tx) => {
    const [m] = await tx<{ status: string; revision: number; content: unknown; pending: boolean }[]>`
      select status, revision, content, coalesce(feedback_pending_until > now(), false) as pending
      from mandalarts where id = ${mandalartId} and student_id = ${student.id}
      for update`;
    if (!m) throw new FeedbackError("만다라트를 찾을 수 없어요.", 404);
    if (m.status === "submitted") throw new FeedbackError("이미 제출한 만다라트예요.", 409, "submitted");
    // 저장과 같은 확인(save-rules.ts의 knowsLatest): 화면이 서버의 지금 글을 모르면(다른 탭·기기가 더 나중에 고침) 받지 않습니다.
    if (!knowsLatest(m, meta)) throw new FeedbackError(STALE_MESSAGE, 409, "stale");
    // 같은 오류가 되풀이되면(키·크레딧·모델 문제 등) 학생이 계속 눌러도 AI를 부르지 않습니다.
    const [{ n: recentFailures }] = await tx<{ n: number }[]>`
      select count(*)::int as n from event_log
      where student_id = ${student.id} and type = 'feedback_error'
        and created_at > now() - make_interval(mins => ${FAILURE_WINDOW_MINUTES})`;
    if (recentFailures >= MAX_RECENT_FAILURES) throw new FeedbackError(TOO_MANY_FAILURES_MESSAGE, 429, "too_many_failures");
    if (m.pending) throw new FeedbackError(BUSY_MESSAGE, 409, "busy");
    const parsed = MandalartContent.parse(m.content);
    const [cls] = await tx<{ school_level: string }[]>`select school_level from classes where id = ${student.class_id}`;
    await tx`update mandalarts set feedback_pending_until = ${pendingUntil} where id = ${mandalartId}`;
    return { content: parsed, level: toSchoolLevel(cls?.school_level) };
  });
  try {
    return await claimedFeedback(student, mandalartId, stage, content, level, requestedAt, deadline);
  } finally {
    await sql`update mandalarts set feedback_pending_until = null
              where id = ${mandalartId} and feedback_pending_until = ${pendingUntil}`.catch(() => {});
  }
}

// '만드는 중' 표시를 잡은 뒤에 하는 일. 확인(회차·30초 간격)도 표시를 잡은 뒤에 해야 동시에 들어온 요청이 같은 확인을 통과하지 못합니다.
async function claimedFeedback(
  student: StudentRow, mandalartId: string, stage: Stage, content: MandalartContent, classLevel: SchoolLevel, requestedAt: Date, deadline: number,
) {
  const notReady = stageNotReady(stage, content);
  if (notReady) throw new FeedbackError(notReady, 400, "not_ready");

  // n_rejected: 마지막 응답이 '안 할래요'인 문제 카드 수(모두 거부하면 그 단계는 끝난 것으로 봅니다)
  const prev = await sql<PrevRound[]>`
    select r.id, r.round_no, r.stage, r.block_index, r.attempt, r.created_at, r.content_snapshot,
      r.diagnosis->>'school_level' as school_level,
      (select count(*)::int from feedback_cards c where c.round_id = r.id and c.kind = 'issue') as n_cards,
      (select count(*)::int from feedback_cards c where c.round_id = r.id and c.kind = 'issue'
         and (select fr.action from feedback_responses fr where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1) = 'reject') as n_rejected
    from feedback_rounds r where r.mandalart_id = ${mandalartId} order by r.round_no`;
  const blockIndex = stage.kind === "block" ? stage.index : null;
  const sameStage = prev.filter((r) => r.stage === stage.kind && r.block_index === blockIndex);
  const attempt = sameStage.length + 1;
  if (attempt > Math.min(student.max_feedback_rounds, 2)) {
    throw new FeedbackError("이 단계의 피드백은 모두 받았어요. 카드를 참고해 직접 고쳐 보세요.", 409, "used_up");
  }
  if (stage.kind === "whole" && attempt === 1) {
    const coreDone = stageDone(prev.filter((r) => r.stage === "core"), student.max_feedback_rounds);
    const blocksDone = Array.from({ length: 8 }, (_, i) =>
      stageDone(prev.filter((r) => r.stage === "block" && r.block_index === i), student.max_feedback_rounds),
    ).filter(Boolean).length;
    if (!coreDone || blocksDone < 8) {
      throw new FeedbackError(`전체 피드백은 중심·세부 목표와 8개 블록의 피드백(확인 피드백 포함)을 모두 마친 뒤에 받을 수 있어요. (블록 ${blocksDone}/8)`, 400, "not_ready");
    }
  }

  // 확인 피드백(2회차): 카드가 가리킨 칸(또는 그 짝 칸, mandalart.ts의 partnerTargets)을 하나 이상 고쳐야 받을 수 있습니다.
  // 띄어쓰기만 바꾼 것은 고친 것으로 보지 않습니다. 이 조건 덕분에 확인 피드백에는 1회차 카드 판정이 적어도 하나 있습니다.
  let firstCards: { id: string; category: Category; target: Target; evidence: string; action: string | null }[] = [];
  let firstContent: MandalartContent | null = null;
  if (attempt === 2) {
    const first = sameStage[0];
    if (first.n_cards === 0) throw new FeedbackError("이 단계는 고칠 점이 없어서 확인 피드백이 필요 없어요.", 400, "not_needed");
    firstContent = MandalartContent.parse(first.content_snapshot);
    firstCards = await sql`
      select c.id, c.category, c.target, coalesce(
               (select it->>'evidence' from jsonb_array_elements(r.diagnosis->'items') it
                where it->>'category' = c.category and it->'target' = c.target limit 1), '') as evidence,
             (select fr.action from feedback_responses fr where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1) as action
      from feedback_cards c join feedback_rounds r on r.id = c.round_id
      where c.round_id = ${first.id} and c.kind = 'issue' order by c.position`;
    const fc = firstContent;
    const touched = (c: (typeof firstCards)[number]) =>
      cellChanged(fc, content, c.target) || changedPartners(c.category, c.target, fc, content).length > 0;
    if (!firstCards.some(touched)) {
      throw new FeedbackError("카드가 가리킨 칸을 하나 이상 고친 뒤에 확인 피드백을 받을 수 있어요.", 400, "not_ready");
    }
  }

  // 이 회차의 학교급: 첫 피드백은 학급 설정, 확인 피드백은 그 단계 첫 피드백에 기록된 학교급('같은 기준으로 다시 판단'과 맞게).
  const level = roundSchoolLevel(classLevel, attempt === 2 ? sameStage[0] : undefined);

  const last = prev[prev.length - 1];
  const waitMs = last ? MIN_INTERVAL_MS - (Date.now() - last.created_at.getTime()) : 0;
  if (waitMs > 0) {
    throw new FeedbackError(`피드백을 반영할 시간을 가진 뒤 다시 요청해 주세요. ${Math.ceil(waitMs / 1000)}초 뒤에 받을 수 있어요.`, 429, "wait");
  }
  const nextNo = (last?.round_no ?? 0) + 1;

  let plans: CardPlan[], cards: CardDraft[], allItems: DiagnosisItem[];
  let diagMeta: CallMeta | null, cardMeta: CallMeta | null = null;
  let concern: Concern;
  try {
    const rule = ruleDiagnose(content, stage);
    const prevNote = firstCards.length
      ? `이전 피드백에서 지적한 항목(같은 기준으로 다시 판단하세요. 고쳐서 해결되었으면 다시 보고하지 마세요): ${firstCards
          .map((c) => `${c.category} @ ${targetKey(c.target)}`)
          .join(", ")}`
      : undefined;
    // AI에는 만다라트 글과 학교급에 맞춘 지시만 보냅니다(학생 이름·번호·학급 없음).
    const ai = await aiDiagnose(content, stage, level, prevNote, deadline);
    diagMeta = ai.meta;
    concern = ai.concern;
    allItems = [...rule, ...ai.items];

    if (attempt === 1) {
      plans = issuePlans(selectItems(allItems, CARDS_PER_STAGE[stage.kind]));
    } else {
      // 1회차 카드별 해결 여부(규칙은 mandalart.ts의 recheckKind):
      // 그 칸(또는 짝 칸)을 고쳤고 같은 문제가 다시 진단되지 않으면 해결,
      // 고쳤는데 문제가 남았거나 고치지 않았지만 '해 볼게요'를 골랐으면 '아직 해결 안 됨'.
      const fc = firstContent!;
      const recheck: CardPlan[] = [];
      for (const c of firstCards) {
        const whole = c.target.kind === "whole";
        const before = cellText(fc, c.target), after = cellText(content, c.target);
        const targetChanged = cellChanged(fc, content, c.target);
        const partners = changedPartners(c.category, c.target, fc, content);
        const cur = allItems.find((it) => it.category === c.category && targetKey(it.target) === targetKey(c.target));
        // 아직 남았는지: 같은 문제가 다시 진단됨. 반복은 칸 위치가 아니라 글로 봅니다(셋 이상 같았던 경우 등).
        const remains = !!cur || (c.category === "DUPLICATE" && duplicateRemains(content, c.target));
        // 문제 칸을 지우기만 한 경우는 해결로 보지 않습니다(빈칸이 되어 AI 진단에서 빠지기 때문).
        const cleared = !whole && c.category !== "EMPTY" && targetChanged && !normalizeCell(after);
        const kind = recheckKind({ targetChanged, partnerChanged: partners.length > 0, stillThere: remains || cleared, accepted: c.action === "accept" });
        if (!kind) continue;
        recheck.push({
          item: { category: c.category, target: c.target, evidence: cur?.evidence ?? c.evidence },
          kind, prevCardId: c.id,
          before: whole ? undefined : before,
          after: whole ? undefined : after,
          changedElsewhere: kind === "resolved" && !targetChanged && !whole
            ? partners.slice(0, 3).map((t) => `${targetLabel(t, fc)} → '${cellText(content, t) || "(비어 있음)"}'`)
            : undefined,
        });
      }
      const firstKeys = new Set(firstCards.map((c) => targetKey(c.target)));
      const fresh = selectItems(allItems.filter((it) => !firstKeys.has(targetKey(it.target))), NEW_CARDS_ON_RECHECK);
      plans = [...recheck, ...issuePlans(fresh)];
    }

    const out = await aiCards(content, plans, level, deadline);
    cards = out.cards;
    cardMeta = out.meta;
  } catch (e) {
    // 기록만 남기고 다시 시도하도록 안내합니다. 학생 이름·만다라트 내용·AI 원문은 기록하지 않습니다.
    await logFeedbackError(student.id, {
      stage: stage.kind, block_index: blockIndex, attempt, elapsed_ms: Date.now() - requestedAt.getTime(), error: e,
    });
    if (e instanceof AiKeyMissingError) throw new FeedbackError(e.message, 503, "no_ai_key");
    throw new FeedbackError("피드백을 만드는 중 문제가 생겼어요. 잠시 후 다시 눌러 주세요.", 503, "failed");
  }

  // 진단 기록: 진단 항목, 카드로 고른 항목, 실제로 응답한 모델, 사용량(비용 확인용), 이 회차에 쓴 학교급
  const diagnosis = {
    school_level: level,
    items: allItems,
    selected: plans.map((p) => ({ category: p.item.category, target: p.item.target, kind: p.kind })),
    usage: { diagnosis: diagMeta?.usage ?? null, cards: cardMeta?.usage ?? null },
    models: { diagnosis: metaLabel(diagMeta), cards: cardMeta || plans.length ? metaLabel(cardMeta) : null },
  };

  let roundId: string;
  try {
    roundId = await sql.begin(async (tx) => {
      // 아직 '작성 중'일 때만 저장합니다. 제출(save-mandalart.ts)은 만드는 중에는 받지 않지만, 표시 시간이 지난 뒤 제출된 경우
      // 제출 뒤에 회차가 생겨 답할 수 없는 카드가 남지 않도록 여기서 한 번 더 확인합니다(행을 잠가 제출과 엇갈리지 않게).
      const [cur] = await tx<{ status: string }[]>`select status from mandalarts where id = ${mandalartId} for share`;
      if (cur?.status !== "draft") throw new FeedbackError("이미 제출한 만다라트라서 피드백을 저장하지 않았어요.", 409, "submitted");
      const [r] = await tx<{ id: string }[]>`
        insert into feedback_rounds (mandalart_id, round_no, stage, block_index, attempt, content_snapshot, diagnosis, model,
                                     concern, concern_kind)
        values (${mandalartId}, ${nextNo}, ${stage.kind}, ${blockIndex}, ${attempt}, ${tx.json(content)},
                ${tx.json(diagnosis as never)}, ${metaLabel(diagMeta)}, ${concern.flag}, ${concern.kind})
        returning id`;
      for (const [i, c] of cards.entries()) {
        await tx`insert into feedback_cards (round_id, position, category, target, body, kind, prev_card_id)
                 values (${r.id}, ${i}, ${c.category}, ${tx.json(c.target)}, ${c.body}, ${c.kind}, ${c.prevCardId ?? null})`;
      }
      return r.id;
    });
  } catch (e) {
    if (e instanceof FeedbackError) throw e;
    // '만드는 중' 표시 덕분에 거의 없지만, 표시 시간이 지난 뒤 같은 회차 번호로 겹친 경우: 먼저 끝난 쪽만 저장됩니다.
    if ((e as { code?: string }).code === "23505") {
      throw new FeedbackError(BUSY_MESSAGE, 409, "conflict");
    }
    await logFeedbackError(student.id, {
      stage: stage.kind, block_index: blockIndex, attempt, elapsed_ms: Date.now() - requestedAt.getTime(), error: e, code: "save_failed",
    });
    throw new FeedbackError("피드백을 저장하는 중 문제가 생겼어요. 잠시 후 다시 눌러 주세요.", 503, "failed");
  }

  return loadRound(roundId);
}

export type CardView = {
  id: string;
  position: number;
  category: Category;
  target: Target;
  body: string;
  kind: "issue" | "resolved" | "unresolved";
  /** 마지막 응답(없으면 null). reason_code·reason_text는 '안 할래요'일 때만, 그것도 선택 */
  response: { action: "accept" | "reject"; reason_code: RejectReason | null; reason_text: string | null } | null;
};
export type RoundView = {
  id: string;
  round_no: number;
  stage: "core" | "block" | "whole";
  block_index: number | null;
  attempt: number;
  created_at: Date;
  cards: CardView[];
};

// 학생 화면용: 진단 내용·안전 신호·모델은 보내지 않습니다.
async function loadRounds(where: { roundId?: string; mandalartId?: string }): Promise<RoundView[]> {
  const rounds = where.roundId
    ? await sql<Omit<RoundView, "cards">[]>`
        select id, round_no, stage, block_index, attempt, created_at from feedback_rounds where id = ${where.roundId}`
    : await sql<Omit<RoundView, "cards">[]>`
        select id, round_no, stage, block_index, attempt, created_at from feedback_rounds
        where mandalart_id = ${where.mandalartId!} order by round_no`;
  if (rounds.length === 0) return [];
  const cards = await sql<(CardView & { round_id: string })[]>`
    select c.round_id, c.id, c.position, c.category, c.target, c.body, c.kind,
      (select json_build_object('action', fr.action, 'reason_code', fr.reason_code, 'reason_text', fr.reason_text)
         from feedback_responses fr where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1) as response
    from feedback_cards c where c.round_id = any(${rounds.map((r) => r.id)}::uuid[]) order by c.position`;
  return rounds.map((r) => ({
    ...r,
    cards: cards.filter((c) => c.round_id === r.id).map((c) => {
      const { round_id, ...card } = c;
      void round_id;
      return card;
    }),
  }));
}

export async function loadRound(roundId: string): Promise<RoundView> {
  const [r] = await loadRounds({ roundId });
  return r;
}

export async function loadRoundsForMandalart(mandalartId: string): Promise<RoundView[]> {
  return loadRounds({ mandalartId });
}
