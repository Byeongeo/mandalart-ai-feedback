"use client";

import { useEffect, useState } from "react";
import type { AiErrorCode } from "@/lib/feedback/ai-errors";
import { fmtKst } from "../format";

// GET /api/teacher/ai-status 응답(키 값·학생 글·AI 원문은 들어 있지 않음)
type AiCheck = {
  ok: boolean;
  /** 실패한 단계의 OpenRouter 응답 상태 코드(정상이면 200, 0 = 응답을 받지 못함: 연결 실패 또는 시간 초과) */
  status: number;
  code: AiErrorCode | null;
  message_ko: string;
  /** 이 키에 걸어 둔 사용 한도의 남은 양(달러, null = 한도 없음). 계정 전체 잔액이 아닙니다. */
  limit_remaining?: number | null;
  usage?: number | null;
};
type RecentError = { at: string; code: AiErrorCode; message_ko: string };
type AiStatusReply = {
  keyConfigured: boolean;
  mock: boolean;
  model: string;
  check: AiCheck | null;
  recentErrors: RecentError[];
};

type Basic = { keyConfigured: boolean; mock: boolean; model: string };

const money = (n: number) => `$${n.toFixed(2)}`;

// 같은 종류의 오류는 한 줄로 묶습니다(가장 최근 시각과 횟수).
function groupErrors(errors: RecentError[]): { code: AiErrorCode; message_ko: string; count: number; last: string }[] {
  const out = new Map<AiErrorCode, { code: AiErrorCode; message_ko: string; count: number; last: string }>();
  for (const e of errors) {
    const g = out.get(e.code);
    if (g) g.count += 1;
    else out.set(e.code, { code: e.code, message_ko: e.message_ko, count: 1, last: e.at });
  }
  return [...out.values()];
}

function isReply(v: unknown): v is AiStatusReply {
  return !!v && typeof v === "object" && Array.isArray((v as AiStatusReply).recentErrors);
}

// 교사 화면 위쪽의 AI 상태: 키가 없거나 모의 모드인지, 최근 24시간의 피드백 오류(쉬운 설명과 시각),
// 'AI 연결 확인' 버튼(피드백과 같은 조건으로 AI를 실제로 한 번 짧게 불러 봄. 학생 글은 보내지 않고, 요금은 아주 조금 듦).
export default function AiStatusBanner({ ai }: { ai: Basic }) {
  const [recent, setRecent] = useState<RecentError[] | null>(null);
  const [check, setCheck] = useState<AiCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);

  // 화면이 열리면 최근 오류만 불러옵니다(OpenRouter는 부르지 않음).
  useEffect(() => {
    let alive = true;
    fetch("/api/teacher/ai-status", { cache: "no-store" })
      .then(async (res) => {
        const data: unknown = await res.json().catch(() => null);
        if (alive && res.ok && isReply(data)) setRecent(data.recentErrors);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function runCheck() {
    if (checking) return;
    setChecking(true);
    setLoadMsg(null);
    try {
      const res = await fetch("/api/teacher/ai-status?check=1", { cache: "no-store" });
      const data: unknown = await res.json().catch(() => null);
      if (res.status === 401) return setLoadMsg("⚠ 로그인이 끝났습니다. 다시 로그인하세요.");
      if (!res.ok || !isReply(data)) return setLoadMsg(`⚠ 확인하지 못했습니다(오류 ${res.status}). 잠시 뒤 다시 눌러 보세요.`);
      setRecent(data.recentErrors);
      setCheck(data.check);
      setCheckedAt(new Date().toISOString());
    } catch {
      setLoadMsg("⚠ 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 보세요.");
    } finally {
      setChecking(false);
    }
  }

  const groups = groupErrors(recent ?? []);

  return (
    <section className="flex flex-col gap-2 print:hidden" aria-label="AI 상태">
      {ai.mock && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
          모의 모드(FEEDBACK_MOCK=1)로 실행 중입니다. 진짜 AI 대신 연습용 피드백이 나옵니다. 개발용 컴퓨터에서만 쓰세요.
        </p>
      )}
      {!ai.mock && !ai.keyConfigured && (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p className="font-semibold">⚠️ AI 키가 아직 없어서 학생들이 AI 피드백을 받을 수 없습니다.</p>
          <p>
            Vercel 대시보드 → 이 프로젝트 → <b>Settings → Environment Variables</b>에 <code className="font-mono">OPENROUTER_API_KEY</code>를 넣고,
            <b> Deployments</b>에서 <b>Redeploy</b>를 누르세요. 만다라트 쓰기와 제출은 키가 없어도 됩니다.
          </p>
        </div>
      )}

      {groups.length > 0 && (
        <div role="alert" className="flex flex-col gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-950">
          <p className="font-semibold">⚠️ 최근 24시간 동안 AI 피드백을 만들지 못한 적이 {recent?.length ?? 0}번 있습니다.</p>
          <ul className="flex flex-col gap-1">
            {groups.map((g) => (
              <li key={g.code}>
                · {g.message_ko}
                <span className="ml-1 text-xs text-rose-800">
                  (마지막 {fmtKst(g.last)}{g.count > 1 ? ` · ${g.count}번` : ""})
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-rose-800">
            학생 화면에는 자세한 이유 없이 짧은 안내만 나옵니다. 아래 &lsquo;AI 연결 확인&rsquo;으로 지금 상태를 볼 수 있습니다.
            (최근 10건까지 보여 줍니다. 학생 이름이나 글은 들어 있지 않습니다.)
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={runCheck} disabled={checking}
            className="rounded-lg border border-stone-400 bg-white px-3 py-1 text-sm font-semibold hover:bg-stone-50 disabled:opacity-50">
            {checking ? "확인하는 중… (최대 30초)" : "AI 연결 확인"}
          </button>
          <span className="text-xs text-stone-500">
            모델 <code className="font-mono">{ai.model}</code> · AI에 아주 짧은 요청을 한 번 보내 확인합니다(요금은 기본 모델 기준 1원 미만).
          </span>
        </div>
        {loadMsg && <p role="alert" className="text-xs text-red-700">{loadMsg}</p>}
        {check && (
          <div role="status" className={`flex flex-col gap-0.5 rounded px-2 py-1.5 ${check.ok ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-950"}`}>
            <p className="font-semibold">
              {check.ok ? "✅ AI 연결 정상" : "⚠️ AI 연결에 문제가 있습니다"}
              {/* 응답 코드는 200이 아닐 때만 보여 줍니다(200인데 실패한 경우는 응답 내용의 문제). */}
              {!check.ok && check.status !== 200 && (
                <span className="ml-1 text-xs font-normal">
                  ({check.status !== 0 ? `응답 ${check.status}` : check.code === "timeout" ? "시간 초과" : "연결하지 못함"})
                </span>
              )}
              {checkedAt && <span className="ml-1 text-xs font-normal opacity-70">· {fmtKst(checkedAt)} 확인</span>}
            </p>
            <p>{check.message_ko}</p>
            {/* 정상일 때 남은 한도는 위 설명에 이미 들어 있으므로, 한도가 없다는 것과 쓴 금액만 덧붙입니다. */}
            {(check.limit_remaining !== undefined || check.usage != null) && (
              <p className="text-xs">
                {[
                  check.limit_remaining === null
                    ? "이 키에는 사용 한도(Limit)가 걸려 있지 않습니다."
                    : check.limit_remaining !== undefined && !check.ok
                      ? `이 키의 남은 사용 한도: ${money(check.limit_remaining)}`
                      : null,
                  check.usage != null ? `이 키로 지금까지 쓴 금액: ${money(check.usage)}` : null,
                  check.ok ? null : "계정 전체 잔액(크레딧)은 OpenRouter → Credits 화면에서 확인하세요.",
                ].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
