import * as z from "zod";
import { currentStudent, isUuid, json } from "@/lib/auth";
import { sql } from "@/lib/db";
import { FeedbackError, loadRoundsForMandalart, requestFeedback } from "@/lib/feedback/round";
import type { Stage } from "@/lib/mandalart";
import { parseSaveMeta } from "@/lib/save-rules";

// AI 호출 시간 예산(round.ts의 REQUEST_BUDGET_MS, 240초)보다 넉넉하게 잡습니다(Vercel Hobby + Fluid 최대 300초).
export const maxDuration = 300;

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("core") }),
  z.object({ kind: z.literal("block"), index: z.number().int().min(0).max(7) }),
  z.object({ kind: z.literal("whole") }),
]);

// 피드백 요청. 본문: { stage, revision·prev·sends·hash(학생 화면의 저장 번호 정보, src/lib/save-rules.ts의 syncMeta) }
// 성공: { round }. 실패: { error, code }
// code: no_ai_key(503) | closed(409) | submitted(409) | not_ready(400) | used_up(409) | not_needed(400) | wait(429)
//       | busy(409, 이미 만드는 중) | too_many_failures(429, 최근 5분 오류 3번 이상) | conflict(409) | failed(503)
//       | stale(409, stale: true. 다른 탭·기기가 더 나중에 고쳐 이 화면의 글이 오래됨: 서버의 새 글로 피드백을 만들지 않음)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const st = await currentStudent();
  if (!st) return json({ error: "다시 로그인해 주세요." }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "만다라트를 찾을 수 없어요." }, 404);
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body?.stage);
  if (!parsed.success) return json({ error: "피드백 단계가 올바르지 않아요." }, 400);
  try {
    const round = await requestFeedback(st, id, parsed.data as Stage, parseSaveMeta(body));
    return json({ round });
  } catch (e) {
    if (e instanceof FeedbackError) {
      return json({ error: e.message, code: e.code ?? null, ...(e.code === "stale" ? { stale: true } : {}) }, e.status);
    }
    throw e;
  }
}

// 학생 화면이 서버에 저장된 피드백 회차를 다시 불러올 때 씁니다(요청이 끊기거나 실패한 뒤 맞추기).
// pending: 지금 피드백을 만드는 중인지(다른 요청이 '만드는 중' 표시를 잡고 있음). 화면은 이것이 false인데
// 새 회차가 없으면 기다리기를 그만둡니다(만들던 요청이 실패한 경우).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const st = await currentStudent();
  if (!st) return json({ error: "다시 로그인해 주세요." }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "만다라트를 찾을 수 없어요." }, 404);
  const [m] = await sql<{ pending: boolean }[]>`
    select coalesce(feedback_pending_until > now(), false) as pending from mandalarts where id = ${id} and student_id = ${st.id}`;
  if (!m) return json({ error: "만다라트를 찾을 수 없어요." }, 404);
  // 회차를 먼저 읽고 표시를 나중에 읽으면, 그 사이에 끝난 요청의 회차를 놓치고 pending=false만 볼 수 있으므로 표시를 먼저 읽습니다.
  return json({ rounds: await loadRoundsForMandalart(id), pending: m.pending });
}
