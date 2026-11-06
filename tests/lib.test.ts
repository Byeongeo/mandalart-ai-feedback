import { test } from "node:test";
import assert from "node:assert/strict";
import { Roster, parseRoster, readRenames, renameWarning, rosterDiff, rosterRenames } from "../src/lib/roster.ts";
import { emptyContent, inStage, stageNotReady, zeroCardMessage } from "../src/lib/mandalart.ts";

test("명렬표: 엑셀 붙여넣기(탭)와 머리글, 세 번째 열부터는 무시", () => {
  const r = parseRoster("번호\t이름\t비고\n1\t김민준\t동의\n2\t이서연\n3\t박 지호\tO");
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.rows, [{ number: 1, name: "김민준" }, { number: 2, name: "이서연" }, { number: 3, name: "박 지호" }]);
});

test("명렬표: CSV, BOM, 빈 줄, 따옴표", () => {
  const r = parseRoster("﻿번호,이름\r\n\r\n12,\"김민준\"\r\n13,이서연,\r\n");
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.rows.map((x) => [x.number, x.name]), [[12, "김민준"], [13, "이서연"]]);
});

test("명렬표: 번호 중복·숫자 아님·이름 빈칸 오류", () => {
  assert.ok(parseRoster("1,김민준\n1,이서연").errors.some((e) => e.includes("중복")));
  assert.ok(parseRoster("1,김민준\n가,이서연").errors.some((e) => e.includes("숫자가 아닙니다")));
  assert.ok(parseRoster("1,김민준\n2,").errors.some((e) => e.includes("이름이 비어")));
  // 서버 검사(Roster)도 같은 규칙
  assert.equal(Roster.safeParse([{ number: 1, name: "가" }, { number: 1, name: "나" }]).success, false);
  assert.equal(Roster.safeParse([]).success, false);
  assert.equal(Roster.safeParse(Array.from({ length: 46 }, (_, i) => ({ number: i + 1, name: "가" }))).success, false);
  assert.equal(Roster.safeParse([{ number: 100, name: "가" }]).success, false);
});

test("명렬표 다시 올리기: 추가·이름 변경·빠진 번호", () => {
  const current = [
    { number: 1, name: "김민준" },
    { number: 2, name: "이서연" },
    { number: 3, name: "박지호" },
    { number: 4, name: "최유나" },
  ];
  const { rows } = parseRoster("1\t김민준\n2\t이 서연\n3\t박지후\n5\t전학생");
  const d = rosterDiff(rows, current);
  assert.deepEqual(d.added, [5]);
  assert.deepEqual(d.renamed, [3]);
  assert.deepEqual(d.missing, [4]);
  // 아직 글이 없는 학급은 이름 변경을 따로 확인하지 않습니다.
  assert.equal(d.renameNeedsConfirm, false);
  assert.equal(rosterDiff(rows, current, { classHasWork: true }).renameNeedsConfirm, true);
});

test("명렬표 다시 올리기: 번호가 밀린 명렬표 경고 문구", () => {
  const current = [
    { number: 4, name: "최유나" },
    { number: 5, name: "전출생" },
    { number: 6, name: "한지민" },
    { number: 7, name: "오세훈" },
  ];
  // 5번이 전출하고 6·7번이 한 칸씩 앞당겨진 명렬표
  const { rows } = parseRoster("4\t최유나\n5\t한지민\n6\t오세훈");
  const d = rosterDiff(rows, current, { classHasWork: true });
  assert.deepEqual(d.missing, [7]);
  assert.deepEqual(d.renamed, [5, 6]);
  assert.deepEqual(d.renames[0], { number: 5, from: "전출생", to: "한지민" });
  const w = renameWarning(d.renames, d.missing);
  assert.match(w, /5번: 전출생 → 한지민/);
  assert.match(w, /번호에 그대로 남습니다/);
  assert.match(w, /명렬표에 없는 번호\(7\)/);
});

test("명렬표 다시 올리기: 서버와 같은 이름 변경 판정(rosterRenames)과 409 응답 읽기", () => {
  const current = [
    { number: 1, name: "김민준" },
    { number: 2, name: null },
    { number: 3, name: "박지호" },
  ];
  // 공백만 다른 이름은 바뀐 것이 아님. 새 번호(4)는 이름 변경이 아님. 이름이 비어 있던 번호는 바뀐 것으로 봄
  const { rows } = parseRoster("1\t김 민준\n2\t이서연\n3\t박지후\n4\t전학생");
  const renames = rosterRenames(rows, current);
  assert.deepEqual(renames, [{ number: 2, from: "", to: "이서연" }, { number: 3, from: "박지호", to: "박지후" }]);
  assert.deepEqual(rosterDiff(rows, current).renames, renames);
  assert.deepEqual(readRenames(JSON.parse(JSON.stringify(renames))), renames);
  assert.deepEqual(readRenames([{ number: "3", from: "a", to: "b" }, null, { number: 5, from: "가", to: "나" }]), [{ number: 5, from: "가", to: "나" }]);
  assert.deepEqual(readRenames(undefined), []);
});

test("단계 준비 조건", () => {
  const c = emptyContent();
  assert.match(stageNotReady({ kind: "core" }, c)!, /중심 목표/);
  c.goal = "목표";
  c.subs = Array(8).fill("영역");
  assert.equal(stageNotReady({ kind: "core" }, c), null);
  c.actions[2] = ["a", "b", "c", "d", "e", "", "", ""];
  assert.match(stageNotReady({ kind: "block", index: 2 }, c)!, /6개 이상/);
  c.actions[2][5] = "f";
  assert.equal(stageNotReady({ kind: "block", index: 2 }, c), null);
  assert.equal(inStage({ kind: "action", sub: 2, action: 0 }, { kind: "block", index: 2 }), true);
  assert.equal(inStage({ kind: "action", sub: 3, action: 0 }, { kind: "block", index: 2 }), false);
  assert.equal(inStage({ kind: "goal" }, { kind: "block", index: 2 }), false);
});

test("카드 없는 첫 피드백 문구: 쓰는 중에는 다음 할 일까지, 볼 수만 있을 때(제출 뒤·학급 닫힘)는 앞부분만", () => {
  const head = "AI가 보기에 이 단계에는 고칠 점이 없어요. 잘 썼어요!";
  assert.equal(zeroCardMessage("core", false), `${head} 한 번 더 읽어 보고 다음 단계로 넘어가세요.`);
  assert.equal(zeroCardMessage("block", false), `${head} 한 번 더 읽어 보고 다음 단계로 넘어가세요.`);
  assert.equal(zeroCardMessage("whole", false), `${head} 한 번 더 읽어 보고 제출해도 좋아요.`);
  for (const stage of ["core", "block", "whole"] as const) {
    assert.equal(zeroCardMessage(stage, true), head);
    assert.doesNotMatch(zeroCardMessage(stage, true), /넘어가|제출/);
  }
});
