import { sql } from "@/lib/db";
import { currentTeacher, isUuid, json } from "@/lib/auth";
import { kst, toCsv } from "@/lib/csv";
import { MandalartContent, type Target } from "@/lib/mandalart";
import { CATEGORIES, REJECT_REASONS, type Category, type RejectReason } from "@/lib/feedback/categories";
import { EXPORT_TYPES, cardRow, cardsHeader, exportFileName, mandalartHeader, mandalartRow, type ExportType } from "@/lib/export";

// 교사 본인 보관용 학급 CSV(학생 이름 포함, PIN·안전 신호 없음). 엑셀에서 한글이 깨지지 않게 BOM을 붙이고, 시간은 한국 시간,
// 학생 글이 =, +, -, @로 시작해도 수식으로 실행되지 않게 막습니다(csv.ts).
// GET /api/teacher/classes/[id]/export?type=mandalart  — 학생 한 명 = 한 줄(만다라트 73칸 + 진행 상황)
// GET /api/teacher/classes/[id]/export?type=cards      — 피드백 카드 하나 = 한 줄(카드 내용과 학생 반응)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "not found" }, 404);
  const typeParam = new URL(req.url).searchParams.get("type") ?? "mandalart";
  if (!EXPORT_TYPES.includes(typeParam as ExportType)) return json({ error: "type은 mandalart 또는 cards입니다." }, 400);
  const type = typeParam as ExportType;
  const [cls] = await sql<{ name: string }[]>`select name from classes where id = ${id} and teacher_id = ${t.id}`;
  if (!cls) return json({ error: "not found" }, 404);

  let csv: string;
  if (type === "mandalart") {
    const rows = await sql<{
      number: number; name: string; status: "draft" | "submitted" | null; submitted_at: Date | null; updated_at: Date | null; content: unknown;
      rounds: number; cards: number; accepted: number; rejected: number;
    }[]>`
      select s.number, s.name, m.status, m.submitted_at, m.updated_at, m.content,
        (select count(*)::int from feedback_rounds r where r.mandalart_id = m.id) as rounds,
        coalesce(cnt.cards, 0) as cards, coalesce(cnt.accepted, 0) as accepted, coalesce(cnt.rejected, 0) as rejected
      from students s
      left join mandalarts m on m.student_id = s.id
      left join lateral (
        select count(*)::int as cards,
          count(*) filter (where lr.action = 'accept')::int as accepted,
          count(*) filter (where lr.action = 'reject')::int as rejected
        from feedback_rounds r join feedback_cards c on c.round_id = r.id
        left join lateral (
          select fr.action from feedback_responses fr where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1
        ) lr on true
        where r.mandalart_id = m.id
      ) cnt on true
      where s.class_id = ${id} order by s.number`;
    csv = toCsv(mandalartHeader(), rows.map((r) => {
      const parsed = r.content ? MandalartContent.safeParse(r.content) : null;
      return mandalartRow({
        ...r,
        submitted_at: kst(r.submitted_at),
        updated_at: kst(r.updated_at),
        content: parsed?.success ? parsed.data : null,
      });
    }));
  } else {
    const rows = await sql<{
      number: number; name: string; round_no: number; stage: "core" | "block" | "whole"; block_index: number | null; attempt: number;
      kind: "issue" | "resolved" | "unresolved"; target: Target; category: Category; body: string; created_at: Date;
      action: "accept" | "reject" | null; reason_code: RejectReason | null; reason_text: string | null; responded_at: Date | null;
    }[]>`
      select s.number, s.name, r.round_no, r.stage, r.block_index, r.attempt, c.kind, c.target, c.category, c.body, r.created_at,
        lr.action, lr.reason_code, lr.reason_text, lr.created_at as responded_at
      from feedback_cards c
      join feedback_rounds r on r.id = c.round_id
      join mandalarts m on m.id = r.mandalart_id
      join students s on s.id = m.student_id
      left join lateral (
        select fr.action, fr.reason_code, fr.reason_text, fr.created_at from feedback_responses fr
        where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1
      ) lr on true
      where s.class_id = ${id}
      order by s.number, r.round_no, c.position`;
    csv = toCsv(cardsHeader(), rows.map((r) => cardRow({
      ...r,
      category_label: CATEGORIES[r.category]?.label ?? r.category,
      reason_label: r.reason_code ? REJECT_REASONS[r.reason_code] ?? r.reason_code : null,
      created_at: kst(r.created_at),
      responded_at: kst(r.responded_at),
    })));
  }

  const today = (kst(new Date()) ?? "").slice(0, 10);
  const filename = exportFileName(cls.name, type, today);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="class.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
