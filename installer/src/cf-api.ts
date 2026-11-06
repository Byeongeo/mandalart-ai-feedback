// Cloudflare API(v4)를 부르는 작은 도구와 오류를 선생님이 읽을 수 있는 한국어로 바꾸는 함수.
// 토큰은 Authorization 머리글에만 넣고, 어디에도 기록하거나 돌려주지 않습니다.
// Cloudflare 오류는 코드와 메시지만 남기고(머리글·요청 본문 없음), 메시지 안에 토큰이 들어 있으면 가립니다.

export type CfErrorItem = { code: number; message: string };

export class CfError extends Error {
  readonly status: number;
  readonly errors: CfErrorItem[];
  /** 무엇을 하다가 실패했는지(한국어, 화면용) */
  readonly action: string;
  constructor(status: number, errors: CfErrorItem[], action: string) {
    super(`Cloudflare API ${status} ${errors.map((e) => e.code).join(",")}`);
    this.name = "CfError";
    this.status = status;
    this.errors = errors;
    this.action = action;
  }
  has(code: number): boolean {
    return this.errors.some((e) => e.code === code);
  }
  mentions(text: string): boolean {
    return this.errors.some((e) => e.message.toLowerCase().includes(text.toLowerCase()));
  }
}

/** 연결 실패·시간 초과 */
export class CfNetworkError extends Error {
  readonly action: string;
  readonly timeout: boolean;
  constructor(action: string, timeout: boolean) {
    super(timeout ? "Cloudflare API timeout" : "Cloudflare API network error");
    this.name = "CfNetworkError";
    this.action = action;
    this.timeout = timeout;
  }
}

/** 화면에 내보낼 수 있게 메시지를 다듬습니다: 토큰 가리기, 제어 문자 빼기, 길이 제한. */
export function cleanMessage(msg: unknown, secrets: string[] = []): string {
  let s = typeof msg === "string" ? msg : "";
  for (const secret of secrets) if (secret && secret.length >= 8) s = s.split(secret).join("***");
  // 토큰처럼 보이는 긴 덩어리(32자 이상 영문·숫자)도 가립니다(UUID·계정 ID는 하이픈이 있거나 32자 hex라 그대로 둠).
  s = s.replace(/[A-Za-z0-9_-]{36,}/g, (m) => (/^[0-9a-f-]+$/i.test(m) ? m : "***"));
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function parseErrors(body: unknown, secrets: string[]): CfErrorItem[] {
  const errs = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errs)) return [];
  return errs.slice(0, 5).map((e) => {
    const o = (e ?? {}) as { code?: unknown; message?: unknown };
    const code = Number(o.code);
    return { code: Number.isFinite(code) ? code : 0, message: cleanMessage(o.message, secrets) };
  });
}

export type CfClient = {
  /** JSON 응답의 result를 돌려줍니다. 실패하면 CfError·CfNetworkError를 던집니다. */
  call<T = unknown>(method: string, path: string, opts: { action: string; json?: unknown; form?: FormData; headers?: Record<string, string>; timeoutMs?: number }): Promise<T>;
};

export function cfClient(base: string, token: string, doFetch: typeof fetch = fetch): CfClient {
  return {
    async call<T>(method: string, path: string, opts: { action: string; json?: unknown; form?: FormData; headers?: Record<string, string>; timeoutMs?: number }): Promise<T> {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", ...opts.headers };
      let body: BodyInit | undefined;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.json);
      } else if (opts.form) body = opts.form;
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
      } catch (e) {
        const name = (e as { name?: string } | null)?.name;
        throw new CfNetworkError(opts.action, name === "TimeoutError" || name === "AbortError");
      }
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      const ok = res.ok && !!data && (data as { success?: unknown }).success !== false;
      if (!ok) throw new CfError(res.status, parseErrors(data, [token]), opts.action);
      return (data as { result: T }).result;
    },
  };
}

const AUTH_CODES = new Set([1000, 1001, 6003, 6111, 7403, 9106, 9109, 10000, 10001]);

/** 권한이 없거나 토큰이 맞지 않아 거절된 것인지 */
export function isAuthError(e: unknown): boolean {
  return e instanceof CfError && (e.status === 401 || e.status === 403 || e.errors.some((x) => AUTH_CODES.has(x.code)));
}

const TOKEN_AGAIN = "2단계의 '설치 토큰 만들기' 버튼으로 토큰을 새로 만들어 붙여 넣어 주세요.";

/** 어떤 오류든 선생님이 읽을 한국어 한 문단으로 바꿉니다(토큰·머리글은 들어가지 않음). */
export function koreanError(e: unknown): string {
  if (e instanceof CfNetworkError) {
    return e.timeout
      ? `${e.action} 중에 Cloudflare 응답이 너무 늦어요. 잠시 뒤 같은 버튼을 다시 눌러 주세요(이미 만든 것은 그대로 이어서 합니다).`
      : `${e.action} 중에 Cloudflare에 연결하지 못했어요. 인터넷 연결을 확인하고 잠시 뒤 다시 눌러 주세요.`;
  }
  if (e instanceof CfError) {
    const detail = e.errors.length
      ? ` (Cloudflare 오류 ${e.errors.map((x) => (x.message ? `${x.code}: ${x.message}` : String(x.code))).join(" / ")})`
      : ` (HTTP ${e.status})`;
    if (e.mentions("email_verification") || e.mentions("verify your email")) {
      return `Cloudflare 이메일 인증이 아직 끝나지 않았어요. 가입한 메일함(스팸함도)에서 Cloudflare 인증 메일을 열어 'Verify'를 누른 뒤 다시 해 주세요.${detail}`;
    }
    if (e.status === 401 || e.has(1000) || e.has(1001) || e.has(6003) || e.has(6111) || e.has(9106)) {
      return `토큰이 맞지 않거나 만료되었어요. 복사할 때 앞뒤가 잘리지 않았는지 확인하고, 그래도 안 되면 ${TOKEN_AGAIN}${detail}`;
    }
    if (isAuthError(e)) {
      return `${e.action}에 필요한 권한이 토큰에 없어요. 토큰 화면에서 Workers Scripts·D1 'Edit' 권한과 'Account Resources'에 이 계정이 들어 있어야 해요. ${TOKEN_AGAIN}${detail}`;
    }
    if (e.has(7406)) return `이 계정의 D1 데이터베이스 개수가 한도에 닿았어요. 쓰지 않는 데이터베이스를 지우거나 강사에게 알려 주세요.${detail}`;
    if (e.status === 429) return `Cloudflare에 요청이 너무 많이 몰렸어요. 1분쯤 뒤에 다시 눌러 주세요.${detail}`;
    if (e.status >= 500) return `${e.action} 중에 Cloudflare 쪽에 잠깐 문제가 생겼어요. 잠시 뒤 다시 눌러 주세요(이미 만든 것은 그대로 이어서 합니다).${detail}`;
    return `${e.action} 중에 Cloudflare에서 오류가 났어요. 화면을 찍어 강사에게 보여 주세요.${detail}`;
  }
  if (e instanceof InstallStop) return e.message;
  return "설치 중에 예상하지 못한 문제가 생겼어요. 잠시 뒤 다시 눌러 주세요. 계속되면 화면을 찍어 강사에게 보여 주세요.";
}

/** 설치를 멈추고 선생님에게 그대로 보여 줄 한국어 안내. goto: 화면이 보여 줄 '다른 탭으로 가기' 버튼 */
export class InstallStop extends Error {
  readonly goto?: "install" | "update";
  constructor(message: string, goto?: "install" | "update") {
    super(message);
    this.name = "InstallStop";
    this.goto = goto;
  }
}
