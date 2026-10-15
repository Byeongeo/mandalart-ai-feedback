"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { targetKey, type MandalartContent, type Target } from "@/lib/mandalart";
import { CELL_MAX, GOAL_MAX, SAVE_TIMEOUT_MS, SAVE_WAIT_MS, clampContent, clampText, retryDelay, withTimeout } from "@/lib/student";
import {
  HANDOFF_KEY, STALE_MESSAGE, adoptIfOwn, isContent, makeHandoff, parseHandoff, prepareSend, sameContent, seedSync, settle, syncMeta, takeLanded,
  type Sync,
} from "@/lib/save-rules";
import FeedbackPanel, { type BeforeRequest, type RoundView } from "./FeedbackPanel";
import LogoutButton from "./LogoutButton";

// 3×3 격자에서 가운데(4)를 뺀 자리에 세부 목표/실천 0~7을 놓습니다.
const GRID_POS = [0, 1, 2, 3, 5, 6, 7, 8];
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

// 저장·제출·피드백 요청에 서버가 401(로그인 안 됨)로 답할 때. 선생님이 이름을 고치거나 PIN을 다시 만들면 그 전 로그인은 끝납니다.
const AUTH_LOST_MESSAGE = "로그인이 풀렸어요. 선생님이 이름이나 PIN을 바꿨을 수 있어요. 다시 로그인해 주세요.";
const UNSAVED_NOTE = " 마지막으로 저장된 뒤에 쓴 내용은 저장되지 않았어요. 필요하면 먼저 옮겨 적어 두세요.";
// 이미 제출된 것을 저장·제출하다가 알게 됐을 때(다른 기기에서 제출, 응답이 끊긴 앞선 제출 등) '다 했어요' 화면에 붙이는 안내
const SUBMITTED_UNSAVED_NOTE = "이미 제출된 만다라트라서, 이 화면에서 마지막으로 고친 내용은 저장되지 않았어요.";
const SUBMITTED_LOAD_FAILED = "제출한 내용을 불러오지 못했어요. ‘새로 고침’을 눌러 확인해 주세요.";
// 서버의 제출한 글을 불러올 때 기다리는 최대 시간
const LOAD_TIMEOUT_MS = 10_000;
// 화면을 연 뒤 서버 글을 한 번 다시 읽는 때. 새로 고치기 직전에 앞 화면이 보낸 저장이 이 화면을 그린 뒤에 반영됐는지 봅니다.
const RECHECK_AFTER_LOAD_MS = 2000;

type View = { kind: "center" } | { kind: "block"; sub: number };
type SaveState = "saved" | "dirty" | "saving" | "error";
type SaveReply = { error?: string; submitted?: boolean; stale?: boolean; closed?: boolean; code?: string; target?: Target; revision?: number };
// 서버가 더는 저장을 받지 않아 이 화면에서 쓰기를 멈춘 까닭: 쓰는 도중 학급이 닫힘(closed), 다른 탭·기기가 더 나중에 고침(stale),
// 로그인이 풀림(auth). 안내 문구와, 그때 저장 안 된 내용이 남아 있었는지
type Blocked = { kind: "closed" | "stale" | "auth"; text: string; unsaved: boolean };

function sameTarget(a: Target | null, b: Target): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "sub" && b.kind === "sub") return a.sub === b.sub;
  if (a.kind === "action" && b.kind === "action") return a.sub === b.sub && a.action === b.action;
  return true;
}

// 화면 밖에 있을 때만 스크롤합니다(넓은 화면에서 괜히 흔들리지 않게).
function reveal(el: Element) {
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

function Cell(props: {
  value: string;
  onChange?: (v: string) => void;
  placeholder: string;
  tone: "goal" | "sub" | "action";
  highlighted: boolean;
  readOnly: boolean;
  maxLength: number;
  footer?: React.ReactNode;
  label: string;
  bindInput?: (el: HTMLTextAreaElement | null) => void;
}) {
  const tones = {
    goal: "bg-amber-100 border-amber-400 font-bold",
    sub: "bg-sky-50 border-sky-300 font-semibold",
    action: "bg-white border-stone-300",
  };
  const { bindInput } = props;
  const composing = useRef(false);
  const [focused, setFocused] = useState(false);
  const editable = !props.readOnly && !!props.onChange;
  // 한글 조합 중에는 자르지 않고(글자가 깨짐), 조합이 끝나거나 칸을 벗어날 때 한도를 넘는 글자를 잘라 냅니다.
  // 이모지를 반으로 자르지 않도록 clampText로 자릅니다(반쪽 글자는 서버 DB가 받지 않음).
  const clamp = (v: string) => {
    if (editable && v.length > props.maxLength) props.onChange?.(clampText(v, props.maxLength));
  };
  const len = props.value.length;
  const nearLimit = focused && editable && len >= props.maxLength - 5;
  return (
    <div
      className={`relative flex aspect-square flex-col rounded-lg border-2 ${tones[props.tone]} ${
        props.highlighted ? "ring-4 ring-rose-400 ring-offset-1" : "focus-within:ring-2 focus-within:ring-sky-500"
      }`}
    >
      <div className="flex min-h-0 flex-1 flex-col justify-center">
        <textarea
          ref={bindInput}
          aria-label={props.label}
          value={props.value}
          readOnly={!editable}
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, " ");
            const isComposing = composing.current || (e.nativeEvent as InputEvent).isComposing;
            props.onChange?.(isComposing ? v : clampText(v, props.maxLength));
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; clamp(e.currentTarget.value.replace(/\n/g, " ")); }}
          onFocus={() => setFocused(true)}
          onBlur={(e) => { setFocused(false); composing.current = false; clamp(e.currentTarget.value.replace(/\n/g, " ")); }}
          placeholder={props.placeholder}
          maxLength={props.maxLength}
          rows={3}
          className="max-h-full w-full resize-none bg-transparent p-1 text-center text-base leading-snug outline-none [field-sizing:content] placeholder:text-stone-400 sm:p-2 sm:text-sm"
        />
      </div>
      {nearLimit && (
        <span aria-hidden="true" className={`pointer-events-none absolute right-1 top-0.5 text-[10px] ${len >= props.maxLength ? "font-bold text-red-700" : "text-stone-500"}`}>
          {len}/{props.maxLength}
        </span>
      )}
      {/* 글을 가리지 않도록 버튼 자리를 칸 안에 따로 둡니다. */}
      {props.footer && <div className="flex shrink-0">{props.footer}</div>}
    </div>
  );
}

function Overview({ c, onOpen, view }: { c: MandalartContent; onOpen: (v: View) => void; view: View }) {
  // 9×9 전체 모습. 블록을 누르면 그 블록으로 이동합니다.
  const block = (b: number) => {
    const isCenter = b === 4;
    const sub = isCenter ? -1 : GRID_POS.indexOf(b);
    const cells = Array.from({ length: 9 }, (_, p) => {
      if (isCenter) return p === 4 ? c.goal : c.subs[GRID_POS.indexOf(p)];
      return p === 4 ? c.subs[sub] : c.actions[sub][GRID_POS.indexOf(p)];
    });
    const active = isCenter ? view.kind === "center" : view.kind === "block" && view.sub === sub;
    return (
      <button
        key={b}
        aria-label={isCenter ? "중심 목표 보기" : `세부 목표 ${CIRCLED[sub]} 블록 보기`}
        onClick={() => onOpen(isCenter ? { kind: "center" } : { kind: "block", sub })}
        className={`grid grid-cols-3 gap-px rounded border p-px ${active ? "border-stone-900" : "border-stone-300"}`}
      >
        {cells.map((v, p) => (
          <span
            key={p}
            className={`flex aspect-square items-center justify-center overflow-hidden text-[7px] leading-none ${
              p === 4 ? (isCenter ? "bg-amber-200" : "bg-sky-100") : isCenter ? "bg-sky-50" : "bg-white"
            } ${v.trim() ? "text-stone-800" : "text-stone-300"}`}
          >
            {v.trim() ? clampText(v, 4) : "·"}
          </span>
        ))}
      </button>
    );
  };
  return <div className="grid grid-cols-3 gap-1">{Array.from({ length: 9 }, (_, b) => block(b))}</div>;
}

// 서버에 저장된 만다라트(글·저장 번호·상태)를 다시 읽습니다. 읽지 못하면 null.
async function loadSaved(url: string): Promise<{ content: MandalartContent; revision: number; status: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    const m = (await res.json().catch(() => null))?.mandalart;
    if (!res.ok || !isContent(m?.content) || typeof m?.revision !== "number" || typeof m?.status !== "string") return null;
    return { content: m.content, revision: m.revision, status: m.status };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div role="alert" className="flex items-start justify-between gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
      <span>{text}</span>
      <button type="button" aria-label="알림 닫기" onClick={onClose} className="shrink-0 px-1 text-red-700">✕</button>
    </div>
  );
}

export default function Editor(props: {
  mandalartId: string;
  initialContent: MandalartContent;
  /** 서버의 저장 번호(mandalarts.revision). 저장·제출할 때 함께 보냅니다. */
  initialRevision: number;
  submitted: boolean;
  header: string;
  maxRounds: number;
  initialRounds: RoundView[];
  /** false면 교사가 아직 AI 키를 넣지 않음 */
  aiReady: boolean;
  /** 학급이 닫혀 있으면 안내 문구(볼 수만 있음), 열려 있으면 null */
  closedMessage: string | null;
}) {
  const router = useRouter();
  const [content, setContent] = useState(props.initialContent);
  const [submitted, setSubmitted] = useState(props.submitted);
  // 제출한 뒤에는 '다 했어요' 화면을 먼저 보여 주고, 원하면 내 만다라트를 다시 볼 수 있게 합니다.
  const [viewing, setViewing] = useState(false);
  const [accepted, setAccepted] = useState(() =>
    props.initialRounds.flatMap((r) => r.cards).filter((c) => c.response?.action === "accept").length);
  const [submitting, setSubmitting] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // 인터넷·서버 문제로 연달아 실패한 횟수(0보다 크면 잠시 뒤 저절로 다시 저장)와 마지막 실패의 까닭
  // (network: 요청이 서버에 닿지 못했거나 15초 넘게 응답이 없음, server: 서버가 오류로 답함)
  const [failCount, setFailCount] = useState(0);
  const [failKind, setFailKind] = useState<"network" | "server">("network");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  // '다 했어요' 화면에 붙이는 안내(이미 제출된 것을 저장·제출하다가 알게 된 경우). reload면 제출한 글을 불러오지 못해 새로 고침을 안내합니다.
  const [doneNote, setDoneNote] = useState<{ text: string; reload: boolean } | null>(null);
  const [view, setView] = useState<View>({ kind: "center" });
  const [focus, setFocus] = useState<Target | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 피드백을 만드는 중(요청을 보냈거나 다른 요청이 만드는 것을 기다리는 중)이면 제출을 막습니다.
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  // 칸으로 이동해 달라는 요청(target이 없으면 격자 전체). n은 같은 칸을 다시 눌러도 동작하게 하는 번호.
  const [scrollReq, setScrollReq] = useState<{ target: Target | null; n: number } | null>(null);
  const latest = useRef(content);
  const version = useRef(0); // 고칠 때마다 1씩 늘어남
  const savedVersion = useRef(0); // 서버에 저장이 확인된 version
  const sync = useRef<Sync>({ revision: props.initialRevision, seq: 0, unknown: [] }); // 저장 번호 맞추기(src/lib/save-rules.ts의 Sync)
  // 이 화면이 받은 서버 글(처음 그린 글, 또는 마지막으로 받아들인 글). 서버 글을 받아들일 때 이 화면에서 고친 칸을 가립니다(takeLanded).
  const base = useRef(props.initialContent);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null); // 아래 save(먼저 정의되는 콜백에서 저장을 예약할 때)
  const inFlight = useRef<Promise<boolean> | null>(null); // 지금 보내는 중인 저장(한 번에 하나)
  const stopped = useRef(props.submitted || props.closedMessage !== null); // 제출했거나 학급이 닫혀 서버가 저장을 받지 않음
  const blockedRef = useRef(false); // 저장이 막힘(학급이 닫힘, 다른 화면에서 고침, 로그인이 풀림). 이 화면에서는 다시 풀리지 않음
  const leaving = useRef(false); // '새로 고침'을 눌러 이미 떠나기로 함(닫기 경고를 다시 띄우지 않음)
  // 'online' 이벤트를 받은 횟수. 저장을 보낼 때와 실패했을 때 모두 오프라인이고 그사이 다시 연결된 적이 없으면 그 요청은 서버에 닿지 못했습니다.
  const onlineSeen = useRef(0);
  const remainingStages = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cells = useRef(new Map<string, HTMLTextAreaElement>());
  const gridRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  // 막힌 뒤에도 글은 화면에 그대로 두어(선택·복사 가능) 필요하면 옮겨 적을 수 있게 합니다.
  const closed = props.closedMessage !== null;
  const readOnly = submitted || submitting || blocked !== null || closed;

  const url = `/api/mandalart/${props.mandalartId}`;

  const goTo = useCallback((t: Target) => {
    setFocus(t);
    if (t.kind === "action") setView({ kind: "block", sub: t.sub });
    else if (t.kind === "goal" || t.kind === "sub") setView({ kind: "center" });
    setScrollReq((r) => ({ target: t, n: (r?.n ?? 0) + 1 }));
  }, []);

  const showGrid = (v: View) => {
    setView(v);
    setScrollReq((r) => ({ target: null, n: (r?.n ?? 0) + 1 }));
  };

  // 바뀐 화면이 그려진 뒤 그 칸(또는 격자)이 보이게 하고, 칸이면 바로 쓸 수 있게 커서를 둡니다.
  useEffect(() => {
    if (!scrollReq) return;
    const t = scrollReq.target;
    const el = t && t.kind !== "whole" ? cells.current.get(targetKey(t)) : undefined;
    const box = el ?? gridRef.current;
    if (box) reveal(box);
    if (el && !el.readOnly) el.focus({ preventScroll: true });
  }, [scrollReq]);

  // 저장을 멈추고 화면을 읽기 전용으로 바꾼 뒤, 위쪽에 안내와 버튼(새로 고침 또는 다시 로그인)을 띄웁니다.
  // 이 화면에서는 다시 풀리지 않습니다. 글은 화면에 그대로 두어 옮겨 적을 수 있게 합니다.
  const halt = useCallback((kind: Blocked["kind"], text: string) => {
    stopped.current = true;
    blockedRef.current = true;
    setFailCount(0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const unsaved = version.current !== savedVersion.current;
    setBlocked((b) => b ?? { kind, text, unsaved });
  }, []);

  // 이미 제출된 것을 알게 됨(다른 기기에서 제출, 응답이 끊긴 앞선 제출 등): 더 저장하지 않고, 서버의 제출한 글을 불러와
  // '다 했어요' 화면에 보여 줍니다(이 화면의 저장 안 된 글을 제출한 글처럼 보여 주지 않게). 이 화면에 저장 안 된 글이 있었고
  // 제출한 글과 다르면 그 내용은 저장되지 않았다고 짧게 알립니다. 불러오지 못하면 새로 고침을 안내합니다.
  const showSubmitted = useCallback(async () => {
    stopped.current = true;
    setFailCount(0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const server = (await loadSaved(url))?.content;
    if (server) {
      const lost = version.current !== savedVersion.current && !sameContent(clampContent(latest.current), server);
      latest.current = server;
      setContent(server);
      savedVersion.current = version.current;
      setDoneNote(lost ? { text: SUBMITTED_UNSAVED_NOTE, reload: false } : null);
    } else {
      // 불러오지 못해도 이 화면에 저장 안 된 글이 있었으면 그 안내도 함께 보여 줍니다.
      const unsaved = version.current !== savedVersion.current;
      setDoneNote({ text: unsaved ? `${SUBMITTED_UNSAVED_NOTE} ${SUBMITTED_LOAD_FAILED}` : SUBMITTED_LOAD_FAILED, reload: true });
    }
    setSubmitted(true);
    setViewing(false);
    setSaveState("saved");
    setSaveError(null);
    setMessage(null);
    window.scrollTo({ top: 0 });
  }, [url]);

  // 다시 읽은 서버 글을 받아들입니다(save-rules.ts의 takeLanded: 같은 탭의 앞 화면이 보낸 글이거나, 이 화면에서 아직 아무것도
  // 고치지 않았을 때). 이 화면에서 고친 칸은 그대로 두고 나머지 칸을 서버 글로 바꾸며, 합친 글이 서버 글과 다르면 곧 저장합니다.
  // 받아들였으면 true.
  const takeServer = useCallback((row: { revision: number; content: MandalartContent }, pristine: boolean): boolean => {
    const next = takeLanded(sync.current, row, base.current, latest.current, pristine);
    if (!next) return false;
    base.current = row.content;
    if (!sameContent(next, latest.current)) {
      latest.current = next;
      setContent(next);
    }
    if (!sameContent(next, row.content)) {
      version.current += 1;
      setSaveState("dirty");
      if (!timer.current) timer.current = setTimeout(() => void saveRef.current?.(), 1500);
    }
    return true;
  }, []);

  // 저장·제출이 '다른 화면에서 고침'(409 stale)으로 거절됐을 때 서버 글을 다시 읽어 정말 다른 탭·기기인지 확인합니다.
  // 서버 글이 이 화면이 보낸 글이면(네트워크가 이 화면의 저장을 늦게 보내 번호가 더 올라간 경우) 번호를 맞추고 'own'
  // (바로 다시 보냄), 이미 제출됐으면 'submitted', 다른 글이면 'other', 읽지 못하면 'unknown'(인터넷 문제처럼 잠시 뒤 다시).
  // 같은 탭의 앞 화면(새로 고치기 전)이 보낸 글이 늦게 반영된 것이어도 받아들이고, 이 화면에서 고친 칸을 합쳐 다시 보냅니다(takeServer).
  const recheckStale = useCallback(async (): Promise<"own" | "submitted" | "other" | "unknown"> => {
    const row = await loadSaved(url);
    if (!row) return "unknown";
    if (row.status !== "draft") return "submitted";
    // 서버 번호가 이 화면이 이미 아는 번호면(요청을 보낸 뒤 이 화면이 그 번호를 알게 됨) 그대로 다시 보내면 됩니다.
    if (row.revision === sync.current.revision) return "own";
    return adoptIfOwn(sync.current, row) || takeServer(row, false) ? "own" : "other";
  }, [url, takeServer]);

  // 제출 안내가 나오면 그 안내가 보이게 합니다(이미 보이면 움직이지 않음).
  useEffect(() => {
    if (message) messageRef.current?.scrollIntoView({ block: "nearest" });
  }, [message]);

  // 최신 내용을 한 번 보냅니다. 결과에 따라 상태를 정리하고, 요청이 성공했는지(또는 바로 다시 보내야 하는지) 돌려줍니다.
  // 응답이 15초 안에 오지 않으면 끊고 인터넷 문제처럼 처리합니다(멈춘 요청 하나가 뒤의 저장을 모두 붙잡지 않게).
  const putLatest = useCallback(async (keepalive: boolean): Promise<boolean> => {
    const v = version.current;
    const { body, seq } = prepareSend(sync.current, clampContent(latest.current));
    const offlineAt = navigator.onLine === false ? onlineSeen.current : -1;
    setSaveState("saving");
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), SAVE_TIMEOUT_MS);
    let res: Response | null = null;
    let data: SaveReply = {};
    try {
      res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive, signal: ctrl.signal });
      data = await res.json().catch(() => ({}));
    } catch {
      res = null;
    } finally {
      clearTimeout(timeout);
    }
    if (res?.ok) {
      // 응답 본문이 끊겨 새 번호를 모르면 결과를 모르는 저장으로 남겨 둡니다(다음 저장에 지문을 함께 보냄).
      if (typeof data.revision === "number") settle(sync.current, seq, data.revision);
      savedVersion.current = Math.max(savedVersion.current, v);
      setFailCount(0);
      setSaveError(null);
      setSaveState(version.current === savedVersion.current ? "saved" : "dirty");
      return true;
    }
    if (!res || res.status >= 500 || res.status === 429) {
      // 인터넷·서버 문제(15초 넘게 응답이 없을 때 포함): 잠시 뒤 저절로 다시 저장합니다(아래 effect).
      // 서버에 반영됐을 수도 있으므로 보낸 내용의 지문은 기억해 두고 다음 저장에 함께 보냅니다(prepareSend).
      // 다만 보낼 때부터 실패할 때까지 오프라인이었으면(그사이 다시 연결된 적 없음) 서버에 닿지 못했으므로 잊습니다.
      // 오래 끊긴 동안 다시 보낸 저장의 지문이 쌓여, 정작 반영됐을 수 있는 것이 함께 보낼 수(MAX_PREV)에서 밀려나지 않게.
      // 서버가 오류로 답했으면 학생의 인터넷 탓이 아니므로 안내를 달리합니다.
      if (!res && offlineAt >= 0 && !ctrl.signal.aborted && navigator.onLine === false && onlineSeen.current === offlineAt) {
        settle(sync.current, seq, null);
      }
      setSaveState("error");
      setFailKind(res ? "server" : "network");
      setFailCount((n) => n + 1);
      return false;
    }
    settle(sync.current, seq, null);
    if (res.status === 409 && data.stale && sync.current.seq > seq) {
      // 이 저장을 보내는 사이 이 탭이 따로 보낸 저장(탭을 닫을 때 보내는 저장)이 먼저 반영된 경우: 그것까지 함께 알려 바로 다시 보냅니다.
      return true;
    }
    if (res.status === 409 && data.submitted) {
      // 이미 제출함(다른 기기 등): 더 보내지 않고, 서버의 제출한 글로 '다 했어요' 화면을 보여 줍니다.
      void showSubmitted();
      return false;
    }
    if (res.status === 409 && data.stale) {
      // 정말 다른 탭·기기가 고쳤는지 서버 글로 확인합니다. 이 화면이 보낸 글이면 번호를 맞추고 바로 다시 보냅니다.
      const check = await recheckStale();
      if (check === "own") return true;
      if (check === "submitted") {
        void showSubmitted();
        return false;
      }
      if (check === "unknown") {
        setSaveState("error");
        setFailKind("network");
        setFailCount((n) => n + 1);
        return false;
      }
    }
    setSaveState("error");
    if (res.status === 401) {
      halt("auth", AUTH_LOST_MESSAGE);
    } else if (res.status === 409 && data.stale) {
      // 다른 탭·기기에서 더 나중에 고침: 이 화면의 오래된 글로 덮어쓰지 않도록 멈추고 새로 고침을 안내합니다.
      halt("stale", data.error ?? STALE_MESSAGE);
    } else if (res.status === 409) {
      // 선생님이 학급을 닫아 더는 고칠 수 없음: 더 보내지 않고, 화면을 읽기 전용으로 바꾼 뒤 새로 고침을 안내합니다.
      halt("closed", data.error ?? "지금은 고칠 수 없어요.");
    } else {
      setSaveError(data.error ?? "저장하지 못했어요.");
      if (data.target) goTo(data.target);
    }
    return false;
  }, [url, goTo, halt, showSubmitted, recheckStale]);

  // 저장은 한 번에 하나만 보냅니다. 보내는 중에 또 부르면 그 저장이 끝난 뒤 최신 내용으로 한 번 더 보냅니다.
  // 화면의 최신 내용이 서버에 저장됐으면 true.
  const save = useCallback(async (keepalive = false): Promise<boolean> => {
    for (let tries = 0; tries < 3; tries++) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      while (inFlight.current) await inFlight.current;
      if (stopped.current) return version.current === savedVersion.current;
      if (version.current === savedVersion.current) {
        setSaveState("saved");
        return true;
      }
      const p = putLatest(keepalive);
      inFlight.current = p;
      let ok = false;
      try {
        ok = await p;
      } finally {
        if (inFlight.current === p) inFlight.current = null;
      }
      if (!ok) return false;
    }
    // 바로 다시 보내기가 거듭돼 끝나지 않았으면(드묾) 잠시 뒤 저절로 다시 저장합니다. 그사이 새로 고친 것이 있으면 예약(timer)이 맡습니다.
    const done = version.current === savedVersion.current;
    if (!done && !stopped.current && !timer.current) {
      setSaveState("error");
      setFailKind("server");
      setFailCount((n) => n + 1);
    }
    return done;
  }, [putLatest]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const update = (fn: (c: MandalartContent) => MandalartContent) => {
    if (readOnly || blockedRef.current) return;
    setContent((prev) => {
      const next = fn(structuredClone(prev));
      latest.current = next;
      return next;
    });
    version.current += 1;
    setSaveState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 1500);
  };

  useEffect(() => {
    const seen = () => { onlineSeen.current += 1; };
    window.addEventListener("online", seen);
    return () => window.removeEventListener("online", seen);
  }, []);

  // 인터넷·서버 문제로 실패하면 2초, 5초, 10초… 뒤에 다시 시도하고, 인터넷이 다시 연결되면 바로 시도합니다.
  useEffect(() => {
    if (failCount === 0) return;
    const t = setTimeout(() => void save(), retryDelay(failCount));
    const online = () => void save();
    window.addEventListener("online", online);
    return () => {
      clearTimeout(t);
      window.removeEventListener("online", online);
    };
  }, [failCount, save]);

  // 탭을 닫거나 다른 앱으로 갈 때: 저장되지 않은 내용을 보내고, 닫기 전에는 경고합니다.
  // 저장이 막힌 뒤(단계 바뀜)에는 보내지 않지만, 저장 안 된 글이 사라지므로 닫기 전 경고는 합니다.
  useEffect(() => {
    const unsaved = () => version.current !== savedVersion.current && !stopped.current;
    // 페이지가 사라져도 요청이 끝까지 가도록 keepalive로 보냅니다(보내는 중인 저장이 있어도 마지막 기회라 보냄).
    // 보내는 중인 저장도 '결과를 모르는 저장'으로 함께 보내므로, 그 저장이 먼저 반영돼 번호가 올라가 있어도 이 저장이 받아들여집니다.
    // 반대로 이것이 먼저 반영되면 늦게 도착한 앞 저장은 번호가 맞지 않아 반영되지 않습니다(더 새 글이 남음).
    const beacon = () => {
      if (!unsaved()) return;
      const { body, seq } = prepareSend(sync.current, clampContent(latest.current));
      const offlineAt = navigator.onLine === false ? onlineSeen.current : -1;
      fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {
        // 보낼 때부터 실패할 때까지 오프라인이었으면 서버에 닿지 못했으므로 잊습니다(putLatest와 같음).
        if (offlineAt >= 0 && navigator.onLine === false && onlineSeen.current === offlineAt) settle(sync.current, seq, null);
      });
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      if (unsaved()) {
        void save(true);
        e.preventDefault();
      } else if (blockedRef.current && version.current !== savedVersion.current) {
        e.preventDefault();
      }
    };
    // 휴대폰에서 다른 앱으로 가면 pagehide 없이 이 이벤트만 오고, 그 뒤 탭이 말없이 지워질 수 있습니다.
    // 그래서 보내는 중인 저장을 기다리지 않습니다: 보내는 중이면 지금 최신 글을 keepalive로 따로 보내고, 아니면 바로 저장합니다.
    const onHidden = () => {
      if (document.visibilityState !== "hidden" || !unsaved()) return;
      if (inFlight.current) beacon();
      else void save(true);
    };
    // 같은 탭의 다음 화면(새로 고침 등)에 결과를 모르는 저장을 넘겨줍니다(save-rules.ts의 makeHandoff, 아래 이어받기).
    const handOff = () => {
      try {
        const h = makeHandoff(props.mandalartId, sync.current);
        if (h) sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(h));
        else sessionStorage.removeItem(HANDOFF_KEY);
      } catch {
        // 저장소를 쓸 수 없으면(사생활 보호 모드 등) 넘기지 않습니다.
      }
    };
    const onPageHide = () => {
      beacon();
      handOff();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHidden);
    const pending = timer;
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHidden);
      // 화면을 떠날 때(로그아웃 등) 남은 예약을 지우고, 저장 안 된 내용이 있으면 마지막으로 보냅니다.
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
      beacon();
      handOff();
    };
  }, [save, url, props.mandalartId]);

  // 새로 고친 화면: 같은 탭의 앞 화면이 넘겨준 결과를 모르는 저장을 이어받고(seedSync), 잠시 뒤 서버 글을 한 번 다시 읽습니다.
  // 앞 화면이 떠나며 보낸 저장이 이 화면을 서버가 그린 뒤에 반영됐으면 그 글을 알림 없이 받아들여 보여 줍니다(takeServer).
  // 그보다 늦게 반영되면 이 화면의 저장이 거절된 뒤 같은 방법으로 받아들입니다(recheckStale).
  // 뒤로 가기 캐시에서 다시 보인 화면(pageshow persisted)도 한 번 다시 읽습니다.
  useEffect(() => {
    try {
      const h = parseHandoff(sessionStorage.getItem(HANDOFF_KEY), props.mandalartId);
      sessionStorage.removeItem(HANDOFF_KEY);
      if (h) seedSync(sync.current, h);
    } catch {
      // 저장소를 쓸 수 없으면 이어받지 않습니다.
    }
    let t: ReturnType<typeof setTimeout> | null = null;
    const recheckSoon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(async () => {
        if (stopped.current) return;
        const row = await loadSaved(url);
        if (!row || row.status !== "draft" || stopped.current) return;
        takeServer(row, version.current === 0 && sync.current.unknown.length === 0);
      }, RECHECK_AFTER_LOAD_MS);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      try {
        sessionStorage.removeItem(HANDOFF_KEY); // 이 화면이 떠나며 남긴 것(같은 화면이 다시 보이므로 필요 없음)
      } catch {
        // 저장소를 쓸 수 없음
      }
      recheckSoon();
    };
    recheckSoon();
    window.addEventListener("pageshow", onShow);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener("pageshow", onShow);
    };
  }, [props.mandalartId, url, takeServer]);

  // 저장이 끝나기를 길어야 ms까지 기다립니다. 보내는 중인 저장이 없어지면 true.
  async function waitIdle(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (inFlight.current) {
      const left = end - Date.now();
      if (left <= 0) return false;
      await withTimeout(inFlight.current, left, false);
    }
    return true;
  }

  // 피드백을 요청하기 전에 저장합니다(길어야 20초). 저장이 막혀(다른 화면에서 고침, 로그인이 풀림, 학급이 닫힘, 이미 제출함)
  // 화면 위쪽에 이미 안내가 나왔으면 'stopped'(피드백 쪽에서 '먼저 저장' 안내를 겹쳐 띄우지 않게).
  async function beforeFeedback(): Promise<BeforeRequest> {
    if (await withTimeout(save(), SAVE_WAIT_MS, false)) return "saved";
    return blockedRef.current || stopped.current ? "stopped" : "unsaved";
  }

  // 피드백 요청에 함께 보낼 저장 번호 정보(서버가 오래된 화면인지 저장과 같은 규칙으로 확인)와, 서버가 '다른 화면에서 고침'으로
  // 답할 때 할 일. 요청을 보낸 뒤 이 화면이 저장을 보냈다면 그 저장이 먼저 반영되어 거절됐을 수 있으므로 멈추지 않고
  // (다시 누르면 됨), 그사이 보낸 저장이 없을 때만 멈춥니다. 화면을 멈췄으면(저장이 막혀 이미 멈춘 경우 포함) true.
  function prepareFeedback() {
    const seq = sync.current.seq;
    return {
      meta: syncMeta(sync.current, clampContent(latest.current)),
      onStale: async () => {
        await waitIdle(SAVE_WAIT_MS);
        if (blockedRef.current) return true;
        if (sync.current.seq !== seq) return false;
        // 서버 글이 이 화면이 보낸 글이면 다른 화면이 아니므로 멈추지 않습니다(다시 누르면 됨).
        const check = await recheckStale();
        if (check === "own" || check === "unknown") return false;
        if (check === "submitted") {
          void showSubmitted();
          return true;
        }
        halt("stale", STALE_MESSAGE);
        return true;
      },
    };
  }

  // 로그아웃 전에 마지막으로 저장합니다(길어야 20초). 저장하지 못했으면 그래도 나갈지 묻습니다.
  // 자동 재시도(failCount)는 그대로 둡니다. 로그아웃이 실패해 화면에 남아도 계속 다시 저장하도록.
  async function beforeLogout(): Promise<boolean> {
    const ok = await withTimeout(save(), SAVE_WAIT_MS, false);
    if (ok || version.current === savedVersion.current) return true;
    return confirm("저장되지 않은 내용이 있어요. 그래도 나갈까요?");
  }

  async function submit() {
    if (submitting || submitted || feedbackBusy) return;
    const left = props.aiReady ? remainingStages.current : 0;
    const msg = left > 0
      ? `아직 피드백(확인 피드백 포함)을 마치지 않은 단계가 ${left}개 있어요.\n제출하면 더 이상 고칠 수 없어요. 그래도 제출할까요?`
      : "제출하면 더 이상 고칠 수 없어요. 제출할까요?";
    if (!confirm(msg)) return;
    setSubmitting(true);
    setMessage(null);
    // 제출하는 동안에는 자동 저장(예약·재시도)을 멈춥니다. 실패하면 restore()로 다시 켭니다.
    const wasStopped = stopped.current;
    stopped.current = true;
    setFailCount(0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const restore = () => {
      stopped.current = wasStopped || blockedRef.current;
      if (!stopped.current && version.current !== savedVersion.current) void save();
    };
    // 보내는 중인 자동 저장이 제출보다 늦게 도착하지 않도록 먼저 끝까지 기다립니다(길어야 20초).
    if (!(await waitIdle(SAVE_WAIT_MS))) {
      setMessage("저장이 끝나지 않아 제출하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.");
      setSubmitting(false);
      restore();
      return;
    }
    // 기다리는 동안 저장이 막힌 것(학급이 닫힘, 다른 화면에서 고침, 로그인이 풀림)을 알게 됐으면 제출하지 않습니다(위쪽 안내가 보임).
    if (blockedRef.current) {
      setSubmitting(false);
      return;
    }
    // 자동 저장과 같은 저장 번호를 함께 보냅니다(다른 탭·기기가 더 나중에 고쳤으면 서버가 받지 않음).
    // '다른 화면에서 고침'으로 거절됐지만 서버 글이 이 화면이 보낸 글이면(recheckStale) 번호를 맞춰 한 번 더 보냅니다.
    // 제출 요청도 15초까지만 기다립니다(멈춘 요청 때문에 '제출하는 중…'에서 끝나지 않게). 끊은 제출은 서버에 반영됐을 수 있으므로
    // 결과를 모르는 저장으로 남겨 두고(settle 하지 않음), 다시 누르면 그 지문을 함께 보내 같은 제출로 확인됩니다.
    try {
      for (let attempt = 0; ; attempt++) {
        const v = version.current;
        const { body, seq } = prepareSend(sync.current, clampContent(latest.current));
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), SAVE_TIMEOUT_MS);
        let res: Response;
        let data: SaveReply;
        try {
          res = await fetch(`/api/mandalart/${props.mandalartId}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: ctrl.signal,
          });
          data = (await res.json().catch(() => ({}))) as SaveReply;
        } finally {
          clearTimeout(timeout);
        }
        if (res.ok) {
          // 이미 제출한 글과 똑같은 글로 다시 제출한 경우(앞선 제출의 응답이 끊김 등)도 성공입니다.
          if (typeof data.revision === "number") settle(sync.current, seq, data.revision);
          stopped.current = true;
          savedVersion.current = v;
          setSubmitted(true);
          setSaveState("saved");
          setSaveError(null);
          setFailCount(0);
          setViewing(false);
          window.scrollTo({ top: 0 });
          return;
        }
        if (res.status < 500) settle(sync.current, seq, null);
        if (res.status === 409 && data.submitted) {
          // 이미 다른 글로 제출돼 있음(다른 기기에서 제출 등): 오류가 아니라 서버의 제출한 글로 '다 했어요' 화면을 보여 줍니다.
          await showSubmitted();
          return;
        }
        if (res.status === 409 && data.stale) {
          const check = await recheckStale();
          if (check === "own" && attempt === 0) continue;
          if (check === "submitted") {
            await showSubmitted();
            return;
          }
          if (check === "other") halt("stale", data.error ?? STALE_MESSAGE);
          else setMessage("제출하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.");
        } else if (res.status === 401) {
          halt("auth", AUTH_LOST_MESSAGE);
        } else if (res.status === 409 && data.closed) {
          // 그사이 선생님이 학급을 닫음: 저장도 막히므로 읽기 전용으로 바꾸고 새로 고침을 안내합니다.
          halt("closed", data.error ?? "지금은 제출할 수 없어요.");
        } else {
          // 피드백을 만드는 중(code: feedback_pending) 등: 안내만 하고 계속 쓸 수 있게 둡니다.
          setMessage(data.error ?? "제출하지 못했어요.");
        }
        break;
      }
    } catch {
      setMessage("제출하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.");
    } finally {
      setSubmitting(false);
    }
    restore();
  }

  // 저장이 막혔을 때 '새로 고침': 저장 안 된 글이 있으면 사라진다는 것을 한 번 더 알립니다.
  function reloadPage() {
    if (blocked?.unsaved && !confirm("새로 고치면 저장되지 않은 내용은 사라져요. 필요하면 먼저 옮겨 적어 두세요. 새로 고칠까요?")) return;
    leaving.current = true;
    window.location.reload();
  }

  // 로그인이 풀렸을 때 '다시 로그인하기': 첫 화면(학생 로그인)으로 갑니다. 저장 안 된 글이 있으면 한 번 더 알립니다.
  function goLogin() {
    if (blocked?.unsaved && !confirm("다시 로그인하러 가면 저장되지 않은 내용은 사라져요. 필요하면 먼저 옮겨 적어 두세요. 이동할까요?")) return;
    leaving.current = true;
    router.replace("/");
    router.refresh();
  }

  // 인터넷·서버 문제로 저장이 안 되어 잠시 뒤 저절로 다시 저장하는 중
  const retrying = !blocked && saveState === "error" && failCount > 0;
  const retryNote = failKind === "network" ? "인터넷 연결을 확인해요" : "잠시 뒤 다시 저장해요";
  const saveLabel = blocked
    ? "저장 안 됨"
    : saveState === "saved" ? "저장됨" : saveState === "error" ? (retrying ? `저장 안 됨 — ${retryNote}` : "저장 안 됨") : "저장 중…";

  const bindCell = (t: Target) => (el: HTMLTextAreaElement | null) => {
    const k = targetKey(t);
    if (el) cells.current.set(k, el);
    else cells.current.delete(k);
  };

  const grid =
    view.kind === "center" ? (
      Array.from({ length: 9 }, (_, p) => {
        if (p === 4)
          return (
            <Cell key={p} label="중심 목표" tone="goal" value={content.goal} placeholder="중심 목표"
              maxLength={GOAL_MAX} readOnly={readOnly} highlighted={sameTarget(focus, { kind: "goal" })}
              bindInput={bindCell({ kind: "goal" })}
              onChange={(v) => update((c) => ({ ...c, goal: v }))} />
          );
        const i = GRID_POS.indexOf(p);
        return (
          <Cell key={p} label={`세부 목표 ${i + 1}`} tone="sub" value={content.subs[i]}
            placeholder={`세부 목표 ${CIRCLED[i]}`} maxLength={CELL_MAX} readOnly={readOnly}
            highlighted={sameTarget(focus, { kind: "sub", sub: i })}
            bindInput={bindCell({ kind: "sub", sub: i })}
            onChange={(v) => update((c) => { c.subs[i] = v; return c; })}
            footer={
              <button
                onClick={() => setView({ kind: "block", sub: i })}
                className="m-1 flex-1 rounded bg-sky-600 px-1 py-0.5 text-[11px] font-medium text-white"
              >
                실천 {content.actions[i].filter((a) => a.trim()).length}/8 →
              </button>
            } />
        );
      })
    ) : (
      Array.from({ length: 9 }, (_, p) => {
        const s = view.sub;
        if (p === 4)
          return (
            <Cell key={p} label={`세부 목표 ${s + 1}`} tone="sub" value={content.subs[s]}
              placeholder={`세부 목표 ${CIRCLED[s]}`} maxLength={CELL_MAX} readOnly={readOnly}
              highlighted={sameTarget(focus, { kind: "sub", sub: s })}
              bindInput={bindCell({ kind: "sub", sub: s })}
              onChange={(v) => update((c) => { c.subs[s] = v; return c; })} />
          );
        const j = GRID_POS.indexOf(p);
        return (
          <Cell key={p} label={`실천 ${j + 1}`} tone="action" value={content.actions[s][j]}
            placeholder={`실천 ${j + 1}`} maxLength={CELL_MAX} readOnly={readOnly}
            highlighted={sameTarget(focus, { kind: "action", sub: s, action: j })}
            bindInput={bindCell({ kind: "action", sub: s, action: j })}
            onChange={(v) => update((c) => { c.actions[s][j] = v; return c; })} />
        );
      })
    );

  const showDone = submitted && !viewing;
  const filled = (content.goal.trim() ? 1 : 0) + content.subs.filter((x) => x.trim()).length + content.actions.flat().filter((x) => x.trim()).length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="inline-block rounded-md bg-stone-200 px-2 py-0.5 text-sm font-semibold text-stone-900">{props.header}</p>
          <h1 className="mt-1 text-lg font-bold">나의 만다라트</h1>
        </div>
        <div className="flex items-center gap-3">
          {!submitted && (
            <span role="status" className={`text-xs ${blocked || saveState === "error" ? "font-semibold text-red-700" : "text-stone-500"}`}>
              {saveLabel}
            </span>
          )}
          <LogoutButton beforeLogout={beforeLogout} />
        </div>
      </header>

      {showDone && (
        <section className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-emerald-200 bg-white px-6 py-10 text-center">
          <p className="text-5xl" aria-hidden="true">🎉</p>
          <h2 className="text-xl font-bold">제출을 마쳤어요. 수고했어요!</h2>
          {doneNote && (
            <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{doneNote.text}</p>
          )}
          {doneNote?.reload ? (
            <button type="button" onClick={() => window.location.reload()}
              className="rounded-lg border border-stone-400 bg-white px-4 py-2 text-sm font-semibold hover:bg-stone-100">
              새로 고침
            </button>
          ) : (
            <>
              {content.goal.trim() && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm">
                  나의 중심 목표 <b className="block text-base">{content.goal}</b>
                </p>
              )}
              <p className="text-sm text-stone-600">
                채운 칸 {filled}/73
                {accepted > 0 && ` · 해 보기로 한 피드백 ${accepted}개`}
              </p>
              <p className="text-sm text-stone-600">이제 계획한 실천을 하나씩 해 보세요. 고칠 것이 생기면 선생님께 말씀드려요.</p>
              <button type="button" onClick={() => setViewing(true)}
                className="rounded-lg border border-stone-400 bg-white px-4 py-2 text-sm font-semibold hover:bg-stone-100">
                내 만다라트 다시 보기
              </button>
            </>
          )}
        </section>
      )}

      {closed && !submitted && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
          <span>{props.closedMessage} 선생님이 다시 열면 &lsquo;새로 고침&rsquo;을 눌러요.</span>
          <button type="button" onClick={() => window.location.reload()} className="rounded bg-white px-2 py-1 text-xs font-semibold text-amber-900">
            새로 고침
          </button>
        </div>
      )}
      {!submitted && retrying && (
        <div role="alert" className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white shadow-md">
          <span>
            {failKind === "network"
              ? "저장이 안 됐어요. 인터넷 연결을 확인해요. 연결되면 저절로 다시 저장해요."
              : "저장이 안 됐어요. 잠시 뒤 자동으로 다시 저장할게요."}
          </span>
          <button type="button" onClick={() => void save()} className="rounded bg-white px-2 py-1 text-xs font-semibold text-red-700">
            지금 다시 저장
          </button>
        </div>
      )}
      {!submitted && blocked && (
        <div role="alert" className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white shadow-md">
          <span>
            {blocked.text}
            {blocked.unsaved && UNSAVED_NOTE}
          </span>
          {blocked.kind === "auth" ? (
            <button type="button" onClick={goLogin} className="rounded bg-white px-2 py-1 text-xs font-semibold text-red-700">
              다시 로그인하기
            </button>
          ) : (
            <button type="button" onClick={reloadPage} className="rounded bg-white px-2 py-1 text-xs font-semibold text-red-700">
              새로 고침
            </button>
          )}
        </div>
      )}
      {submitted && viewing && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">제출한 만다라트예요. 볼 수만 있어요.</p>
      )}
      {saveError && <Notice text={saveError} onClose={() => setSaveError(null)} />}

      {/* 완료 화면에서도 숨기기만 하고 그대로 두어, 받은 피드백 카드가 다시 볼 때 그대로 남게 합니다. */}
      <div className={`flex flex-col gap-6 lg:flex-row ${showDone ? "hidden" : ""}`}>
        <section className="flex w-full flex-col gap-3 lg:max-w-lg">
          <div className="flex items-center justify-between">
            {view.kind === "block" ? (
              <>
                <button onClick={() => setView({ kind: "center" })} className="text-sm font-medium text-sky-700">
                  ← 중심으로
                </button>
                <span className="text-sm font-semibold">세부 목표 {CIRCLED[view.sub]}의 실천</span>
                <span className="flex gap-2">
                  <button aria-label="이전 세부 목표" onClick={() => setView({ kind: "block", sub: (view.sub + 7) % 8 })} className="px-2 text-lg">‹</button>
                  <button aria-label="다음 세부 목표" onClick={() => setView({ kind: "block", sub: (view.sub + 1) % 8 })} className="px-2 text-lg">›</button>
                </span>
              </>
            ) : (
              <span className="text-sm text-stone-600">가운데에 중심 목표, 둘레에 세부 목표 8개를 써요.</span>
            )}
          </div>
          <div ref={gridRef} className="grid grid-cols-3 gap-1.5 sm:gap-2">{grid}</div>

          {!submitted && (
            <div className="mt-2 flex flex-col items-end gap-1">
              <button onClick={submit} disabled={readOnly || feedbackBusy} aria-describedby={feedbackBusy && !readOnly ? "submit-hint" : undefined}
                className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
                {submitting ? "제출하는 중…" : "제출하기"}
              </button>
              {feedbackBusy && !readOnly && (
                <p id="submit-hint" className="text-xs text-stone-600">피드백을 만드는 중이에요. 다 만들어진 뒤에 제출할 수 있어요.</p>
              )}
            </div>
          )}
          {/* 제출 결과 안내는 제출하기 버튼 바로 아래에 둡니다(위쪽에 두면 버튼을 누른 자리에서 보이지 않음). */}
          {message && (
            <div ref={messageRef}>
              <Notice text={message} onClose={() => setMessage(null)} />
            </div>
          )}
        </section>

        <aside className="flex w-full flex-col gap-6 lg:max-w-md">
          <div>
            <p className="mb-2 text-xs font-medium text-stone-500">전체 보기 (누르면 이동)</p>
            <div className="max-w-[18rem]">
              <Overview c={content} view={view} onOpen={showGrid} />
            </div>
          </div>
          <FeedbackPanel
            mandalartId={props.mandalartId}
            content={content}
            initialRounds={props.initialRounds}
            maxRounds={props.maxRounds}
            aiReady={props.aiReady}
            disabled={readOnly}
            onAcceptedChange={setAccepted}
            view={view.kind === "center" ? { kind: "center" } : { kind: "block", sub: view.sub }}
            beforeRequest={beforeFeedback}
            prepareRequest={prepareFeedback}
            onBusyChange={setFeedbackBusy}
            onAuthLost={() => halt("auth", AUTH_LOST_MESSAGE)}
            onSubmitted={() => void showSubmitted()}
            onFocusTarget={goTo}
            onProgress={(n) => { remainingStages.current = n; }}
            onOpenStage={(st) => showGrid(st.kind === "block" ? { kind: "block", sub: st.index } : { kind: "center" })}
          />
        </aside>
      </div>
    </div>
  );
}
