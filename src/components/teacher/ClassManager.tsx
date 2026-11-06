"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { readRenames, renameWarning, rosterDiff, type RosterRow } from "@/lib/roster";
import type { ClassOverview, StudentProgress } from "@/lib/queries";
import { fmtKst, type Jsonify } from "../format";
import RosterInput from "./RosterInput";
import ExportButtons from "./ExportButtons";
import { SCHOOL_LEVELS, SCHOOL_LEVEL_KEYS, type SchoolLevel } from "@/lib/school-level";
import { AI_SOURCE_NOTE, RULE_GONE_TEXT, RULE_NOW_TEXT, RULE_SOURCE_NOTE, SafetyHint, concernLabel, ruleKindsText } from "./concern";

type Overview = Jsonify<ClassOverview>;
type Student = Jsonify<StudentProgress>;
type Reply = Record<string, unknown>;

const NET_ERROR = "⚠ 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 시도하세요.";
const AUTO_REFRESH_MS = 30_000;
// 학생 정보 고치기(PATCH …/students)가 한 번에 받는 최대 인원
const STUDENT_BATCH = 60;

// 안내 카드에 넣을 앱 주소(브라우저에서만 알 수 있음)
const noSubscribe = () => () => {};
function useOrigin(): string {
  return useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");
}

function Mark({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${done ? "bg-emerald-100 font-semibold text-emerald-800" : "bg-stone-100 text-stone-500"}`}>
      {children}
    </span>
  );
}

// 학생 표의 표현 검사 표시: 지금 글에서 걸리는 종류와, 기록된 가장 무거운 종류가 지금 글에 없으면 그 종류를 따로 보여 줍니다.
function RuleConcernMark({ rule }: { rule: NonNullable<Student["rule_concern"]> }) {
  const k = ruleKindsText(rule);
  return (
    <>
      {k.now && <span className="whitespace-nowrap font-semibold">⚠️ 표현: {k.now}</span>}
      {k.gone && (
        <span className="whitespace-nowrap text-stone-500">
          {k.now ? "" : "⚠️ 표현: "}{k.gone} ({RULE_GONE_TEXT})
        </span>
      )}
    </>
  );
}

export default function ClassManager({ overview }: { overview: Overview }) {
  const { cls, students, aiConcerns, ruleConcerns, hasWork } = overview;
  const router = useRouter();
  const origin = useOrigin();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [showRoster, setShowRoster] = useState(false);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [rosterKey, setRosterKey] = useState(0);
  // PIN은 기본으로 숨깁니다(화면을 칠판·TV에 띄워도 보이지 않게).
  const [showPins, setShowPins] = useState(false);
  // 안전 신호(누가, 어떤 종류)도 기본으로 숨깁니다. 수업 시작 때 학급 코드를 보여 주려고 화면을 띄워도 친구들이 보지 못하게.
  // PIN처럼 저장하지 않으므로 페이지를 다시 열면 다시 숨겨집니다(30초 자동 새로 고침에는 그대로).
  const [showSafety, setShowSafety] = useState(false);
  // 설정(단계별 피드백 횟수, '학생 PIN 사용', 학교급)을 바꾸는 동안 고른 값(value)을 먼저 보여 줍니다. 요청이 끝나고 새로 고친 서버 자료가
  // 들어오면 버리고, 그 전에라도 서버 값이 바뀌면(from과 다름) 버립니다. 그 뒤로는 늘 서버 값을 따르므로, 다른 기기에서 다시 바꾼 값도
  // '새로 고침'이나 30초 자동 새로 고침으로 그대로 보입니다(먼저 보여 준 값이 남아 서버 값을 가리지 않게).
  const [pendingRounds, setPendingRounds] = useState<{ value: number; from: number } | null>(null);
  const [pendingPin, setPendingPin] = useState<{ value: boolean; from: boolean } | null>(null);
  const [pendingLevel, setPendingLevel] = useState<{ value: SchoolLevel; from: SchoolLevel } | null>(null);
  if (pendingRounds && pendingRounds.from !== cls.max_feedback_rounds) setPendingRounds(null);
  if (pendingPin && pendingPin.from !== cls.require_pin) setPendingPin(null);
  if (pendingLevel && pendingLevel.from !== cls.school_level) setPendingLevel(null);
  const [deleteCode, setDeleteCode] = useState("");

  // 학급이 열려 있는 동안 진행 상황을 30초마다 새로 고칩니다(화면을 보고 있을 때만).
  useEffect(() => {
    if (!cls.is_open) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [cls.is_open, router]);

  async function request(url: string, method: string, body: unknown) {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { res, data: (await res.json().catch(() => ({}))) as Reply };
  }

  function failMessage(status: number, data: Reply): string {
    if (status === 401) return "⚠ 로그인이 끝났습니다. 다시 로그인하세요.";
    if (status === 404) return "⚠ 찾을 수 없습니다. 화면을 새로 고쳐 보세요.";
    return `⚠ ${typeof data.error === "string" ? data.error : "실패했습니다."}`;
  }

  // 서버에 요청하고 결과 문구를 보여 준 뒤 화면을 새로 고칩니다. 성공하면 응답 본문, 실패하면 null.
  // settle: 성공한 뒤 새로 고친 서버 자료가 화면에 들어올 때 함께 할 일(먼저 보여 준 설정 값 버리기). 새로 고침과 같은 transition에서
  // 부르므로 새 자료가 올 때까지는 먼저 보여 준 값이 남고(옛 값으로 잠깐 되돌아가 보이지 않음), 새 자료와 함께 서버 값으로 바뀝니다.
  async function call(url: string, method: string, body: unknown, okMsg: (d: Reply) => string, settle?: () => void): Promise<Reply | null> {
    setMsg(null);
    setBusy(true);
    try {
      const { res, data } = await request(url, method, body);
      if (!res.ok) {
        setMsg(failMessage(res.status, data));
        router.refresh();
        return null;
      }
      setMsg(okMsg(data));
      if (settle) {
        startRefresh(() => {
          router.refresh();
          settle();
        });
      } else {
        router.refresh();
      }
      return data;
    } catch {
      setMsg(NET_ERROR);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const classUrl = `/api/teacher/classes/${cls.id}`;

  function setOpen(open: boolean) {
    if (!open && !confirm(`[${cls.name}] 학생 쓰기를 닫을까요?\n\n닫으면 학생은 자기 만다라트를 볼 수만 있고, 고치기·피드백·제출은 못 합니다. 쓰던 글은 그대로 남고, 다시 열면 이어서 쓸 수 있습니다.`)) return;
    void call(classUrl, "PATCH", { isOpen: open }, () => (open ? "학생 쓰기를 열었습니다." : "학생 쓰기를 닫았습니다."));
  }

  async function setMaxRounds(n: number) {
    setPendingRounds({ value: n, from: cls.max_feedback_rounds });
    const ok = await call(classUrl, "PATCH", { maxFeedbackRounds: n }, () => "저장했습니다.", () => setPendingRounds(null));
    if (!ok) setPendingRounds(null);
  }

  // 학교급: AI 진단 기준과 카드 질문 수준만 바뀝니다. 피드백을 요청할 때 서버가 읽으므로 그다음 피드백부터 적용되고,
  // 학생은 로그아웃되지 않으며 이미 받은 카드는 그대로입니다. 그래서 확인 창 없이 바로 바꿉니다.
  async function setSchoolLevel(level: SchoolLevel) {
    setPendingLevel({ value: level, from: cls.school_level });
    const ok = await call(classUrl, "PATCH", { schoolLevel: level },
      () => `학교급을 ${SCHOOL_LEVELS[level]}로 바꿨습니다. 그다음에 받는 AI 피드백부터 적용됩니다.`, () => setPendingLevel(null));
    if (!ok) setPendingLevel(null);
  }

  // 학생 PIN 켜기·끄기. 학생 세션 지문에 이 설정이 들어 있어서, 바꾸면 이 학급 학생은 모두 다시 로그인해야 합니다(src/lib/pin.ts).
  // PIN을 끄면 같은 반 친구(학급 코드·번호·이름을 다 앎)가 다른 학생으로 들어가 글을 고치거나 지우거나 제출하고, 피드백 기회를 써 버리거나,
  // 걱정되는 글을 써서 안전 신호가 엉뚱한 학생에게 붙게 할 수 있습니다. 그래서 시범 수업처럼 짧게 쓸 때만 끄도록 확인을 받습니다.
  async function setPinRequired(on: boolean) {
    const question = on
      ? `[${cls.name}] 학생 PIN을 켤까요?\n\n지금 로그인해 있는 학생은 모두 로그아웃되고, 학급 코드·번호·이름과 PIN(4자리)으로 다시 로그인해야 합니다. PIN을 끈 사이 다른 학생으로 들어와 있던 친구도 함께 로그아웃됩니다.\n\n전에 만든 PIN은 그대로입니다. 안내 카드를 인쇄해 나눠 주세요.${noPin > 0 ? `\n\nPIN이 없는 학생 ${noPin}명에게는 PIN을 새로 만듭니다.` : ""}`
      : `[${cls.name}] 학생 PIN을 끌까요?\n\n끄면 학급 코드·번호·이름만으로 들어올 수 있어서, 같은 반 친구가 다른 학생으로 들어가 글을 고치거나 지우거나 제출할 수 있습니다. 그 학생의 피드백 기회를 써 버리거나, 걱정되는 글을 써서 안전 신호가 엉뚱한 학생에게 붙을 수도 있습니다.\n\n시범 수업처럼 짧게 쓸 때만 끄세요. 지금 로그인해 있는 학생은 모두 다시 로그인해야 합니다. 학생 PIN은 지우지 않으므로, 다시 켜면 전에 쓰던 PIN을 그대로 씁니다.`;
    if (!confirm(question)) return;
    setPendingPin({ value: on, from: cls.require_pin });
    const ok = await call(classUrl, "PATCH", { requirePin: on }, (d) => {
      if (!on) return "학생 PIN을 껐습니다. 학생은 학급 코드·번호·이름으로 다시 로그인해야 합니다.";
      const made = Number(d.pins_created) || 0;
      return `학생 PIN을 켰습니다. 학생은 PIN으로 다시 로그인해야 합니다. 안내 카드를 인쇄해 나눠 주세요.${made ? ` (PIN이 없던 ${made}명에게 PIN을 새로 만들었습니다.)` : ""}`;
    }, () => setPendingPin(null));
    if (!ok) setPendingPin(null);
  }

  function renameClass() {
    const name = prompt("학급 이름을 고칩니다. (40자까지)", cls.name)?.trim();
    if (!name || name === cls.name) return;
    void call(classUrl, "PATCH", { name }, () => "학급 이름을 고쳤습니다.");
  }

  async function applyRoster() {
    if (!roster) return;
    const d = rosterDiff(roster, students, { classHasWork: hasWork });
    const lines: string[] = [];
    if (d.added.length) lines.push(`· 새로 추가: ${d.added.length}명 (번호 ${d.added.join(", ")}) — PIN이 새로 생깁니다.`);
    if (d.renamed.length) lines.push(`· 이름이 바뀜: 번호 ${d.renamed.join(", ")} — 이 학생들은 로그인해 있던 기기에서 로그아웃되고, 새 이름으로 다시 들어와야 합니다.`);
    if (d.missing.length) lines.push(`· 명렬표에 없는 번호: ${d.missing.join(", ")} — 지우지 않고 그대로 둡니다.`);
    if (!lines.length) return setMsg("바뀌는 내용이 없습니다.");
    if (!confirm(`[${cls.name}] 명렬표를 이렇게 반영할까요?\n\n${lines.join("\n")}`)) return;
    if (d.renameNeedsConfirm && !confirm(`[${cls.name}] ${renameWarning(d.renames, d.missing)}`)) return;

    setMsg(null);
    setBusy(true);
    try {
      let { res, data } = await request(`${classUrl}/roster`, "PUT", { roster, ...(d.renameNeedsConfirm ? { confirmRenames: true } : {}) });
      // 화면이 오래되어 서버가 이름 변경을 따로 확인하라고 하면 한 번 더 묻고 다시 보냅니다.
      const renames = readRenames(data.renames);
      if (res.status === 409 && renames.length) {
        const missing = Array.isArray(data.missing) ? data.missing.filter((n): n is number => typeof n === "number") : [];
        if (!confirm(`[${cls.name}] 화면이 오래되어 지금 학급 명단으로 다시 확인합니다.\n\n${renameWarning(renames, missing)}`)) {
          setMsg("반영하지 않았습니다.");
          router.refresh();
          return;
        }
        ({ res, data } = await request(`${classUrl}/roster`, "PUT", { roster, confirmRenames: true }));
      }
      if (!res.ok) {
        setMsg(failMessage(res.status, data));
      } else {
        const added = Number(data.added) || 0;
        setMsg(`명렬표를 반영했습니다. 새 학생 ${added}명, 이름 바뀜 ${Number(data.renamed) || 0}명.${added ? " 새 학생의 안내 카드를 인쇄해 나눠 주세요." : ""}`);
        setShowRoster(false);
        setRoster(null);
        setRosterKey((k) => k + 1);
      }
      router.refresh();
    } catch {
      setMsg(NET_ERROR);
    } finally {
      setBusy(false);
    }
  }

  function renameStudent(s: Student) {
    const name = prompt(`${s.number}번 학생의 이름을 고칩니다. 학생은 이 이름으로 들어옵니다.\n이름을 고치면 이 학생이 로그인해 있던 기기는 로그아웃되므로, 새 이름으로 다시 들어오게 알려 주세요.`, s.name)?.trim();
    if (!name || name === s.name) return;
    void call(`${classUrl}/students`, "PATCH", { updates: [{ id: s.id, name }] }, () => `${s.number}번 이름을 고쳤습니다. 학생은 새 이름으로 다시 들어와야 합니다.`);
  }

  function unlock(s: Student) {
    void call(`${classUrl}/students`, "PATCH", { updates: [{ id: s.id, unlock: true }] }, () => `${s.number}번 학생의 잠금을 풀었습니다. 다시 8번 틀리면 10분 잠금부터 시작합니다.`);
  }

  // 학급 코드를 아는 학생이 남의 번호로 일부러 틀려 여러 명을 잠갔을 때 한 번에 풉니다.
  async function unlockAll(ids: string[]) {
    setMsg(null);
    setBusy(true);
    try {
      let unlocked = 0;
      for (let i = 0; i < ids.length; i += STUDENT_BATCH) {
        const updates = ids.slice(i, i + STUDENT_BATCH).map((id) => ({ id, unlock: true }));
        const { res, data } = await request(`${classUrl}/students`, "PATCH", { updates });
        if (!res.ok) return setMsg(failMessage(res.status, data));
        unlocked += Number(data.updated) || 0;
      }
      setMsg(`잠긴 학생 ${unlocked}명의 잠금을 모두 풀었습니다. 다시 8번 틀리면 10분 잠금부터 시작합니다.`);
    } catch {
      setMsg(NET_ERROR);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  function createPins(n: number) {
    if (!confirm(`[${cls.name}] PIN이 없는 학생 ${n}명에게 4자리 PIN을 만들까요?\n\n만든 뒤 안내 카드를 인쇄해 나눠 주세요.`)) return;
    void call(`${classUrl}/pins`, "POST", {}, (d) => `PIN을 만들었습니다. (${Number(d.count) || 0}명) 안내 카드를 인쇄해 나눠 주세요.`);
  }

  function resetPin(s: Student) {
    if (!confirm(`[${cls.name}] ${s.number}번 학생의 PIN을 새로 만들까요?\n\n지금 PIN으로는 더 들어올 수 없게 되고, 이미 로그인해 있던 기기도 로그아웃됩니다. 잠금도 함께 풀립니다(다음 잠금은 10분부터). 쓴 글은 그대로 남습니다. 새 PIN을 학생에게 따로 알려 주세요.`)) return;
    void call(`${classUrl}/pins`, "POST", { studentId: s.id }, (d) => `${s.number}번 학생의 새 PIN: ${String(d.pin ?? "")} (학생에게 따로 알려 주세요)`);
  }

  function reopen(s: Student) {
    if (!confirm(`[${cls.name}] ${s.number}번 학생의 제출을 취소하고 다시 고칠 수 있게 할까요?\n\n받은 피드백은 그대로 남고, 학생은 고친 뒤 다시 제출해야 합니다.`)) return;
    void call(`${classUrl}/reopen`, "POST", { studentId: s.id }, () => `${s.number}번 학생이 다시 고칠 수 있게 제출을 취소했습니다.`);
  }

  async function deleteClass() {
    if (deleteCode.trim().toUpperCase() !== cls.class_code.toUpperCase()) return;
    if (!confirm(`[${cls.name}] 학급을 정말 지울까요?\n\n학생 ${students.length}명의 만다라트, 피드백, 기록이 모두 지워지고 되돌릴 수 없습니다.`)) return;
    setMsg(null);
    setBusy(true);
    try {
      const { res, data } = await request(classUrl, "DELETE", { confirmCode: deleteCode.trim() });
      if (!res.ok) return setMsg(failMessage(res.status, data));
      router.replace("/teacher");
      router.refresh();
    } catch {
      setMsg(NET_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const noPin = students.filter((s) => !s.pin).length;
  const requirePin = pendingPin && pendingPin.from === cls.require_pin ? pendingPin.value : cls.require_pin;
  // PIN을 끄면 '학생 PIN 보기'도 끕니다(끈 동안은 그 칸이 보이지 않아 끌 수 없으므로). 다시 켰을 때 화면을 띄워 둔 채로 PIN이 바로 드러나지 않게.
  if (!requirePin && showPins) setShowPins(false);
  const started = students.filter((s) => s.status !== null).length;
  const submitted = students.filter((s) => s.status === "submitted").length;
  const maxRounds = pendingRounds && pendingRounds.from === cls.max_feedback_rounds ? pendingRounds.value : cls.max_feedback_rounds;
  const schoolLevel = pendingLevel && pendingLevel.from === cls.school_level ? pendingLevel.value : cls.school_level;
  const byId = new Map(students.map((s) => [s.id, s]));
  // PIN을 끈 학급은 잠금을 쓰지 않으므로(학생 로그인이 잠금을 보지 않음) 잠김 표시·풀기 버튼도 보이지 않습니다.
  const lockedIds = requirePin ? students.filter((s) => s.locked).map((s) => s.id) : [];
  // 안전 신호: 살펴볼 학생(아직 확인 안 함 또는 확인한 뒤 새 신호)과, 신호가 있었지만 '확인했어요'를 누른 학생
  const hasSignal = (s: Student) => s.concern_count > 0 || s.rule_concern !== null;
  const reviewCount = students.filter((s) => s.needs_review).length;
  const reviewedCount = students.filter((s) => hasSignal(s) && !s.needs_review).length;
  const afterReview = <span className="text-xs text-amber-900"> (확인한 뒤 새로 생김)</span>;

  const statusCell = (s: Student) => {
    if (s.status === null) return <span className="text-xs text-stone-400">아직 안 들어옴</span>;
    if (s.status === "submitted") {
      return (
        <span className="font-semibold text-emerald-700" title={`제출 ${fmtKst(s.submitted_at)}`}>
          제출 ✓<span className="ml-1 text-[11px] font-normal text-stone-500">{fmtKst(s.submitted_at)}</span>
        </span>
      );
    }
    return <span className="text-stone-700">쓰는 중 {s.filled}/73</span>;
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold">
            {cls.name}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls.is_open ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"}`}>
              {cls.is_open ? "열림" : "닫힘"}
            </span>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800">{SCHOOL_LEVELS[schoolLevel]}</span>
            <button onClick={renameClass} disabled={busy} className="text-xs font-normal text-stone-500 underline disabled:opacity-40">이름 고치기</button>
          </h1>
          <p className="text-sm text-stone-600">
            학급 코드 <b className="font-mono text-base tracking-wider">{cls.class_code}</b> · 학생 {students.length}명 · 들어온 학생 {started}명 · 제출 {submitted}명
          </p>
          <p className="text-xs text-stone-500">
            {requirePin ? "학생은 앱 주소에서 학급 코드, 번호, 이름, PIN(4자리)으로 들어옵니다." : "학생은 앱 주소에서 학급 코드, 번호, 이름으로 들어옵니다(PIN 없음)."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => startRefresh(() => router.refresh())} disabled={refreshing}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50">
            {refreshing ? "불러오는 중…" : "새로 고침"}
          </button>
          <button onClick={() => window.print()} className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm">
            안내 카드 인쇄
          </button>
        </div>
      </header>

      {!requirePin && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 print:hidden">
          ⚠️ 학생 PIN을 쓰지 않는 학급입니다 — 학급 코드·번호·이름만으로 들어옵니다. 친구가 다른 학생으로 들어갈 수 있으니, 시범 수업이 끝나면 아래 &lsquo;학생 PIN 사용&rsquo;을 다시 켜세요.
        </p>
      )}

      {msg && (
        <p role="status" className="flex items-start justify-between gap-2 rounded-lg bg-stone-100 px-3 py-2 text-sm print:hidden">
          <span>{msg}</span>
          <button type="button" aria-label="알림 닫기" onClick={() => setMsg(null)} className="shrink-0 px-1 text-stone-500">✕</button>
        </p>
      )}

      <section className="flex flex-col gap-4 rounded-xl border border-stone-300 bg-white p-4 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h2 className="font-semibold">학생 쓰기</h2>
            <p className="text-sm text-stone-600">
              {cls.is_open
                ? "열려 있습니다. 학생이 만다라트를 쓰고, AI 피드백을 받고, 제출할 수 있습니다."
                : "닫혀 있습니다. 학생은 볼 수만 있습니다. 수업 때 다시 여세요."}
            </p>
          </div>
          {cls.is_open ? (
            <button onClick={() => setOpen(false)} disabled={busy}
              className="rounded-lg border border-stone-400 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50">
              닫기
            </button>
          ) : (
            <button onClick={() => setOpen(true)} disabled={busy}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              열기
            </button>
          )}
        </div>
        <p className="text-xs text-stone-500">수업이 끝나면 닫아 두세요. 집에서 혼자 계속 쓰거나 AI 피드백을 받지 못하게 되어 AI 비용도 아낄 수 있습니다.</p>
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requirePin} disabled={busy} onChange={(e) => void setPinRequired(e.target.checked)}
              aria-describedby="pin-setting-hint" />
            학생 PIN 사용
          </label>
          <p id="pin-setting-hint" className={`text-xs ${requirePin ? "text-stone-500" : "font-medium text-amber-900"}`}>
            {requirePin
              ? "PIN을 끄면 같은 반 친구가 다른 학생으로 들어갈 수 있습니다. 시범 수업처럼 짧게 쓸 때만 끄세요."
              : "꺼져 있습니다. 학급 코드·번호·이름만으로 들어오고, 여러 번 틀려도 잠기지 않습니다. 켜거나 끄면 학생은 모두 다시 로그인해야 합니다."}
          </p>
        </div>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          단계별 피드백 횟수
          <select value={maxRounds} disabled={busy} onChange={(e) => void setMaxRounds(Number(e.target.value))}
            className="rounded border border-stone-300 bg-white px-2 py-1">
            <option value={2}>2회 (첫 피드백 + 고친 뒤 확인 피드백)</option>
            <option value={1}>1회 (첫 피드백만)</option>
          </select>
        </label>
        <div className="flex flex-col gap-0.5">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            학교급
            <select value={schoolLevel} disabled={busy} onChange={(e) => void setSchoolLevel(e.target.value as SchoolLevel)}
              aria-describedby="level-setting-hint" className="rounded border border-stone-300 bg-white px-2 py-1">
              {SCHOOL_LEVEL_KEYS.map((k) => <option key={k} value={k}>{SCHOOL_LEVELS[k]}</option>)}
            </select>
          </label>
          <p id="level-setting-hint" className="text-xs text-stone-500">
            AI 피드백의 진단 기준과 카드 질문 수준이 바뀝니다. 바꾸면 그다음에 새로 받는 피드백부터 적용됩니다(이미 받은 카드와 그 단계의 확인 피드백은 바꾸기 전 기준).
          </p>
        </div>
        <ExportButtons classId={cls.id} />
      </section>

      {/* 안전 신호는 기본으로 이름·종류 없이 숫자만 보여 줍니다(화면을 학생들에게 띄워도 괜찮게). */}
      {reviewCount > 0 && !showSafety && (
        <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 print:hidden">
          <p className="text-sm text-amber-950">
            ⚠️ 살펴볼 학생이 {reviewCount}명 있어요. 화면을 학생들에게 보여 주고 있지 않을 때 &lsquo;안전 신호 보기&rsquo;를 누르세요.
          </p>
          <button onClick={() => setShowSafety(true)}
            className="rounded-lg border border-amber-700 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900">
            안전 신호 보기
          </button>
        </section>
      )}

      {reviewCount > 0 && showSafety && (
        <section className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-amber-950">⚠️ 직접 살펴볼 학생 {reviewCount}명</h2>
            <button onClick={() => setShowSafety(false)}
              className="rounded-lg border border-amber-700 bg-white px-3 py-1.5 text-sm text-amber-900">
              안전 신호 숨기기
            </button>
          </div>
          <SafetyHint />
          {ruleConcerns.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-amber-950">표현 검사 (저장할 때마다)</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {ruleConcerns.map((c) => {
                  const k = ruleKindsText(c);
                  return (
                    <li key={c.student_id}>
                      <Link href={`/teacher/class/${cls.id}/student/${c.student_id}`} className="text-amber-950 underline">
                        {c.number}번 {byId.get(c.student_id)?.name ?? ""}
                      </Link>
                      {k.now && (
                        <span className="text-amber-950"> · {k.now} <span className="text-xs font-semibold">({RULE_NOW_TEXT})</span></span>
                      )}
                      {k.gone && (
                        <span className="text-stone-600"> · {k.gone} <span className="text-xs">({RULE_GONE_TEXT})</span></span>
                      )}
                      <span className="text-amber-900"> · 마지막 {fmtKst(c.at)}</span>
                      {c.after_review && afterReview}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {aiConcerns.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-amber-950">AI 신호 (피드백을 받을 때)</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {aiConcerns.map((c) => (
                  <li key={c.student_id}>
                    <Link href={`/teacher/class/${cls.id}/student/${c.student_id}`} className="text-amber-950 underline">
                      {c.number}번 {byId.get(c.student_id)?.name ?? ""}
                    </Link>
                    <span className="text-amber-900"> · {c.kinds.map((k) => concernLabel(k)).join(", ")} · {c.count}회 · 마지막 {fmtKst(c.last_at)}</span>
                    {c.after_review && afterReview}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-amber-950">
            학생 이름을 누른 뒤 &lsquo;안전 신호 보기&rsquo;를 눌러 글을 살펴보고 &lsquo;확인했어요&rsquo;를 누르면, 새 신호가 생길 때까지 이 목록과 첫 화면의 숫자에서 빠집니다.
            {reviewedCount > 0 && ` 이미 확인한 학생 ${reviewedCount}명은 여기에 나오지 않습니다(학생 표에 ‘✓ 확인함’).`}
          </p>
          <p className="text-[11px] text-amber-900">{RULE_SOURCE_NOTE} {AI_SOURCE_NOTE}</p>
        </section>
      )}

      <section className="flex flex-col gap-3 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">학생</h2>
          <div className="flex flex-wrap items-center gap-3">
            {lockedIds.length > 0 && (
              <button onClick={() => void unlockAll(lockedIds)} disabled={busy} title="PIN을 여러 번 틀려 잠긴 학생을 한 번에 풉니다"
                className="rounded-lg border border-rose-700 bg-white px-3 py-1.5 text-sm text-rose-800 disabled:opacity-50">
                잠긴 학생 모두 풀기 ({lockedIds.length}명)
              </button>
            )}
            {requirePin && noPin > 0 && (
              <button onClick={() => createPins(noPin)} disabled={busy} title="PIN이 없는 학생에게만 새로 만듭니다(이미 있는 PIN은 그대로)"
                className="rounded-lg border border-sky-700 bg-white px-3 py-1.5 text-sm text-sky-800 disabled:opacity-50">
                PIN 만들기 ({noPin}명)
              </button>
            )}
            <button onClick={() => { setShowRoster(!showRoster); setRoster(null); }} className="text-xs text-sky-700 underline">
              {showRoster ? "명렬표 닫기" : "명렬표 다시 올리기"}
            </button>
            {students.some(hasSignal) && (
              <label className="flex items-center gap-1 text-xs" title="화면을 칠판·TV에 띄울 때는 끄세요">
                <input type="checkbox" checked={showSafety} onChange={(e) => setShowSafety(e.target.checked)} /> 안전 신호 보기
              </label>
            )}
            {requirePin && (
              <label className="flex items-center gap-1 text-xs" title="화면을 칠판·TV에 띄울 때는 끄세요">
                <input type="checkbox" checked={showPins} onChange={(e) => setShowPins(e.target.checked)} /> 학생 PIN 보기
              </label>
            )}
          </div>
        </div>

        {showRoster && (
          <div className="flex flex-col gap-2 rounded-xl border border-stone-300 bg-white p-4">
            <p className="text-xs text-stone-600">
              번호가 같은 학생은 이름이 바뀌고, 없는 번호는 새로 추가됩니다(새 학생은 PIN도 생김). 명렬표에 없는 학생은 지우지 않습니다.
              한 명의 이름만 고칠 때는 아래 표의 &lsquo;이름 고치기&rsquo;를 쓰세요. 반영하기 전에 바뀌는 내용을 한 번 더 보여 줍니다.
            </p>
            <RosterInput key={rosterKey} onChange={setRoster} />
            <button disabled={!roster || busy} onClick={applyRoster}
              className="self-start rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
              명렬표 반영
            </button>
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-stone-300 bg-white">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-stone-50 text-xs text-stone-600">
              <tr>
                <th className="px-2 py-2 text-left">번호</th>
                <th className="px-2 py-2 text-left">이름</th>
                <th className="px-2 py-2 text-left">상태</th>
                <th className="px-2 py-2" title="중심·세부 목표 → 블록 8개 → 전체. ✓는 확인 피드백까지 마친 단계">피드백 단계</th>
                <th className="px-2 py-2" title="받은 피드백 횟수(확인 피드백 포함)">피드백</th>
                <th className="px-2 py-2" title="카드마다 학생이 마지막으로 고른 것">해 볼게요 / 안 할래요</th>
                {showSafety && <th className="px-2 py-2" title="안전 신호(진단 아님): 표현 검사 표시와 AI 신호가 붙은 피드백 횟수">⚠️ 안전 신호</th>}
                {showPins && requirePin && <th className="px-2 py-2">PIN</th>}
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id} className={`border-t border-stone-200 text-center ${showSafety && s.needs_review ? "bg-amber-50/60" : ""}`}>
                  <td className="px-2 py-1.5 text-left">{s.number}</td>
                  <td className="px-2 py-1.5 text-left">
                    <Link href={`/teacher/class/${cls.id}/student/${s.id}`} className="text-sky-800 underline decoration-dotted">{s.name}</Link>
                    {requirePin && s.locked && <span className="ml-1 rounded bg-rose-100 px-1 text-xs text-rose-800">잠김</span>}
                  </td>
                  <td className="px-2 py-1.5 text-left">{statusCell(s)}</td>
                  <td className="px-2 py-1.5">
                    {s.status !== null && (
                      <span className="inline-flex gap-1">
                        <Mark done={s.core_done}>중심{s.core_done ? " ✓" : ""}</Mark>
                        <Mark done={s.blocks_done === 8}>블록 {s.blocks_done}/8</Mark>
                        <Mark done={s.whole_done}>전체{s.whole_done ? " ✓" : ""}</Mark>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">{s.rounds || ""}</td>
                  <td className="px-2 py-1.5 text-xs">
                    {s.cards > 0 && (
                      <span title={`카드 ${s.cards}장 중 응답 없음 ${s.cards - s.accepted - s.rejected}장`}>
                        <b className="text-emerald-700">{s.accepted}</b> / <span className="text-stone-600">{s.rejected}</span>
                        <span className="text-stone-400"> (카드 {s.cards})</span>
                      </span>
                    )}
                  </td>
                  {showSafety && (
                    <td className="px-2 py-1.5">
                      {s.needs_review ? (
                        <Link href={`/teacher/class/${cls.id}/student/${s.id}`} className="inline-flex flex-col items-center gap-0.5 text-xs text-amber-900 underline"
                          title="진단이 아닙니다. 학생 글을 직접 살펴보세요.">
                          {s.rule_concern && <RuleConcernMark rule={s.rule_concern} />}
                          {s.concern_count > 0 && <span className="whitespace-nowrap font-semibold">⚠️ AI {s.concern_count}회</span>}
                        </Link>
                      ) : hasSignal(s) && (
                        <Link href={`/teacher/class/${cls.id}/student/${s.id}`} className="whitespace-nowrap text-xs text-stone-500 underline"
                          title={`${fmtKst(s.concern_reviewed_at)}까지의 신호를 '확인했어요'로 표시했습니다. 새 신호가 생기면 다시 표시됩니다.`}>
                          ✓ 확인함
                        </Link>
                      )}
                    </td>
                  )}
                  {showPins && requirePin && (
                    <td className="whitespace-nowrap px-2 text-xs">
                      <span className="font-mono text-sm">{s.pin ?? "—"}</span>
                      <button disabled={busy} className="ml-2 text-stone-500 underline disabled:opacity-40" onClick={() => resetPin(s)}>
                        {s.pin ? "다시 만들기" : "만들기"}
                      </button>
                    </td>
                  )}
                  <td className="space-x-2 whitespace-nowrap px-2 text-xs">
                    <Link href={`/teacher/class/${cls.id}/student/${s.id}`} className="text-sky-700 underline">보기</Link>
                    <button disabled={busy} className="text-stone-500 underline disabled:opacity-40" onClick={() => renameStudent(s)}>이름 고치기</button>
                    {requirePin && s.locked && (
                      <button disabled={busy} className="font-semibold text-rose-700 underline disabled:opacity-40" onClick={() => unlock(s)}>잠금 해제</button>
                    )}
                    {s.status === "submitted" && (
                      <button disabled={busy} className="text-stone-500 underline disabled:opacity-40" onClick={() => reopen(s)}
                        title="학생이 실수로 제출했거나 더 고치고 싶어 할 때">
                        제출 취소
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {requirePin ? (
          <p className="text-xs text-stone-500">
            PIN을 잊었거나 친구가 알게 되면 &lsquo;학생 PIN 보기&rsquo;를 켜고 &lsquo;다시 만들기&rsquo;를 누르세요. PIN을 8번 틀리면 잠깁니다(24시간 안에 처음은 10분, 두 번째는 60분, 세 번째부터는 선생님이 풀 때까지). &lsquo;잠금 해제&rsquo;나 PIN 다시 만들기로 바로 풀 수 있고, 그 뒤 다음 잠금은 다시 10분부터입니다.
            다른 학생이 남의 번호로 일부러 틀려도 잠기므로, 여러 명이 한꺼번에 잠기면 &lsquo;잠긴 학생 모두 풀기&rsquo;로 한 번에 푸세요.
            이름을 고쳐도 PIN을 다시 만들 때처럼 그 학생이 로그인해 있던 기기는 로그아웃됩니다.
          </p>
        ) : (
          <p className="text-xs text-stone-500">
            학생 PIN을 끈 동안에는 PIN을 묻지 않고, 여러 번 틀려도 잠기지 않습니다. 학생 PIN은 지우지 않고 그대로 두므로, 다시 켜면 전에 쓰던 PIN으로 들어옵니다.
            이름을 고치면 그 학생이 로그인해 있던 기기는 로그아웃됩니다.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-rose-200 bg-white p-4 print:hidden">
        <h2 className="font-semibold text-rose-800">학급 지우기</h2>
        <p className="text-xs text-stone-600">
          학생, 만다라트, 피드백이 모두 지워지고 되돌릴 수 없습니다. 필요하면 먼저 CSV로 내려받아 두세요.
          지우려면 학급 코드 <b className="font-mono">{cls.class_code}</b>를 똑같이 입력하세요.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input value={deleteCode} onChange={(e) => setDeleteCode(e.target.value)} placeholder="학급 코드" aria-label="지울 학급의 학급 코드"
            autoComplete="off" className="w-32 rounded border border-stone-300 bg-white px-2 py-1.5 font-mono text-sm uppercase" />
          <button onClick={deleteClass} disabled={busy || deleteCode.trim().toUpperCase() !== cls.class_code.toUpperCase()}
            className="rounded-lg bg-rose-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
            학급 지우기
          </button>
        </div>
      </section>

      {/* 인쇄용 안내 카드(화면에서는 보이지 않음) */}
      <div className="hidden grid-cols-2 gap-2 print:grid">
        {students.map((s) => (
          <div key={s.id} className="break-inside-avoid rounded border border-black p-3 text-sm leading-relaxed">
            <p className="font-semibold">{cls.name} · {s.number}번 {s.name}</p>
            {origin && <p>주소: <b className="font-mono">{origin}</b></p>}
            <p>학급 코드: <b className="font-mono text-base">{cls.class_code}</b></p>
            {requirePin ? (
              <>
                <p>PIN: <b className="font-mono text-base">{s.pin ?? "(선생님께 받기)"}</b></p>
                <p className="text-xs">학급 코드 + 번호 + 이름 + PIN으로 들어가요. PIN은 친구에게 알려 주지 마세요.</p>
              </>
            ) : (
              <p className="text-xs">학급 코드 + 번호 + 이름으로 들어가요. PIN 칸은 비워 두세요.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
