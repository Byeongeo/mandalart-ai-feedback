import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  TEACHER_UNLOCK_MINUTES,
  fingerprintMatches,
  generatePin,
  hasPinInput,
  isPin,
  isWeakPin,
  lockMinutes,
  lockedMessage,
  normalizePin,
  pinFingerprint,
  pinMatches,
  studentLoginMatches,
} from "../src/lib/pin.ts";

test("PIN 만들기: 4자리 숫자 문자열이고 쉬운 PIN은 나오지 않음", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 3000; i++) {
    const pin = generatePin();
    assert.match(pin, /^\d{4}$/);
    assert.equal(isWeakPin(pin), false);
    seen.add(pin);
  }
  // 무작위로 고르게 나오는지 대략 확인(3000번에 서로 다른 값이 충분히 많음)
  assert.ok(seen.size > 2000);
});

test("쉬운 PIN 거르기", () => {
  for (const p of ["0000", "1111", "9999", "1234", "4321", "0123", "6789", "9876", "3210", "1212", "9090", "1112", "1222", "2580", "1004"])
    assert.equal(isWeakPin(p), true, p);
  for (const p of ["0472", "8351", "1029", "5718", "0007"]) assert.equal(isWeakPin(p), p === "0007", p);
  assert.equal(isWeakPin("123"), true);
  assert.equal(isWeakPin("12a4"), true);
});

test("PIN 비교: 같을 때만 참, 빈 값·다른 길이·숫자 아님은 거짓", () => {
  assert.equal(pinMatches("0472", "0472"), true);
  assert.equal(pinMatches(" 04 72 ", "0472"), true);
  assert.equal(pinMatches("04-72", "0472"), true);
  assert.equal(pinMatches("0473", "0472"), false);
  assert.equal(pinMatches("472", "0472"), false);
  assert.equal(pinMatches("04720", "0472"), false);
  assert.equal(pinMatches("", "0472"), false);
  assert.equal(pinMatches(undefined, "0472"), false);
  assert.equal(pinMatches(null, "0472"), false);
  assert.equal(pinMatches(472, "0472"), false);
  assert.equal(normalizePin(" 1 2 "), "12");
});

test("저장된 값이 PIN인지: 4자리 숫자만", () => {
  assert.equal(isPin("0472"), true);
  assert.equal(isPin("AB3K7"), false);
  assert.equal(isPin("12345"), false);
  assert.equal(isPin(null), false);
  assert.equal(isPin(undefined), false);
});

test("세션 지문: PIN이 바뀌면 달라지고, PIN 자체는 드러나지 않음", () => {
  const secret = "s".repeat(32);
  const a = pinFingerprint(secret, "0472");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, pinFingerprint(secret, "0472")); // 같은 PIN이면 같은 지문
  assert.notEqual(a, pinFingerprint(secret, "8351")); // PIN을 다시 만들면 다른 지문
  assert.notEqual(a, pinFingerprint("t".repeat(32), "0472")); // 비밀값이 다르면 다른 지문
  assert.ok(!a.includes("0472"));
  // PIN이 없던 학생(null·빈 값)에게 PIN을 만들면 지문이 달라짐
  assert.equal(pinFingerprint(secret, null), pinFingerprint(secret, undefined));
  assert.equal(pinFingerprint(secret, null), pinFingerprint(secret, ""));
  assert.notEqual(pinFingerprint(secret, null), a);
  assert.equal(pinFingerprint(new TextEncoder().encode(secret), "0472"), a); // 바이트 비밀값도 같은 결과
});

test("세션 지문: 이름을 넣으면 이름이 바뀔 때 달라지고, 띄어쓰기만 다른 이름은 같음", () => {
  const secret = "s".repeat(32);
  const a = pinFingerprint(secret, "0472", "김민준");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, pinFingerprint(secret, "0472", "김 민준")); // 띄어쓰기는 무시(normName과 같은 규칙)
  assert.notEqual(a, pinFingerprint(secret, "0472", "이서연")); // 이름을 고치면 기존 세션은 끝남
  assert.notEqual(a, pinFingerprint(secret, "8351", "김민준"));
  assert.notEqual(a, pinFingerprint(secret, "0472")); // 이름 없는 지문과도 다름
  assert.ok(!a.includes("0472"));
});

test("세션 지문: 학급의 '학생 PIN 사용'을 켜거나 끄면 달라진다(그 학급 학생은 모두 다시 로그인)", () => {
  const secret = "s".repeat(32);
  const on = pinFingerprint(secret, "0472", "김민준", true);
  const off = pinFingerprint(secret, "0472", "김민준", false);
  assert.match(off, /^[0-9a-f]{16}$/);
  assert.notEqual(on, off); // 켬 → 끔, 끔 → 켬 모두 지문이 바뀜
  assert.equal(pinFingerprint(secret, "0472", "김민준"), on); // 넣지 않으면 켬(기본)
  // PIN을 끈 학급도 PIN·이름 부분은 그대로 지문에 들어감(PIN 다시 만들기·이름 고치기를 하면 로그아웃)
  assert.notEqual(off, pinFingerprint(secret, "8351", "김민준", false));
  assert.notEqual(off, pinFingerprint(secret, "0472", "이서연", false));
  assert.equal(off, pinFingerprint(secret, "0472", "김 민준", false));
  // PIN이 없는 학생도 끈 학급에서는 지문을 만들 수 있고, 켠 학급의 지문과 다름
  assert.notEqual(pinFingerprint(secret, null, "김민준", false), pinFingerprint(secret, null, "김민준", true));
  assert.ok(!off.includes("0472"));
});

test("세션 지문: PIN을 켠 학급은 이 설정이 생기기 전과 같은 지문(앱을 업데이트해도 로그아웃되지 않음)", () => {
  const secret = "s".repeat(32);
  const before = (pin: string, name: string) =>
    createHmac("sha256", secret).update(`student-pin:${pin}|${name.replace(/\s+/g, "")}`).digest("hex").slice(0, 16);
  assert.equal(pinFingerprint(secret, "0472", "김민준", true), before("0472", "김민준"));
  assert.equal(pinFingerprint(secret, "0472", "김 민준", true), before("0472", "김민준"));
  assert.notEqual(pinFingerprint(secret, "0472", "김민준", false), before("0472", "김민준"));
});

test("학생 로그인 확인: PIN을 켠 학급은 이름과 PIN이 모두 맞아야 함", () => {
  const base = { requirePin: true, storedName: "김민준", storedPin: "0472" };
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: "0472" }), true);
  assert.equal(studentLoginMatches({ ...base, name: "김 민준", pin: "04 72" }), true); // 띄어쓰기는 무시
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: "0473" }), false);
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: "" }), false); // 빈 PIN
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: undefined }), false);
  assert.equal(studentLoginMatches({ ...base, name: "이서연", pin: "0472" }), false);
  // PIN이 아직 없는 학생은 무엇을 넣어도 못 들어옴(선생님이 PIN을 만든 뒤에)
  assert.equal(studentLoginMatches({ ...base, storedPin: null, name: "김민준", pin: "" }), false);
  assert.equal(studentLoginMatches({ ...base, storedPin: null, name: "김민준", pin: "0472" }), false);
});

test("학생 로그인 확인: PIN을 끈 학급은 이름만 맞으면 되고 입력한 PIN은 보지 않음", () => {
  const base = { requirePin: false, storedName: "김민준", storedPin: "0472" };
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: "" }), true);
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: "0472" }), true);
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: "9999" }), true); // 아무 PIN이나 넣어도 무시
  assert.equal(studentLoginMatches({ ...base, name: "김민준", pin: undefined }), true);
  assert.equal(studentLoginMatches({ ...base, name: " 김 민 준 ", pin: "" }), true);
  assert.equal(studentLoginMatches({ ...base, storedPin: null, name: "김민준", pin: "" }), true); // PIN이 없는 학생도
  assert.equal(studentLoginMatches({ ...base, name: "이서연", pin: "0472" }), false); // 이름이 틀리면 PIN이 맞아도 안 됨
  assert.equal(studentLoginMatches({ ...base, name: "김민", pin: "" }), false);
});

test("PIN 칸을 비웠는지: 비었거나 공백·하이픈뿐이면 비운 것(PIN을 쓰는 학급에서 시도 횟수에 넣지 않음)", () => {
  for (const v of ["", " ", "  -  ", "\t", undefined, null, 1234]) assert.equal(hasPinInput(v), false, String(v));
  for (const v of ["0472", "0", "abcd", "04 72", "12"]) assert.equal(hasPinInput(v), true, v);
});

test("세션 지문 비교: 같을 때만 참, 없거나 형식이 다르면 거짓", () => {
  const f = pinFingerprint("s".repeat(32), "0472");
  assert.equal(fingerprintMatches(f, f), true);
  assert.equal(fingerprintMatches(f, pinFingerprint("s".repeat(32), "8351")), false);
  assert.equal(fingerprintMatches(f, undefined), false);
  assert.equal(fingerprintMatches(f, ""), false);
  assert.equal(fingerprintMatches(f, f.slice(0, 15)), false);
  assert.equal(fingerprintMatches(f, 12345), false);
});

test("잠금 시간: 24시간 안에 첫 잠금 10분, 두 번째 60분, 세 번째부터 선생님이 풀 때까지", () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(lockMinutes), [10, 60, TEACHER_UNLOCK_MINUTES, TEACHER_UNLOCK_MINUTES, TEACHER_UNLOCK_MINUTES]);
  assert.equal(TEACHER_UNLOCK_MINUTES, 60 * 24 * 30);
  assert.equal(lockMinutes(-1), 10);
  assert.equal(lockMinutes(Number.NaN), 10);
});

test("잠김 안내 문구: 남은 시간이 짧으면 몇 분 뒤, 길면 선생님께", () => {
  assert.equal(lockedMessage(10), "여러 번 틀려서 잠시 잠겼어요. 10분 뒤에 다시 하거나 선생님께 말씀드리세요.");
  assert.equal(lockedMessage(0.2), "여러 번 틀려서 잠시 잠겼어요. 1분 뒤에 다시 하거나 선생님께 말씀드리세요.");
  assert.ok(lockedMessage(60).includes("60분 뒤"));
  assert.equal(lockedMessage(TEACHER_UNLOCK_MINUTES), "여러 번 틀려서 잠겼어요. 선생님께 풀어 달라고 말씀드리세요.");
  assert.ok(lockedMessage(null).includes("잠시 뒤에"));
});
