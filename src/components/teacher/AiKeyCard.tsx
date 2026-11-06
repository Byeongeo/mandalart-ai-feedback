"use client";

import { useEffect, useState } from "react";

// GET /api/teacher/ai-key 응답(키 값은 들어 있지 않고 끝 네 글자만)
type KeyInfo = { configured: boolean; last4: string | null; fromEnv: boolean };
type Reply = { ok?: boolean; configured?: boolean; last4?: string | null; fromEnv?: boolean; error?: unknown };

const NET_ERROR = "⚠ 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.";
const AUTH_ERROR = "⚠ 로그인이 끝났습니다. 다시 로그인하세요.";

function isInfo(v: unknown): v is KeyInfo {
  return !!v && typeof v === "object" && typeof (v as KeyInfo).configured === "boolean";
}

// 교사 첫 화면의 'AI 연결 키': 연수 강사에게 받은 OpenRouter 키를 붙여 넣어 저장하거나 지웁니다.
// 키는 서버가 DB에 암호화해 저장하고, 화면에는 끝 네 글자만 보여 줍니다(키 값을 다시 받아 오지 않음).
// 서버 설정(환경 변수)에 키가 있으면 그 키를 쓰므로 입력 칸을 보여 주지 않습니다.
// onChange: 저장하거나 지운 뒤(교사 화면이 AI 상태를 다시 읽고, 저장했으면 'AI 연결 확인'을 저절로 함)
export default function AiKeyCard({ onChange }: { onChange?: (what: "saved" | "deleted") => void }) {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/teacher/ai-key", { cache: "no-store" })
      .then(async (res) => {
        const data: unknown = await res.json().catch(() => null);
        if (!alive) return;
        if (res.ok && isInfo(data)) {
          setInfo(data);
          setLoadMsg(null);
        } else {
          setLoadMsg(res.status === 401 ? AUTH_ERROR : `⚠ 키 상태를 확인하지 못했습니다(오류 ${res.status}).`);
        }
      })
      .catch(() => {
        if (alive) setLoadMsg(NET_ERROR);
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  async function send(method: "PUT" | "DELETE") {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/teacher/ai-key", {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ key: value.trim() }) } : {}),
      });
      const data = ((await res.json().catch(() => null)) ?? {}) as Reply;
      if (!res.ok || data.error) {
        setMsg({
          ok: false,
          text: res.status === 401 ? AUTH_ERROR : `⚠ ${typeof data.error === "string" ? data.error : `저장하지 못했습니다(오류 ${res.status}). 잠시 뒤 다시 해 보세요.`}`,
        });
        return;
      }
      const configured = data.configured ?? method === "PUT";
      setInfo((i) => ({ configured, last4: configured ? (data.last4 ?? null) : null, fromEnv: data.fromEnv ?? i?.fromEnv ?? false }));
      setLoadMsg(null);
      setValue("");
      if (method === "PUT") {
        setMsg({ ok: true, text: "키를 저장했습니다. 지금 AI 연결을 확인하고 있어요. 결과는 위 ‘AI 연결 확인’ 아래에 나옵니다." });
        onChange?.("saved");
      } else {
        setMsg({ ok: true, text: "키를 지웠습니다. 새 키를 넣기 전까지 학생들은 AI 피드백을 받을 수 없습니다." });
        onChange?.("deleted");
      }
    } catch {
      setMsg({ ok: false, text: NET_ERROR });
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!confirm("AI 연결 키를 지울까요?\n\n지우면 학생들이 AI 피드백을 받을 수 없습니다. 만다라트 쓰기와 제출은 그대로 할 수 있습니다.")) return;
    void send("DELETE");
  }

  const fromEnv = info?.fromEnv === true;
  const configured = info?.configured === true;

  return (
    <section aria-labelledby="ai-key-title" className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="ai-key-title" className="font-semibold">AI 연결 키</h2>
        {info && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${configured ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
            {configured ? `넣어 둠${info.last4 ? ` · 끝 네 글자 ${info.last4}` : ""}` : "아직 없음"}
          </span>
        )}
      </div>

      {!info && !loadMsg && <p className="text-xs text-stone-500">키 상태를 확인하는 중…</p>}
      {loadMsg && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-700">
          {loadMsg}
          <button type="button" onClick={() => { setLoadMsg(null); setReload((n) => n + 1); }} className="rounded border border-stone-300 bg-white px-2 py-0.5 text-stone-700">
            다시 확인
          </button>
        </p>
      )}

      {fromEnv ? (
        <p className="text-xs text-stone-600">
          이 앱의 서버 설정에 키가 들어 있어 그 키를 씁니다. 여기서는 바꾸거나 지울 수 없습니다.
        </p>
      ) : (
        <>
          <p className="text-xs text-stone-600">
            연수 강사에게 받은 OpenRouter 키를 붙여 넣으세요. 키는 이 앱의 데이터베이스에 암호화되어 저장되고, 화면에는 끝 네 글자만 보입니다.
            {configured && " 다른 키로 바꾸려면 새 키를 붙여 넣고 저장하세요."}
          </p>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && value.trim()) void send("PUT");
            }}
          >
            <input
              type="password"
              name="ai-key"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={configured ? "새 키 붙여 넣기" : "키 붙여 넣기 (sk-or-…)"}
              aria-label="OpenRouter 키 붙여 넣기"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              className="min-w-0 flex-1 basis-56 rounded-lg border border-stone-300 bg-white px-3 py-1.5 font-mono text-sm"
            />
            <button disabled={busy || !value.trim()}
              className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
              {busy ? "저장하는 중…" : "저장"}
            </button>
            {configured && (
              <button type="button" onClick={remove} disabled={busy}
                className="rounded-lg border border-stone-400 bg-white px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-40">
                키 지우기
              </button>
            )}
          </form>
        </>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-xs ${msg.ok ? "text-emerald-800" : "text-red-700"}`}>{msg.text}</p>}
    </section>
  );
}
