import { test } from "node:test";
import assert from "node:assert/strict";
import { BOM, csvCell, kst, toCsv } from "../src/lib/csv.ts";
import {
  EXPORT_TYPES, cardRow, cardsHeader, exportFileName, mandalartHeader, mandalartRow, positionName, safeFileName, stageName,
} from "../src/lib/export.ts";
import { emptyContent } from "../src/lib/mandalart.ts";

test("CSV: 수식으로 읽힐 글자 칸은 작은따옴표를 붙이고 따옴표로 감쌉니다", () => {
  assert.equal(csvCell("-매일 30분 운동하기"), `"'-매일 30분 운동하기"`);
  assert.equal(csvCell("+1시간 공부"), `"'+1시간 공부"`);
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvCell("@친구"), `"'@친구"`);
  assert.equal(csvCell("\t탭"), `"'\t탭"`);
  assert.equal(csvCell("\r줄"), `"'\r줄"`);
  // 보통 글자는 그대로, 쉼표·따옴표·줄바꿈만 감쌉니다.
  assert.equal(csvCell("줄넘기 300개"), "줄넘기 300개");
  assert.equal(csvCell("a,b"), `"a,b"`);
  assert.equal(csvCell("중간에 - 있음"), "중간에 - 있음");
});

test("CSV: 숫자·참거짓·빈칸은 바꾸지 않습니다", () => {
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(4.5), "4.5");
  assert.equal(csvCell(true), "true");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("CSV: BOM으로 시작하고 줄은 CRLF", () => {
  const s = toCsv(["a", "b"], [[1, "-x"], [null, "y"]]);
  assert.equal(BOM, "﻿");
  assert.ok(s.startsWith("﻿a,b\r\n"));
  assert.equal(s, `﻿a,b\r\n1,"'-x"\r\n,y`);
});

test("시간: 한국 시간 'YYYY-MM-DD HH:MM:SS'", () => {
  assert.equal(kst(new Date("2026-03-02T23:50:00Z")), "2026-03-03 08:50:00");
  assert.equal(kst("2026-03-03T00:35:07.999Z"), "2026-03-03 09:35:07");
  assert.equal(kst(null), null);
  assert.equal(kst("이상한 값"), null);
});

test("교사용 내보내기: 만다라트 한 줄은 머리글과 칸 수가 같고, 학생 글의 수식은 막힙니다", () => {
  const header = mandalartHeader();
  assert.equal(header.length, 9 + 1 + 8 + 64);
  assert.equal(header[0], "번호");
  assert.equal(header[1], "이름");
  assert.ok(!header.some((h) => /PIN/i.test(h)), "PIN 열이 없어야 함");
  assert.ok(!header.some((h) => /안전|신호|⚠/.test(h)), "안전 신호 열이 없어야 함");
  const c = emptyContent();
  c.goal = "=SUM(A1)";
  c.actions[7][7] = "마지막 칸";
  const row = mandalartRow({
    number: 3, name: "김민준", status: "submitted", submitted_at: "2026-03-03 09:00:00", updated_at: "2026-03-03 09:00:00",
    rounds: 4, cards: 7, accepted: 5, rejected: 1, content: c,
  });
  assert.equal(row.length, header.length);
  assert.equal(row[2], "제출함");
  assert.equal(row[row.length - 1], "마지막 칸");
  const csv = toCsv(header, [row]);
  assert.ok(csv.includes(`"'=SUM(A1)"`));
  // 아직 들어오지 않은 학생도 같은 칸 수
  const empty = mandalartRow({ number: 4, name: "이서연", status: null, submitted_at: null, updated_at: null, rounds: 0, cards: 0, accepted: 0, rejected: 0, content: null });
  assert.equal(empty.length, header.length);
  assert.equal(empty[2], "들어오지 않음");
});

test("교사용 내보내기: 카드 한 줄", () => {
  const row = cardRow({
    number: 1, name: "김민준", round_no: 2, stage: "block", block_index: 2, attempt: 2, kind: "unresolved",
    target: { kind: "action", sub: 2, action: 4 }, category_label: "실천이 행동이 아니라 다짐", body: "-힌트", action: "reject",
    reason_label: null, reason_text: null, created_at: "2026-03-03 09:00:00", responded_at: null,
  });
  assert.equal(row.length, cardsHeader().length);
  assert.equal(row[3], "블록 ③");
  assert.equal(row[4], "확인 피드백");
  assert.equal(row[5], "아직 해결 안 됨");
  assert.equal(row[6], "③ 실천 5");
  assert.equal(row[9], "안 할래요");
  assert.equal(stageName("core", null), "중심·세부 목표");
  assert.equal(positionName({ kind: "sub", sub: 0 }), "세부 목표 ①");
  assert.equal(positionName({ kind: "whole" }), "전체");
});

test("교사용 내보내기: 파일 이름은 '교사용·이름 포함'이 드러나고 쓸 수 없는 글자는 바뀜", () => {
  assert.deepEqual([...EXPORT_TYPES], ["mandalart", "cards"]);
  assert.equal(exportFileName("2학년 3반", "mandalart", "2026-03-03"), "2학년 3반_만다라트_2026-03-03_교사용_이름포함.csv");
  assert.equal(exportFileName("a/b:c", "cards", "2026-03-03"), "a_b_c_피드백카드_2026-03-03_교사용_이름포함.csv");
  assert.equal(safeFileName("   "), "학급");
});
