"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REJECT_REASONS, type RejectReason } from "@/lib/feedback/categories";
import {
  stageDone as sharedStageDone, stageKey, stageLabel, stageNotReady, targetLabel, zeroCardMessage, type MandalartContent, type Stage,
  type Target,
} from "@/lib/mandalart";

export type CardView = {
  id: string;
  position: number;
  category: string;
  target: Target;
  body: string;
  kind: "issue" | "resolved" | "unresolved";
  response: { action: "accept" | "reject"; reason_code: string | null; reason_text: string | null } | null;
};
export type RoundView = {
  id: string;
  round_no: number;
  stage: "core" | "block" | "whole";
  block_index: number | null;
  attempt: number;
  created_at: string;
  cards: CardView[];
};

// 서버를 기다리는 최대 시간. 서버의 AI 시간 예산(240초)과 함수 제한(300초) 사이로 잡습니다.
const REQUEST_TIMEOUT_MS = 290_000;
// 이미 다른 요청(다른 탭, 두 번 누름, 끊긴 요청)이 피드백을 만드는 중일 때(서버 'busy'): 5초마다 서버 기록을 확인합니다.
// 서버의 '만드는 중' 표시는 길어야 300초이므로 그보다 조금 길게 기다립니다.
const BUSY_POLL_MS = 5_000;
const BUSY_POLL_MAX = 66;
// 최근 실패가 많아 서버가 잠시 멈춘 경우(서버 'too_many_failures'): 이 시간 동안 요청 버튼을 막습니다(서버는 최근 5분을 봄).
const FAILURE_PAUSE_MS = 5 * 60_000;
// 버튼을 누른 뒤 이 시간 안에 나온 안내만 그 자리로 스크롤합니다. 피드백을 기다리는 동안 다른 칸을 쓰고 있을 수 있으므로
// 한참 뒤에 나온 안내(기다리던 피드백 도착, AI 오류 등)로는 화면을 옮기지 않습니다.
const SCROLL_WITHIN_MS = 10_000;
const BUSY_MESSAGE = "이미 피드백을 만들고 있어요. 잠시 뒤 화면에 나타나요.";
const TOO_MANY_FAILURES_MESSAGE = "피드백을 만드는 데 여러 번 실패했어요. 선생님께 말씀드려 주세요. (몇 분 뒤에 다시 해 볼 수 있어요)";

// 서버에 저장된 회차와, 지금 피드백을 만드는 중인지(pending). 실패하면 null, 로그인이 풀렸으면 "auth".
type Synced = { rounds: RoundView[]; pending: boolean };
async function loadRounds(mandalartId: string): Promise<Synced | "auth" | null> {
  try {
    const res = await fetch(`/api/mandalart/${mandalartId}/feedback`, { cache: "no-store" });
    if (res.status === 401) return "auth";
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.rounds) ? { rounds: data.rounds, pending: data.pending === true } : null;
  } catch {
    return null;
  }
}

// 한 단계가 끝났는지(서버와 같은 규칙: mandalart.ts의 stageDone)
function stageDone(rs: RoundView[], max: number): boolean {
  return sharedStageDone(
    rs.map((r) => {
      const issues = r.cards.filter((c) => c.kind === "issue");
      return { attempt: r.attempt, n_cards: issues.length, n_rejected: issues.filter((c) => c.response?.action === "reject").length };
    }),
    max,
  );
}

function Card({ card, content, disabled, onFocusTarget, onResponded, onSending, onAuthLost }: {
  card: CardView;
  content: MandalartContent;
  disabled: boolean;
  onFocusTarget: (t: Target) => void;
  onResponded: (r: CardView["response"]) => void;
  onSending: (busy: boolean) => void;
  onAuthLost?: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // 응답을 보내는 중에는 버튼을 막아 같은 응답이 여러 번 저장되지 않게 합니다.
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const r = card.response;

  async function send(body: object) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSending(true);
    onSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/cards/${card.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        // 로그인이 풀림: 화면 위쪽 안내(다시 로그인하기)가 대신 알려 줍니다.
        onAuthLost?.();
        return false;
      }
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? "저장하지 못했어요.");
        return false;
      }
      return true;
    } catch {
      setError("인터넷 연결을 확인하고 다시 눌러 주세요.");
      return false;
    } finally {
      inFlight.current = false;
      setSending(false);
      onSending(false);
    }
  }

  async function accept() {
    if (await send({ action: "accept" })) {
      onResponded({ action: "accept", reason_code: null, reason_text: null });
      setEditing(false);
      onFocusTarget(card.target);
    }
  }

  // 이유는 고르지 않아도 됩니다(고르거나 쓰면 함께 저장).
  async function reject() {
    const reasonText = text.trim() || null;
    if (await send({ action: "reject", reasonCode: reason, reasonText })) {
      onResponded({ action: "reject", reason_code: reason, reason_text: reasonText });
      setRejecting(false);
      setEditing(false);
    }
  }

  const decided = r && !editing;
  if (card.kind === "resolved") {
    return (
      <li className="rounded-xl border border-emerald-300 bg-emerald-50 p-3">
        <p className="mb-1 text-xs font-semibold text-emerald-800">✓ 잘 고쳤어요 · {targetLabel(card.target, content)}</p>
        <p className="text-sm leading-relaxed">{card.body}</p>
      </li>
    );
  }
  return (
    <li className={`rounded-xl border bg-white p-3 ${r?.action === "accept" ? "border-emerald-400" : r?.action === "reject" ? "border-stone-300 opacity-80" : "border-stone-300"}`}>
      {card.kind === "unresolved" && <p className="mb-1 text-xs font-semibold text-amber-700">↻ 한 번 더 다듬어 볼까요</p>}
      {card.target.kind !== "whole" ? (
        <button
          onClick={() => onFocusTarget(card.target)}
          className="mb-1 text-left text-xs font-semibold text-rose-700 underline decoration-dotted"
        >
          📍 {targetLabel(card.target, content)}
        </button>
      ) : (
        <p className="mb-1 text-xs font-semibold text-rose-700">📍 {targetLabel(card.target, content)}</p>
      )}
      <p className="text-sm leading-relaxed">{card.body}</p>

      {decided ? (
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className={r.action === "accept" ? "font-semibold text-emerald-700" : "text-stone-600"}>
            {r.action === "accept"
              ? "✓ 해 보기로 했어요"
              : `안 하기로 했어요${r.reason_code && REJECT_REASONS[r.reason_code as RejectReason] ? ` · ${REJECT_REASONS[r.reason_code as RejectReason]}` : ""}${r.reason_text ? ` · “${r.reason_text}”` : ""}`}
          </span>
          {!disabled && (
            <button onClick={() => setEditing(true)} className="text-stone-500 underline">바꾸기</button>
          )}
        </div>
      ) : (
        !disabled && (
          <div className="mt-3 flex flex-col gap-2">
            {!rejecting ? (
              <div className="flex gap-2">
                <button onClick={accept} disabled={sending} className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {sending ? "저장 중…" : "해 볼게요"}
                </button>
                <button onClick={() => setRejecting(true)} disabled={sending} className="flex-1 rounded-lg border border-stone-300 py-2 text-sm disabled:opacity-60">
                  안 할래요
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg bg-stone-50 p-2">
                <p className="text-xs font-medium">왜 안 하기로 했나요? <span className="font-normal text-stone-500">(고르지 않아도 괜찮아요)</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(REJECT_REASONS) as RejectReason[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={reason === k}
                      onClick={() => setReason((cur) => (cur === k ? null : k))}
                      className={`rounded-full border px-2.5 py-1 text-xs ${reason === k ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white"}`}
                    >
                      {REJECT_REASONS[k]}
                    </button>
                  ))}
                </div>
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={100}
                  placeholder="한 줄로 더 말해 줄래요? (선택)"
                  className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm"
                />
                <div className="flex gap-2">
                  <button onClick={reject} disabled={sending} className="flex-1 rounded-lg bg-stone-800 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
                    {sending ? "저장 중…" : "안 할래요로 정하기"}
                  </button>
                  <button onClick={() => { setRejecting(false); setReason(null); setText(""); setError(null); }} className="rounded-lg px-3 text-sm text-stone-500">취소</button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
          </div>
        )
      )}
    </li>
  );
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

function sameStage(r: RoundView, st: Stage): boolean {
  return r.stage === st.kind && (st.kind !== "block" || r.block_index === st.index);
}

/** 피드백 요청 전 저장 결과. stopped: 저장이 막혀(다른 화면에서 고침, 로그인이 풀림 등) 화면 위쪽에 이미 안내가 나옴 */
export type BeforeRequest = "saved" | "unsaved" | "stopped";
/** 피드백 요청에 함께 보낼 저장 번호 정보와, 서버가 '다른 화면에서 고침'(409 stale)으로 답할 때 할 일(화면을 멈췄으면 true) */
export type RequestPrep = { meta: object; onStale: () => Promise<boolean> };

export default function FeedbackPanel(props: {
  mandalartId: string;
  content: MandalartContent;
  initialRounds: RoundView[];
  maxRounds: number;
  /** false면 교사가 아직 AI 키를 넣지 않아 피드백을 받을 수 없음 */
  aiReady: boolean;
  disabled: boolean;
  view: { kind: "center" } | { kind: "block"; sub: number };
  beforeRequest: () => Promise<BeforeRequest>;
  prepareRequest: () => RequestPrep;
  onFocusTarget: (t: Target) => void;
  onOpenStage: (st: Stage) => void;
  onProgress?: (remaining: number) => void;
  /** '해 볼게요'를 고른 카드 수가 바뀔 때(제출 뒤 완료 화면에 씀) */
  onAcceptedChange?: (n: number) => void;
  /** 피드백을 만드는 중(요청을 보냈거나 다른 요청이 만드는 것을 기다리는 중)인지가 바뀔 때. 그동안 Editor는 제출을 막습니다. */
  onBusyChange?: (busy: boolean) => void;
  /** 서버가 401(로그인이 풀림)로 답할 때 */
  onAuthLost?: () => void;
  /** 서버가 '이미 제출함'(409 submitted)으로 답할 때(다른 기기에서 제출 등). Editor가 '다 했어요' 화면으로 바꿉니다. */
  onSubmitted?: () => void;
}) {
  const [rounds, setRounds] = useState(props.initialRounds);
  const [pending, setPending] = useState<string | null>(null);
  // 저장 중인 카드 응답 수. 응답이 저장되기 전에 피드백을 요청하면 서버가 이전 응답으로 판정하므로 그동안 요청 버튼을 막습니다.
  const [answering, setAnswering] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 위 안내(error·notice)가 어느 단계의 버튼에서 나온 것인지(stageKey). 그 단계 버튼 바로 아래에 보여 줍니다.
  const [msgStage, setMsgStage] = useState<string | null>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // 마지막으로 피드백 버튼을 누른 시각과, 안내로 스크롤해 달라는 요청 번호(아래 say)
  const clickedAt = useRef(0);
  const [scrollReq, setScrollReq] = useState(0);
  const [showOther, setShowOther] = useState(false);
  // 실패가 여러 번 이어져 잠시 멈춤(다시 누르기 버튼을 막음)
  const [paused, setPaused] = useState(false);
  // '전체' 칩을 눌렀을 때: 전체 단계 칸을 열고 그 자리로 이동합니다(아직 열리지 않았으면 조건을 알려 줌).
  const [wholeOpen, setWholeOpen] = useState(false);
  const [wholeReq, setWholeReq] = useState(0);
  const wholeRef = useRef<HTMLDivElement>(null);
  // 다른 요청이 만들고 있는 피드백을 기다리는 중: 그때까지 알던 회차 수와 확인한 횟수
  const [waiting, setWaiting] = useState<{ known: number; tries: number } | null>(null);
  // 401을 알릴 함수. 기다리는 effect가 화면을 다시 그릴 때마다 처음부터 다시 시작하지 않도록 ref로 둡니다(아래 effect에서 맞춤).
  const authLost = useRef(props.onAuthLost);

  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const t = setTimeout(async () => {
      const synced = await loadRounds(props.mandalartId);
      if (stop) return;
      if (synced === "auth") {
        setWaiting(null);
        setPending(null);
        setNotice(null);
        authLost.current?.();
      } else if (synced && synced.rounds.length > waiting.known) {
        setRounds(synced.rounds);
        setWaiting(null);
        setPending(null);
        setNotice("피드백이 도착했어요. 아래 카드를 확인해 보세요.");
      } else if (synced && !synced.pending) {
        // 만들던 요청이 실패해 '만드는 중' 표시가 풀렸는데 새 피드백이 없음: 더 기다리지 않고 다시 누르게 합니다.
        setWaiting(null);
        setPending(null);
        setNotice(null);
        setError("피드백을 받지 못했어요. 잠시 후 다시 눌러 주세요.");
      } else if (waiting.tries + 1 >= BUSY_POLL_MAX) {
        setWaiting(null);
        setPending(null);
        setNotice(null);
        setError("피드백이 아직 오지 않았어요. 잠시 후 다시 눌러 주세요.");
      } else {
        setWaiting({ known: waiting.known, tries: waiting.tries + 1 });
      }
    }, BUSY_POLL_MS);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [waiting, props.mandalartId]);

  // 버튼을 누른 바로 뒤에 나온 안내는 그 안내가 보이게 합니다(이미 보이면 움직이지 않음). 1366×768 노트북에서도 누른 버튼 아래
  // 안내가 화면 밖에 있지 않게. 다만 패널 밖의 글 칸에 커서가 있으면(학생이 쓰는 중) 그 칸에서 떼어 놓지 않도록 움직이지 않습니다.
  useEffect(() => {
    if (!scrollReq) return;
    const a = document.activeElement;
    const typing = a instanceof HTMLElement && (a.isContentEditable || a.matches("input, textarea, select"));
    if (typing && !sectionRef.current?.contains(a)) return;
    msgRef.current?.scrollIntoView({ block: "nearest" });
  }, [scrollReq]);

  useEffect(() => {
    if (!paused) return;
    const t = setTimeout(() => setPaused(false), FAILURE_PAUSE_MS);
    return () => clearTimeout(t);
  }, [paused]);

  useEffect(() => {
    if (!wholeReq) return;
    const el = wholeRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [wholeReq]);

  // 지금 화면에 해당하는 단계
  const current: Stage = props.view.kind === "center" ? { kind: "core" } : { kind: "block", index: props.view.sub };
  const whole: Stage = { kind: "whole" };
  const roundsOf = (st: Stage) => rounds.filter((r) => sameStage(r, st));
  const coreDone = stageDone(roundsOf({ kind: "core" }), props.maxRounds);
  const blocksDone = new Set(Array.from({ length: 8 }, (_, i) => i).filter((i) => stageDone(roundsOf({ kind: "block", index: i }), props.maxRounds)));
  const wholeDone = stageDone(roundsOf({ kind: "whole" }), props.maxRounds);
  const wholeReady = coreDone && blocksDone.size === 8;
  const remaining = 10 - (coreDone ? 1 : 0) - blocksDone.size - (wholeDone ? 1 : 0);
  const accepted = rounds.flatMap((r) => r.cards).filter((c) => c.response?.action === "accept").length;
  const busy = pending !== null;
  const reported = useRef(-1);
  const reportedAccepted = useRef(-1);
  const reportedBusy = useRef(false);
  useEffect(() => {
    authLost.current = props.onAuthLost;
    if (reported.current !== remaining) {
      reported.current = remaining;
      props.onProgress?.(remaining);
    }
    if (reportedAccepted.current !== accepted) {
      reportedAccepted.current = accepted;
      props.onAcceptedChange?.(accepted);
    }
    if (reportedBusy.current !== busy) {
      reportedBusy.current = busy;
      props.onBusyChange?.(busy);
    }
  });


  // 피드백 요청의 결과 안내(error·notice). 버튼을 누른 바로 뒤에 나온 것이면 그 안내로 스크롤합니다(위 effect).
  // 기다리던 피드백이 도착했다는 안내처럼 한참 뒤에 나오는 것은 스크롤하지 않습니다.
  const markClick = useCallback(() => { clickedAt.current = Date.now(); }, []);
  const say = useCallback((kind: "error" | "notice", text: string) => {
    if (kind === "error") setError(text);
    else setNotice(text);
    if (Date.now() - clickedAt.current <= SCROLL_WITHIN_MS) setScrollReq((n) => n + 1);
  }, []);

  async function request(st: Stage) {
    markClick();
    setError(null);
    setNotice(null);
    setMsgStage(stageKey(st));
    setPending(stageKey(st));
    const ready = await props.beforeRequest();
    if (ready !== "saved") {
      setPending(null);
      // 저장이 막혀 화면 위쪽에 이미 안내(새로 고침·다시 로그인)가 나왔으면 여기서는 따로 알리지 않습니다.
      if (ready === "unsaved") say("error", "먼저 저장이 되어야 해요. 잠시 후 다시 눌러 주세요.");
      return;
    }
    const known = rounds.length;
    const prep = props.prepareRequest();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(`/api/mandalart/${props.mandalartId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: st, ...prep.meta }),
      signal: ctrl.signal,
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    clearTimeout(timer);
    if (res?.ok && data.round) {
      setPending(null);
      return setRounds((rs) => [...rs, data.round]);
    }
    if (res?.status === 401) {
      // 로그인이 풀림: 화면 위쪽 안내(다시 로그인하기)가 대신 알려 줍니다.
      setPending(null);
      return props.onAuthLost?.();
    }
    if (res?.status === 409 && data.code === "submitted") {
      // 이미 제출함(다른 기기 등): 화면 전체가 '다 했어요' 화면으로 바뀌므로 여기서는 따로 알리지 않습니다.
      setPending(null);
      return props.onSubmitted?.();
    }
    if (res?.status === 409 && data.stale) {
      // 다른 탭·기기가 더 나중에 고침: 화면 위쪽 안내(새로 고침)가 대신 알려 줍니다. 요청한 뒤 이 화면의 저장이 먼저 반영되어
      // 거절된 경우라면 화면을 멈추지 않으므로 다시 누르게 합니다.
      const halted = await prep.onStale();
      setPending(null);
      if (!halted) say("error", "피드백을 받지 못했어요. 잠시 후 다시 눌러 주세요.");
      return;
    }
    if (res?.status === 409 && data.code === "busy") {
      // 실패가 아닙니다. 이미 만드는 중인 피드백이 저장되기를 기다렸다가(위 effect) 화면에 보여 줍니다.
      // 그동안 pending을 그대로 두어 다른 요청 버튼도 막습니다.
      say("notice", typeof data.error === "string" ? data.error : BUSY_MESSAGE);
      return setWaiting({ known, tries: 0 });
    }
    if (res?.status === 429 && data.code === "too_many_failures") {
      // 다시 눌러도 같은 결과이므로 잠시 버튼을 막고, 선생님께 알리도록 안내합니다.
      setPending(null);
      setPaused(true);
      return say("error", typeof data.error === "string" ? data.error : TOO_MANY_FAILURES_MESSAGE);
    }
    const message = ctrl.signal.aborted
      ? "피드백을 만드는 데 너무 오래 걸리고 있어요. 잠시 후 다시 눌러 주세요."
      : !res
        ? "인터넷 연결을 확인해 주세요."
        : (data.error ?? "피드백을 받지 못했어요. 잠시 후 다시 눌러 주세요.");
    // 요청이 끊기거나 실패해도 서버에는 피드백이 저장됐을 수 있으니, 서버 기록으로 화면을 맞춥니다.
    const synced = await loadRounds(props.mandalartId);
    setPending(null);
    if (synced === "auth") return props.onAuthLost?.();
    if (synced) {
      setRounds(synced.rounds);
      if (synced.rounds.length > known) {
        return say("notice", "연결이 잠깐 끊겼지만 피드백은 만들어져 있었어요. 아래 카드를 확인해 보세요.");
      }
    }
    say("error", message);
  }

  const setResponse = (roundId: string, cardId: string, resp: CardView["response"]) =>
    setRounds((rs) =>
      rs.map((r) => (r.id !== roundId ? r : { ...r, cards: r.cards.map((c) => (c.id === cardId ? { ...c, response: resp } : c)) })),
    );

  // 카드가 한 장도 없는 회차 = 그 단계에서 규칙 진단·AI 진단 모두 고칠 점을 찾지 못한 첫 피드백(그 단계는 마친 것으로 봄).
  // 확인 피드백은 카드가 가리킨 칸(또는 짝 칸)을 고쳐야 받을 수 있고, 고친 카드마다 '해결됨'이나 '아직 해결 안 됨' 카드가 생기므로
  // 카드 없는 확인 피드백은 생기지 않습니다. 새 문제 없이 '해결됨'만 나온 확인 피드백에는 이 안내를 붙이지 않습니다
  // ('안 할래요'로 두고 고치지 않은 카드는 다시 판단하지 않으므로, 고칠 점이 없다고 말할 수 없음).
  // 제출한 뒤나 학급이 닫혀 볼 수만 있을 때(props.disabled)는 '넘어가세요/제출해도 좋아요' 없이 앞부분만 보여 줍니다.
  const renderRound = (r: RoundView, disabled: boolean) =>
    r.cards.length === 0 ? (
      <p className="rounded-lg bg-stone-100 p-3 text-sm">{zeroCardMessage(r.stage, props.disabled)}</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {r.cards.map((c) => (
          <Card key={c.id} card={c} content={props.content} disabled={disabled}
            onFocusTarget={props.onFocusTarget} onResponded={(resp) => setResponse(r.id, c.id, resp)}
            onSending={(sending) => setAnswering((n) => Math.max(0, n + (sending ? 1 : -1)))}
            onAuthLost={props.onAuthLost} />
        ))}
      </ul>
    );

  const stageButton = (st: Stage) => {
    const rs = roundsOf(st);
    // 더 받을 수 없는 경우에만 버튼을 숨깁니다. 카드를 모두 '안 할래요'로 고른 단계는 끝난 것으로 보지만,
    // 그래도 칸을 고쳤다면 확인 피드백을 받을 수 있게 버튼은 남겨 둡니다.
    const firstIssues = rs.find((r) => r.attempt === 1)?.cards.filter((c) => c.kind === "issue").length ?? 0;
    const noMore = rs.length > 0 && (firstIssues === 0 || rs.length >= Math.min(props.maxRounds, 2));
    if (props.disabled || noMore || !props.aiReady) return null;
    const recheck = rs.length > 0;
    const optional = recheck && stageDone(rs, props.maxRounds);
    const notReady = st.kind === "whole" && !recheck
      ? (wholeReady ? null : `중심·세부 목표와 8개 블록의 피드백(확인 피드백 포함)을 모두 마치면 열려요. (블록 ${blocksDone.size}/8)`)
      : stageNotReady(st, props.content);
    const making = pending === stageKey(st);
    return (
      <div className="flex flex-col gap-1">
        <button onClick={() => request(st)} disabled={!!notReady || pending !== null || answering > 0 || paused}
          className={`rounded-lg py-2.5 text-sm font-semibold text-white disabled:bg-stone-300 disabled:text-stone-600 ${recheck ? "bg-emerald-700" : "bg-sky-700"}`}>
          {making ? "피드백을 만들고 있어요… (보통 30초 안팎)" : recheck ? "고친 뒤 확인 피드백 받기" : `${stageLabel(st)} 피드백 받기`}
        </button>
        {notReady && <p className="text-xs text-stone-500">{notReady}</p>}
        {!notReady && recheck && (
          <p className="text-xs text-stone-500">
            {optional
              ? "카드를 모두 안 하기로 해서 이 단계는 마쳤어요. 그래도 카드가 가리킨 칸을 고쳤다면 눌러서 확인해 볼 수 있어요."
              : "카드가 가리킨 칸을 고친 뒤 눌러 보세요. 잘 고쳤는지 알려 줘요."}
          </p>
        )}
      </div>
    );
  };

  // 같은 단계에 더 나중 회차가 있으면 앞 회차 카드는 바꿀 수 없습니다(어느 화면에서 보든 같게).
  const latestOfStage = new Map<string, string>();
  for (const r of rounds) latestOfStage.set(`${r.stage}:${r.block_index ?? ""}`, r.id);
  // 피드백을 만드는 동안에도 잠급니다(서버가 요청 시점의 응답으로 판정하므로, 기다리는 사이 바꾼 응답이 엇갈리지 않게).
  const locked = (r: RoundView) => props.disabled || pending !== null || latestOfStage.get(`${r.stage}:${r.block_index ?? ""}`) !== r.id;

  const currentRounds = rounds.filter((r) => sameStage(r, current));
  const wholeButton = stageButton(whole);
  const wholeRounds = rounds.filter((r) => r.stage === "whole");
  const otherRounds = rounds.filter((r) => !sameStage(r, current) && r.stage !== "whole").reverse();
  const wholeShown = wholeReady || wholeRounds.length > 0 || wholeOpen;

  // 피드백 요청의 안내·오류는 누른 버튼 바로 아래에 보여 줍니다(카드 아래 맨 끝에 두면 30초 기다림 안내나
  // '아직 받을 수 없어요' 같은 거절을 보지 못함). 그 단계가 지금 화면에 없으면(다른 블록으로 옮겨 감) 맨 아래에 둡니다.
  const msgAt = msgStage === null ? "bottom"
    : msgStage === stageKey(current) ? "current"
      : msgStage === stageKey(whole) && wholeShown ? "whole" : "bottom";
  const messages = (error || notice) && (
    <div ref={msgRef} className="flex scroll-my-4 flex-col gap-1">
      {notice && <p role="status" className="text-sm text-sky-800">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );

  const chip = (label: string, done: boolean, active: boolean, onClick: () => void) => (
    <button key={label} onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-xs ${done ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-stone-300 text-stone-500"} ${active ? "ring-2 ring-sky-500" : ""}`}>
      {done ? "✓ " : ""}{label}
    </button>
  );

  return (
    <section ref={sectionRef} className="flex flex-col gap-3">
      <h2 className="font-bold">피드백</h2>
      <div className="flex flex-wrap gap-1.5">
        {chip("중심·세부", coreDone, current.kind === "core", () => props.onOpenStage({ kind: "core" }))}
        {Array.from({ length: 8 }, (_, i) =>
          chip(`블록${CIRCLED[i]}`, blocksDone.has(i), current.kind === "block" && current.index === i, () => props.onOpenStage({ kind: "block", index: i })),
        )}
        {chip("전체", wholeDone, false, () => {
          setWholeOpen(true);
          setWholeReq((n) => n + 1);
        })}
      </div>
      <p className="text-xs text-stone-600">
        단계마다 AI 피드백을 받고, 고친 뒤 <b>확인 피드백</b>으로 잘 고쳤는지 볼 수 있어요. 피드백은 참고용이에요. 카드마다 <b>해 볼게요</b> 또는 <b>안 할래요</b>를 스스로 정해요.
      </p>
      {!props.aiReady && !props.disabled && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          선생님이 아직 AI 피드백을 준비하지 않았어요. 만다라트는 계속 쓸 수 있어요.
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-white/60 p-3">
        <p className="text-sm font-semibold">{stageLabel(current)}</p>
        {stageButton(current)}
        {msgAt === "current" && messages}
        {currentRounds.map((r) => (
          <div key={r.id} className="flex flex-col gap-1">
            <p className="text-xs font-semibold text-stone-500">{r.attempt === 1 ? "첫 피드백" : "확인 피드백"}</p>
            {renderRound(r, locked(r))}
          </div>
        ))}
      </div>

      {wholeShown && (
        <div ref={wholeRef} tabIndex={-1}
          className="flex scroll-mt-4 flex-col gap-2 rounded-xl border border-stone-200 bg-white/60 p-3 outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
          <p className="text-sm font-semibold">{stageLabel(whole)}</p>
          {wholeButton}
          {msgAt === "whole" && messages}
          {!wholeButton && wholeRounds.length === 0 && (
            <p className="text-xs text-stone-500">
              {!props.aiReady
                ? "선생님이 AI 피드백을 준비하면 받을 수 있어요."
                : props.disabled
                  ? "전체 피드백은 받지 않았어요."
                  : `중심·세부 목표와 8개 블록의 피드백(확인 피드백 포함)을 모두 마치면 열려요. (블록 ${blocksDone.size}/8)`}
            </p>
          )}
          {wholeRounds.map((r) => (
            <div key={r.id} className="flex flex-col gap-1">
              <p className="text-xs font-semibold text-stone-500">{r.attempt === 1 ? "첫 피드백" : "확인 피드백"}</p>
              {renderRound(r, locked(r))}
            </div>
          ))}
        </div>
      )}
      {msgAt === "bottom" && messages}

      {otherRounds.length > 0 && (
        <div>
          <button onClick={() => setShowOther((v) => !v)} className="text-xs text-stone-500 underline">
            다른 단계 피드백 {showOther ? "접기" : `보기 (${otherRounds.length})`}
          </button>
          {showOther && (
            <div className="mt-2 flex flex-col gap-4">
              {otherRounds.map((r) => (
                <div key={r.id} className="flex flex-col gap-2">
                  <p className="text-xs font-semibold text-stone-500">
                    {stageLabel(r.stage === "block" ? { kind: "block", index: r.block_index ?? 0 } : { kind: r.stage })} · {r.attempt === 1 ? "첫 피드백" : "확인 피드백"}
                  </p>
                  {renderRound(r, locked(r))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
