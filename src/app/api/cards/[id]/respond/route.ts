import * as z from "zod";
import { sql } from "@/lib/db";
import { CLASS_CLOSED_MESSAGE, currentStudent, isUuid, json } from "@/lib/auth";
import { REJECT_REASON_KEYS, type RejectReason } from "@/lib/feedback/categories";

// 카드에 '해 볼게요'(accept) / '안 할래요'(reject). 안 할래요의 이유(reasonCode·reasonText)는 고르지 않아도 됩니다.
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({
    action: z.literal("reject"),
    reasonCode: z.enum(REJECT_REASON_KEYS as [RejectReason, ...RejectReason[]]).nullish(),
    reasonText: z.string().trim().max(100).nullish(),
  }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const st = await currentStudent();
  if (!st) return json({ error: "다시 로그인해 주세요." }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "응답할 수 없는 피드백이에요." }, 404);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "응답 형식이 올바르지 않아요. 이유는 100자까지 쓸 수 있어요." }, 400);
  if (!st.is_open) return json({ error: CLASS_CLOSED_MESSAGE, closed: true }, 409);

  // 본인 카드이고, 제출 전 만다라트이며, 같은 단계에 더 나중 회차(확인 피드백)가 없는 카드여야 합니다.
  const [card] = await sql<{ superseded: boolean }[]>`
    select exists (
             select 1 from feedback_rounds r2
             where r2.mandalart_id = r.mandalart_id and r2.stage = r.stage
               and r2.block_index is not distinct from r.block_index and r2.round_no > r.round_no
           ) as superseded
    from feedback_cards c
    join feedback_rounds r on r.id = c.round_id
    join mandalarts m on m.id = r.mandalart_id
    where c.id = ${id} and m.student_id = ${st.id} and m.status = 'draft'`;
  if (!card) return json({ error: "응답할 수 없는 피드백이에요." }, 404);
  if (card.superseded) return json({ error: "확인 피드백을 받은 뒤라 이 카드는 바꿀 수 없어요." }, 409);

  const b = parsed.data;
  const reasonCode = b.action === "reject" ? b.reasonCode ?? null : null;
  const reasonText = b.action === "reject" && b.reasonText ? b.reasonText : null;
  // 같은 응답을 짧은 시간에 다시 보낸 경우(두 번 누름, 다시 보내기)는 한 번만 저장합니다.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${id}))`;
    const [dup] = await tx`
      select 1 from (
        select action, reason_code, reason_text, created_at from feedback_responses
        where card_id = ${id} order by created_at desc, id desc limit 1
      ) l
      where l.action = ${b.action} and l.reason_code is not distinct from ${reasonCode}
        and l.reason_text is not distinct from ${reasonText} and l.created_at > now() - interval '10 seconds'`;
    if (dup) return;
    await tx`insert into feedback_responses (card_id, action, reason_code, reason_text)
      values (${id}, ${b.action}, ${reasonCode}, ${reasonText})`;
  });
  return json({ ok: true });
}
