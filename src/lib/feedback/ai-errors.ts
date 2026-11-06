// AI(OpenRouter) 오류를 짧은 코드로 나누고, 교사에게 보여 줄 쉬운 한국어 설명으로 바꿉니다(순수 함수, 서버·단위 테스트 공용).
// 교사 화면에는 이 설명만 보여 주고, 학생 글이나 OpenRouter가 돌려준 원문은 보여 주지 않습니다.

export const AI_ERROR_CODES = [
  "no_key", "auth", "credit", "forbidden", "model_not_found", "no_provider", "bad_request",
  "rate_limit", "server", "timeout", "network", "refusal", "too_long", "bad_output", "save_failed", "unknown",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  no_key: "AI 키(OPENROUTER_API_KEY)가 없습니다. Vercel > Settings > Environment Variables에 넣고 Redeploy하세요.",
  auth: "AI 키가 맞지 않거나 지워졌습니다(401). OpenRouter > Keys에서 키를 확인하고 Vercel에 다시 넣은 뒤 Redeploy하세요.",
  credit: "OpenRouter 크레딧이 부족하거나 키 사용 한도에 닿았습니다(402). OpenRouter > Credits 잔액과 키의 한도(Limit)를 확인하세요.",
  forbidden: "OpenRouter의 내용 검사에서 요청이 거절되었습니다(403). 학생 글에 걱정되는 표현이 있는지 직접 살펴보세요.",
  model_not_found: "설정된 AI 모델 이름을 OpenRouter에서 찾지 못했습니다. OPENROUTER_MODEL 값(비워 두면 기본 모델)을 확인하세요.",
  no_provider: "학생 글을 보관하지 않는 조건(ZDR)에 맞는 AI 제공사를 지금 찾지 못했습니다(404). 잠시 뒤 다시 해 보거나 모델 설정을 확인하세요.",
  bad_request: "AI 요청이 거절되었습니다(400). 잠시 뒤 다시 해 보고, 계속되면 모델 설정을 확인하세요.",
  rate_limit: "AI 요청이 한꺼번에 너무 많았습니다(429). 잠시 뒤 다시 하면 됩니다.",
  server: "OpenRouter나 AI 제공사에 잠깐 문제가 있었습니다(5xx). 잠시 뒤 다시 하면 됩니다.",
  timeout: "AI 응답이 너무 늦어 시간 초과로 끝났습니다. 잠시 뒤 다시 해 보세요.",
  network: "OpenRouter에 연결하지 못했습니다. 잠시 뒤 다시 해 보세요.",
  refusal: "AI 모델이 응답을 거절했습니다. 학생 글에 걱정되는 표현이 있는지 직접 살펴보세요.",
  too_long: "AI 응답이 길이 제한에서 잘렸습니다. 다시 하면 대부분 괜찮아집니다.",
  bad_output: "AI 응답 형식이 맞지 않았습니다. 다시 하면 대부분 괜찮아집니다.",
  save_failed: "만든 피드백을 데이터베이스에 저장하지 못했습니다. 잠시 뒤 다시 해 보세요.",
  unknown: "알 수 없는 문제로 피드백을 만들지 못했습니다. 잠시 뒤 다시 해 보세요.",
};

export function isAiErrorCode(v: unknown): v is AiErrorCode {
  return typeof v === "string" && (AI_ERROR_CODES as readonly string[]).includes(v);
}

const MODEL_INVALID = /not a valid model|invalid model|unknown model|model .*(not found|does not exist)|no such model/i;
const NO_PROVIDER = /no endpoints|no allowed providers|data policy|zdr|data collection|requested parameters|no providers/i;

/** OpenRouter HTTP 응답(상태 코드 + 오류 문구)을 코드로 나눕니다. */
export function classifyHttp(status: number, message: string | null | undefined): AiErrorCode {
  const m = message ?? "";
  if (status === 401) return "auth";
  if (status === 402) return "credit";
  if (status === 403) return "forbidden";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (MODEL_INVALID.test(m)) return "model_not_found";
  if (status === 404) return NO_PROVIDER.test(m) ? "no_provider" : "model_not_found";
  if (status === 400) return "bad_request";
  return "unknown";
}

/**
 * 'AI 연결 확인'에서 실제 호출이 '맞는 제공사 없음(404)'으로 실패했는데, 모델 정보를 보니 모델도 있고 제공사도 있을 때의 설명.
 * 이 앱은 학생 글을 보관하지 않는(ZDR) 제공사 + JSON 응답 형식을 지원하는 제공사만 고르므로, 그 조건에 맞는 곳이 없다는 뜻입니다.
 * openRouterMessage는 OpenRouter 오류 원문(화면에는 넣지 않고 설명을 고르는 데만 씀), providersSet은 OPENROUTER_PROVIDERS를 지정했는지.
 */
export function noMatchingProviderMessage(model: string, openRouterMessage: string, providersSet: boolean): string {
  const format = /requested parameters/i.test(openRouterMessage) && !/data policy|zdr|data collection/i.test(openRouterMessage);
  const why = format
    ? `이 모델(${model})은 있지만, 학생 글을 보관하지 않는 조건(ZDR)과 이 앱이 쓰는 JSON 응답 형식을 함께 지키는 AI 제공사가 없습니다(404).`
    : `이 모델(${model})은 있지만, 학생 글을 보관하지 않는 조건(ZDR)을 지키는 AI 제공사가 없습니다(404).`;
  const todo = providersSet
    ? "OPENROUTER_PROVIDERS를 비우거나 OPENROUTER_MODEL에 다른 모델을 넣은 뒤 Redeploy하세요(설치 안내 참고)."
    : "OPENROUTER_MODEL에 다른 모델을 넣은 뒤 Redeploy하세요(설치 안내 참고).";
  return `${why} ${todo}`;
}

/** event_log 'feedback_error'의 payload에서 코드를 읽습니다(코드가 없는 기록은 남은 글로 짐작). */
export function errorCodeFromEvent(payload: unknown): AiErrorCode {
  const p = (payload && typeof payload === "object" ? payload : {}) as { code?: unknown; status?: unknown; error?: unknown };
  if (isAiErrorCode(p.code)) return p.code;
  const text = typeof p.error === "string" ? p.error : "";
  const http = /OpenRouter (\d{3})/.exec(text);
  if (http) return classifyHttp(Number(http[1]), text);
  if (/저장 실패/.test(text)) return "save_failed";
  if (/시간|timeout|aborted/i.test(text)) return "timeout";
  if (/거절/.test(text)) return "refusal";
  if (/스키마|JSON|빈 응답|카드 \d+/.test(text)) return "bad_output";
  return "unknown";
}

/** 교사 화면용 최근 오류 한 줄(학생 글·원문 없음) */
export function sanitizeErrorEvent(e: { created_at: Date | string; payload: unknown }): { at: string; code: AiErrorCode; message_ko: string } {
  const code = errorCodeFromEvent(e.payload);
  const at = e.created_at instanceof Date ? e.created_at.toISOString() : new Date(e.created_at).toISOString();
  return { at, code, message_ko: AI_ERROR_MESSAGES[code] };
}
