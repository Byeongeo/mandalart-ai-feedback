import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_JUMP, MAX_PREV, adoptIfOwn, contentHash, knowsLatest, makeHandoff, nextRevision, parseHandoff, parseSaveMeta, prepareSend, rebaseContent,
  sameContent, saveDecision, seedSync, settle, syncMeta, takeLanded,
  type SaveMeta, type Sync,
} from "../src/lib/save-rules.ts";
import { cellMatches, nextRuleConcern, type CellMatches } from "../src/lib/rule-concern-state.ts";
import { CONCERN_RULES, compactText, matchConcernText, ruleConcern } from "../src/lib/concern-rules.ts";
import { emptyContent, type MandalartContent } from "../src/lib/mandalart.ts";
import type { ConcernKind } from "../src/lib/feedback/categories.ts";

// ── 저장 번호(revision): 서버(save-mandalart.ts)가 하는 확인을 흉내 낸 가짜 서버로 탭 사이의 순서를 재현합니다 ──
type Row = { revision: number; content: unknown };
// DB(jsonb)는 키 순서를 바꿔 돌려주므로 가짜 서버도 다른 순서로 담아 둡니다(지문이 키 순서와 상관없는지 함께 확인).
const stored = (c: MandalartContent) => ({ actions: structuredClone(c.actions), subs: [...c.subs], goal: c.goal });
function put(row: Row, body: string): { status: number; revision?: number } {
  const b = JSON.parse(body);
  const m = parseSaveMeta(b);
  const d = saveDecision(row, m, b.content);
  if (d === "stale") return { status: 409 };
  if (d === "save") {
    row.content = stored(b.content);
    row.revision = nextRevision(row.revision, m);
  }
  return { status: 200, revision: row.revision };
}
const tab = (revision: number): Sync => ({ revision, seq: 0, unknown: [] });
const goalOf = (row: Row) => (row.content as MandalartContent).goal;
const withGoal = (goal: string, filled = 0): MandalartContent => {
  const c = emptyContent();
  c.goal = goal;
  for (let i = 0; i < filled; i++) c.actions[Math.floor(i / 8) % 8][i % 8] = `실천 ${i}`;
  return c;
};
const meta = (m: Partial<SaveMeta>): SaveMeta => ({ revision: null, prev: [], sends: 0, hash: null, horizon: 0, ...m });

test("오래된 탭(다른 탭이 고친 뒤)은 더 새 글을 덮어쓰지 못한다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0), b = tab(0);
  const sa = prepareSend(a, withGoal("A", 64));
  const ra = put(row, sa.body);
  assert.equal(ra.status, 200);
  settle(a, sa.seq, ra.revision!);
  const sb = prepareSend(b, withGoal("B(옛 글)"));
  assert.equal(put(row, sb.body).status, 409);
  assert.equal(goalOf(row), "A");
  assert.equal((row.content as MandalartContent).actions[7][7], "실천 63");
});

test("같은 탭에서 차례로 저장하면 막히지 않는다(제출도 마지막 번호로)", () => {
  const row: Row = { revision: 3, content: emptyContent() };
  const a = tab(3);
  for (let i = 0; i < 6; i++) {
    const s = prepareSend(a, withGoal(`고침 ${i}`));
    const r = put(row, s.body);
    assert.equal(r.status, 200);
    settle(a, s.seq, r.revision!);
  }
  assert.equal(a.revision, 9);
  assert.equal(a.unknown.length, 0);
});

test("응답이 끊긴 저장이 이미 반영됐어도 다음 저장은 받아들여진다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0);
  put(row, prepareSend(a, withGoal("첫 글")).body); // 반영됐지만 응답을 못 받음(settle 없음)
  const s2 = prepareSend(a, withGoal("둘째 글"));
  const r2 = put(row, s2.body);
  assert.equal(r2.status, 200);
  settle(a, s2.seq, r2.revision!);
  assert.equal(goalOf(row), "둘째 글");
  assert.equal(a.unknown.length, 0);
});

test("반영된 저장의 응답이 끊긴 뒤 인터넷이 끊겨 여러 번 다른 글로 다시 보내도 '다른 화면에서 고침'이 되지 않는다", () => {
  for (const offline of [3, 10, 200]) {
    const row: Row = { revision: 5, content: emptyContent() };
    const a = tab(5);
    put(row, prepareSend(a, withGoal("나의 꿈 1")).body); // 반영됐지만 응답이 끊김
    // 인터넷이 끊긴 동안 계속 쓰고, 보낸 저장은 서버에 닿지 못함(결과를 모름). 같은 글로 다시 보내기도 섞음.
    for (let i = 0; i < offline; i++) {
      prepareSend(a, withGoal(`오프라인 ${i}`));
      if (i % 3 === 0) prepareSend(a, withGoal(`오프라인 ${i}`));
    }
    const s = prepareSend(a, withGoal("다시 연결된 뒤 글"));
    assert.ok(new TextEncoder().encode(s.body).length < 4096, "본문이 작아야 함(keepalive)");
    const r = put(row, s.body);
    assert.equal(r.status, 200, `오프라인 ${offline}번`);
    settle(a, s.seq, r.revision!);
    assert.equal(goalOf(row), "다시 연결된 뒤 글");
    assert.equal(a.revision, row.revision);
    assert.equal(a.unknown.length, 0);
  }
});

test("같은 저장 요청이 두 번 도착해도(재전송) 받아들이고, 새로 안 것이 없는 두 번째는 번호를 올리지 않는다", () => {
  const row: Row = { revision: 4, content: emptyContent() };
  const a = tab(4);
  const s = prepareSend(a, withGoal("재전송 시험"));
  const first = put(row, s.body);
  assert.deepEqual(first, { status: 200, revision: 5 });
  assert.deepEqual(put(row, s.body), { status: 200, revision: 5 }); // 같은 요청이 그대로 두 번 도착: 'same'
  // 첫 응답이 끊겨 같은 글을 다시 보낸 경우: 서버 글과 같고, 먼저 보낸 저장은 이미 받아들여질 수 없으므로(horizon 4 < 5)
  // 번호를 올리지 않고 지금 번호를 알려 줌
  const again = prepareSend(a, withGoal("재전송 시험"));
  assert.deepEqual(put(row, again.body), { status: 200, revision: 5 });
  settle(a, again.seq, 5);
  assert.equal(a.revision, 5);
  assert.equal(a.unknown.length, 0);
  // 다른 기기의 오래된 화면이라도 서버 글과 똑같은 글이면 바꿀 것이 없으므로 받아 줌(지금 번호를 알려 줌)
  const b = tab(0);
  assert.deepEqual(put(row, prepareSend(b, withGoal("재전송 시험")).body), { status: 200, revision: 5 });
});

test("다시 보낸 같은 글이 두 번 도착해도 번호는 한 번만 올라, 탭을 닫을 때 보내는 다음 저장이 거절되지 않는다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0);
  prepareSend(a, withGoal("나의 꿈")); // 와이파이가 흔들려 실패(결과를 모름)
  const r = prepareSend(a, withGoal("나의 꿈")); // 2초 뒤 같은 글로 다시 보냄: prev에 '나의 꿈'
  const first = put(row, r.body);
  assert.deepEqual(first, { status: 200, revision: 1 });
  assert.deepEqual(put(row, r.body), { status: 200, revision: 1 }); // 네트워크가 한 번 더 보냄: 같은 글이라 번호 그대로
  settle(a, r.seq, first.revision!); // 화면은 먼저 온 응답(1)만 받음 → '저장됨'
  // 마지막 줄을 쓰고 바로 탭을 닫음(keepalive, 응답을 볼 수 없어 adoptIfOwn으로 다시 확인할 기회가 없음)
  const close = prepareSend(a, withGoal("나의 꿈 — 수업 끝 마지막 줄"));
  assert.equal(put(row, close.body).status, 200);
  assert.equal(goalOf(row), "나의 꿈 — 수업 끝 마지막 줄");
});

test("서버 번호가 화면이 아는 것보다 더 올라가 거절돼도, 화면은 서버 글이 자기 글인지 확인하고 이어서 저장한다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0);
  const r = prepareSend(a, withGoal("가"));
  const first = put(row, r.body);
  settle(a, r.seq, first.revision!);
  assert.equal(a.last, contentHash(withGoal("가")));
  row.revision += 1; // 예전 서버처럼 같은 저장이 두 번 도착해 번호가 한 번 더 오름(글은 그대로)
  const next = prepareSend(a, withGoal("가나"));
  assert.equal(put(row, next.body).status, 409);
  settle(a, next.seq, null);
  // 서버 글을 다시 읽어 보니 이 화면이 마지막으로 확인한 글: 번호를 받아들이고 다시 보냄
  assert.equal(adoptIfOwn(a, row), true);
  assert.equal(a.revision, 2);
  const again = prepareSend(a, withGoal("가나"));
  assert.deepEqual(put(row, again.body), { status: 200, revision: 3 });
  assert.equal(goalOf(row), "가나");
});

test("adoptIfOwn: 서버 글이 이 화면이 보낸 글이 아니면(다른 탭·기기) 받아들이지 않는다", () => {
  const a = tab(3);
  const s1 = prepareSend(a, withGoal("확인된 글"));
  settle(a, s1.seq, 4);
  prepareSend(a, withGoal("결과 모름"));
  assert.equal(adoptIfOwn(a, { revision: 9, content: withGoal("다른 기기 글") }), false);
  assert.equal(a.revision, 4);
  assert.equal(adoptIfOwn(a, { revision: 9, content: { goal: "모양이 이상함" } }), false);
  assert.equal(adoptIfOwn(a, { revision: 6, content: withGoal("결과 모름") }), true);
  assert.equal(a.revision, 6);
  assert.equal(adoptIfOwn(a, { revision: 8, content: withGoal("확인된 글") }), true);
  assert.equal(a.revision, 8);
  assert.equal(a.unknown.length, 1); // 결과를 모르는 저장은 그대로 기억(나중에 반영될 수 있음)
  // 처음 연 화면(확인된 저장 없음)은 서버 글이 같아도 자기 글로 보지 않음
  const fresh = tab(0);
  assert.equal(adoptIfOwn(fresh, { revision: 2, content: emptyContent() }), false);
});

test("되돌린 글(서버 글과 같음)도 아는 화면이면 번호를 올려, 그 전에 보내 놓고 늦게 도착한 저장이 덮어쓰지 못한다", () => {
  // 응답이 끊기지 않은 경우: 앞 저장이 네트워크에 붙잡힌 사이 학생이 서버 글 그대로 되돌림
  {
    const row: Row = { revision: 0, content: withGoal("원래 글") };
    const a = tab(0);
    const held = prepareSend(a, withGoal("원래 글 + 지울 말"));
    const back = prepareSend(a, withGoal("원래 글"));
    const r = put(row, back.body);
    assert.deepEqual(r, { status: 200, revision: 1 });
    settle(a, back.seq, r.revision!);
    assert.equal(put(row, held.body).status, 409);
    assert.equal(goalOf(row), "원래 글");
  }
  // 앞 저장이 반영됐지만 응답이 끊긴 뒤: 다음 저장이 붙잡힌 사이 학생이 반영된 글로 되돌림
  {
    const row: Row = { revision: 0, content: withGoal("O") };
    const a = tab(0);
    put(row, prepareSend(a, withGoal("X")).body);
    const held = prepareSend(a, withGoal("Y"));
    const back = prepareSend(a, withGoal("X"));
    const r = put(row, back.body);
    assert.deepEqual(r, { status: 200, revision: 2 });
    settle(a, back.seq, r.revision!);
    assert.equal(put(row, held.body).status, 409);
    assert.equal(goalOf(row), "X");
  }
});

test("결과를 모르는 저장이 여럿이어도, 그 뒤의 저장이 반영되면 먼저 보낸 저장은 늦게 도착해도 받아들여지지 않는다(horizon)", () => {
  // X(서버에 닿지 못함) → Y(네트워크에 붙잡힘) → 학생이 X로 되돌림(반영) → Y가 늦게 도착
  const row: Row = { revision: 3, content: withGoal("처음") };
  const a = tab(3);
  prepareSend(a, withGoal("X"));
  const held = prepareSend(a, withGoal("Y"));
  const back = prepareSend(a, withGoal("X"));
  assert.equal(JSON.parse(back.body).horizon, 4); // 먼저 보낸 Y는 번호 4(3 + 결과 모름 1)까지 받아들여질 수 있음
  const r = put(row, back.body);
  assert.deepEqual(r, { status: 200, revision: 5 }); // 그래서 4를 넘겨 5로
  settle(a, back.seq, r.revision!);
  assert.equal(put(row, held.body).status, 409);
  assert.equal(goalOf(row), "X");
  // 첫 저장 X가 사실은 늦게 도착해도 마찬가지(서버 글과 같으면 바꿀 것 없음)
  assert.deepEqual(put(row, prepareSend(tab(3), withGoal("X")).body), { status: 200, revision: 5 });
  // 반영된 저장 자체가 한 번 더 도착해도 같은 글이고 먼저 보낸 저장은 이미 받아들여질 수 없으므로 번호를 올리지 않음.
  // 그 뒤에도 먼저 보낸 저장은 받아들여지지 않고, 화면의 다음 저장은 그대로 받아들여짐
  assert.deepEqual(put(row, back.body), { status: 200, revision: 5 });
  assert.equal(goalOf(row), "X");
  assert.equal(put(row, held.body).status, 409);
  assert.equal(put(row, prepareSend(a, withGoal("X 다음")).body).status, 200);
  assert.equal(goalOf(row), "X 다음");
});

test("끊겨서 늦게 도착한 옛 저장은 새 글을 덮어쓰지 못한다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0);
  const late = prepareSend(a, withGoal("옛 글")); // 15초 넘게 응답이 없어 끊음
  const s2 = prepareSend(a, withGoal("새 글"));
  const r2 = put(row, s2.body);
  assert.equal(r2.status, 200);
  settle(a, s2.seq, r2.revision!);
  assert.equal(put(row, late.body).status, 409);
  assert.equal(goalOf(row), "새 글");
});

test("늦게 도착한 옛 저장은 학생이 글을 예전 그대로 되돌린 뒤에도 덮어쓰지 못한다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0);
  put(row, prepareSend(a, withGoal("가")).body); // 반영됐지만 응답이 끊김
  const late = prepareSend(a, withGoal("가나")); // 서버로 가는 길에서 오래 머묾
  const s3 = prepareSend(a, withGoal("가")); // 학생이 '가'로 되돌림
  const r3 = put(row, s3.body);
  assert.deepEqual(r3, { status: 200, revision: 2 }); // 서버 글과 같아도 아는 화면이라 번호를 올림
  settle(a, s3.seq, r3.revision!);
  const s4 = prepareSend(a, withGoal("가다"));
  assert.equal(put(row, s4.body).status, 200);
  // 늦게 도착: 그 요청의 prev에는 '가'가 있지만 그 뒤로 번호가 보낸 횟수보다 더 올라가 있음
  assert.equal(put(row, late.body).status, 409);
  assert.equal(goalOf(row), "가다");
});

test("탭을 닫을 때 보내는 저장은 보내는 중인 저장과 어느 쪽이 먼저 도착해도 마지막 글이 남는다", () => {
  for (const order of ["put-first", "beacon-first"] as const) {
    const row: Row = { revision: 0, content: emptyContent() };
    const a = tab(0);
    const inFlight = prepareSend(a, withGoal("보내는 중"));
    const beacon = prepareSend(a, withGoal("마지막 글"));
    if (order === "put-first") {
      assert.equal(put(row, inFlight.body).status, 200);
      assert.equal(put(row, beacon.body).status, 200);
    } else {
      assert.equal(put(row, beacon.body).status, 200);
      assert.equal(put(row, inFlight.body).status, 409);
      // 탭이 그대로 남아 있었다면(뒤로 가기 캐시 등): 거절된 저장을 잊고 다시 보내면 닫을 때 보낸 저장 위에 받아들여진다.
      settle(a, inFlight.seq, null);
      assert.ok(a.seq > inFlight.seq);
      const again = prepareSend(a, withGoal("다시 보냄"));
      assert.equal(put(row, again.body).status, 200);
      assert.equal(goalOf(row), "다시 보냄");
      continue;
    }
    assert.equal(goalOf(row), "마지막 글");
  }
});

test("반영된 저장 뒤에 보낸 것(닫을 때 보낸 저장)은 기억에 남는다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0);
  const p = prepareSend(a, withGoal("보내는 중"));
  prepareSend(a, withGoal("닫을 때")); // 아직 결과를 모름
  const r = put(row, p.body);
  settle(a, p.seq, r.revision!);
  assert.deepEqual(a.unknown.map((u) => u.hash), [contentHash(withGoal("닫을 때"))]);
  // 반영이 확인된 저장은 last로 남지만(adoptIfOwn용) 서버에 보내는 지문에는 넣지 않음
  assert.equal(a.last, contentHash(withGoal("보내는 중")));
  assert.deepEqual(syncMeta(a), { revision: 1, prev: [contentHash(withGoal("닫을 때"))], sends: 1 });
  // 늦게 온 앞 저장의 응답(더 작은 번호)은 last를 바꾸지 않음
  const b = tab(5);
  const old = prepareSend(b, withGoal("옛"));
  const cur = prepareSend(b, withGoal("새"));
  settle(b, cur.seq, 7);
  settle(b, old.seq, 6);
  assert.equal(b.last, contentHash(withGoal("새")));
  assert.equal(b.revision, 7);
});

// 한 탭(Editor처럼 한 번에 하나씩 보냄)이 쓰는 동안 네트워크가 요청을 떨어뜨리고·응답을 잃고·두 번 보내고·붙잡았다가 늦게 보냅니다.
// 탭이 하나뿐이므로 '다른 화면에서 고침'(409)이 한 번도 나오면 안 되고, 확인된 새 글을 그보다 먼저 보낸 저장이 덮어쓰면 안 되며,
// 끝에 붙잡힌 요청이 모두 도착하고 마지막 저장이 확인되면 서버 글 = 화면 글이어야 합니다.
function chaos(seed: number, steps: number) {
  let x = seed;
  const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const row: Row = { revision: 0, content: withGoal("") };
  const a = tab(0);
  const goals: string[] = [""];
  let latest = "", version = 0, savedVersion = 0;
  let newestConfirmed = { seq: 0, goal: "" };
  const held: { due: number; body: string; seq: number; goal: string }[] = [];
  const problems: string[] = [];
  const deliver = (body: string, seq: number, goal: string) => {
    const before = goalOf(row);
    const r = put(row, body);
    if (r.status === 200 && goalOf(row) !== before && seq < newestConfirmed.seq && goal !== newestConfirmed.goal) {
      problems.push(`옛 저장(${seq})이 확인된 새 글(${newestConfirmed.seq})을 덮어씀`);
    }
    return r;
  };
  const send = (fate: string, step: number): void => {
    const v = version, goal = latest;
    const { body, seq } = prepareSend(a, withGoal(goal));
    const ok = (r: { status: number; revision?: number }) => {
      if (r.status === 409) {
        // Editor처럼: 거절된 저장을 잊고, 서버 글을 다시 읽어 이 화면이 보낸 글이면 번호를 받아들여 다시 보냄(아니면 '다른 화면' 안내)
        settle(a, seq, null);
        if (adoptIfOwn(a, row)) return send("pass", step);
        return problems.push(`한 탭인데 막힘(seq ${seq}, ${fate}, 서버 '${goalOf(row)}')`);
      }
      settle(a, seq, r.revision!);
      savedVersion = Math.max(savedVersion, v);
      if (seq > newestConfirmed.seq) newestConfirmed = { seq, goal };
    };
    if (fate === "pass") ok(deliver(body, seq, goal));
    else if (fate === "offline") settle(a, seq, null); // 보낼 때부터 오프라인: 서버에 닿지 않은 것이 확실(Editor가 잊음)
    else if (fate === "drop") { /* 서버에 닿지 못함, 결과를 모름 */ }
    else if (fate === "lost") deliver(body, seq, goal); // 반영됐지만 응답이 끊김
    else if (fate === "hold") held.push({ due: step + 1 + Math.floor(rand() * 6), body, seq, goal }); // 화면은 기다리다 끊음
    else if (fate === "dup") {
      const r1 = deliver(body, seq, goal), r2 = deliver(body, seq, goal);
      ok(rand() < 0.5 ? r1 : r2);
    } else if (fate === "beacon") {
      // 보내는 중에 화면을 떠나며(다른 앱으로 감) 더 새 글을 keepalive로 따로 보냄. 두 요청은 어느 쪽이든 먼저 도착하고,
      // 화면은 앞 요청의 응답만 받음. 앞 요청이 거절되면 그사이 따로 보낸 저장이 있으므로 '다른 화면'으로 보지 않고 다시 보냄(Editor).
      latest = `떠날 때 ${seed}-${step}`;
      goals.push(latest);
      version++;
      const b2 = prepareSend(a, withGoal(latest));
      const first = rand() < 0.5;
      const rb = first ? deliver(b2.body, b2.seq, latest) : null;
      const r = deliver(body, seq, goal);
      if (!first) deliver(b2.body, b2.seq, latest);
      if (rb && r.status === 409 && a.seq > seq) {
        settle(a, seq, null);
        return send("pass", step);
      }
      ok(r);
    }
  };
  for (let step = 0; step < steps; step++) {
    for (const h of held.filter((h) => h.due === step)) deliver(h.body, h.seq, h.goal);
    const roll = rand();
    if (roll < 0.45) {
      // 쓰기: 새 글, 가끔 예전 글로 되돌리기
      latest = rand() < 0.2 ? pick(goals) : `글 ${seed}-${step}`;
      goals.push(latest);
      version++;
    }
    if (version !== savedVersion || rand() < 0.1) {
      const offlineStretch = step % 97 < 20; // 가끔 오래 끊김
      send(offlineStretch ? (rand() < 0.9 ? "offline" : pick(["lost", "drop"])) : pick(["pass", "pass", "drop", "lost", "hold", "dup", "offline", "beacon"]), step);
    }
  }
  for (const h of held.splice(0)) deliver(h.body, h.seq, h.goal);
  for (let i = 0; i < 3 && version !== savedVersion; i++) send("pass", steps);
  if (version !== savedVersion) send("pass", steps); // 마지막 글이 서버 글과 같아도 한 번은 확인
  if (goalOf(row) !== latest) problems.push(`끝: 서버 '${goalOf(row)}' ≠ 화면 '${latest}'`);
  return problems;
}

test("네트워크가 어지러워도(떨어뜨림·응답 잃음·두 번 보냄·붙잡음·오래 끊김·되돌리기) 한 탭은 막히지 않고 옛 저장이 새 글을 덮어쓰지 않는다", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const problems = chaos(seed, 250);
    assert.deepEqual(problems, [], `seed ${seed}`);
  }
});

// 같은 어지러운 네트워크에서 쓰다가 탭을 닫습니다: 보내는 중인 저장과 닫을 때 보낸 저장(keepalive), 붙잡혀 있던 요청이
// 아무 순서로 도착합니다. 화면은 닫혀서 응답을 볼 수 없으므로(adoptIfOwn 없음) 닫을 때 보낸 마지막 글이 그대로 받아들여져야 합니다.
function closeChaos(seed: number, steps: number): string[] {
  let x = seed;
  const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const row: Row = { revision: 0, content: withGoal("") };
  const a = tab(0);
  let latest = "", version = 0, saved = 0, n = 0;
  const held: { body: string; due: number }[] = [];
  const problems: string[] = [];
  const write = () => { latest = rand() < 0.15 ? "" : `글 ${seed}-${n++}`; version++; };
  const deliverHeld = (step: number) => {
    for (let i = held.length - 1; i >= 0; i--) if (held[i].due <= step) put(row, held.splice(i, 1)[0].body);
  };
  const attempt = (step: number, depth = 0): void => {
    const v = version;
    const { body, seq } = prepareSend(a, withGoal(latest));
    const fate = pick(["pass", "pass", "pass", "drop", "lost", "hold", "dup", "offline", "hide"]);
    let r: { status: number; revision?: number };
    if (fate === "drop") return;
    if (fate === "lost") return void put(row, body);
    if (fate === "offline") return settle(a, seq, null);
    if (fate === "hold") return void held.push({ body, due: step + 1 + Math.floor(rand() * 8) });
    if (fate === "dup") {
      const r1 = put(row, body), r2 = put(row, body);
      r = rand() < 0.5 ? r1 : r2;
    } else if (fate === "hide") {
      // 보내는 중에 다른 앱으로 감: 더 고친 글을 keepalive로 따로 보냄(Editor의 onHidden → beacon). 도착 순서는 아무렇게나.
      write();
      const b = prepareSend(a, withGoal(latest));
      const bf = pick(["first", "after", "drop", "hold"]);
      if (bf === "first") put(row, b.body);
      if (bf === "hold") held.push({ body: b.body, due: step + 1 + Math.floor(rand() * 8) });
      r = put(row, body);
      if (bf === "after") put(row, b.body);
      if (r.status === 409 && a.seq > seq) {
        settle(a, seq, null);
        if (depth < 3) attempt(step, depth + 1);
        return;
      }
    } else r = put(row, body);
    if (r.status === 200) {
      settle(a, seq, r.revision!);
      saved = Math.max(saved, v);
      return;
    }
    settle(a, seq, null);
    if (rand() < 0.3) deliverHeld(step + 3); // 서버 글을 다시 읽기 전에 붙잡힌 요청이 도착할 수도
    if (adoptIfOwn(a, row)) {
      if (depth < 3) attempt(step, depth + 1);
      return;
    }
    problems.push(`step ${step}: 한 탭인데 다른 화면으로 판단(서버 '${goalOf(row)}')`);
  };
  for (let step = 0; step < steps && problems.length === 0; step++) {
    deliverHeld(step);
    if (rand() < 0.5) write();
    if (version !== saved) attempt(step);
  }
  if (problems.length) return problems;
  // 탭을 닫음: 보내는 중인 저장(지금 글)과, 그사이 더 고친 글을 닫을 때 보낸 저장, 붙잡힌 요청을 아무 순서로 배달
  const inFlight = prepareSend(a, withGoal(latest));
  write();
  const close = prepareSend(a, withGoal(latest));
  const queue = [inFlight.body, close.body, ...held.map((h) => h.body)];
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  for (const q of queue) put(row, q);
  if (goalOf(row) !== latest) problems.push(`닫을 때 마지막 글을 잃음: 서버 '${goalOf(row)}' ≠ '${latest}'`);
  return problems;
}

test("어지러운 네트워크에서 쓰다가 탭을 닫아도 닫을 때 보낸 마지막 글이 남는다", () => {
  for (let seed = 1; seed <= 1000; seed++) assert.deepEqual(closeChaos(seed, 200), [], `seed ${seed}`);
});

// ── 새로 고친 화면: 앞 화면이 떠나며 보낸 저장(keepalive)이 새 화면을 그린 뒤에 반영되는 경우 ──
const ID = "11111111-2222-4333-8444-555555555555";
const cells = (subs: Record<number, string>): MandalartContent => {
  const c = emptyContent();
  for (const [i, v] of Object.entries(subs)) c.subs[+i] = v;
  return c;
};
// 앞 화면: 서버 글(번호 3)을 알고, 세부 목표 1을 쓰자마자 새로 고침 → 떠나며 keepalive를 보내고 sessionStorage에 남김
function reloadSetup() {
  const row: Row = { revision: 3, content: cells({ 0: "공부" }) };
  const old = tab(3);
  const keepalive = prepareSend(old, cells({ 0: "공부", 1: "새로 고침 직전" }));
  const stored = JSON.stringify(makeHandoff(ID, old));
  // 새 화면: 서버가 keepalive보다 먼저 그림(옛 글, 번호 3). sessionStorage에서 이어받음
  const base = structuredClone(row.content as MandalartContent);
  const page = tab(row.revision);
  const h = parseHandoff(stored, ID);
  assert.ok(h);
  seedSync(page, h);
  return { row, keepalive, base, page };
}

test("새로 고친 화면: 앞 화면의 저장이 늦게 반영되면 잠시 뒤 다시 읽어 그 글을 받아들이고, 다음 저장이 막히지 않는다", () => {
  const { row, keepalive, base, page } = reloadSetup();
  assert.equal(put(row, keepalive.body).status, 200); // 새 화면을 그린 뒤 반영
  // 아직 아무것도 안 고친 화면: 서버 글을 그대로 받아들임
  const shown = takeLanded(page, row, base, base, true);
  assert.deepEqual(shown, cells({ 0: "공부", 1: "새로 고침 직전" }));
  assert.equal(page.revision, row.revision);
  const s = prepareSend(page, cells({ 0: "공부", 1: "새로 고침 직전", 2: "새로 고친 뒤" }));
  assert.equal(put(row, s.body).status, 200);
  assert.deepEqual((row.content as MandalartContent).subs.slice(0, 3), ["공부", "새로 고침 직전", "새로 고친 뒤"]);
});

test("새로 고친 화면: 다시 읽기 전에 고친 칸은 남기고 앞 화면이 고친 칸은 받아들인다(저장이 거절된 뒤에도 같음)", () => {
  // (1) 다시 읽을 때 이 화면에 저장 안 된 고침이 있음
  {
    const { row, keepalive, base, page } = reloadSetup();
    put(row, keepalive.body);
    const mine = cells({ 0: "공부", 2: "새로 고친 뒤" });
    const merged = takeLanded(page, row, base, mine, false);
    assert.deepEqual(merged, cells({ 0: "공부", 1: "새로 고침 직전", 2: "새로 고친 뒤" }));
    const s = prepareSend(page, merged!);
    assert.equal(put(row, s.body).status, 200);
  }
  // (2) 다시 읽기 전에 이 화면의 저장이 먼저 나감: 거절(409)된 뒤 서버 글을 읽어 합치고 다시 보냄('다른 탭' 안내 없음)
  {
    const { row, keepalive, base, page } = reloadSetup();
    put(row, keepalive.body);
    const mine = cells({ 0: "공부", 2: "새로 고친 뒤" });
    const first = prepareSend(page, mine);
    assert.equal(put(row, first.body).status, 409);
    settle(page, first.seq, null);
    assert.equal(adoptIfOwn(page, row), false);
    const merged = takeLanded(page, row, base, mine, false);
    assert.ok(merged);
    const again = prepareSend(page, merged);
    assert.equal(put(row, again.body).status, 200);
    assert.deepEqual((row.content as MandalartContent).subs.slice(0, 3), ["공부", "새로 고침 직전", "새로 고친 뒤"]);
  }
  // (3) 이 화면의 저장이 먼저 반영되면 늦게 도착한 앞 화면의 저장은 받아들여지지 않음(새 화면에서 고친 글을 덮지 않음)
  {
    const { row, keepalive, page } = reloadSetup();
    const s = prepareSend(page, cells({ 0: "공부", 2: "새로 고친 뒤" }));
    assert.equal(put(row, s.body).status, 200);
    assert.equal(put(row, keepalive.body).status, 409);
    assert.deepEqual((row.content as MandalartContent).subs.slice(0, 3), ["공부", "", "새로 고친 뒤"]);
  }
});

test("새로 고친 화면: 다른 탭·기기가 고친 글은 고친 것이 있는 화면에서 받아들이지 않고, 넘겨받은 것이 없으면 예전처럼 막힌다", () => {
  const { row, base, page } = reloadSetup();
  const other = tab(3);
  assert.equal(put(row, prepareSend(other, cells({ 0: "다른 기기" })).body).status, 200);
  assert.equal(takeLanded(page, row, base, cells({ 0: "공부", 5: "고침" }), false), null);
  assert.equal(page.revision, 3);
  // 아무것도 고치지 않은 화면이면 잃을 것이 없으므로 받아들임
  assert.deepEqual(takeLanded(page, row, base, base, true), cells({ 0: "다른 기기" }));
  // sessionStorage를 쓸 수 없어 넘겨받지 못한 화면: 앞 화면의 글도 알아보지 못함(그래서 넘겨받음)
  const r2 = reloadSetup();
  put(r2.row, r2.keepalive.body);
  const blind = tab(3);
  assert.equal(takeLanded(blind, r2.row, r2.base, cells({ 0: "공부", 5: "고침" }), false), null);
  // 서버 번호가 이미 아는 번호 이하면 할 일 없음
  assert.equal(takeLanded(tab(9), r2.row, r2.base, r2.base, true), null);
});

test("새로 고친 화면: 앞 화면의 저장 응답을 받았어도 새 화면이 그보다 먼저 읽혔으면, 마지막으로 확인된 저장으로 알아본다", () => {
  // 떠나기 전 경고 → 저장(keepalive)의 응답이 pagehide 전에 옴(결과를 모르는 저장 없음). 그런데 새 화면 요청은 그 저장보다 먼저 DB를 읽음
  const row: Row = { revision: 10, content: cells({ 0: "옛 글" }) };
  const base = structuredClone(row.content as MandalartContent);
  const old = tab(10);
  const s = prepareSend(old, cells({ 0: "새로 고침 직전" }));
  const r = put(row, s.body);
  settle(old, s.seq, r.revision!);
  assert.equal(old.unknown.length, 0);
  const h = parseHandoff(JSON.stringify(makeHandoff(ID, old)), ID);
  assert.deepEqual(h?.hashes, [contentHash(cells({ 0: "새로 고침 직전" }))]);
  const page = tab(10); // 옛 글(번호 10)을 그린 새 화면
  seedSync(page, h!);
  const mine = cells({ 0: "옛 글", 1: "새로 고친 뒤" });
  const first = prepareSend(page, mine);
  assert.equal(put(row, first.body).status, 409);
  settle(page, first.seq, null);
  const merged = takeLanded(page, row, base, mine, false);
  assert.deepEqual(merged, cells({ 0: "새로 고침 직전", 1: "새로 고친 뒤" }));
  assert.equal(put(row, prepareSend(page, merged!).body).status, 200);
});

test("새로 고친 화면을 다시 새로 고쳐도 앞앞 화면의 저장을 알아본다(이어받은 지문도 넘김)", () => {
  const { row, keepalive, page } = reloadSetup();
  const next = parseHandoff(JSON.stringify(makeHandoff(ID, page)), ID);
  assert.ok(next);
  const third = tab(3);
  seedSync(third, next);
  put(row, keepalive.body);
  const base = cells({ 0: "공부" });
  assert.deepEqual(takeLanded(third, row, base, base, false), cells({ 0: "공부", 1: "새로 고침 직전" }));
});

test("makeHandoff·parseHandoff·seedSync·rebaseContent", () => {
  assert.equal(makeHandoff(ID, tab(4)), null); // 넘길 것이 없음
  const a = tab(4);
  a.horizon = 2;
  for (let i = 0; i < 3; i++) prepareSend(a, withGoal(`글 ${i % 2}`));
  const h = makeHandoff(ID, a)!;
  assert.deepEqual(h.hashes, [contentHash(withGoal("글 1")), contentHash(withGoal("글 0"))]); // 겹침 없이(최근에 보낸 차례로)
  assert.equal(h.horizon, 4 + 3); // 보낸 저장이 받아들여질 수 있는 번호보다 크거나 같음
  assert.ok(h.horizon >= a.horizon!);
  assert.deepEqual(parseHandoff(JSON.stringify(h), ID), h);
  assert.equal(parseHandoff(JSON.stringify(h), "다른 만다라트"), null);
  assert.equal(parseHandoff(null, ID), null);
  assert.equal(parseHandoff("{깨진", ID), null);
  assert.equal(parseHandoff(JSON.stringify({ ...h, horizon: -1 }), ID), null);
  assert.equal(parseHandoff(JSON.stringify({ ...h, hashes: ["x", 3] }), ID), null);
  assert.deepEqual(parseHandoff(JSON.stringify({ ...h, hashes: ["x", ...h.hashes] }), ID)?.hashes, h.hashes);
  // 이어받으면 첫 저장이 앞 화면의 저장보다 번호를 크게 올림(그 뒤에 늦게 도착한 앞 화면의 저장은 거절)
  const b = tab(4);
  seedSync(b, h);
  assert.equal(JSON.parse(prepareSend(b, withGoal("새 화면")).body).horizon, 7);
  assert.deepEqual(syncMeta(b).prev, [contentHash(withGoal("새 화면"))]); // 넘겨받은 지문은 서버에 보내지 않음
  // 칸마다: 이 화면에서 고친 칸은 화면 글, 아니면 서버 글
  const base = cells({ 0: "가", 1: "나" });
  const server = cells({ 0: "가!", 1: "나", 3: "라" });
  const mine = cells({ 0: "가", 1: "나나" });
  mine.goal = "목표";
  mine.actions[2][2] = "실천";
  const out = rebaseContent(base, server, mine);
  assert.deepEqual(out.subs.slice(0, 4), ["가!", "나나", "", "라"]);
  assert.equal(out.goal, "목표");
  assert.equal(out.actions[2][2], "실천");
  assert.ok(sameContent(rebaseContent(base, server, base), server));
});

test("내 저장이 반영된 뒤 다른 탭이 고쳤으면 막힌다", () => {
  const row: Row = { revision: 0, content: emptyContent() };
  const a = tab(0);
  put(row, prepareSend(a, withGoal("A 첫 글")).body); // 반영됐지만 응답을 못 받음
  const b = tab(row.revision);
  assert.equal(put(row, prepareSend(b, withGoal("B가 새로 씀")).body).status, 200);
  assert.equal(put(row, prepareSend(a, withGoal("A 둘째 글")).body).status, 409);
  assert.equal(goalOf(row), "B가 새로 씀");
});

test("보내는 지문은 겹치지 않고, 많으면 번호를 확인한 뒤 처음 보낸 것과 가장 최근에 보낸 것들을 남긴다", () => {
  const a = tab(0);
  for (let i = 0; i < 5; i++) prepareSend(a, withGoal("같은 글"));
  assert.deepEqual(syncMeta(a), { revision: 0, prev: [contentHash(withGoal("같은 글"))], sends: 5 });
  for (let i = 0; i < 100; i++) prepareSend(a, withGoal(`글 ${i}`));
  const m = syncMeta(a);
  assert.equal(m.prev.length, MAX_PREV);
  assert.equal(m.sends, 105);
  assert.equal(m.prev[0], contentHash(withGoal("같은 글")));
  assert.equal(m.prev[1], contentHash(withGoal("글 37")));
  assert.equal(m.prev.at(-1), contentHash(withGoal("글 99")));
  assert.equal(syncMeta(a, withGoal("x")).hash, contentHash(withGoal("x")));
  // 같은 글을 다시 보내면 그 글은 마지막으로 보낸 차례로 봄(오래전에 처음 보냈어도 남음)
  prepareSend(a, withGoal("글 1"));
  assert.equal(syncMeta(a).prev.at(-1), contentHash(withGoal("글 1")));
  assert.ok(!syncMeta(a).prev.includes(contentHash(withGoal("글 37"))));
  // 번호를 확인하면 그 뒤에 처음 보낸 것이 맨 앞
  const b = tab(0);
  const ok = prepareSend(b, withGoal("확인됨"));
  settle(b, ok.seq, 1);
  for (let i = 0; i < 100; i++) prepareSend(b, withGoal(`뒤 ${i}`));
  const mb = syncMeta(b);
  assert.equal(mb.prev.length, MAX_PREV);
  assert.equal(mb.sends, 100);
  assert.deepEqual(mb.prev.slice(0, 2), [contentHash(withGoal("뒤 0")), contentHash(withGoal("뒤 37"))]);
  assert.equal(mb.prev.at(-1), contentHash(withGoal("뒤 99")));
});

test("결과를 모르는 저장이 64개를 넘은 뒤 81번째가 반영되고 응답이 끊겨도, 한 번 더 실패한 뒤의 저장은 막히지 않는다", () => {
  const row: Row = { revision: 0, content: withGoal("") };
  const a = tab(0);
  for (let i = 1; i <= 80; i++) prepareSend(a, withGoal(`오프라인 ${i}`)); // 모두 서버에 닿지 못함(결과를 모름)
  put(row, prepareSend(a, withGoal("오프라인 81")).body); // 반영됐지만 응답이 끊김
  prepareSend(a, withGoal("오프라인 82")); // 실패
  const s = prepareSend(a, withGoal("오프라인 83"));
  assert.ok(JSON.parse(s.body).prev.length <= MAX_PREV);
  const r = put(row, s.body);
  assert.equal(r.status, 200);
  assert.ok(r.revision! > 1);
  settle(a, s.seq, r.revision!);
  assert.equal(goalOf(row), "오프라인 83");
});

test("내용 지문: 키 순서·JSON 왕복과 상관없이 같고, 칸 글이 하나라도 다르면 다르다", () => {
  const c = withGoal("2학기 평균 90점", 20);
  c.subs[3] = "독서 주 1권";
  const h = contentHash(c);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(contentHash(stored(c) as MandalartContent), h);
  assert.equal(contentHash(JSON.parse(JSON.stringify({ subs: c.subs, actions: c.actions, goal: c.goal, extra: 1 }))), h);
  const d = structuredClone(c);
  d.actions[7][7] = " ";
  assert.notEqual(contentHash(d), h);
  // 칸 경계가 달라지면 이어 붙인 글이 같아도 다르다
  const e1 = emptyContent(), e2 = emptyContent();
  e1.subs[0] = "ab";
  e2.subs[0] = "a";
  e2.subs[1] = "b";
  assert.notEqual(contentHash(e1), contentHash(e2));
  assert.notEqual(contentHash(emptyContent()), contentHash(withGoal(" ")));
});

test("parseSaveMeta·knowsLatest·saveDecision·sameContent", () => {
  assert.deepEqual(parseSaveMeta(null), { revision: null, prev: [], sends: 0, hash: null, horizon: 0 });
  assert.equal(parseSaveMeta({ horizon: 12 }).horizon, 12);
  assert.equal(parseSaveMeta({ horizon: -1 }).horizon, 0);
  assert.equal(parseSaveMeta({ horizon: "9" }).horizon, 0);
  // 새 번호: 보통 1 올리고, horizon이 더 크면 그보다 1 크게(이상하게 큰 값은 MAX_JUMP까지만)
  assert.equal(nextRevision(4, meta({})), 5);
  assert.equal(nextRevision(4, meta({ horizon: 3 })), 5);
  assert.equal(nextRevision(4, meta({ horizon: 9 })), 10);
  assert.equal(nextRevision(4, meta({ horizon: 2 ** 40 })), 4 + MAX_JUMP + 1);
  assert.equal(parseSaveMeta({ revision: -1 }).revision, null);
  assert.equal(parseSaveMeta({ revision: 1.5 }).revision, null);
  assert.equal(parseSaveMeta({ revision: "3" }).revision, null);
  assert.equal(parseSaveMeta({ revision: 0 }).revision, 0);
  const good = withGoal("가");
  const hg = contentHash(good);
  const many = Array.from({ length: MAX_PREV + 10 }, (_, i) => contentHash(withGoal(`${i}`)));
  const parsed = parseSaveMeta({ revision: 2, prev: [{ goal: 1 }, "x", "ABCDEF0123456789", hg, ...many], sends: 3, hash: "zz" });
  assert.equal(parsed.prev.length, MAX_PREV);
  assert.equal(parsed.prev[0], hg);
  assert.equal(parsed.sends, 3);
  assert.equal(parsed.hash, null);
  assert.equal(parseSaveMeta({ sends: -2 }).sends, 0);
  // 번호가 없으면(아주 오래된 화면) 모르는 것으로 본다
  assert.equal(knowsLatest({ revision: 0, content: emptyContent() }, meta({})), false);
  assert.equal(knowsLatest({ revision: 5, content: good }, meta({ revision: 5 })), true);
  assert.equal(knowsLatest({ revision: 6, content: good }, meta({ revision: 5 })), false);
  assert.equal(knowsLatest({ revision: 6, content: good }, meta({ revision: 5, prev: [hg], sends: 1 })), true);
  assert.equal(knowsLatest({ revision: 7, content: good }, meta({ revision: 5, prev: [hg], sends: 1 })), false);
  assert.equal(knowsLatest({ revision: 4, content: good }, meta({ revision: 5, prev: [hg], sends: 1 })), false);
  // 피드백 요청: 화면 글의 지문이 서버 글과 같으면 번호와 상관없이 안다
  assert.equal(knowsLatest({ revision: 9, content: good }, meta({ revision: 1, hash: hg })), true);
  assert.equal(knowsLatest({ revision: 9, content: good }, meta({ revision: 1, hash: contentHash(withGoal("나")) })), false);
  assert.equal(knowsLatest({ revision: 9, content: { goal: "가" } }, meta({ revision: 1, hash: hg })), false);
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 1 }), withGoal("가")), "same");
  // 아는 화면이 같은 글을 보냄: 먼저 보낸 저장이 아직 받아들여질 수 있으면(horizon ≥ 지금 번호) 번호를 올리고, 아니면 그대로
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 9 }), withGoal("가")), "same");
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 9, horizon: 8 }), withGoal("가")), "same");
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 9, horizon: 9 }), withGoal("가")), "save");
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 8, prev: [hg], sends: 1, horizon: 9 }), withGoal("가")), "save");
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 8, prev: [hg], sends: 1, horizon: 8 }), withGoal("가")), "same");
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 9 }), withGoal("나")), "save");
  assert.equal(saveDecision({ revision: 9, content: good }, meta({ revision: 8 }), withGoal("나")), "stale");
  assert.equal(sameContent(good, structuredClone(good)), true);
  const other = structuredClone(good);
  other.actions[3][4] = " ";
  assert.equal(sameContent(good, other), false);
  assert.equal(sameContent(good, { goal: "가" }), false);
});

test("피드백 요청: 다른 기기가 고친 뒤 쓰지 않은 오래된 화면은 모르는 것으로, 저장을 마친 화면은 아는 것으로 본다", () => {
  const row: Row = { revision: 0, content: withGoal("공부 잘하기") };
  const old = tab(0), cur = tab(0);
  const s = prepareSend(cur, withGoal("2학기 평균 90점"));
  settle(cur, s.seq, put(row, s.body).revision!);
  assert.equal(knowsLatest(row, parseSaveMeta(syncMeta(old, withGoal("공부 잘하기")))), false);
  assert.equal(knowsLatest(row, parseSaveMeta(syncMeta(cur, withGoal("2학기 평균 90점")))), true);
});

// ── 규칙 기반 안전 신호 기록 ──
const ORDER = CONCERN_RULES.map((r) => r.kind);
// 칸 글 맞추기를 흉내 낸 가짜 표현 검사(표현 목록이 바뀌어도 기록 규칙 시험은 그대로 돌게)
const FAKE: Record<string, ConcernKind> = { 위험: "self_harm", 따돌: "bullying", 굶기: "eating" };
const fakeMatch = (text: string): ConcernKind | null => {
  for (const [word, kind] of Object.entries(FAKE)) if (text.includes(word)) return kind;
  return null;
};

// 가짜 표현 검사와 함께 쓰는 칸 글 다듬기(공백만 지움). 서버는 실제 표현 검사의 compactText를 넘깁니다(save-mandalart.ts).
const squeeze = (text: string) => text.replace(/\s+/g, "");

// 저장을 차례로 흉내 냅니다: 저장할 때마다 저장 전·후 칸 글을 비교해 기록을 바꾸고 시각을 새로 적었는지(touch) 돌려줍니다.
function recorder(match: (t: string) => ConcernKind | null = fakeMatch, compact: (t: string) => string = squeeze) {
  const st = { kind: null as ConcernKind | null, current: false, content: emptyContent() };
  return {
    st,
    save(c: MandalartContent): boolean {
      const before: CellMatches = cellMatches(st.content, match, compact);
      const next = nextRuleConcern(st.kind, before, cellMatches(c, match, compact), ORDER);
      st.kind = next.kind;
      st.current = next.current;
      st.content = structuredClone(c);
      return next.touch;
    },
  };
}

test("규칙 신호: 확인 뒤 다른 칸에 새 표현이 생기면(종류가 그대로여도) 시각을 새로 적는다", () => {
  const r = recorder();
  const c = emptyContent();
  c.actions[0][0] = "위험 A";
  assert.equal(r.save(c), true); // 처음 걸림
  // (교사가 '확인했어요'를 누름)
  c.actions[3][2] = "위험 B";
  assert.equal(r.save(c), true); // 같은 종류, 지금도 걸려 있지만 새 표현
  assert.deepEqual([r.st.kind, r.st.current], ["self_harm", true]);
  c.subs[6] = "따돌 C";
  assert.equal(r.save(c), true); // 더 가벼운 종류의 새 표현도 새로 적되 종류는 내리지 않음
  assert.equal(r.st.kind, "self_harm");
});

test("규칙 신호: 같은 글을 다시 저장하거나 옮기기만 하면 시각은 그대로", () => {
  const r = recorder();
  const c = emptyContent();
  c.subs[0] = "위험 하기";
  c.goal = "공부 잘하기";
  assert.equal(r.save(c), true);
  assert.equal(r.save(structuredClone(c)), false); // 그대로 다시 저장
  c.goal = "공부 더 잘하기";
  assert.equal(r.save(c), false); // 다른 칸만 고침
  c.subs[0] = "";
  c.actions[5][5] = "위험 하기";
  assert.equal(r.save(c), false); // 같은 글을 다른 칸으로 옮김
  c.actions[5][5] = "위험  하 기";
  assert.equal(r.save(c), false); // 띄어쓰기만 바꿈
  c.actions[5][5] = "위험 하기 싫다";
  assert.equal(r.save(c), true); // 걸린 표현을 고쳐 씀
});

test("규칙 신호: 걸린 글을 다른 칸에 한 번 더 쓰면(복사) 다시 적고, 옮기거나 하나를 지우는 것은 그대로", () => {
  const r = recorder();
  const c = emptyContent();
  c.subs[0] = "위험 하기";
  assert.equal(r.save(c), true);
  // (교사가 '확인했어요'를 누름)
  c.actions[1][1] = "위험  하기";
  assert.equal(r.save(c), true); // 같은 글을 다른 칸에 복사(띄어쓰기가 달라도 같은 글)
  c.actions[1][1] = "";
  c.actions[2][2] = "위험 하기";
  assert.equal(r.save(c), false); // 복사한 것을 다른 칸으로 옮김(칸 수 그대로)
  c.subs[0] = "";
  assert.equal(r.save(c), false); // 하나를 지움
  assert.deepEqual([r.st.kind, r.st.current], ["self_harm", true]);
  c.subs[3] = "위험 하기";
  c.subs[4] = "위험 하기";
  c.actions[2][2] = "";
  assert.equal(r.save(c), true); // 한 번에 하나 지우고 둘을 씀: 1칸 → 2칸
  const counts = cellMatches(c, fakeMatch, squeeze);
  assert.deepEqual([...counts.values()], [{ kind: "self_harm", count: 2 }]);
});

test("규칙 신호: 더 무거운 종류가 걸리면 올리고 시각을 새로 적으며, 가벼운 것으로 내리지 않는다", () => {
  const r = recorder();
  const c = emptyContent();
  c.subs[1] = "따돌 당함";
  assert.equal(r.save(c), true);
  assert.equal(r.st.kind, "bullying");
  c.subs[2] = "위험";
  assert.equal(r.save(c), true);
  assert.equal(r.st.kind, "self_harm");
  c.subs[2] = "";
  assert.equal(r.save(c), false); // 무거운 칸을 지움: 종류는 그대로, 시각도 그대로
  assert.deepEqual([r.st.kind, r.st.current], ["self_harm", true]);
  // 목록에 없는 종류(AI 쪽 'other')가 남아 있으면 규칙 종류가 더 무겁다
  const m: CellMatches = new Map([["eating\u0000굶기", { kind: "eating" as ConcernKind, count: 1 }]]);
  assert.deepEqual(nextRuleConcern("other", m, m, ORDER), { kind: "eating", current: true, touch: true });
  // 저장 전·후가 같아도 처음 기록하면(표현 목록이 바뀌어 새로 걸림 등) 시각을 적는다
  assert.deepEqual(nextRuleConcern(null, m, m, ORDER), { kind: "eating", current: true, touch: true });
});

test("규칙 신호: 다 지웠다가 다시 쓰면 시각을 새로 적고, 지운 동안에는 지금 걸리지 않음으로 남긴다", () => {
  const r = recorder();
  const c = emptyContent();
  c.goal = "굶기 다이어트";
  assert.equal(r.save(c), true);
  c.goal = "";
  assert.equal(r.save(c), false);
  assert.deepEqual([r.st.kind, r.st.current], ["eating", false]);
  assert.equal(r.save(c), false);
  c.goal = "굶기 다이어트";
  assert.equal(r.save(c), true);
  assert.deepEqual([r.st.kind, r.st.current], ["eating", true]);
});

test("규칙 신호(실제 표현 검사): 따돌림 표현을 확인한 뒤 '죽고 싶다'를 새로 쓰면 다시 표시된다", () => {
  const r = recorder(matchConcernText, compactText);
  const c = emptyContent();
  c.subs[0] = "반에서 따돌림을 당해서 힘들다";
  c.subs[5] = "자해 안 하기";
  assert.equal(r.save(c), true);
  c.subs[5] = "";
  assert.equal(r.save(c), false); // 자해 칸을 지움: 따돌림만 남음(종류는 그대로 자해)
  assert.deepEqual([r.st.kind, r.st.current], ["self_harm", true]);
  // (교사가 '확인했어요'를 누름)
  c.subs[6] = "요즘 죽고 싶다는 생각이 든다";
  assert.equal(r.save(c), true);
});

test("규칙 신호(실제 표현 검사): 확인한 뒤 문장부호·이모지·'ㅠㅠ'만 붙이거나 띄어쓰기만 바꾸면 다시 표시되지 않는다", () => {
  const r = recorder(matchConcernText, compactText);
  const c = emptyContent();
  c.subs[2] = "죽고 싶다";
  assert.equal(r.save(c), true);
  // (교사가 '확인했어요'를 누름)
  for (const v of ["죽고 싶다!", "죽고 싶다…ㅠㅠ", "죽고 싶다 😢", "죽고  싶다?!", "죽.고 싶 다"]) {
    c.subs[2] = v;
    assert.equal(r.save(c), false, v);
  }
  assert.deepEqual([r.st.kind, r.st.current], ["self_harm", true]);
  // 걸린 칸의 낱말을 고쳐 쓰면(검사가 보는 글자가 바뀜) 다시 표시
  c.subs[2] = "정말 죽고 싶다";
  assert.equal(r.save(c), true);
  // 문장부호만 다른 글을 다른 칸에 한 번 더 쓰면 같은 글의 복사(칸 수가 늘어남)로 다시 표시
  c.actions[0][0] = "정말, 죽고 싶다!";
  assert.equal(r.save(c), true);
  // 공백만 지우는 다듬기라면 '!'를 붙이는 것만으로 다시 표시되던 것(고치기 전 동작)
  const old = recorder(matchConcernText, squeeze);
  const d = emptyContent();
  d.subs[2] = "죽고 싶다";
  old.save(d);
  d.subs[2] = "죽고 싶다!";
  assert.equal(old.save(d), true);
});

test("규칙 신호의 무게 순서는 ruleConcern이 대표 종류를 고르는 순서와 같다", () => {
  const c = emptyContent();
  c.subs[0] = "왕따 안 당하기";
  c.subs[1] = "자해 안 하기";
  const both = ruleConcern(c)!;
  assert.equal(both.kind, "self_harm");
  assert.ok(ORDER.indexOf("self_harm") < ORDER.indexOf("bullying"));
});

test("닿지 못한 것이 확실해 잊은 저장이 있어도, 다시 연결된 뒤 보내는 중에 탭을 닫으며 보낸 저장은 거절되지 않는다", () => {
  const row: Row = { revision: 5, content: stored(withGoal("저장된 글")) };
  const s = tab(5);
  // 인터넷이 끊긴 채 자동 저장 X와 화면을 떠날 때의 저장 B가 모두 실패 → 화면은 둘 다 잊습니다.
  const X = prepareSend(s, withGoal("저장된 글 + 1"));
  const B = prepareSend(s, withGoal("저장된 글 + 12"));
  settle(s, X.seq, null);
  settle(s, B.seq, null);
  // 다시 연결: 자동 저장 E를 보내는 중에 탭을 닫아 마지막 저장 F를 보냄.
  const E = prepareSend(s, withGoal("저장된 글 + 12"));
  const F = prepareSend(s, withGoal("저장된 글 + 123"));
  assert.equal(put(row, E.body).status, 200);
  assert.equal(put(row, F.body).status, 200);
  assert.equal(goalOf(row), "저장된 글 + 123");
});
