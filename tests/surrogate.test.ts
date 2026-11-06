import { test } from "node:test";
import assert from "node:assert/strict";
import { CELL_MAX, GOAL_MAX, clampContent, clampText, tooLongCell, wellFormed, wellFormedContent } from "../src/lib/student.ts";
import { MandalartContent, emptyContent } from "../src/lib/mandalart.ts";
import { contentHash } from "../src/lib/save-rules.ts";

// 반쪽 글자(짝 없는 UTF-16 서로게이트)가 남아 있는지. DB(jsonb)는 이런 글을 받지 않습니다(22P02).
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test("clampText: 한도에서 이모지를 반으로 자르지 않는다(글자 수는 UTF-16 셈)", () => {
  const cell = "가" + "나".repeat(38) + "😀"; // 41칸: 한글 조합 중 이모지를 넣어 한도를 넘음
  assert.equal(cell.length, CELL_MAX + 1);
  const out = clampText(cell, CELL_MAX);
  assert.equal(out, "가" + "나".repeat(38)); // 이모지를 통째로 뺌
  assert.ok(!LONE.test(out));
  // 이모지가 한도 안에 온전히 들어가면 그대로
  assert.equal(clampText("가".repeat(38) + "😀", CELL_MAX), "가".repeat(38) + "😀");
  assert.equal(clampText("가".repeat(38) + "😀x", CELL_MAX), "가".repeat(38) + "😀");
  // 한도 안이면 손대지 않음
  assert.equal(clampText("짧은 글", CELL_MAX), "짧은 글");
  // 여러 이모지(👍🏽 피부색, 가족 이모지)도 반쪽이 남지 않음
  for (const e of ["👍🏽", "👨‍👩‍👧", "🇰🇷"]) {
    for (let pad = 30; pad <= 40; pad++) {
      const v = clampText("가".repeat(pad) + e + e, CELL_MAX);
      assert.ok(v.length <= CELL_MAX);
      assert.ok(!LONE.test(v), `${e} ${pad}`);
    }
  }
});

test("wellFormed: 짝 없는 반쪽 글자만 '�'로 바꾸고 글자 수는 그대로", () => {
  assert.equal(wellFormed("a\ud83db"), "a�b");
  assert.equal(wellFormed("\udc00x"), "�x");
  assert.equal(wellFormed("x\ud83d"), "x�");
  assert.equal(wellFormed("\ude00\ud83d"), "��");
  assert.equal(wellFormed("😀 공부 👍🏽"), "😀 공부 👍🏽");
  const plain = "그대로인 글";
  assert.equal(wellFormed(plain), plain);
  const broken = "가".repeat(39) + "\ud83d";
  assert.equal(wellFormed(broken).length, broken.length);
});

test("clampContent·wellFormedContent: 저장할 내용에 반쪽 글자가 남지 않고 서버 검사를 통과한다", () => {
  const c = emptyContent();
  c.goal = "목".repeat(GOAL_MAX - 1) + "😀"; // 61칸
  c.subs[3] = "세".repeat(CELL_MAX - 1) + "🎯";
  c.actions[2][5] = "\ud83d반쪽"; // 이미 깨진 글(옛 화면이 잘라 보낸 것 등)
  c.actions[7][7] = "운동 💪";
  const out = clampContent(c);
  assert.equal(out.goal, "목".repeat(GOAL_MAX - 1));
  assert.equal(out.subs[3], "세".repeat(CELL_MAX - 1));
  assert.equal(out.actions[2][5], "�반쪽");
  assert.equal(out.actions[7][7], "운동 💪");
  assert.ok(MandalartContent.safeParse(out).success);
  assert.ok(![out.goal, ...out.subs, ...out.actions.flat()].some((x) => LONE.test(x)));
  // JSON으로 보내도 짝 없는 \ud83d 같은 이스케이프가 생기지 않음(DB가 받지 않는 글)
  assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(JSON.stringify(out)));
  // 서버도 같은 방법으로 고치므로(save-mandalart.ts) 화면과 서버의 내용 지문이 같다
  assert.equal(contentHash(wellFormedContent(c)), contentHash(wellFormedContent(wellFormedContent(c))));
  // 한도까지 잘랐지만 반쪽 글자는 고치지 않은 글(예전 화면처럼 slice로 자름)을 받아도 서버 검사를 통과하고, 서버가 고쳐 저장한다
  const sent = { ...c, goal: c.goal.slice(0, GOAL_MAX), subs: c.subs.map((s) => s.slice(0, CELL_MAX)) };
  assert.ok(LONE.test(sent.goal));
  const server = wellFormedContent(MandalartContent.parse(JSON.parse(JSON.stringify(sent))));
  assert.equal(server.actions[2][5], "�반쪽");
  assert.equal(server.goal, "목".repeat(GOAL_MAX - 1) + "�");
  // 원본은 바꾸지 않음
  assert.equal(c.actions[2][5], "\ud83d반쪽");
});

test("글자 수 한도: 서버 검사(MandalartContent)·tooLongCell·clampText가 모두 UTF-16 셈으로 같은 한도를 쓴다", () => {
  const cases: { cell: string; over: boolean }[] = [
    { cell: "😀".repeat(20), over: false }, // 40칸 = 이모지 20개
    { cell: "😀".repeat(21), over: true }, // 42칸(코드 포인트로는 21개)
    { cell: "😀".repeat(40), over: true }, // 80칸(코드 포인트로는 40개: 예전 서버 검사는 받았음)
    { cell: "가".repeat(39) + "😀", over: true }, // 41칸
    { cell: "가".repeat(38) + "😀", over: false }, // 40칸
    { cell: "가".repeat(40), over: false },
    { cell: "가".repeat(41), over: true },
  ];
  for (const { cell, over } of cases) {
    const c = emptyContent();
    c.subs[5] = cell;
    assert.equal(!MandalartContent.safeParse(c).success, over, `서버 검사 ${cell.length}칸`);
    assert.deepEqual(tooLongCell(c), over ? { kind: "sub", sub: 5 } : null, `tooLongCell ${cell.length}칸`);
    assert.equal(clampText(cell, CELL_MAX) !== cell, over, `clampText ${cell.length}칸`);
    // 화면이 잘라 보낸 글은 언제나 서버 검사를 통과
    c.subs[5] = clampText(cell, CELL_MAX);
    assert.ok(MandalartContent.safeParse(c).success);
  }
  // 중심 목표(60칸)와 실천 칸도 같음
  const g = emptyContent();
  g.goal = "목".repeat(GOAL_MAX - 1) + "😀"; // 61칸, 코드 포인트 60개
  assert.equal(MandalartContent.safeParse(g).success, false);
  assert.deepEqual(tooLongCell(g), { kind: "goal" });
  g.goal = clampText(g.goal, GOAL_MAX);
  g.actions[6][1] = "실".repeat(CELL_MAX - 1) + "💪";
  assert.equal(MandalartContent.safeParse(g).success, false);
  assert.deepEqual(tooLongCell(g), { kind: "action", sub: 6, action: 1 });
  assert.ok(MandalartContent.safeParse(clampContent(g)).success);
});
