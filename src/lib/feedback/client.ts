import "server-only";
import * as z from "zod";
import { AI_ERROR_MESSAGES, classifyHttp, noMatchingProviderMessage, type AiErrorCode } from "./ai-errors";

// OpenRouter(OpenAI 호환 Chat Completions)로 모델을 부릅니다. 학생 이름·번호·PIN은 절대 보내지 않습니다(만다라트 글만).
// 회차마다 실제로 응답한 모델·제공사가 feedback_rounds.model에 저장됩니다.

export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
export const DEFAULT_REASONING_EFFORT = "low";

const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
// 마감(deadline)이 있으면 남은 시간 안에서만 시도합니다. 함수가 플랫폼 제한에 걸려 강제 종료되면 오류 기록도 남지 않기 때문입니다.
const DEADLINE_MARGIN_MS = 5_000; // 한 번의 시도는 마감 5초 전에 끊음
const MIN_RETRY_LEFT_MS = 15_000; // 남은 시간이 15초보다 적으면 다시 시도하지 않음
const MIN_ATTEMPT_MS = 10_000; // 한 번의 시도에 최소 10초는 있어야 부름
const MAX_RETRY_AFTER_MS = 20_000;

// 개발용 모의 모드: API 키 없이 화면 흐름을 확인할 때만 씁니다. 운영(production) 빌드에서는 항상 꺼집니다.
export const MOCK = process.env.FEEDBACK_MOCK === "1" && process.env.NODE_ENV !== "production";

/** OPENROUTER_API_KEY가 없을 때. 학생에게는 message를, 교사 화면에는 aiStatus()의 keyConfigured=false를 보여 줍니다. */
export class AiKeyMissingError extends Error {
  constructor() {
    super("선생님이 아직 AI 키를 넣지 않았어요. 선생님께 말씀드려 주세요.");
  }
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function aiConfig() {
  const apiKey = env("OPENROUTER_API_KEY");
  const model = env("OPENROUTER_MODEL") ?? DEFAULT_MODEL;
  const providers = (env("OPENROUTER_PROVIDERS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // 'none'/'off'로 두면 추론 설정을 보내지 않습니다(모델 기본값).
  const rawEffort = (env("OPENROUTER_REASONING_EFFORT") ?? DEFAULT_REASONING_EFFORT).toLowerCase();
  const effort = rawEffort === "none" || rawEffort === "off" ? null : rawEffort;
  const baseUrl = (env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  return { apiKey, model, providers, effort, baseUrl };
}

/** 교사 화면용 AI 설정 상태(키 값은 절대 돌려주지 않음) */
export function aiStatus(): { keyConfigured: boolean; mock: boolean; model: string } {
  const c = aiConfig();
  return { keyConfigured: MOCK || !!c.apiKey, mock: MOCK, model: MOCK ? "mock" : c.model };
}

/** 피드백을 만들 수 있는지 먼저 확인합니다(모의 모드이면 통과). */
export function assertAiReady(): void {
  if (!MOCK && !aiConfig().apiKey) throw new AiKeyMissingError();
}

export type CallMeta = { model: string; provider: string | null; ms: number; usage: unknown };

export function metaLabel(m: CallMeta | null): string {
  if (MOCK) return "mock";
  if (!m) return aiConfig().model;
  return m.provider ? `${m.model} @ ${m.provider}` : m.model;
}

// OpenAI strict JSON schema가 받아들이지 않는 키워드를 제거합니다.
function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "minimum" || k === "maximum" || k === "default") continue;
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return node;
}

type ChatResponse = {
  model?: string;
  provider?: string;
  usage?: unknown;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  error?: { message?: string; code?: number };
};

/**
 * AI 호출 오류. code는 교사 화면에 보여 줄 설명(ai-errors.ts)을 고르는 데 씁니다.
 * message에는 학생 글을 넣지 않습니다(거절 문구는 학생 글을 인용할 수 있어 담지 않음).
 */
export class AiCallError extends Error {
  // 생성자 매개변수 속성(readonly code …)은 쓰지 않습니다. 단위 테스트(node --experimental-strip-types)가 읽지 못합니다.
  readonly code: AiErrorCode;
  readonly opts: { status?: number; retryable?: boolean; retryAfterMs?: number };
  constructor(code: AiErrorCode, message: string, opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.code = code;
    this.opts = opts;
  }
  get status() {
    return this.opts.status;
  }
}

/** 어떤 오류든 코드로(AiKeyMissingError는 no_key, 시간 초과는 timeout, 그 밖의 낯선 오류는 unknown) */
export function aiErrorCode(e: unknown): AiErrorCode {
  if (e instanceof AiCallError) return e.code;
  if (e instanceof AiKeyMissingError) return "no_key";
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "timeout";
  return "unknown";
}

function toAiError(e: unknown): AiCallError {
  if (e instanceof AiCallError) return e;
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return new AiCallError("timeout", "시간 초과", { retryable: true });
  // fetch 자체가 실패(DNS, 연결 끊김 등)하면 TypeError가 납니다.
  if (e instanceof TypeError) return new AiCallError("network", "연결 실패", { retryable: true });
  return new AiCallError("unknown", e instanceof Error ? e.message.slice(0, 200) : "알 수 없는 오류");
}

// 429 응답의 Retry-After(초 또는 날짜)를 밀리초로 바꿉니다.
function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const sec = Number(v);
  const ms = Number.isFinite(sec) ? sec * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AiConfig = ReturnType<typeof aiConfig>;

/**
 * OpenRouter에 보낼 요청 본문. 피드백 호출(structuredCall)과 'AI 연결 확인'(checkAi)이 함께 씁니다.
 * 모델·제공사 조건(ZDR 등)·추론 설정·응답 형식(JSON 스키마)이 두 곳에서 늘 같아야, 연결 확인이 통과하면 피드백도 같은 길로 갑니다.
 */
function chatBody(cfg: AiConfig, o: { name: string; system: string; user: string; schema: z.ZodType; maxTokens: number }) {
  return {
    model: cfg.model,
    max_tokens: o.maxTokens,
    messages: [
      { role: "system", content: o.system },
      { role: "user", content: o.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: o.name,
        strict: true,
        schema: cleanSchema(z.toJSONSchema(o.schema, { target: "draft-7", io: "output" })),
      },
    },
    ...(cfg.effort ? { reasoning: { effort: cfg.effort, exclude: true } } : {}),
    provider: {
      // 제공사를 지정했으면 그 순서대로만(자동 전환 없음). 비워 두면 OpenRouter가 고릅니다.
      ...(cfg.providers.length ? { order: cfg.providers, allow_fallbacks: false } : {}),
      // JSON 스키마 등 요청한 기능을 지원하는 제공사만
      require_parameters: true,
      // 학생 글이 학습에 쓰이거나 보관되지 않는 제공사만 사용
      data_collection: "deny",
      zdr: true,
    },
  };
}

/**
 * 한 번 부릅니다(다시 시도하지 않음). 실패하면 AiCallError(HTTP 상태 포함)를 던지고, 성공하면 모델이 쓴 글과 응답을 돌려줍니다.
 * HTTP 응답은 200인데 내용이 쓸 수 없는 경우(거절, 잘림, 빈 응답)도 status에 200을 담아 던집니다.
 */
async function chatOnce(cfg: AiConfig, body: unknown, timeoutMs: number): Promise<{ text: string; json: ChatResponse; status: number }> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Mandalart Feedback",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as ChatResponse;
  const errMsg = (json.error?.message ?? "").slice(0, 200);
  if (res.status === 429 || res.status >= 500) {
    throw new AiCallError(classifyHttp(res.status, errMsg), `OpenRouter ${res.status}: ${errMsg}`, {
      status: res.status, retryable: true, retryAfterMs: res.status === 429 ? retryAfterMs(res) : undefined,
    });
  }
  if (!res.ok || json.error) {
    const status = res.ok ? (json.error?.code ?? res.status) : res.status;
    throw new AiCallError(classifyHttp(status, errMsg), `OpenRouter ${status}: ${errMsg || "unknown error"}`, { status });
  }
  const status = res.status;
  const choice = json.choices?.[0];
  // 거절 문구는 학생 글을 인용할 수 있으므로 기록에 담지 않습니다.
  if (choice?.message?.refusal) throw new AiCallError("refusal", "모델이 응답을 거절했습니다.", { status });
  if (choice?.finish_reason === "length") throw new AiCallError("too_long", "응답이 길이 제한에서 잘렸습니다.", { status });
  if (choice?.finish_reason === "content_filter") throw new AiCallError("refusal", "내용 필터에 걸렸습니다.", { status });
  const text = choice?.message?.content;
  if (!text) throw new AiCallError("bad_output", "빈 응답", { status, retryable: true });
  return { text, json, status };
}

/** 시스템·사용자 메시지를 보내고, 응답을 zod 스키마로 검증해 돌려줍니다. */
export async function structuredCall<T>(opts: {
  name: string;
  system: string;
  user: string;
  /** 응답을 검사(parse)하는 스키마 */
  schema: z.ZodType<T>;
  /** 모델에게 보내는 JSON 스키마(없으면 schema). 보낼 때는 엄격하게, 받을 때는 너그럽게 검사하고 싶을 때 씁니다. */
  responseSchema?: z.ZodType;
  maxTokens: number;
  /** 이 시각(epoch ms)까지 끝내야 합니다. 여러 호출이 같은 마감을 나눠 씁니다. */
  deadline?: number;
  /** 스키마는 맞지만 내용이 부족하면 오류 문구를 돌려줍니다(다시 시도함). */
  validate?: (data: T) => string | null;
}): Promise<{ data: T; meta: CallMeta }> {
  const cfg = aiConfig();
  if (!cfg.apiKey) throw new AiKeyMissingError();
  const body = chatBody(cfg, {
    name: opts.name,
    system: opts.system,
    user: opts.user,
    schema: opts.responseSchema ?? opts.schema,
    maxTokens: opts.maxTokens,
  });

  let lastError: unknown;
  const left = () => (opts.deadline ?? Infinity) - Date.now();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 지수 대기 + 무작위 흔들기(여러 학생이 동시에 다시 부르지 않도록). 429면 Retry-After를 따릅니다.
      const hinted = lastError instanceof AiCallError ? lastError.opts.retryAfterMs : undefined;
      const wait = (hinted ?? 1000 * 2 ** (attempt - 1)) * (1 + Math.random() * 0.5);
      if (left() - wait < MIN_RETRY_LEFT_MS) break;
      await sleep(wait);
    }
    const budget = Math.min(TIMEOUT_MS, left() - DEADLINE_MARGIN_MS);
    // 너무 짧은 시간으로는 부르지 않습니다(유료 호출이 거의 확실히 시간 초과로 끝나므로).
    if (budget < MIN_ATTEMPT_MS) {
      lastError ??= new AiCallError("timeout", "시간 안에 응답을 받지 못했습니다.");
      break;
    }
    const started = Date.now();
    try {
      const { text, json } = await chatOnce(cfg, body, budget);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        throw new AiCallError("bad_output", "JSON이 아닌 응답", { retryable: true });
      }
      const parsed = opts.schema.safeParse(parsedJson);
      if (!parsed.success) {
        const where = parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")).join(", ");
        throw new AiCallError("bad_output", `스키마 불일치: ${where}`, { retryable: true });
      }
      const invalid = opts.validate?.(parsed.data);
      if (invalid) throw new AiCallError("bad_output", invalid, { retryable: true });

      return {
        data: parsed.data,
        meta: { model: json.model ?? cfg.model, provider: json.provider ?? null, ms: Date.now() - started, usage: json.usage ?? null },
      };
    } catch (e) {
      const err = toAiError(e);
      lastError = err;
      if (!err.opts.retryable) throw err;
    }
  }
  throw toAiError(lastError);
}

// ── 교사 화면의 'AI 연결 확인' ─────────────────────────────────
// 피드백과 똑같은 요청(chatBody: 같은 모델, 같은 제공사 조건(ZDR 등), 같은 추론 설정, JSON 응답 형식)으로 AI를 실제로 한 번 짧게 부릅니다.
// 질문은 정해 둔 짧은 글이고 학생 글은 넣지 않습니다. 요금은 아주 조금 듭니다(기본 모델 기준 1원보다 훨씬 적음).
// 함께 키 정보(GET {base}/key, 무료)를 물어 limit_remaining(이 키에 걸어 둔 사용 한도의 남은 양, 한도가 없으면 null)과
// 쓴 금액을 알려 줍니다. 계정 전체 크레딧 잔액은 이 응답에 없습니다(OpenRouter > Credits 화면에서 확인).
// 실제 호출이 '찾지 못함(404)'으로 실패하면 모델 정보(GET {base}/models/{모델}/endpoints, 무료)를 보고
// 모델 이름이 틀린 것인지, 모델은 있는데 조건에 맞는 제공사가 없는 것인지 가려 줍니다.
export type AiCheck = {
  ok: boolean;
  /** 실패한 단계의 OpenRouter 응답 상태 코드(정상이면 200, 연결 실패·시간 초과는 0) */
  status: number;
  code: AiErrorCode | null;
  message_ko: string;
  limit_remaining?: number | null;
  usage?: number | null;
};

const CHECK_TIMEOUT_MS = 20_000; // 실제 호출 한 번
const INFO_TIMEOUT_MS = 8_000; // 키 정보·모델 정보(무료 조회)
// 추론을 켜 두면 생각하는 데 쓴 토큰도 max_tokens에 들어갑니다. 추론 예산을 최소 1024토큰으로 잡는 모델도 있으므로
// 짧은 답({"ok":true})이 잘리지 않게 넉넉히 둡니다(요금은 실제로 쓴 토큰만큼만 나갑니다).
const CHECK_MAX_TOKENS = 2_000;
const CheckReply = z.object({ ok: z.boolean() });
const CHECK_SYSTEM = "연결 확인용 요청입니다. ok에 true를 넣어 답하세요.";
const CHECK_USER = "연결 확인";

async function getJson(url: string, apiKey: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// 키 정보(무료): 남은 사용 한도와 쓴 금액. 받지 못하면 빈 값(판정에는 쓰지 않음)
async function keyInfo(cfg: AiConfig, apiKey: string): Promise<{ limit_remaining?: number | null; usage?: number | null }> {
  try {
    const key = await getJson(`${cfg.baseUrl}/key`, apiKey);
    if (key.status !== 200) return {};
    const data = ((key.json as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
    return { limit_remaining: num(data.limit_remaining), usage: num(data.usage) };
  } catch {
    return {};
  }
}

// 실제 호출 한 번(다시 시도하지 않음). 실패하면 AiCallError를 돌려줍니다.
async function checkCall(cfg: AiConfig): Promise<{ ok: true; model: string; provider: string | null } | { ok: false; error: AiCallError }> {
  try {
    const body = chatBody(cfg, { name: "connection_check", system: CHECK_SYSTEM, user: CHECK_USER, schema: CheckReply, maxTokens: CHECK_MAX_TOKENS });
    const { text, json, status } = await chatOnce(cfg, body, CHECK_TIMEOUT_MS);
    let reply: unknown = null;
    try {
      reply = JSON.parse(text);
    } catch {
      // 아래에서 형식 오류로 처리
    }
    if (!CheckReply.safeParse(reply).success) throw new AiCallError("bad_output", "연결 확인 응답의 형식이 맞지 않음", { status });
    return { ok: true, model: json.model ?? cfg.model, provider: json.provider ?? null };
  } catch (e) {
    return { ok: false, error: toAiError(e) };
  }
}

// 실제 호출이 '찾지 못함'으로 실패했을 때만 모델 정보로 원인을 가립니다. 모델 정보를 받지 못하면 실제 호출의 판정을 그대로 씁니다.
async function explainFailure(cfg: AiConfig, apiKey: string, err: AiCallError): Promise<{ code: AiErrorCode; message_ko: string }> {
  const current = ` (지금 값: ${cfg.model})`;
  const fallback = { code: err.code, message_ko: AI_ERROR_MESSAGES[err.code] + (err.code === "model_not_found" ? current : "") };
  if (err.code !== "model_not_found" && err.code !== "no_provider" && err.status !== 404) return fallback;
  try {
    const path = cfg.model.split("/").map(encodeURIComponent).join("/");
    const m = await getJson(`${cfg.baseUrl}/models/${path}/endpoints`, apiKey);
    if (m.status === 404 || m.status === 400) return { code: "model_not_found", message_ko: AI_ERROR_MESSAGES.model_not_found + current };
    const endpoints = (m.json as { data?: { endpoints?: unknown } } | null)?.data?.endpoints;
    if (m.status === 200 && Array.isArray(endpoints)) {
      // 모델도 제공사도 있는데 요청이 실패했다면, 이 앱의 조건(ZDR·JSON 응답 형식)에 맞는 제공사가 없는 것입니다.
      if (endpoints.length > 0) {
        return { code: "no_provider", message_ko: noMatchingProviderMessage(cfg.model, err.message, cfg.providers.length > 0) };
      }
      return { code: "no_provider", message_ko: AI_ERROR_MESSAGES.no_provider + current };
    }
  } catch {
    // 모델 정보는 설명을 더 정확히 하려는 덤입니다.
  }
  return fallback;
}

export async function checkAi(): Promise<AiCheck> {
  if (MOCK) return { ok: true, status: 200, code: null, message_ko: "모의 모드(FEEDBACK_MOCK=1)라 AI를 부르지 않습니다." };
  const cfg = aiConfig();
  const apiKey = cfg.apiKey;
  if (!apiKey) return { ok: false, status: 0, code: "no_key", message_ko: AI_ERROR_MESSAGES.no_key };
  // 키 정보와 실제 호출을 함께 보냅니다. 판정은 실제 호출로 하고, 키 정보는 남은 한도·쓴 금액을 보여 주는 데만 씁니다.
  const [key, call] = await Promise.all([keyInfo(cfg, apiKey), checkCall(cfg)]);
  if (!call.ok) {
    const { code, message_ko } = await explainFailure(cfg, apiKey, call.error);
    return { ok: false, status: call.error.status ?? 0, code, message_ko, ...key };
  }
  const left = key.limit_remaining == null ? "" : ` 이 키의 남은 한도: $${key.limit_remaining.toFixed(2)}.`;
  const served = call.provider ? `${call.model}, 제공사 ${call.provider}` : call.model;
  return {
    ok: true, status: 200, code: null, ...key,
    message_ko: `AI가 정상적으로 답했습니다(모델 ${served}).${left} 계정 잔액은 OpenRouter > Credits에서 확인하세요.`,
  };
}
