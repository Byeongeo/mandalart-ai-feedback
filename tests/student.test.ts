import { test } from "node:test";
import assert from "node:assert/strict";
import { CELL_MAX, GOAL_MAX, SAVE_TIMEOUT_MS, SAVE_WAIT_MS, cellName, clampContent, retryDelay, tooLongCell, tooLongMessage, withRo, withTimeout } from "../src/lib/student.ts";
import { MandalartContent, emptyContent } from "../src/lib/mandalart.ts";
import { hashPassword, loginDelayMs, loginIdKey, verifyPasswordOrDummy } from "../src/lib/password.ts";

test("글자 수 한도: 서버 검사(MandalartContent)와 같다", () => {
  const c = emptyContent();
  c.goal = "가".repeat(GOAL_MAX);
  c.subs[0] = "가".repeat(CELL_MAX);
  c.actions[7][7] = "가".repeat(CELL_MAX);
  assert.ok(MandalartContent.safeParse(c).success);
  c.subs[0] += "가";
  assert.ok(!MandalartContent.safeParse(c).success);
});

test("clampContent: 넘친 글자만 잘라 내고 원본은 그대로 둔다", () => {
  const c = emptyContent();
  c.goal = "목".repeat(GOAL_MAX + 1);
  c.subs[2] = "세".repeat(CELL_MAX + 1);
  c.actions[1][3] = "실".repeat(CELL_MAX + 3);
  c.actions[0][0] = "짧은 글";
  const out = clampContent(c);
  assert.equal(out.goal.length, GOAL_MAX);
  assert.equal(out.subs[2].length, CELL_MAX);
  assert.equal(out.actions[1][3].length, CELL_MAX);
  assert.equal(out.actions[0][0], "짧은 글");
  assert.equal(c.subs[2].length, CELL_MAX + 1);
  assert.ok(MandalartContent.safeParse(out).success);
});

test("tooLongCell: 넘친 첫 칸을 찾고, 형식이 이상하면 null", () => {
  const c = emptyContent();
  assert.equal(tooLongCell(c), null);
  c.actions[1][2] = "가".repeat(CELL_MAX + 1);
  assert.deepEqual(tooLongCell(c), { kind: "action", sub: 1, action: 2 });
  c.subs[4] = "가".repeat(CELL_MAX + 1);
  assert.deepEqual(tooLongCell(c), { kind: "sub", sub: 4 });
  c.goal = "가".repeat(GOAL_MAX + 1);
  assert.deepEqual(tooLongCell(c), { kind: "goal" });
  assert.equal(tooLongCell(null), null);
  assert.equal(tooLongCell("문자열"), null);
  assert.equal(tooLongCell({ subs: "x", actions: [null, 3] }), null);
});

test("칸 이름과 안내 문구", () => {
  assert.equal(cellName({ kind: "goal" }), "중심 목표");
  assert.equal(cellName({ kind: "sub", sub: 1 }), "세부 목표 ②");
  assert.equal(cellName({ kind: "action", sub: 1, action: 2 }), "세부 목표 ②의 실천 3");
  assert.equal(tooLongMessage({ kind: "action", sub: 1, action: 2 }), "세부 목표 ②의 실천 3 칸의 글이 너무 길어요. 40자까지 쓸 수 있어요.");
  assert.ok(tooLongMessage({ kind: "goal" }).includes("60자"));
});

test("withRo: 받침에 따라 로/으로", () => {
  assert.equal(withRo("7번 김민지"), "7번 김민지로");
  assert.equal(withRo("7번 김민준"), "7번 김민준으로");
  assert.equal(withRo("3번 이하늘"), "3번 이하늘로"); // ㄹ받침
  assert.equal(withRo("12번"), "12번으로"); // 이름이 없으면 번호 뒤에 붙음
  assert.equal(withRo("5번 Alex"), "5번 Alex(으)로");
});

test("retryDelay: 점점 길어지다가 30초에서 멈춘다", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelay), [2000, 5000, 10_000, 20_000, 30_000, 30_000]);
});

test("verifyPasswordOrDummy: 없는 아이디는 계산은 하되 항상 실패", async () => {
  const h = await hashPassword("correct horse battery");
  assert.equal(await verifyPasswordOrDummy("correct horse battery", h), true);
  assert.equal(await verifyPasswordOrDummy("wrong", h), false);
  assert.equal(await verifyPasswordOrDummy("correct horse battery", null), false);
  assert.equal(await verifyPasswordOrDummy("", undefined), false);
});

test("withTimeout: 제때 끝나면 그 값, 늦거나 실패하면 대신 값", async () => {
  assert.equal(await withTimeout(Promise.resolve(true), 50, false), true);
  assert.equal(await withTimeout(new Promise<boolean>(() => {}), 20, false), false);
  assert.equal(await withTimeout(Promise.reject(new Error("x")), 50, false), false);
  const late = new Promise<string>((r) => setTimeout(() => r("늦음"), 60));
  assert.equal(await withTimeout(late, 10, "시간 초과"), "시간 초과");
  // 저장 요청을 끊는 시간이 기다리는 시간보다 짧아야 기다림이 끝나기 전에 재시도로 넘어간다.
  assert.ok(SAVE_TIMEOUT_MS < SAVE_WAIT_MS);
});

test("loginDelayMs: 10번까지는 바로, 그다음 2초씩 늘어 15초에서 멈춘다(막지는 않음)", () => {
  assert.deepEqual([0, 1, 10, 11, 12, 17, 18, 100].map(loginDelayMs), [0, 0, 0, 2000, 4000, 14_000, 15_000, 15_000]);
  assert.equal(loginDelayMs(Number.NaN), 0);
});

test("loginIdKey: 공백·대소문자를 무시한 해시이고 원문이 드러나지 않는다", () => {
  const k = loginIdKey("  Teacher01 ", "s".repeat(32));
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, loginIdKey("teacher01", "s".repeat(32)));
  assert.notEqual(k, loginIdKey("teacher02", "s".repeat(32)));
  assert.notEqual(k, loginIdKey("teacher01", "t".repeat(32))); // 비밀값이 다르면 다른 열쇠
  assert.notEqual(k, loginIdKey("teacher01")); // 비밀값이 없으면 SHA-256
  assert.match(loginIdKey("teacher01"), /^[0-9a-f]{64}$/);
  assert.ok(!k.includes("teacher"));
});
