// 화면에 시간을 한국 시간으로 보여 주는 순수 함수(서버·브라우저 공용).
// Intl 대신 직접 계산해, 서버에서 그린 글자와 브라우저에서 다시 그린 글자가 항상 같게 합니다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** '10/15 14:05' (한국 시간). 값이 없거나 잘못되면 빈 문자열 */
export function fmtKst(v: string | Date | null | undefined, withYear = false): string {
  if (!v) return "";
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + KST_OFFSET_MS);
  const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${withYear ? `${d.getUTCFullYear()}/` : ""}${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 서버 컴포넌트가 클라이언트 컴포넌트에 넘기는 값의 모양(Date → ISO 문자열) */
export type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

/** Date를 ISO 문자열로 바꿔 클라이언트 컴포넌트에 넘길 수 있게 합니다. */
export function toJson<T>(v: T): Jsonify<T> {
  return JSON.parse(JSON.stringify(v)) as Jsonify<T>;
}
