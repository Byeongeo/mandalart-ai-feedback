import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import {
  categoryFits, cellChanged, changedPartners, duplicateRemains, emptyContent, normalizeCell, partnerTargets, recheckKind, stageDone, stageProgress, targetKey,
} from "../src/lib/mandalart.ts";
import { AI_ERROR_MESSAGES, noMatchingProviderMessage } from "../src/lib/feedback/ai-errors.ts";
import { CARDS_PER_STAGE } from "../src/lib/feedback/categories.ts";
import { SCHOOL_LEVEL_KEYS, roundSchoolLevel } from "../src/lib/school-level.ts";
import { createHash } from "node:crypto";

// 서버 전용 모듈(import "server-only", 확장자 없는 상대 경로)을 테스트에서 불러오기 위한 설정
type Resolved = { url: string; shortCircuit?: boolean };
(nodeModule as unknown as {
  registerHooks(h: { resolve(s: string, c: object, next: (s: string, c: object) => Resolved): Resolved }): void;
}).registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
// AI 설정은 부를 때마다 환경 변수에서 읽고, 모의 모드 여부만 불러올 때 정해집니다.
delete process.env.FEEDBACK_MOCK;
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_BASE_URL = "http://openrouter.test/api/v1";
const { ruleDiagnose, aiDiagnose, diagnosisSystem } = await import("../src/lib/feedback/diagnose.ts");
const { selectItems, aiCards, cardSystem } = await import("../src/lib/feedback/cards.ts");
const { checkAi, DEFAULT_MODEL } = await import("../src/lib/feedback/client.ts");

test("칸 비교: 띄어쓰기만 바꾼 것은 고친 것이 아님", () => {
  assert.equal(normalizeCell("  열심히   공부하기 "), "열심히 공부하기");
  const a = emptyContent();
  const b = emptyContent();
  a.actions[0][0] = "열심히 공부하기";
  b.actions[0][0] = "열심히 공부하기 ";
  const t = { kind: "action", sub: 0, action: 0 } as const;
  assert.equal(cellChanged(a, b, t), false);
  // 띄어쓰기를 빼거나 대소문자만 바꾼 것도 고친 것이 아님
  b.actions[0][0] = "열심히공부하기";
  assert.equal(cellChanged(a, b, t), false);
  b.actions[0][0] = "매일 수학 문제 5개 풀기";
  assert.equal(cellChanged(a, b, t), true);
  // 빈칸에 공백만 넣은 것도 고친 것이 아님
  const c = emptyContent();
  c.actions[0][6] = " ";
  assert.equal(cellChanged(a, c, { kind: "action", sub: 0, action: 6 }), false);
});

test("전체(whole) 대상 카드는 어느 칸이든 바뀌면 바뀐 것", () => {
  const a = emptyContent();
  const b = emptyContent();
  assert.equal(cellChanged(a, b, { kind: "whole" }), false);
  b.actions[1][0] = "다른 블록";
  assert.equal(cellChanged(a, b, { kind: "whole" }), true);
});

test("단계 완료: 첫 피드백 카드를 모두 거부하면 끝난 것으로 봄", () => {
  assert.equal(stageDone([], 2), false);
  assert.equal(stageDone([{ attempt: 1, n_cards: 0, n_rejected: 0 }], 2), true);
  assert.equal(stageDone([{ attempt: 1, n_cards: 2, n_rejected: 0 }], 2), false);
  assert.equal(stageDone([{ attempt: 1, n_cards: 2, n_rejected: 1 }], 2), false);
  assert.equal(stageDone([{ attempt: 1, n_cards: 2, n_rejected: 2 }], 2), true);
  assert.equal(stageDone([{ attempt: 1, n_cards: 2, n_rejected: 0 }, { attempt: 2, n_cards: 1, n_rejected: 0 }], 2), true);
  // 교사가 회차를 1번으로 줄였으면 첫 피드백만으로 끝
  assert.equal(stageDone([{ attempt: 1, n_cards: 2, n_rejected: 0 }], 1), true);
});

test("확인 피드백 판정: 그 칸이나 짝 칸을 고쳐야 해결", () => {
  const k = (o: Partial<{ targetChanged: boolean; partnerChanged: boolean; stillThere: boolean; accepted: boolean }>) =>
    recheckKind({ targetChanged: false, partnerChanged: false, stillThere: false, accepted: false, ...o });
  // 그 칸을 고쳤고 문제가 사라짐 → 해결, 남음 → 아직
  assert.equal(k({ targetChanged: true }), "resolved");
  assert.equal(k({ targetChanged: true, stillThere: true }), "unresolved");
  // 짝 칸(중복의 다른 칸 등)을 고쳐 문제가 사라짐 → 해결
  assert.equal(k({ partnerChanged: true }), "resolved");
  // 손대지 않았는데 진단에서 빠짐: '해 볼게요'였으면 아직, 아니면 보여 주지 않음
  assert.equal(k({ accepted: true }), "unresolved");
  assert.equal(k({}), null);
  // 문제가 남았고 고치지도 받아들이지도 않음 → 보여 주지 않음
  assert.equal(k({ stillThere: true }), null);
  assert.equal(k({ stillThere: true, accepted: true }), "unresolved");
});

test("짝 칸: 중복은 1회차에 같은 글이던 칸, 연결 약함은 위 목표", () => {
  const c = emptyContent();
  c.goal = "1년 안에 성적 올리기";
  c.subs[2] = "운동";
  c.actions[0][0] = "독서 30분";
  c.actions[0][1] = "독서  30분";
  c.actions[3][5] = "독서 30분";
  c.actions[0][2] = "수학 문제 5개";
  const dup = partnerTargets("DUPLICATE", { kind: "action", sub: 0, action: 1 }, c).map(targetKey);
  assert.deepEqual(dup, ["action:0:0", "action:3:5"]);
  assert.deepEqual(partnerTargets("ACTION_MISALIGNED", { kind: "action", sub: 2, action: 3 }, c).map(targetKey), ["sub:2"]);
  assert.deepEqual(partnerTargets("SUB_MISALIGNED", { kind: "sub", sub: 2 }, c).map(targetKey), ["goal"]);
  assert.equal(partnerTargets("SUB_OVERLAP", { kind: "sub", sub: 2 }, c).length, 7);
  // 짝 칸이 없는 범주: 다른 칸을 고쳐도 해결로 치지 않음
  assert.deepEqual(partnerTargets("ACTION_NOT_ACTIONABLE", { kind: "action", sub: 0, action: 2 }, c), []);
  assert.deepEqual(partnerTargets("GOAL_VAGUE", { kind: "goal" }, c), []);
});

test("AI 진단 범주와 칸 종류·단계가 맞아야 함", () => {
  const block = { kind: "block", index: 4 } as const;
  const core = { kind: "core" } as const;
  const whole = { kind: "whole" } as const;
  assert.equal(categoryFits("SUB_MISALIGNED", { kind: "action", sub: 4, action: 2 }, block), false);
  assert.equal(categoryFits("ACTION_NOT_ACTIONABLE", { kind: "action", sub: 4, action: 2 }, block), true);
  assert.equal(categoryFits("ACTION_NOT_ACTIONABLE", { kind: "action", sub: 3, action: 2 }, block), false);
  assert.equal(categoryFits("ACTION_MISALIGNED", { kind: "sub", sub: 1 }, core), false);
  assert.equal(categoryFits("GOAL_VAGUE", { kind: "goal" }, core), true);
  assert.equal(categoryFits("GOAL_VAGUE", { kind: "sub", sub: 0 }, core), false);
  assert.equal(categoryFits("UNBALANCED", { kind: "whole" }, core), false);
  assert.equal(categoryFits("UNBALANCED", { kind: "whole" }, whole), true);
  assert.equal(categoryFits("UNBALANCED", { kind: "goal" }, whole), false);
  assert.equal(categoryFits("ACTION_MISALIGNED", { kind: "action", sub: 0, action: 0 }, whole), true);
  assert.equal(categoryFits("NOT_A_CATEGORY", { kind: "goal" }, whole), false);
});

test("반복이 남았는지는 칸 위치가 아니라 글로 판단", () => {
  const c = emptyContent();
  c.actions[0][2] = "단어장 복습";
  c.actions[1][3] = "단어장 복습";
  c.actions[2][4] = "단어장  복습";
  // [1][3]에 카드, 학생은 [0][2]만 고침 → [1][3]은 아직 [2][4]와 같음
  c.actions[0][2] = "영어 듣기 20분";
  assert.equal(duplicateRemains(c, { kind: "action", sub: 1, action: 3 }), true);
  c.actions[2][4] = "수학 오답 정리";
  assert.equal(duplicateRemains(c, { kind: "action", sub: 1, action: 3 }), false);
  // 세부 목표는 세부 목표끼리만
  c.subs[1] = "건강";
  c.subs[5] = "건강";
  assert.equal(duplicateRemains(c, { kind: "sub", sub: 5 }), true);
  assert.equal(duplicateRemains(c, { kind: "action", sub: 1, action: 3 }), false);
});

test("짝 칸을 지우기만 한 것은 고친 짝 칸이 아님", () => {
  const first = emptyContent();
  first.actions[0][0] = "독서 30분";
  first.actions[0][1] = "독서 30분";
  const now = structuredClone(first);
  now.actions[0][0] = "";
  const t = { kind: "action", sub: 0, action: 1 } as const;
  assert.deepEqual(changedPartners("DUPLICATE", t, first, now), []);
  now.actions[0][0] = "줄넘기 100번";
  assert.deepEqual(changedPartners("DUPLICATE", t, first, now).map(targetKey), ["action:0:0"]);
});

test("단계 진행: 중심·블록·전체를 회차 요약으로 셈", () => {
  const r = (stage: "core" | "block" | "whole", block_index: number | null, attempt: number, n_cards: number, n_rejected = 0) =>
    ({ stage, block_index, attempt, n_cards, n_rejected });
  assert.deepEqual(stageProgress([], 2), { coreDone: false, blocksDone: 0, wholeDone: false });
  const rounds = [
    r("core", null, 1, 2), r("core", null, 2, 1),
    r("block", 0, 1, 0), // 카드 없음 → 끝
    r("block", 1, 1, 2, 2), // 모두 거부 → 끝
    r("block", 2, 1, 3), // 확인 피드백 전
  ];
  assert.deepEqual(stageProgress(rounds, 2), { coreDone: true, blocksDone: 2, wholeDone: false });
  // 학급 설정이 1회면 첫 피드백만으로 끝
  assert.deepEqual(stageProgress(rounds, 1), { coreDone: true, blocksDone: 3, wholeDone: false });
  assert.equal(stageProgress([...rounds, r("whole", null, 1, 0)], 2).wholeDone, true);
});

// ── 규칙 진단: 실천 빈칸은 블록 단계에서만 ─────────────────────────
function filledContent() {
  const c = emptyContent();
  c.goal = "2학년 2학기 기말고사 평균 80점";
  c.subs = ["수학", "영어", "국어", "과학", "운동", "수면", "독서", "생활"];
  c.actions = c.subs.map((s) => Array.from({ length: 8 }, (_, j) => `${s} 실천 ${j + 1}`));
  // 블록은 실천 6칸부터 피드백을 받을 수 있어 빈칸이 남을 수 있습니다.
  c.actions[0][6] = "";
  c.actions[0][7] = "";
  c.actions[3][7] = "";
  return c;
}

test("규칙 진단: 블록 단계는 그 블록의 실천 빈칸마다 진단", () => {
  const items = ruleDiagnose(filledContent(), { kind: "block", index: 0 });
  assert.deepEqual(items.map((i) => `${i.category}@${targetKey(i.target)}`), ["EMPTY@action:0:6", "EMPTY@action:0:7"]);
  assert.deepEqual(ruleDiagnose(filledContent(), { kind: "block", index: 1 }), []);
});

test("규칙 진단: 전체 단계는 실천 빈칸을 다시 진단하지 않음(구조 진단 카드를 밀어내지 않게)", () => {
  const c = filledContent();
  const whole = ruleDiagnose(c, { kind: "whole" });
  assert.equal(whole.some((i) => i.category === "EMPTY" && i.target.kind === "action"), false);
  // 반복(같은 글)은 전체 단계에서도 그대로
  c.actions[5][0] = c.actions[4][0];
  assert.deepEqual(ruleDiagnose(c, { kind: "whole" }).map((i) => `${i.category}@${targetKey(i.target)}`), ["DUPLICATE@action:5:0"]);
  // 나중에 지운 중심 목표·세부 목표는 전체 단계에서도 알려 줌
  c.goal = "";
  c.subs[2] = "";
  const keys = ruleDiagnose(c, { kind: "whole" }).map((i) => `${i.category}@${targetKey(i.target)}`);
  assert.ok(keys.includes(`EMPTY@${targetKey({ kind: "goal" })}`));
  assert.ok(keys.includes(`EMPTY@${targetKey({ kind: "sub", sub: 2 })}`));
  // 중심 단계에는 실천 칸 진단이 없음
  assert.equal(ruleDiagnose(filledContent(), { kind: "core" }).length, 0);
});

test("전체 단계 카드: 빈칸 카드가 구조 진단(치우침 등)을 밀어내지 않음", () => {
  const c = filledContent();
  const structure = [
    { category: "UNBALANCED", target: { kind: "whole" }, severity: 2, evidence: "공부에 몰림", source: "ai" },
    { category: "SUB_MISALIGNED", target: { kind: "sub", sub: 7 }, severity: 2, evidence: "연결 약함", source: "ai" },
  ] as const;
  const picked = selectItems([...ruleDiagnose(c, { kind: "whole" }), ...structure], CARDS_PER_STAGE.whole);
  assert.deepEqual(picked.map((i) => i.category).sort(), ["SUB_MISALIGNED", "UNBALANCED"]);
});

// ── AI 연결 확인: 피드백과 같은 요청으로 실제 한 번 부름 ─────────────────
type Reply = { status: number; body: unknown } | "network";
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let route: (url: string, body: Record<string, unknown> | null) => Reply = () => ({ status: 500, body: {} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  calls.push({ url, method: init?.method ?? "GET", body });
  const r = route(url, body);
  if (r === "network") throw new TypeError("fetch failed");
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const BASE = "http://openrouter.test/api/v1";
const KEY_OK: Reply = { status: 200, body: { data: { usage: 1.25, limit: 10, limit_remaining: 8.75 } } };
const okChat = (content: string): Reply => ({
  status: 200,
  body: { model: "anthropic/claude-haiku-5.5", provider: "ZdrCloud", usage: { cost: 0.00001 }, choices: [{ finish_reason: "stop", message: { content } }] },
});
const orError = (status: number, message: string): Reply => ({ status, body: { error: { message, code: status } } });
function setup(r: (url: string, body: Record<string, unknown> | null) => Reply) {
  calls = [];
  route = r;
}
const chatCalls = () => calls.filter((c) => c.url === `${BASE}/chat/completions`);
const modelCalls = () => calls.filter((c) => c.url.startsWith(`${BASE}/models/`));

test("AI 연결 확인: 피드백과 같은 모델·제공사 조건·추론 설정·엄격한 JSON 형식으로 실제로 한 번 부름", async () => {
  for (const providers of ["", "ProvA, ProvB"]) {
    process.env.OPENROUTER_PROVIDERS = providers;
    setup((url, body) => {
      if (url === `${BASE}/key`) return KEY_OK;
      const name = ((body?.response_format as { json_schema?: { name?: string } }).json_schema ?? {}).name;
      return okChat(name === "connection_check" ? '{"ok":true}' : '{"items":[],"concern":{"flag":false,"kind":null}}');
    });
    const check = await checkAi();
    assert.equal(check.ok, true);
    assert.equal(check.status, 200);
    assert.equal(check.code, null);
    assert.equal(check.limit_remaining, 8.75);
    assert.equal(check.usage, 1.25);
    assert.match(check.message_ko, /정상적으로 답했습니다/);
    assert.match(check.message_ko, /ZdrCloud/);
    assert.equal(modelCalls().length, 0, "성공하면 모델 정보는 묻지 않음");
    const [probe] = chatCalls();
    assert.equal(probe.method, "POST");

    // 실제 피드백 호출(진단)의 요청과 비교
    calls = [];
    const c = emptyContent();
    c.goal = "학생 글";
    await aiDiagnose(c, { kind: "core" }, "middle");
    const [real] = chatCalls();
    for (const k of ["model", "provider", "reasoning"]) assert.deepEqual(probe.body?.[k], real.body?.[k], k);
    assert.equal(probe.body?.model, DEFAULT_MODEL);
    assert.deepEqual(probe.body?.reasoning, { effort: "low", exclude: true });
    const expectedProvider = {
      ...(providers ? { order: ["ProvA", "ProvB"], allow_fallbacks: false } : {}),
      require_parameters: true, data_collection: "deny", zdr: true,
    };
    assert.deepEqual(probe.body?.provider, expectedProvider);
    const fmt = (b: Call["body"]) => b?.response_format as { type: string; json_schema: { strict: boolean; schema: unknown } };
    assert.equal(fmt(probe.body).type, "json_schema");
    assert.equal(fmt(probe.body).json_schema.strict, true);
    assert.equal(fmt(real.body).json_schema.strict, true);
    // 추론 예산(최소 1024토큰인 모델도 있음)에 잘리지 않을 만큼, 하지만 피드백보다는 작게
    assert.ok((probe.body?.max_tokens as number) > 1024 && (probe.body?.max_tokens as number) <= 4000);
    // 확인 요청에는 학생 글이 들어가지 않음
    assert.ok(!JSON.stringify(probe.body?.messages).includes("학생 글"));
  }
  delete process.env.OPENROUTER_PROVIDERS;
});

test("AI 연결 확인: 데이터 보관 조건에 맞는 제공사가 없으면(404) 모델 정보로 원인을 가려 알려 줌", async () => {
  setup((url) => {
    if (url === `${BASE}/key`) return KEY_OK;
    if (url.startsWith(`${BASE}/models/`)) return { status: 200, body: { data: { endpoints: [{ provider_name: "NoZdr" }] } } };
    return orError(404, "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy");
  });
  const check = await checkAi();
  assert.equal(check.ok, false);
  assert.equal(check.status, 404);
  assert.equal(check.code, "no_provider");
  assert.equal(check.message_ko, noMatchingProviderMessage(DEFAULT_MODEL, "data policy", false));
  assert.match(check.message_ko, /보관하지 않는 조건\(ZDR\)/);
  assert.match(check.message_ko, /OPENROUTER_MODEL/);
  assert.match(check.message_ko, /설치 안내/);
  assert.equal(modelCalls().length, 1);
  assert.equal(modelCalls()[0].url, `${BASE}/models/anthropic/claude-haiku-5.5/endpoints`);
  // 남은 한도는 함께 보여 줌
  assert.equal(check.limit_remaining, 8.75);
});

test("AI 연결 확인: 모델 이름이 없으면 모델을 찾지 못했다고, 모델 정보도 못 받으면 실제 호출의 판정 그대로", async () => {
  setup((url) => {
    if (url === `${BASE}/key`) return KEY_OK;
    if (url.startsWith(`${BASE}/models/`)) return orError(404, "Model not found");
    return orError(400, "anthropic/claude-haiku-5.5 is not a valid model ID");
  });
  let check = await checkAi();
  assert.deepEqual([check.ok, check.status, check.code], [false, 400, "model_not_found"]);
  assert.equal(check.message_ko, `${AI_ERROR_MESSAGES.model_not_found} (지금 값: ${DEFAULT_MODEL})`);

  setup((url) => {
    if (url === `${BASE}/key`) return KEY_OK;
    if (url.startsWith(`${BASE}/models/`)) return "network";
    return orError(404, "No endpoints found that can handle the requested parameters.");
  });
  check = await checkAi();
  assert.deepEqual([check.ok, check.status, check.code], [false, 404, "no_provider"]);
  assert.equal(check.message_ko, AI_ERROR_MESSAGES.no_provider);
});

test("AI 연결 확인: status는 실패한 단계의 응답 코드(크레딧 402, 키 401, 연결 실패 0, 내용 문제는 200)", async () => {
  // 크레딧: 키 정보는 200이어도 실제 호출이 402면 402
  setup((url) => (url === `${BASE}/key` ? { status: 200, body: { data: { usage: 10, limit_remaining: 0 } } } : orError(402, "Insufficient credits")));
  let check = await checkAi();
  assert.deepEqual([check.ok, check.status, check.code, check.message_ko], [false, 402, "credit", AI_ERROR_MESSAGES.credit]);
  assert.equal(check.limit_remaining, 0);
  assert.equal(modelCalls().length, 0, "404가 아니면 모델 정보는 묻지 않음");

  setup((url) => (url === `${BASE}/key` ? orError(401, "No auth credentials found") : orError(401, "User not found.")));
  check = await checkAi();
  assert.deepEqual([check.ok, check.status, check.code], [false, 401, "auth"]);
  assert.equal(check.limit_remaining, undefined);

  setup(() => "network");
  check = await checkAi();
  assert.deepEqual([check.ok, check.status, check.code], [false, 0, "network"]);

  setup((url) => (url === `${BASE}/key` ? KEY_OK : okChat("확인했습니다")));
  check = await checkAi();
  assert.deepEqual([check.ok, check.status, check.code], [false, 200, "bad_output"]);

  setup((url) => (url === `${BASE}/key` ? KEY_OK : { status: 200, body: { choices: [{ finish_reason: "length", message: { content: "" } }] } }));
  check = await checkAi();
  assert.deepEqual([check.ok, check.status, check.code], [false, 200, "too_long"]);
});

test("맞는 제공사 없음 설명: 보관 조건 / 응답 형식 / 제공사 지정 여부에 따라", () => {
  const m = "vendor/model-x";
  const privacy = noMatchingProviderMessage(m, "OpenRouter 404: No endpoints found matching your data policy", false);
  assert.match(privacy, /vendor\/model-x/);
  assert.match(privacy, /ZDR\)을 지키는 AI 제공사가 없습니다/);
  assert.doesNotMatch(privacy, /JSON/);
  assert.doesNotMatch(privacy, /OPENROUTER_PROVIDERS/);
  const format = noMatchingProviderMessage(m, "OpenRouter 404: No endpoints found that can handle the requested parameters.", false);
  assert.match(format, /JSON 응답 형식/);
  assert.match(noMatchingProviderMessage(m, "", true), /OPENROUTER_PROVIDERS를 비우거나/);
});

// ── 학교급(학급 설정)에 따른 AI 프롬프트 ─────────────────────────────
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
// 학교급 설정이 생기기 전(fda0cb4)의 진단·카드 시스템 프롬프트 해시. 중학교 학급은 이 글을 그대로 받아야 합니다.
const MIDDLE_DIAGNOSIS_SHA256 = "ff6552558fa23d80306e307dc7e6abac4809feda04306fb845886a888636ddcc";
const MIDDLE_CARD_SHA256 = "a2c706eef7a96f8c1429dc51d30c216060616aeb5bbab074d9cba0eb221670bd";

test("학교급 프롬프트: 중학교는 학교급 설정 전과 글자 하나까지 같음", () => {
  assert.equal(sha256(diagnosisSystem("middle")), MIDDLE_DIAGNOSIS_SHA256);
  assert.equal(sha256(cardSystem("middle")), MIDDLE_CARD_SHA256);
  assert.ok(diagnosisSystem("middle").includes("- 중학생 수준을 고려해 지나치게 엄격하게 판단하지 마세요. 문제가 없으면 items를 빈 배열로 둡니다."));
  assert.ok(cardSystem("middle").includes("- 두 문장 이내, 공백 포함 60~110자. 중학생이 한눈에 읽을 수 있게 짧게 쓰세요."));
  for (const t of [diagnosisSystem("middle"), cardSystem("middle")]) assert.ok(!t.includes("고등학생"));
});

// 두 학교급의 프롬프트를 줄마다 비교해, 다른 줄만 [중학교, 고등학교]로 돌려줍니다(줄 수는 같아야 함).
function lineDiff(a: string, b: string): [string, string][] {
  const la = a.split("\n"), lb = b.split("\n");
  assert.equal(la.length, lb.length);
  return la.flatMap((l, i) => (l === lb[i] ? [] : [[l, lb[i]] as [string, string]]));
}

test("학교급 프롬프트: 고등학교 진단은 대상·판단 기준 세 가지·엄격함만 다르고, 안전 신호 부분은 같음", () => {
  const mid = diagnosisSystem("middle"), high = diagnosisSystem("high");
  assert.deepEqual(lineDiff(mid, high), [
    ["당신은 중학생의 만다라트(목표 설정 도구)를 진단하는 교육 평가 보조자입니다.", "당신은 고등학생의 만다라트(목표 설정 도구)를 진단하는 교육 평가 보조자입니다."],
    [
      "- GOAL_VAGUE: 중심 목표에 기간·수준·대상 중 어느 것도 드러나지 않아 이뤘는지 판단할 수 없을 때. target_kind는 goal.",
      "- GOAL_VAGUE: 중심 목표에 기한(언제까지)과 이뤘는지 잴 수 있는 기준(점수·등급·횟수 등) 중 하나라도 빠졌을 때. target_kind는 goal.",
    ],
    [
      "- SUB_MISALIGNED: 세부 목표가 중심 목표 달성에 기여한다고 보기 어려울 때. target_kind는 sub.",
      "- SUB_MISALIGNED: 세부 목표가 중심 목표 달성에 어떻게 기여하는지 설명하기 어려울 때(중심 목표가 진로·학업에 관한 것이면 그 맥락에서 이어지는지도 봅니다. 건강·관계·마음 관리처럼 중심 목표를 받쳐 주는 영역은 기여하는 것으로 봅니다). target_kind는 sub.",
    ],
    [
      "- ACTION_NOT_MEASURABLE: 행동은 맞지만 했는지 확인할 기준(횟수·시간·요일 등)이 전혀 없어 점검이 어려울 때. 짧고 분명한 행동(예: '물 마시기 하루 8잔')은 해당하지 않습니다.",
      "- ACTION_NOT_MEASURABLE: 행동은 맞지만 횟수·시간·점검 방법 중 어느 것도 드러나지 않아 했는지 점검하기 어려울 때('자주', '꾸준히'처럼 막연한 말만 있으면 드러나지 않은 것으로 봅니다). 짧고 분명한 행동(예: '물 마시기 하루 8잔')은 해당하지 않습니다.",
    ],
    [
      "- 중학생 수준을 고려해 지나치게 엄격하게 판단하지 마세요. 문제가 없으면 items를 빈 배열로 둡니다.",
      "- 고등학생 수준에 맞게 위 기준을 분명히 적용하되, 맞춤법·띄어쓰기·말투 같은 사소한 표현은 지적하지 마세요. 문제가 없으면 items를 빈 배열로 둡니다.",
    ],
  ]);
  // 안전 신호(concern) 부분은 두 학교급이 똑같습니다.
  const concern = (t: string) => t.slice(t.indexOf("안전 신호(concern)"));
  assert.ok(concern(mid).length > 500);
  assert.equal(concern(high), concern(mid));
  assert.ok(!high.includes("중학생"));
  // 받쳐 주는 영역(건강·관계 등)은 연결된 것으로 보아 UNBALANCED(공부만 몰림)와 부딪히지 않고, 진로·학업은 그런 중심 목표일 때만 봅니다.
  assert.ok(high.includes("- UNBALANCED: 세부 목표 대부분이 한 영역(예: 공부 과목만)에 몰려 있을 때."));
  assert.ok(!high.includes("진로·학업 맥락에서 중심 목표와 논리적으로"));
  // 측정 기준은 셋 중 하나라도 있으면 됩니다(셋 모두를 요구하지 않음).
  assert.ok(high.includes("횟수·시간·점검 방법 중 어느 것도 드러나지 않아"));
});

test("학교급 프롬프트: 고등학교 카드는 대상·질문 깊이만 다르고, 길이·답 대신 쓰지 않기·칭찬 빼기·종류별 방식은 같음", () => {
  const mid = cardSystem("middle"), high = cardSystem("high");
  assert.deepEqual(lineDiff(mid, high), [
    ["당신은 중학생이 만다라트(목표 설정 도구)를 스스로 고치도록 돕는 피드백 작성자입니다.", "당신은 고등학생이 만다라트(목표 설정 도구)를 스스로 고치도록 돕는 피드백 작성자입니다."],
    [
      "- 학생이 실제로 쓴 표현을 짚어서, 그 학생의 목표에 맞는 질문이나 방향을 제시하세요.",
      "- 학생이 실제로 쓴 표현을 짚어서, 그 학생의 목표에 맞는 질문이나 방향을 제시하세요. 새 문제·아직 해결 안 됨 카드에서는 그 항목에 맞을 때 기한, 잴 수 있는 기준, 점검 방법처럼 한 걸음 더 깊이 생각하게 하는 질문을 하세요(해결됨 카드에는 넣지 마세요).",
    ],
    ["- 두 문장 이내, 공백 포함 60~110자. 중학생이 한눈에 읽을 수 있게 짧게 쓰세요.", "- 두 문장 이내, 공백 포함 60~110자. 고등학생이 한눈에 읽을 수 있게 짧게 쓰세요."],
  ]);
  for (const rule of ["- 힌트만 주고 답을 대신 써 주지 마세요.", "칭찬이나 인사말은 넣지 마세요.", "따뜻하고 차분한 말투를 지키세요", "- 해결됨:", "- 아직 해결 안 됨:"]) {
    assert.ok(high.includes(rule), rule);
  }
  assert.ok(!high.includes("중학생"));
  // 더 깊은 질문은 새 문제·아직 해결 안 됨 카드에만. 해결됨 카드는 두 학교급 모두 새 지적을 하지 않습니다.
  assert.ok(high.includes("새 문제·아직 해결 안 됨 카드에서는 그 항목에 맞을 때"));
  assert.ok(high.includes("(해결됨 카드에는 넣지 마세요)"));
  assert.ok(high.includes("새로운 지적은 하지 마세요."));
  assert.ok(!high.includes("진로·학업"));
});

test("학교급 프롬프트: AI 요청에는 학교급에 맞는 지시와 만다라트 글만 들어가고 학생 이름·번호·PIN·학급은 없음, 모델 조건은 같음", async () => {
  // 학생 정보처럼 보이는 값(만다라트 글에는 넣지 않음). 진단·카드 함수는 이런 값을 받을 자리가 없습니다.
  const student = { name: "홍길동", number: "37번", pin: "4821", className: "3학년 7반", classCode: "QWZ7KD" };
  const c = filledContent();
  c.goal = "1학기 기말고사 수학 80점 넘기";
  setup((url, body) => {
    if (url === `${BASE}/key`) return KEY_OK;
    const name = ((body?.response_format as { json_schema?: { name?: string } }).json_schema ?? {}).name;
    return okChat(name === "feedback_cards" ? '{"cards":[{"index":0,"body":"언제까지 무엇으로 확인할지 정하면 더 분명해질까요?"}]}' : '{"items":[],"concern":{"flag":false,"kind":null}}');
  });
  const plan = { item: { category: "GOAL_VAGUE" as const, target: { kind: "goal" as const }, evidence: "기한 없음" }, kind: "issue" as const };
  const sent: Record<string, Call["body"][]> = {};
  for (const level of SCHOOL_LEVEL_KEYS) {
    calls = [];
    await aiDiagnose(c, { kind: "core" }, level);
    await aiCards(c, [plan], level);
    const [diag, card] = chatCalls();
    sent[level] = [diag.body, card.body];
    const messages = (b: Call["body"]) => b?.messages as { role: string; content: string }[];
    assert.equal(messages(diag.body)[0].content, diagnosisSystem(level));
    assert.equal(messages(card.body)[0].content, cardSystem(level));
    const all = JSON.stringify([messages(diag.body), messages(card.body)]);
    for (const v of Object.values(student)) assert.ok(!all.includes(v), v);
    assert.ok(all.includes("1학기 기말고사 수학 80점 넘기"));
  }
  // 학교급과 상관없이 모델·제공사 조건·추론 설정·응답 형식·토큰 한도와 사용자 메시지(만다라트 글)는 같습니다.
  for (const i of [0, 1]) {
    const { messages: mm, ...restMid } = sent.middle[i] ?? {};
    const { messages: mh, ...restHigh } = sent.high[i] ?? {};
    assert.deepEqual(restHigh, restMid);
    assert.equal((mh as { content: string }[])[1].content, (mm as { content: string }[])[1].content);
  }
});

test("학교급: 첫 피드백은 학급 설정, 확인 피드백은 그 단계 첫 피드백에 기록된 학교급(기록 없으면 중학교)", () => {
  // 첫 피드백(2회차가 아님): 지금 학급 설정
  assert.equal(roundSchoolLevel("high"), "high");
  assert.equal(roundSchoolLevel("middle"), "middle");
  // 확인 피드백: 단계 중간에 교사가 바꿔도 첫 피드백의 기준 그대로
  assert.equal(roundSchoolLevel("high", { school_level: "middle" }), "middle");
  assert.equal(roundSchoolLevel("middle", { school_level: "high" }), "high");
  // 학교급 설정 전 회차(기록 없음)는 중학교 프롬프트로 만든 것이므로 중학교
  assert.equal(roundSchoolLevel("high", { school_level: null }), "middle");
  assert.equal(roundSchoolLevel("high", { school_level: undefined }), "middle");
});
