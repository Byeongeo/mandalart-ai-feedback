import { test } from "node:test";
import assert from "node:assert/strict";
import { CONCERN_RULES, compactText, matchConcernText, ruleConcern, ruleConcernsByKind } from "../src/lib/concern-rules.ts";
import { CONCERN_KIND_KEYS } from "../src/lib/feedback/categories.ts";
import { AI_ERROR_CODES, AI_ERROR_MESSAGES, classifyHttp, errorCodeFromEvent, sanitizeErrorEvent } from "../src/lib/feedback/ai-errors.ts";
import { emptyContent } from "../src/lib/mandalart.ts";
import { GRID_PHRASES, GRID_PREFIXES, HEAD_FLAGGED_BENIGN, KNOWN_FALSE_POSITIVES, KNOWN_MISSES, NEGATIVE, POSITIVE, headMatch } from "./concern-corpus.ts";

// ── 규칙 기반 안전 신호 ──
// 원칙(concern-rules.ts 머리말): 학생 자신의 괴로움을 놓치지 않는 쪽. 예외는 적게, 구절 모양으로만.
// 시험 글은 tests/concern-corpus.ts에 모아 두었습니다(걸릴 글, 걸리면 안 되는 글, 알고 둔 오탐·놓침, b9bca8b와 비교).
const show = (t: string) => `${t} → ${matchConcernText(t)}`;
const corpus = [...POSITIVE.map(([t]) => t), ...NEGATIVE, ...KNOWN_FALSE_POSITIVES.map(([t]) => t), ...KNOWN_MISSES];

test("규칙 안전 신호: 걱정되는 표현은 종류에 맞게 걸린다", () => {
  assert.ok(POSITIVE.length >= 400, "말뭉치가 줄었습니다");
  assert.deepEqual(POSITIVE.filter(([t, k]) => matchConcernText(t) !== k).map(([t, k]) => `${show(t)} (기대: ${k})`), []);
});

test("규칙 안전 신호: 평범한 목표·실천·하소연은 걸리지 않는다", () => {
  assert.ok(NEGATIVE.length >= 300, "말뭉치가 줄었습니다");
  assert.deepEqual([...NEGATIVE, "", "   ", "!!!"].filter((t) => matchConcernText(t) !== null).map(show), []);
});

test("규칙 안전 신호: 알고 둔 오탐은 일부러 걸리고, 알고 둔 놓침은 AI 신호에 맡긴다", () => {
  assert.deepEqual(KNOWN_FALSE_POSITIVES.filter(([t, k]) => matchConcernText(t) !== k).map(([t, k]) => `${show(t)} (기대: ${k})`), []);
  assert.deepEqual(KNOWN_MISSES.filter((t) => matchConcernText(t) !== null).map(show), []);
  // 같은 글이 두 목록에 들어가지 않게
  assert.equal(new Set(corpus).size, corpus.length, "말뭉치에 같은 글이 두 번 있습니다");
});

test("규칙 안전 신호: b9bca8b가 잡던 글은 따로 적은 무해한 글(HEAD_FLAGGED_BENIGN) 말고는 지금도 잡는다", () => {
  const lost = corpus.filter((t) => headMatch(t) !== null && matchConcernText(t) === null);
  assert.deepEqual(lost.filter((t) => !HEAD_FLAGGED_BENIGN.includes(t)), [], "b9bca8b가 잡던 글을 놓침");
  // 목록이 실제와 맞는지(지금도 잡히거나 b9bca8b가 잡지 않던 글이 남아 있지 않게)
  assert.deepEqual(HEAD_FLAGGED_BENIGN.filter((t) => !lost.includes(t)), []);
  assert.deepEqual(HEAD_FLAGGED_BENIGN.filter((t) => !NEGATIVE.includes(t) && !KNOWN_MISSES.includes(t)), []);
});

test("규칙 안전 신호: 어떤 꾸밈말·주어·때·곳이 앞에 와도 걱정 표현은 그 종류로 걸린다", () => {
  const wrong: string[] = [];
  for (const p of GRID_PREFIXES) for (const [v, k] of GRID_PHRASES) if (matchConcernText(p + v) !== k) wrong.push(`${show(p + v)} (기대: ${k})`);
  assert.deepEqual(wrong, []);
});

test("규칙 안전 신호: 공백·문장부호·기호·모음 자모를 지우고, 자음 줄임말은 남긴다", () => {
  assert.equal(compactText(" 죽 고  싶\t다 "), "죽고싶다");
  assert.equal(compactText("죽.고~싶-다ㅠㅠ!! 😢…"), "죽고싶다");
  assert.equal(compactText("“사라지고” 싶다^^ ㅋㅋㅎㅎ ❤️"), "사라지고싶다");
  assert.equal(compactText("ㅈㄱㅅㄷ ㅜㅜ"), "ㅈㄱㅅㄷ");
  // 한글 채움 문자(빈칸처럼 보이는 글자)와 따로 쓴 자모(NFD)도 다듬음
  assert.equal(compactText("죽고\u3164싶다"), "죽고싶다");
  assert.equal(compactText("죽고싶다".normalize("NFD")), "죽고싶다");
  for (const t of ["죽_고_싶_다", "자.해", "살기 싫다!!!", "ㅈㄱㅅㄷ", "죽고 싶다 ㅠㅠㅠ", "사라지고~싶어~"]) assert.equal(matchConcernText(t), "self_harm", t);
});

test("규칙 안전 신호: 정해진 순서(자해 > 학대 > 따돌림 > 폭력 > 섭식)", () => {
  assert.deepEqual(CONCERN_RULES.map((r) => r.kind), ["self_harm", "abuse", "bullying", "violence", "eating"]);
});

test("규칙 안전 신호: 저장할 때마다 돌아도 빠르다(무작위 40자 1만 칸, 아주 긴 글)", () => {
  // 걱정 표현 조각이 자주 섞이도록 고른 글자들(되돌아가며 찾기가 길어지는 정규식이 있으면 여기서 느려짐)
  const pool = [..."가나다라마바사아자차카타파하는은이가를을에서도만고싶죽사라지없어졌으면좋겠내제저나왕따당친구애들괴롭힘놀림때려맞아빠엄한테살기싫끝내토굶요즘그냥진짜다 "];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cells = Array.from({ length: 10_000 }, () => Array.from({ length: 40 }, () => pool[Math.floor(rand() * pool.length)]).join(""));
  let t0 = performance.now();
  for (const c of cells) matchConcernText(c);
  const random = performance.now() - t0;
  assert.ok(random < 3000, `무작위 1만 칸: ${random.toFixed(0)}ms`);
  const long = ["그냥 학교에서 친구가 나는 왕따 당하는 ".repeat(80), "나는".repeat(800), "에서".repeat(800), "가".repeat(1600), "친구가 ".repeat(400)];
  t0 = performance.now();
  for (let i = 0; i < 50; i++) for (const s of long) matchConcernText(s + i);
  const slow = performance.now() - t0;
  assert.ok(slow < 3000, `1600자 안팎 글 250번: ${slow.toFixed(0)}ms`);
});

test("규칙 안전 신호: 칸마다 따로 검사한다", () => {
  const c = emptyContent();
  // 칸을 이어 붙이면 '…다 / 끝내고 싶다'처럼 엉뚱하게 걸릴 수 있으므로 칸마다 봅니다.
  c.subs[0] = "그냥 다";
  c.subs[1] = "끝내고 싶은 일 정리";
  c.actions[0][0] = "숙제 다 끝내고 싶다";
  assert.equal(ruleConcern(c), null);
});

test("규칙 안전 신호: 걸린 칸들과 가장 앞 순위 종류를 돌려준다", () => {
  const c = emptyContent();
  assert.equal(ruleConcern(c), null);
  c.goal = "건강해지기";
  c.actions[2][5] = "먹고 토하지 않기";
  c.subs[3] = "왕따 안 당하기";
  const r = ruleConcern(c);
  assert.ok(r);
  // 순서: self_harm > abuse > bullying > violence > eating
  assert.equal(r.kind, "bullying");
  assert.deepEqual(r.cells, [{ kind: "sub", sub: 3 }, { kind: "action", sub: 2, action: 5 }]);
  c.goal = "살기 싫다";
  assert.equal(ruleConcern(c)?.kind, "self_harm");
  assert.deepEqual(ruleConcern(c)?.cells[0], { kind: "goal" });
});

test("규칙 안전 신호: 교사 화면은 지금 글에서 걸린 종류마다 그 종류의 칸만 받는다", () => {
  const c = emptyContent();
  assert.deepEqual(ruleConcernsByKind(c), []);
  c.actions[0][0] = "죽고 싶다";
  c.actions[2][1] = "반에서 따돌림 당하지 않기";
  c.subs[4] = "먹고 토하지 않기";
  assert.deepEqual(ruleConcernsByKind(c), [
    { kind: "self_harm", cells: [{ kind: "action", sub: 0, action: 0 }] },
    { kind: "bullying", cells: [{ kind: "action", sub: 2, action: 1 }] },
    { kind: "eating", cells: [{ kind: "sub", sub: 4 }] },
  ]);
  // 자해 표현을 지우고 따돌림 표현만 남으면 지금 글의 종류는 따돌림뿐(기록된 '가장 무거운 종류'와 다를 수 있음)
  c.actions[0][0] = "";
  c.subs[4] = "";
  assert.deepEqual(ruleConcernsByKind(c), [{ kind: "bullying", cells: [{ kind: "action", sub: 2, action: 1 }] }]);
  assert.equal(ruleConcern(c)?.kind, "bullying");
});

test("규칙 안전 신호 종류는 모두 CONCERN_KINDS 안에 있다", () => {
  for (const r of CONCERN_RULES) assert.ok((CONCERN_KIND_KEYS as string[]).includes(r.kind), r.kind);
});

// ── AI 오류 설명 ──
test("AI 오류 분류: OpenRouter 상태 코드와 문구", () => {
  assert.equal(classifyHttp(401, "No auth credentials found"), "auth");
  assert.equal(classifyHttp(402, "Insufficient credits"), "credit");
  assert.equal(classifyHttp(403, "flagged by moderation"), "forbidden");
  assert.equal(classifyHttp(400, "anthropic/claude-x is not a valid model ID"), "model_not_found");
  assert.equal(classifyHttp(404, "Model not found"), "model_not_found");
  assert.equal(classifyHttp(404, "No endpoints found matching your data policy (Zero data retention)"), "no_provider");
  assert.equal(classifyHttp(404, "No endpoints found that can handle the requested parameters"), "no_provider");
  assert.equal(classifyHttp(400, "max_tokens too large"), "bad_request");
  assert.equal(classifyHttp(408, ""), "timeout");
  assert.equal(classifyHttp(429, "Rate limit exceeded"), "rate_limit");
  assert.equal(classifyHttp(502, ""), "server");
  assert.equal(classifyHttp(503, ""), "server");
  assert.equal(classifyHttp(418, ""), "unknown");
});

test("AI 오류 설명: 모든 코드에 한국어 설명이 있고, 기록에서 코드를 읽는다", () => {
  for (const code of AI_ERROR_CODES) assert.ok(AI_ERROR_MESSAGES[code]?.length > 5, code);
  assert.equal(errorCodeFromEvent({ code: "credit", status: 402 }), "credit");
  assert.equal(errorCodeFromEvent({ code: "toString" }), "unknown");
  // 코드가 없는 예전 기록은 글로 짐작
  assert.equal(errorCodeFromEvent({ error: "OpenRouter 401: User not found" }), "auth");
  assert.equal(errorCodeFromEvent({ error: "스키마 불일치: concern" }), "bad_output");
  assert.equal(errorCodeFromEvent({ error: "저장 실패: deadlock" }), "save_failed");
  assert.equal(errorCodeFromEvent(null), "unknown");
});

test("교사 화면용 오류 한 줄에는 학생 글이나 AI 원문이 들어가지 않는다", () => {
  const row = sanitizeErrorEvent({
    created_at: new Date("2026-10-15T01:02:03Z"),
    payload: { code: "refusal", error: "죽고 싶다는 학생 글 인용", detail: "김민준" },
  });
  assert.deepEqual(Object.keys(row).sort(), ["at", "code", "message_ko"]);
  assert.equal(row.at, "2026-10-15T01:02:03.000Z");
  assert.equal(row.code, "refusal");
  assert.ok(!row.message_ko.includes("죽고") && !row.message_ko.includes("김민준"));
});
