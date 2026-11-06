// 학생 화면(만다라트 편집·로그인)에서 쓰는 순수 함수 모음. 서버·브라우저·단위 테스트에서 함께 씁니다.
import type { MandalartContent, Target } from "./mandalart";

// 칸 글자 수 한도(UTF-16 셈, 이모지 하나 = 2칸). mandalart.ts의 MandalartContent 검사(60/40)와 같아야 합니다.
export const GOAL_MAX = 60;
export const CELL_MAX = 40;

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

// 짝이 없는 반쪽 글자(UTF-16 서로게이트 하나만 남은 것)를 '�'(U+FFFD)로 바꿉니다. 글자 수(length)는 그대로입니다.
// 이모지 같은 글자는 두 칸(서로게이트 한 쌍)이라 반으로 잘리면 이렇게 남는데, DB(jsonb)가 이런 글을 받지 않아(22P02)
// 저장이 계속 실패합니다. 옛 iOS Safari에서도 돌도록 정규식 뒤보기(lookbehind) 없이 한 글자씩 봅니다.
export function wellFormed(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      i++; // 온전한 한 쌍
      continue;
    }
    out += s.slice(from, i) + "\ufffd";
    from = i + 1;
  }
  return from === 0 ? s : out + s.slice(from);
}

// 글을 max칸(UTF-16, 서버 검사 MandalartContent·tooLongCell과 같은 셈)까지 자릅니다. 이모지를 반으로 자르지 않도록
// 마지막 칸이 쌍의 앞쪽이면 그 글자를 통째로 뺍니다.
export function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

// 저장하기 전에 칸마다 한도를 넘는 글자를 잘라 내고(한글 조합 중 한 글자가 넘친 경우 등), 반쪽 글자를 고칩니다.
// 서버(save-mandalart.ts)도 저장하기 전에 같은 방법으로 반쪽 글자를 고칩니다(wellFormedContent).
export function clampContent(c: MandalartContent): MandalartContent {
  return wellFormedContent({
    goal: clampText(c.goal, GOAL_MAX),
    subs: c.subs.map((s) => clampText(s, CELL_MAX)),
    actions: c.actions.map((row) => row.map((a) => clampText(a, CELL_MAX))),
  });
}

// 모든 칸의 반쪽 글자를 '�'로 바꿉니다(글자 수는 그대로라 한도 검사 결과도 그대로).
export function wellFormedContent(c: MandalartContent): MandalartContent {
  return { goal: wellFormed(c.goal), subs: c.subs.map(wellFormed), actions: c.actions.map((row) => row.map(wellFormed)) };
}

// 글자 수가 한도를 넘는 첫 칸. 형식이 다르거나 넘는 칸이 없으면 null.
export function tooLongCell(raw: unknown): Target | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { goal?: unknown; subs?: unknown; actions?: unknown };
  const over = (v: unknown, max: number) => typeof v === "string" && v.length > max;
  if (over(c.goal, GOAL_MAX)) return { kind: "goal" };
  if (Array.isArray(c.subs)) {
    for (let i = 0; i < Math.min(8, c.subs.length); i++) if (over(c.subs[i], CELL_MAX)) return { kind: "sub", sub: i };
  }
  if (Array.isArray(c.actions)) {
    for (let i = 0; i < Math.min(8, c.actions.length); i++) {
      const row = c.actions[i];
      if (!Array.isArray(row)) continue;
      for (let j = 0; j < Math.min(8, row.length); j++) if (over(row[j], CELL_MAX)) return { kind: "action", sub: i, action: j };
    }
  }
  return null;
}

// 칸 이름(내용 없이 위치만): '중심 목표', '세부 목표 ②', '세부 목표 ②의 실천 3'
export function cellName(t: Target): string {
  if (t.kind === "goal") return "중심 목표";
  if (t.kind === "sub") return `세부 목표 ${CIRCLED[t.sub]}`;
  if (t.kind === "action") return `세부 목표 ${CIRCLED[t.sub]}의 실천 ${t.action + 1}`;
  return "만다라트 전체";
}

export function tooLongMessage(t: Target): string {
  const max = t.kind === "goal" ? GOAL_MAX : CELL_MAX;
  return `${cellName(t)} 칸의 글이 너무 길어요. ${max}자까지 쓸 수 있어요.`;
}

// 이름 뒤 조사 '로/으로': 받침이 없거나 ㄹ받침이면 '로'.
export function withRo(name: string): string {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (!last || code < 0 || code > 11171) return `${name}(으)로`;
  const jong = code % 28;
  return jong === 0 || jong === 8 ? `${name}로` : `${name}으로`;
}

// 자동 저장 재시도 간격(밀리초): 2초, 5초, 10초, 20초, 그다음부터 30초마다
export function retryDelay(failures: number): number {
  const steps = [2000, 5000, 10_000, 20_000];
  return failures >= 1 && failures <= steps.length ? steps[failures - 1] : 30_000;
}

// 자동 저장 요청 하나를 기다리는 최대 시간. 넘으면 끊고 인터넷 문제처럼 다시 시도합니다.
// 서버 저장 함수의 제한(maxDuration 12초, src/app/api/mandalart/[id]/route.ts)보다 길어야, 끊긴 요청이 나중에 새 글을 덮어쓰지 않습니다.
export const SAVE_TIMEOUT_MS = 15_000;
// 제출·로그아웃·피드백 요청 전에 저장이 끝나기를 기다리는 최대 시간. 넘으면 '저장하지 못함'으로 처리합니다.
export const SAVE_WAIT_MS = 20_000;

// p가 ms 안에 끝나면 그 값을, 아니면 fallback을 돌려줍니다(p는 계속 진행되며, p가 실패해도 fallback).
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}
