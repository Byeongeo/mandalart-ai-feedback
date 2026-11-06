import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

// 학생 PIN(4자리 숫자). students.pin에 그대로 저장하고, 교사 화면·안내 카드에만 보여 줍니다.
// CSV, event_log, 오류 메시지, AI 프롬프트에는 PIN을 넣지 않습니다.

// 저장된 값이 PIN인지(4자리 숫자). DB에도 같은 규칙의 check 제약(pin ~ '^[0-9]{4}$')이 있습니다.
export function isPin(code: string | null | undefined): code is string {
  return typeof code === "string" && /^\d{4}$/.test(code);
}

// 너무 쉽게 맞힐 수 있는 PIN: 같은 숫자(0000, 1111), 이어지는 숫자(1234, 4321, 0123…), 두 숫자 반복(1212),
// 그리고 자주 쓰는 몇 가지(2580 = 키패드 세로줄, 1004 = 천사 등)
const COMMON = new Set(["2580", "0852", "1004", "0119", "0112", "1122", "1212", "6969", "1357", "2468", "1379"]);

export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (COMMON.has(pin)) return true;
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return true; // 같은 숫자
  const steps = d.slice(1).map((x, i) => x - d[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true; // 이어지는 숫자
  if (d[0] === d[2] && d[1] === d[3]) return true; // 두 숫자 반복(1212, 9090)
  if (d[0] === d[1] && d[1] === d[2]) return true; // 앞 세 자리가 같은 숫자(1112)
  if (d[1] === d[2] && d[2] === d[3]) return true; // 뒤 세 자리가 같은 숫자(1222)
  return false;
}

// 무작위 4자리 PIN('0000'~'9999' 형식, 쉬운 것은 다시 뽑음)
export function generatePin(): string {
  for (;;) {
    const pin = String(randomInt(10_000)).padStart(4, "0");
    if (!isWeakPin(pin)) return pin;
  }
}

// 학생이 입력한 PIN 다듬기: 공백·하이픈을 지웁니다(숫자 사이에 띄어 써도 맞게).
export function normalizePin(input: unknown): string {
  return typeof input === "string" ? input.replace(/[\s-]/g, "") : "";
}

// PIN 칸에 무엇이라도 넣었는지(공백·하이픈만 넣은 것은 비운 것으로 봄).
// PIN을 쓰는 학급에서 PIN 칸을 비워 보낸 로그인은 시도 횟수에 넣지 않습니다(맞혀 본 PIN이 없음. src/app/api/auth/student/route.ts).
export function hasPinInput(input: unknown): boolean {
  return normalizePin(input).length > 0;
}

// 입력한 PIN이 저장된 PIN과 같은지. 길이와 상관없이 같은 시간이 걸리도록 해시끼리 비교합니다.
export function pinMatches(input: unknown, stored: string): boolean {
  const a = createHash("sha256").update(normalizePin(input)).digest();
  const b = createHash("sha256").update(stored).digest();
  return timingSafeEqual(a, b) && normalizePin(input).length > 0;
}

// ── 로그인 세션과 PIN 연결 ──
// 학생 로그인 토큰에는 PIN 자체가 아니라 '지금 PIN(과 이름, 학급의 PIN 설정)의 지문'(비밀값으로 만든 HMAC-SHA256 앞 16자리)만 넣습니다.
// 교사가 PIN을 다시 만들거나 이름을 고치면(명렬표로 그 번호에 다른 학생이 들어온 경우 등) 지문이 달라져,
// 그 전에 로그인한 세션은 더 이상 통하지 않습니다. 이름은 공백을 지우고 비교합니다(roster.ts의 normName과 같은 규칙).
// PIN이 비어 있으면 빈 문자열의 지문을 씁니다. 비밀값 없이는 지문에서 PIN을 거꾸로 찾을 수 없습니다.
//
// requirePin(학급의 '학생 PIN 사용', classes.require_pin)도 지문에 넣습니다. 교사가 PIN을 켜거나 끄면 그 학급 학생의 세션이 모두 끝납니다.
// - PIN을 켜면: PIN 없이(학급 코드·번호·이름만으로) 들어온 세션이 끝나, 다른 학생으로 들어와 있던 친구도 쫓겨납니다.
// - PIN을 끄면: 모두 새로 들어옵니다.
// PIN을 켠 학급의 지문은 이 설정이 생기기 전과 같은 글(`student-pin:PIN|이름`)로 만듭니다. 그래서 앱을 업데이트해도
// 이미 로그인해 있던 학생은 로그아웃되지 않습니다. PIN을 끈 학급은 다른 머리말(`student-pin-off:`)을 써서 두 지문이 겹치지 않습니다.
// (켬 → 끔 → 켬으로 바꾸면 처음 켬 때의 세션이 다시 통할 수 있지만, 그 세션도 PIN으로 들어온 것이라 지금 설정보다 약하지 않습니다.)
export function pinFingerprint(
  secret: string | Uint8Array,
  pin: string | null | undefined,
  name?: string | null,
  requirePin: boolean = true,
): string {
  const tail = name === undefined ? "" : `|${(name ?? "").replace(/\s+/g, "")}`;
  const head = requirePin ? "student-pin:" : "student-pin-off:";
  return createHmac("sha256", secret).update(`${head}${pin ?? ""}${tail}`).digest("hex").slice(0, 16);
}

// 학생 로그인에서 이름(과 PIN)이 맞는지. 이름은 공백을 지우고 비교합니다(roster.ts의 normName과 같은 규칙).
// - requirePin이 true(기본): 저장된 PIN이 있고 입력한 PIN과 같아야 합니다. PIN이 아직 없는 학생은 들어올 수 없습니다.
// - requirePin이 false(학생 PIN을 끈 학급): 입력한 PIN은 보지 않고(무엇을 넣었든) 이름만 맞으면 됩니다.
export function studentLoginMatches(o: {
  requirePin: boolean;
  storedName: string;
  storedPin: string | null | undefined;
  name: string;
  pin: unknown;
}): boolean {
  const nameOk = o.storedName.replace(/\s+/g, "") === o.name.replace(/\s+/g, "");
  if (!o.requirePin) return nameOk;
  // 이름이 틀려도 PIN 비교는 똑같이 합니다(걸리는 시간으로 무엇이 틀렸는지 드러나지 않게).
  const pinOk = isPin(o.storedPin) && pinMatches(o.pin, o.storedPin);
  return nameOk && pinOk;
}

// 토큰의 지문이 지금 DB 값의 지문과 같은지(형식이 이상하거나 없으면 거짓)
export function fingerprintMatches(expected: string, got: unknown): boolean {
  if (typeof got !== "string" || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

// ── 잠금 ──
// 8번 틀리면 잠급니다. 최근 24시간 안에 잠긴 횟수(event_log의 'login_locked')에 따라 점점 길게 잠급니다.
// 선생님이 잠금을 풀거나 PIN을 다시 만들면('login_unlocked') 그 뒤의 잠금만 셉니다(다음 잠금은 다시 10분부터).
// 첫 번째 10분, 두 번째 60분, 세 번째부터는 선생님이 풀어 줄 때까지(30일 뒤로 잡아 둠).
export const MAX_FAILS = 8;
export const LOCK_LOOKBACK_HOURS = 24;
export const TEACHER_UNLOCK_MINUTES = 60 * 24 * 30;

export function lockMinutes(priorLocks24h: number): number {
  const n = Number.isFinite(priorLocks24h) && priorLocks24h > 0 ? Math.floor(priorLocks24h) : 0;
  if (n === 0) return 10;
  if (n === 1) return 60;
  return TEACHER_UNLOCK_MINUTES;
}

// 잠긴 학생에게 보여 줄 문구. minutesLeft는 남은 시간(분)입니다. 2시간이 넘게 남았으면 선생님이 풀어 줘야 하는 잠금입니다.
export function lockedMessage(minutesLeft: number | null | undefined): string {
  const m = typeof minutesLeft === "number" && Number.isFinite(minutesLeft) ? Math.max(1, Math.ceil(minutesLeft)) : null;
  if (m === null) return "여러 번 틀려서 잠겼어요. 잠시 뒤에 다시 하거나 선생님께 말씀드리세요.";
  if (m > 120) return "여러 번 틀려서 잠겼어요. 선생님께 풀어 달라고 말씀드리세요.";
  return `여러 번 틀려서 잠시 잠겼어요. ${m}분 뒤에 다시 하거나 선생님께 말씀드리세요.`;
}
