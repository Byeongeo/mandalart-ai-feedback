import { notFound } from "next/navigation";
import Link from "next/link";
import { isUuid, requireTeacherPage } from "@/lib/auth";
import { studentDetail } from "@/lib/queries";
import { stageLabel, targetLabel, type Stage } from "@/lib/mandalart";
import { CATEGORIES, REJECT_REASONS } from "@/lib/feedback/categories";
import ConcernReviewButton from "@/components/teacher/ConcernReviewButton";
import { SafetyBox, SafetyMandalart, SafetyReveal, RoundFrame, WhenSafetyShown } from "@/components/teacher/SafetyReveal";
import { AI_SOURCE_NOTE, RULE_GONE_TEXT, RULE_NOW_TEXT, RULE_SOURCE_NOTE, SafetyHint, concernLabel } from "@/components/teacher/concern";
import { fmtKst } from "@/components/format";

const KIND_BADGE = {
  issue: null,
  resolved: <span className="rounded bg-emerald-100 px-1.5 text-emerald-800">✓ 해결됨</span>,
  unresolved: <span className="rounded bg-amber-100 px-1.5 text-amber-800">↻ 아직 해결 안 됨</span>,
} as const;

function roundStage(r: { stage: "core" | "block" | "whole"; block_index: number | null }): Stage {
  return r.stage === "block" ? { kind: "block", index: r.block_index ?? 0 } : { kind: r.stage };
}

// 교사용 학생 한 명 보기: 지금 만다라트, 받은 피드백 카드와 학생의 선택, 안전 신호.
// 이 화면은 학생 만다라트를 예시로 띄울 때도 쓰므로, 안전 신호(종류, 걸린 칸, 주황 표시)는 '안전 신호 보기'를 누를 때만 보입니다(SafetyReveal).
export default async function StudentDetailPage({ params }: { params: Promise<{ id: string; sid: string }> }) {
  const t = await requireTeacherPage();
  const { id, sid } = await params;
  if (!isUuid(id) || !isUuid(sid)) notFound();
  const d = await studentDetail(t.id, id, sid);
  if (!d) notFound();
  const { student, mandalart, rounds, rule_concern: rule } = d;
  const concernRounds = rounds.filter((r) => r.concern);
  const hasSignal = concernRounds.length > 0 || rule !== null;
  // '확인했어요'를 누른 뒤로 새로 생기지 않은 신호에 붙이는 표시
  const reviewedMark = <span className="text-stone-600"> · 확인함</span>;
  // 표현 검사: 지금 글에서 걸리는 종류별 칸(주황 테두리)
  const nowCells = rule ? rule.now.flatMap((g) => g.cells) : [];

  return (
    <SafetyReveal>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
        <Link href={`/teacher/class/${id}`} className="text-sm text-sky-700">← {d.cls.name}</Link>
        <header className="flex flex-col gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold">
            {student.number}번 {student.name}
            {student.locked && <span className="rounded bg-rose-100 px-1.5 text-xs font-medium text-rose-800">잠김</span>}
          </h1>
          <p className="text-sm text-stone-600">
            {!mandalart
              ? "아직 들어오지 않았습니다."
              : mandalart.status === "submitted"
                ? `제출함 · ${fmtKst(mandalart.submitted_at)}`
                : `쓰는 중 · 마지막 저장 ${fmtKst(mandalart.updated_at)}`}
            {rounds.length > 0 && ` · 피드백 ${rounds.length}회`}
          </p>
        </header>

        <SafetyBox signal={hasSignal}>
          {!hasSignal && (
            <p className="text-sm text-stone-600">
              이 학생에게는 표현 검사 표시도, AI 신호도 없습니다. 표시가 없다고 문제가 없다는 뜻은 아닙니다.
            </p>
          )}
          {rule && (
            <div className="flex flex-col gap-1 text-sm text-amber-950">
              <h3 className="font-semibold">표현 검사</h3>
              {/* 지금 글에서 걸리는 종류와 칸. 기록된 가장 무거운 종류가 지금 글에 없으면 아래에 따로 적습니다. */}
              {rule.now.map((g) => (
                <p key={g.kind}>
                  <b>{concernLabel(g.kind)}</b> · {RULE_NOW_TEXT}
                  {mandalart && <> · 걸린 칸: {g.cells.map((t) => targetLabel(t, mandalart.content)).join(", ")}</>}
                </p>
              ))}
              {rule.now.length > 0 && <p className="text-xs text-amber-900">걸린 칸은 아래 만다라트에 주황 테두리로 표시했습니다.</p>}
              {!rule.kind_now && (
                <>
                  <p>
                    <b>{concernLabel(rule.kind)}</b> · <span className="text-stone-600">{RULE_GONE_TEXT}(기록은 남김)</span>
                  </p>
                  <p className="text-xs text-amber-900">학생이 그 표현을 지웠거나 고쳤습니다. 지워졌어도 한 번 썼던 글이니 함께 살펴보세요.</p>
                </>
              )}
              <p className="text-xs text-amber-900">
                {rule.at ? `마지막으로 걸린 시각 ${fmtKst(rule.at)}` : "걸린 기록 있음"}
                {rule.reviewed && reviewedMark}
              </p>
            </div>
          )}
          {concernRounds.length > 0 && (
            <div className="flex flex-col gap-1 text-sm text-amber-950">
              <h3 className="font-semibold">AI 신호 {concernRounds.length}회</h3>
              <ul className="flex flex-col gap-0.5">
                {concernRounds.map((r) => (
                  <li key={r.id}>
                    · {concernLabel(r.concern_kind)} — {stageLabel(roundStage(r))} {r.attempt === 1 ? "첫" : "확인"} 피드백 · {fmtKst(r.created_at)}
                    {r.concern_reviewed && reviewedMark}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hasSignal && (
            <>
              <ConcernReviewButton
                url={`/api/teacher/classes/${id}/students/${student.id}`}
                needsReview={d.needs_review}
                reviewedAt={student.concern_reviewed_at?.toISOString() ?? null}
                seenUntil={d.concern_seen_until?.toISOString() ?? null}
              />
              <SafetyHint />
              <p className="text-[11px] text-amber-900">{RULE_SOURCE_NOTE} {AI_SOURCE_NOTE}</p>
            </>
          )}
        </SafetyBox>

        {mandalart && (
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">지금 만다라트</h2>
            <SafetyMandalart content={mandalart.content} highlight={nowCells} />
          </section>
        )}

        {rounds.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">받은 피드백과 학생의 선택</h2>
            {rounds.map((r) => (
              <RoundFrame key={r.id} concern={r.concern}>
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {stageLabel(roundStage(r))} · {r.attempt === 1 ? "첫 피드백" : "확인 피드백"}
                  <span className="text-xs font-normal text-stone-500">{fmtKst(r.created_at)}</span>
                  {r.concern && (
                    <WhenSafetyShown>
                      <span className="rounded bg-amber-200 px-1.5 text-xs font-medium text-amber-950">
                        ⚠️ AI 신호: {concernLabel(r.concern_kind)}
                      </span>
                    </WhenSafetyShown>
                  )}
                </p>
                {r.cards.length === 0 ? (
                  <p className="text-sm text-stone-500">고칠 점을 찾지 못한 피드백입니다(카드 없음).</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {r.cards.map((c) => (
                      <li key={c.id} className="rounded-lg border border-stone-200 bg-white p-2.5">
                        <p className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
                          {KIND_BADGE[c.kind]}
                          <span>{CATEGORIES[c.category]?.label ?? c.category}</span>
                          <span>· {targetLabel(c.target, r.content_snapshot)}</span>
                        </p>
                        <p className="mt-1 leading-relaxed">{c.body}</p>
                        {c.kind !== "resolved" && (
                          <p className="mt-1 text-xs font-medium">
                            {c.response === null ? (
                              <span className="text-stone-400">— 아직 고르지 않음</span>
                            ) : c.response.action === "accept" ? (
                              <span className="text-emerald-700">✓ 해 볼게요</span>
                            ) : (
                              <span className="text-stone-700">
                                ✗ 안 할래요
                                {c.response.reason_code && ` · ${REJECT_REASONS[c.response.reason_code] ?? c.response.reason_code}`}
                                {c.response.reason_text && ` · “${c.response.reason_text}”`}
                              </span>
                            )}
                            {c.response && <span className="ml-2 font-normal text-stone-400">{fmtKst(c.response.created_at)}</span>}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </RoundFrame>
            ))}
          </section>
        )}
      </main>
    </SafetyReveal>
  );
}
