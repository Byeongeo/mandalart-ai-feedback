// 교사용 학급 CSV(교사 본인 보관용, 학생 이름 포함)의 열과 행을 만듭니다. 순수 함수(서버·단위 테스트 공용).
// 파일로 만드는 일(BOM, 수식 막기, 줄바꿈)은 csv.ts의 toCsv가 합니다. 시간은 호출하는 쪽에서 kst()로 바꿔 넘깁니다.
// PIN과 안전 신호(⚠️)는 넣지 않습니다(안전 신호는 교사 화면에만 보여 줍니다. 파일은 전달·공유되기 쉽기 때문).
import type { MandalartContent, Target } from "./mandalart";

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

export type ExportType = "mandalart" | "cards";
export const EXPORT_TYPES: readonly ExportType[] = ["mandalart", "cards"];

// 파일 이름에 쓸 수 없는 글자를 바꿉니다.
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 60) || "학급";
}

export function exportFileName(className: string, type: ExportType, today: string): string {
  const kind = type === "cards" ? "피드백카드" : "만다라트";
  return `${safeFileName(className)}_${kind}_${today}_교사용_이름포함.csv`;
}

// ── 학생별 만다라트(한 학생 = 한 줄) ───────────────────────────
export function mandalartHeader(): string[] {
  const subs = CIRCLED.map((c) => `세부 목표 ${c}`);
  const actions = CIRCLED.flatMap((c) => Array.from({ length: 8 }, (_, j) => `${c} 실천 ${j + 1}`));
  return [
    "번호", "이름", "상태", "제출 시각", "마지막 저장", "피드백 횟수", "카드 수", "해 볼게요", "안 할래요",
    "중심 목표", ...subs, ...actions,
  ];
}

export type MandalartExportRow = {
  number: number;
  name: string;
  status: "draft" | "submitted" | null;
  submitted_at: string | null; // KST 문자열
  updated_at: string | null; // KST 문자열
  rounds: number;
  cards: number;
  accepted: number;
  rejected: number;
  content: MandalartContent | null;
};

const STATUS = { draft: "작성 중", submitted: "제출함" } as const;

export function mandalartRow(r: MandalartExportRow): (string | number | null)[] {
  const c = r.content;
  return [
    r.number, r.name, r.status ? STATUS[r.status] : "들어오지 않음", r.submitted_at, r.updated_at,
    r.rounds, r.cards, r.accepted, r.rejected,
    c?.goal ?? "", ...(c?.subs ?? Array(8).fill("")), ...(c?.actions.flat() ?? Array(64).fill("")),
  ];
}

// ── 피드백 카드(카드 하나 = 한 줄) ─────────────────────────────
export function cardsHeader(): string[] {
  return ["번호", "이름", "피드백 순서", "단계", "첫/확인", "카드 종류", "위치", "고칠 점", "카드 내용", "학생 반응", "안 할래요 이유", "이유(직접 쓴 글)", "받은 시각", "반응 시각"];
}

export type CardExportRow = {
  number: number;
  name: string;
  round_no: number;
  stage: "core" | "block" | "whole";
  block_index: number | null;
  attempt: number;
  kind: "issue" | "resolved" | "unresolved";
  target: Target;
  category_label: string;
  body: string;
  action: "accept" | "reject" | null;
  reason_label: string | null;
  reason_text: string | null;
  created_at: string | null; // KST
  responded_at: string | null; // KST
};

const KIND = { issue: "고칠 점", resolved: "해결됨", unresolved: "아직 해결 안 됨" } as const;

export function stageName(stage: CardExportRow["stage"], blockIndex: number | null): string {
  if (stage === "core") return "중심·세부 목표";
  if (stage === "block") return `블록 ${CIRCLED[blockIndex ?? 0]}`;
  return "전체";
}

export function positionName(t: Target): string {
  if (t.kind === "goal") return "중심 목표";
  if (t.kind === "sub") return `세부 목표 ${CIRCLED[t.sub]}`;
  if (t.kind === "action") return `${CIRCLED[t.sub]} 실천 ${t.action + 1}`;
  return "전체";
}

export function cardRow(r: CardExportRow): (string | number | null)[] {
  return [
    r.number, r.name, r.round_no, stageName(r.stage, r.block_index), r.attempt === 1 ? "첫 피드백" : "확인 피드백",
    KIND[r.kind], positionName(r.target), r.category_label, r.body,
    r.action === "accept" ? "해 볼게요" : r.action === "reject" ? "안 할래요" : "", r.reason_label, r.reason_text,
    r.created_at, r.responded_at,
  ];
}
