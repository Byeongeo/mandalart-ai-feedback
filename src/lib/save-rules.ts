// 학생 만다라트 저장·제출의 저장 번호(revision) 규칙(순수 함수, 서버·학생 화면·단위 테스트 공용).
// 서버는 화면이 아는 번호와 맞을 때만 저장하고 번호를 올립니다(오래된 탭·다른 기기가 더 새 글을 덮어쓰지 못하게, nextRevision).
// 실제 저장(SQL)은 save-mandalart.ts가 합니다. 학생 화면도 가져다 쓰므로 안전 신호 규칙(concern-rules.ts)은 여기서 가져오지 마세요
// (가져오면 그 표현 목록이 학생 브라우저로 내려갑니다). 안전 신호 기록 규칙은 rule-concern-state.ts에 있습니다.
import type { MandalartContent } from "./mandalart";

export const STALE_MESSAGE = "다른 탭이나 기기에서 이 만다라트를 더 나중에 고쳤어요. ‘새로 고침’을 눌러 최신 내용을 불러와 주세요.";
export const FEEDBACK_PENDING_MESSAGE = "피드백을 만드는 중이에요. 다 만들어진 뒤에 제출해 주세요.";

// 화면이 함께 보내는 '결과를 모르는 저장'의 내용 지문(prev)은 이 수까지만 봅니다(화면도 이보다 많이 보내지 않음).
// 지문 하나는 16글자라 64개여도 1KB 남짓입니다(탭을 닫을 때 보내는 keepalive 요청은 본문이 64KB를 넘으면 안 됨).
export const MAX_PREV = 64;
// 한 번 저장할 때 번호를 건너뛸 수 있는 최대치(아래 horizon). 정상 화면은 결과를 모르는 저장 수만큼만 건너뜁니다.
// 이상한 값으로 번호(integer)가 넘치지 않게 막는 상한입니다.
export const MAX_JUMP = 10_000;

export type SaveMeta = {
  /** 화면이 마지막으로 안 저장 번호. 없거나 이상하면 null(오래된 화면: 다른 화면에서 고친 것으로 봄) */
  revision: number | null;
  /** 이 화면이 그 번호 뒤에 보냈지만 결과를 모르는 저장들의 내용 지문(contentHash, 겹침 없이, MAX_PREV개까지) */
  prev: string[];
  /** 결과를 모르는 저장을 보낸 횟수(같은 내용을 다시 보낸 것도 셈). 그사이 이 화면 때문에 올라갈 수 있는 번호의 최대치 */
  sends: number;
  /** 피드백 요청만: 화면에 있는 지금 글의 지문. 서버 글과 같으면 번호와 상관없이 받습니다. */
  hash: string | null;
  /**
   * 이 화면이 이 요청보다 먼저 보낸 저장들이 받아들여질 수 있는 가장 큰 서버 번호(각 저장의 revision + sends 중 최대, 없으면 0).
   * 이 요청을 저장하면 번호를 이보다 크게 올려(nextRevision), 먼저 보낸 저장이 늦게 도착해도 다시는 받아들여지지 않게 합니다.
   */
  horizon: number;
};

// 만다라트 내용 모양(중심 1 + 세부 8 + 실천 8×8, 모두 글자)인지. 비교에만 쓰므로 글자 수 한도는 보지 않습니다
// (저장할 내용 자체는 라우트가 MandalartContent로 검사). 단위 테스트가 바로 가져올 수 있도록 zod 없이 확인합니다.
export function isContent(x: unknown): x is MandalartContent {
  const c = x as Partial<MandalartContent> | null;
  const strings = (v: unknown) => Array.isArray(v) && v.length === 8 && v.every((s) => typeof s === "string");
  return !!c && typeof c === "object" && typeof c.goal === "string" && strings(c.subs) && Array.isArray(c.actions) && c.actions.length === 8 && c.actions.every(strings);
}

/**
 * 내용 지문(16글자). 칸 글만 정해진 순서로 이어 붙여(JSON.stringify([goal, subs, actions])) 해시하므로 DB(jsonb)가
 * 키 순서를 바꿔도 같습니다. 서버와 학생 화면이 같은 함수를 씁니다. 암호용이 아니라 '같은 글인지' 확인용이며
 * (cyrb53을 64비트로 늘린 것), 다른 글이 우연히 같은 지문이 될 확률은 무시할 만큼 작습니다.
 */
export function contentHash(c: MandalartContent): string {
  const s = JSON.stringify([c.goal, c.subs, c.actions]);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const HASH = /^[0-9a-f]{16}$/;

export function parseSaveMeta(body: unknown): SaveMeta {
  const b = (body && typeof body === "object" ? body : {}) as { revision?: unknown; prev?: unknown; sends?: unknown; hash?: unknown; horizon?: unknown };
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const revision = count(b.revision) ? (b.revision as number) : null;
  const prev = Array.isArray(b.prev) ? b.prev.filter((h): h is string => typeof h === "string" && HASH.test(h)).slice(0, MAX_PREV) : [];
  const sends = count(b.sends) ? (b.sends as number) : 0;
  const hash = typeof b.hash === "string" && HASH.test(b.hash) ? b.hash : null;
  // 예전 화면은 horizon을 보내지 않습니다(0: 번호를 1만 올림).
  const horizon = count(b.horizon) ? (b.horizon as number) : 0;
  return { revision, prev, sends, hash, horizon };
}

/** 두 만다라트 내용이 글자 하나까지 같은지(b는 DB에서 읽은 값이라 모양부터 확인) */
export function sameContent(a: MandalartContent, b: unknown): boolean {
  if (!isContent(b)) return false;
  return a.goal === b.goal && a.subs.every((s, i) => s === b.subs[i]) && a.actions.every((row, i) => row.every((x, j) => x === b.actions[i][j]));
}

/**
 * 이 화면이 서버의 지금 글을 알고 있는지(저장·피드백 요청 공용).
 * - 서버 번호가 화면이 아는 번호와 같으면 압니다.
 * - 서버 번호가 더 크더라도 지금 서버 글이 이 화면이 그 번호 뒤에 보낸 글(prev) 가운데 하나이고, 올라간 번호가 보낸 횟수(sends)를
 *   넘지 않으면 이 화면이 쓴 것입니다(응답이 끊긴 저장, 인터넷이 끊긴 동안 다시 보낸 저장, 탭을 닫을 때 보낸 저장 등).
 *   번호를 함께 보는 까닭: 늦게 도착한 옛 저장이, 학생이 글을 예전 그대로 되돌린 것을 자기 글로 착각해 덮어쓰지 않게.
 * - 피드백 요청은 화면 글의 지문(hash)이 서버 글과 같아도 압니다.
 * 그 밖에는 다른 탭·기기가 더 나중에 고친 것입니다.
 */
export function knowsLatest(row: { revision: number; content: unknown }, meta: SaveMeta): boolean {
  const rowHash = isContent(row.content) ? contentHash(row.content) : null;
  if (rowHash !== null && meta.hash === rowHash) return true;
  if (meta.revision === null) return false;
  if (row.revision === meta.revision) return true;
  const gap = row.revision - meta.revision;
  return rowHash !== null && gap > 0 && gap <= meta.sends && meta.prev.includes(rowHash);
}

/**
 * 저장할 때 새 번호. 보통은 1 올리지만, 이 화면이 먼저 보낸 저장들이 받아들여질 수 있는 가장 큰 번호(horizon)보다 크게 올립니다.
 * knowsLatest는 서버 번호가 요청의 revision + sends를 넘으면 받지 않으므로, 이렇게 올려 두면 먼저 보내 놓고 늦게 도착한
 * 저장(되돌리기 전 글 등)은 결과를 모르는 저장이 몇 개였든 다시는 받아들여지지 않습니다.
 */
export function nextRevision(current: number, meta: SaveMeta): number {
  return Math.max(current, Math.min(meta.horizon, current + MAX_JUMP)) + 1;
}

/**
 * 저장 요청을 어떻게 할지. 화면이 서버의 지금 글을 알면 'save'(새 번호, nextRevision),
 * 보낸 글이 서버 글과 똑같으면 'same'(바꿀 것이 없고 지금 번호를 돌려줌), 아니면 'stale'(다른 탭·기기가 더 나중에 고침).
 * 아는 화면이 서버 글과 같은 글을 보냈을 때는, 그 화면이 먼저 보낸 저장 중에 아직 받아들여질 수 있는 것이 있을 때만
 * (horizon이 지금 번호 이상) 번호를 올립니다('save'). 학생이 글을 서버 글 그대로 되돌렸는데 번호가 그대로면, 그 전에 보내 놓고
 * 늦게 도착한 앞 저장(되돌리기 전 글)이 받아들여져 되돌린 글을 덮어쓰기 때문입니다. 번호를 올려 두면 그 앞 저장은 'stale'이 됩니다.
 * 먼저 보낸 저장이 모두 이미 받아들여질 수 없으면(horizon < 지금 번호) 'same'으로 번호를 그대로 둡니다. 네트워크가 같은 저장을
 * 두 번 보내도 번호가 한 번만 올라, 화면이 다음에 보내는 저장(탭을 닫을 때의 저장처럼 다시 확인할 기회가 없는 것 포함)이
 * 화면이 모르는 번호 때문에 거절되지 않습니다. 그래도 번호가 화면이 아는 것보다 더 올라가 거절되면, 화면은 서버 글을 다시 읽어
 * 자기가 보낸 글인지 확인합니다(adoptIfOwn).
 */
export function saveDecision(row: { revision: number; content: unknown }, meta: SaveMeta, content: MandalartContent): "same" | "save" | "stale" {
  const same = sameContent(content, row.content);
  if (knowsLatest(row, meta) && !(same && meta.horizon < row.revision)) return "save";
  return same ? "same" : "stale";
}

// ── 학생 화면 쪽: 저장 번호 맞추기 ─────────────────────────────

// 학생 화면(Editor)이 들고 있는 저장 번호와 '결과를 모르는 저장'(보내는 중이거나, 인터넷이 끊기거나 응답이 늦었던 것).
// 결과를 모르는 저장은 다음 저장에 내용 지문(prev)과 보낸 횟수(sends)로 함께 보내, 그 저장이 이미 반영됐더라도 같은 탭의 저장이
// '다른 화면에서 고침'으로 막히지 않게 합니다(위 knowsLatest). 번호가 확인될 때까지 잊지 않습니다(서버에 닿지 못한 것이 확실한 것만
// 잊음: Editor가 settle(…, null)). seq는 보낸 차례 번호, last는 마지막으로 반영이 확인된 저장의 지문입니다(adoptIfOwn).
// horizon은 지금까지 보낸 저장들이 받아들여질 수 있는 가장 큰 서버 번호(revision + sends 중 최대)입니다(SaveMeta.horizon).
// carried는 같은 탭의 앞 화면(새로 고치기 전)이 넘겨준 결과를 모르는 저장의 지문입니다(아래 Handoff). 서버에 보내지 않고,
// 서버 글이 그중 하나인지 볼 때만 씁니다(takeLanded).
// confirmed: 반영이 확인된 가장 늦은 저장의 순번. sends는 그 뒤로 보낸 저장 수로 셉니다(닿지 못한 것이 확실해 잊은 저장도 포함:
// 그 사이 horizon이 이미 그만큼 올라가 있으므로, 서버가 허용하는 범위도 같이 넓혀야 탭을 닫을 때 보낸 저장이 거절되지 않음).
export type Sync = { revision: number; seq: number; unknown: { seq: number; hash: string }[]; last?: string; horizon?: number; carried?: string[]; confirmed?: number };

// 함께 보낼 결과를 모르는 저장의 지문(겹침 없이, MAX_PREV개까지). 꼭 남기는 것: 번호를 확인한 뒤 처음 보낸 저장(인터넷이 끊기기
// 직전에 반영됐을 수 있음). 나머지 자리는 가장 최근에 보낸 것부터 채웁니다(인터넷이 잠깐 붙었을 때 반영됐을 수 있음).
// 같은 글을 여러 번 보냈으면 마지막으로 보낸 차례로 봅니다.
function prevHashes(unknown: Sync["unknown"]): string[] {
  if (unknown.length === 0) return [];
  const first = unknown[0].hash;
  const recent: string[] = [];
  for (let i = unknown.length - 1; i >= 0 && recent.length < MAX_PREV - 1; i--) {
    const h = unknown[i].hash;
    if (h !== first && !recent.includes(h)) recent.push(h);
  }
  return [first, ...recent.reverse()];
}

/** 서버에 함께 보낼 저장 번호 정보. content를 주면 그 지문(hash)도 넣습니다(피드백 요청용). */
export function syncMeta(s: Sync, content?: MandalartContent): { revision: number; prev: string[]; sends: number; hash?: string } {
  const meta = { revision: s.revision, prev: prevHashes(s.unknown), sends: Math.max(s.unknown.length, s.seq - (s.confirmed ?? 0)) };
  return content ? { ...meta, hash: contentHash(content) } : meta;
}

/** 보낼 본문을 만들고, 보낸 내용의 지문을 결과를 알 때까지 기억합니다. */
export function prepareSend(s: Sync, content: MandalartContent): { body: string; seq: number } {
  const meta = syncMeta(s);
  const body = JSON.stringify({ content, ...meta, horizon: s.horizon ?? 0 });
  s.horizon = Math.max(s.horizon ?? 0, meta.revision + meta.sends);
  const seq = ++s.seq;
  s.unknown = [...s.unknown, { seq, hash: contentHash(content) }];
  return { body, seq };
}

/**
 * 결과를 알게 된 저장. 반영됐으면(revision) 새 번호를 받고 그때까지 보낸 것은 잊습니다
 * (그 뒤에 보낸 것, 예를 들어 탭을 닫을 때 보낸 저장은 이 번호 위에 반영될 수 있어 남김). 반영된 저장의 지문은 last로 남깁니다.
 * 거절됐거나 서버에 닿지 못한 것이 확실하면(null) 그것만 잊습니다.
 */
export function settle(s: Sync, seq: number, revision: number | null): void {
  if (revision !== null) {
    const own = s.unknown.find((u) => u.seq === seq);
    // 늦게 온 앞 저장의 응답(더 작은 번호)이면 last를 바꾸지 않습니다.
    if (own && revision >= s.revision) s.last = own.hash;
    s.revision = Math.max(s.revision, revision);
    s.confirmed = Math.max(s.confirmed ?? 0, seq);
    s.unknown = s.unknown.filter((u) => u.seq > seq);
  } else {
    s.unknown = s.unknown.filter((u) => u.seq !== seq);
  }
}

/**
 * 학생 화면이 가장 새 글을 보냈는데 '다른 화면에서 고침'(409 stale)으로 거절됐을 때, 서버에서 다시 읽은 지금 글(row)이 이 화면이
 * 보낸 글인지 봅니다(마지막으로 확인된 저장 last, 결과를 모르는 저장). 맞으면 다른 탭·기기가 아니라, 네트워크가 이 화면의 저장을
 * 두 번 보내거나, 결과를 모르는 저장이 번호를 건너뛰어(nextRevision) 이 화면이 아는 것보다 더 올라간 것입니다.
 * 그때는 서버 번호를 받아들이고 true(바로 다시 보내면 됨). 아니면 false(정말 다른 탭·기기가 고침).
 * 서버 글이 이 화면이 보낸 글이므로 덮어써도 다른 화면의 글을 잃지 않습니다. 늦게 도착한 옛 저장은 이것과 상관없이 서버가 번호로 막습니다.
 */
export function adoptIfOwn(s: Sync, row: { revision: number; content: unknown }): boolean {
  if (!isContent(row.content) || !Number.isSafeInteger(row.revision)) return false;
  const h = contentHash(row.content);
  if (h !== s.last && !s.unknown.some((u) => u.hash === h)) return false;
  s.revision = Math.max(s.revision, row.revision);
  return true;
}

// ── 새로 고친 화면: 앞 화면이 보낸 저장 이어받기 ─────────────────────────────
// 글을 쓰자마자 새로 고치면 앞 화면이 떠나며 보낸 저장(keepalive)이 새 화면을 서버가 그린 뒤에 반영될 수 있습니다(떠나기 전 경고가
// 없는 iOS Safari 등. 저장 응답을 받았어도 새 화면 요청이 그보다 먼저 DB를 읽었을 수 있음). 그러면 새 화면은 옛 글을 보여 주고,
// 다음 저장이 '다른 탭에서 고침'으로 막힙니다. 그래서 떠나는 화면은 자기가 보낸 저장(결과를 모르는 것과 마지막으로 반영이 확인된 것)의
// 지문과 번호 범위를 sessionStorage(같은 탭에서만 보임)에 남기고(makeHandoff), 새 화면은 그것을 이어받은 뒤(seedSync) 서버 글을
// 다시 읽어, 앞 화면이 보낸 글이면 받아들입니다(takeLanded). Editor가 씁니다.
export const HANDOFF_KEY = "mandalart-handoff";
export type Handoff = { id: string; hashes: string[]; horizon: number };

/** 떠나는 화면이 남길 정보(이어받은 지문, 마지막으로 반영이 확인된 저장, 결과를 모르는 저장의 지문과 번호 범위). 남길 것이 없으면 null. */
export function makeHandoff(id: string, s: Sync): Handoff | null {
  const own = [...(s.carried ?? []), ...(s.last ? [s.last] : []), ...s.unknown.map((u) => u.hash)];
  const hashes = [...new Set(own.reverse())].reverse().slice(-MAX_PREV); // 겹치면 나중 것(최근에 보낸 차례)으로
  if (hashes.length === 0) return null;
  return { id, hashes, horizon: Math.max(s.horizon ?? 0, s.revision + s.unknown.length) };
}

/** sessionStorage에서 읽은 글. 이 만다라트의 것이 아니거나 모양이 이상하면 null. */
export function parseHandoff(raw: string | null, id: string): Handoff | null {
  let h: { id?: unknown; hashes?: unknown; horizon?: unknown } | null;
  try {
    h = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!h || typeof h !== "object" || h.id !== id || !Array.isArray(h.hashes)) return null;
  if (typeof h.horizon !== "number" || !Number.isSafeInteger(h.horizon) || h.horizon < 0) return null;
  const hashes = h.hashes.filter((x): x is string => typeof x === "string" && HASH.test(x)).slice(-MAX_PREV);
  return hashes.length ? { id, hashes, horizon: h.horizon } : null;
}

/**
 * 앞 화면의 정보를 이어받습니다. 번호 범위(horizon)를 이어받아 이 화면의 첫 저장이 앞 화면의 저장들보다 번호를 크게 올리게 하고
 * (그 뒤에 늦게 도착한 앞 화면의 저장은 받아들여지지 않음), 지문은 carried로 기억합니다. 지문을 서버에 보내지는 않습니다
 * (보내면 이 화면의 옛 글이 앞 화면이 마지막으로 보낸 글을 그대로 덮어씀: 대신 거절된 뒤 takeLanded로 합침).
 */
export function seedSync(s: Sync, h: Handoff): void {
  s.horizon = Math.max(s.horizon ?? 0, h.horizon);
  s.carried = [...new Set([...(s.carried ?? []), ...h.hashes])].slice(-MAX_PREV);
}

/** 이 화면에서 고친 칸(base와 다른 칸)은 지금 화면 글(mine)을, 나머지 칸은 서버 글(server)을 씁니다. */
export function rebaseContent(base: MandalartContent, server: MandalartContent, mine: MandalartContent): MandalartContent {
  const pick = (b: string, sv: string, m: string) => (m !== b ? m : sv);
  return {
    goal: pick(base.goal, server.goal, mine.goal),
    subs: mine.subs.map((m, i) => pick(base.subs[i], server.subs[i], m)),
    actions: mine.actions.map((row, i) => row.map((m, j) => pick(base.actions[i][j], server.actions[i][j], m))),
  };
}

/**
 * 다시 읽은 서버 글(row)이 이 화면이 아는 것보다 새것일 때 받아들일지. base는 이 화면이 받은 서버 글(처음 그린 글, 또는 마지막으로
 * 받아들인 글), mine은 지금 화면 글, pristine은 이 화면에서 아직 아무것도 고치거나 보내지 않았는지입니다.
 * - 서버 글이 앞 화면이 넘겨준 저장(carried) 중 하나면 같은 탭의 글이므로 받아들입니다. 이 화면에서 고친 칸은 그대로 둡니다(rebaseContent).
 * - 그 밖의 글이라도 pristine이면 잃을 것이 없으므로 그대로 받아들입니다.
 * 받아들이면 번호를 서버 번호로 맞추고 화면에 보여 줄 글을 돌려줍니다. 아니면 null(다른 탭·기기가 고침: 저장할 때 기존 규칙대로 막힘).
 */
export function takeLanded(
  s: Sync, row: { revision: number; content: unknown }, base: MandalartContent, mine: MandalartContent, pristine: boolean,
): MandalartContent | null {
  if (!isContent(row.content) || !Number.isSafeInteger(row.revision) || row.revision <= s.revision) return null;
  if (!pristine && !(s.carried ?? []).includes(contentHash(row.content))) return null;
  s.revision = row.revision;
  return rebaseContent(base, row.content, mine);
}
