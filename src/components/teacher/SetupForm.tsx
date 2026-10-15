"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base";

type Status = {
  db: { ok: true } | { ok: false; error: string };
  tokenConfigured: boolean;
  needsSetup: boolean | null;
  /** 교사 계정이 있고 설정 코드가 준비되어 '비밀번호 다시 정하기'를 할 수 있음 */
  canReset?: boolean;
};

type Reply = { ok?: boolean; error?: string; code?: string };

// POST /api/auth/setup 실패 응답을 화면 문구로 바꿉니다(서버 문구가 있으면 그대로).
function failText(status: number, data: Reply, fallback: string): string {
  if (typeof data.error === "string" && data.error) return data.error;
  if (status === 429) return "설정 코드를 너무 많이 틀렸습니다. 15분 뒤에 다시 시도하세요.";
  if (status >= 500) return "서버 오류입니다. 잠시 뒤 다시 시도하고, 계속되면 Vercel 로그를 확인하세요.";
  return fallback;
}

async function postSetup(body: Record<string, unknown>): Promise<{ res: Response; data: Reply }> {
  const res = await fetch("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, data: (await res.json().catch(() => ({}))) as Reply };
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden="true">{ok ? "✅" : "⚠️"}</span>
      <span>{children}</span>
    </li>
  );
}

// 첫 교사 계정 만들기와 교사 비밀번호 다시 정하기(둘 다 설정 코드 SETUP_TOKEN이 필요). 열리면 먼저 설치 상태(DB 연결·표 만들기, SETUP_TOKEN, 교사 계정 유무)를 확인해 보여 줍니다.
export default function SetupForm() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/setup", { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as Status | null;
        if (!alive) return;
        if (data && typeof data === "object" && "db" in data) {
          setStatus(data);
          setLoadError(null);
        } else {
          setLoadError(`설치 상태를 확인하지 못했습니다(오류 ${res.status}). Vercel의 배포 로그를 확인하세요.`);
        }
      })
      .catch(() => {
        if (alive) setLoadError("서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  if (!status) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <Heading status={null} />
        <p className="text-stone-600">{loadError ?? "설치 상태를 확인하는 중… (처음에는 데이터베이스 표를 만드느라 몇 초 걸릴 수 있어요)"}</p>
        {loadError && (
          <button type="button" onClick={() => { setLoadError(null); setReload((n) => n + 1); }}
            className="self-start rounded-lg border border-stone-300 bg-white px-3 py-1.5">
            다시 확인
          </button>
        )}
      </div>
    );
  }

  const ready = status.db.ok && status.tokenConfigured && status.needsSetup === true;
  const resetReady = status.db.ok && status.needsSetup === false && status.canReset === true;

  return (
    <div className="flex flex-col gap-5">
      <Heading status={status} />
      <ul className="flex flex-col gap-1.5 rounded-xl border border-stone-300 bg-white p-4 text-sm">
        <Check ok={status.db.ok}>
          {status.db.ok ? "데이터베이스(Neon)에 연결했고, 필요한 표를 준비했습니다." : status.db.error}
        </Check>
        <Check ok={status.tokenConfigured}>
          {status.tokenConfigured
            ? "설정 코드(SETUP_TOKEN)가 준비되어 있습니다."
            : "설정 코드(SETUP_TOKEN)가 없거나 16자보다 짧습니다. Vercel → Settings → Environment Variables에 넣고 Redeploy하세요."}
        </Check>
        {status.needsSetup === false && (
          <Check ok>이미 교사 계정이 있습니다. <Link href="/teacher/login" className="text-sky-700 underline">교사 로그인</Link>으로 들어가세요.
            {resetReady && " 비밀번호를 잊었다면 아래에서 다시 정할 수 있습니다."}</Check>
        )}
      </ul>

      {!ready && !resetReady && (
        <button type="button" onClick={() => { setStatus(null); setReload((n) => n + 1); }}
          className="self-start rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm">
          다시 확인
        </button>
      )}

      {ready && (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending) return;
            const f = new FormData(e.currentTarget);
            if (f.get("password") !== f.get("password2")) return setError("비밀번호가 서로 다릅니다.");
            setPending(true);
            setError(null);
            let moving = false;
            try {
              const { res, data } = await postSetup({
                token: f.get("token"),
                loginId: f.get("loginId"),
                displayName: f.get("displayName"),
                password: f.get("password"),
              });
              if (res.ok) {
                moving = true;
                setDone("교사 계정을 만들었습니다. 교사 화면으로 이동합니다…");
                return router.replace("/teacher");
              }
              setError(failText(res.status, data, "만들지 못했습니다."));
            } catch {
              setError("인터넷 연결을 확인하고 다시 시도하세요.");
            } finally {
              if (!moving) setPending(false);
            }
          }}
        >
          <input name="token" placeholder="설정 코드 (Vercel에 넣은 SETUP_TOKEN 값)" aria-label="설정 코드" required autoComplete="off" className={input} />
          <input name="loginId" placeholder="아이디 (3자 이상)" aria-label="아이디" required minLength={3} maxLength={50} autoComplete="username" className={input} />
          <input name="displayName" placeholder="표시 이름 (예: 홍길동)" aria-label="표시 이름" required maxLength={30} className={input} />
          <input name="password" type="password" placeholder="비밀번호 (10자 이상)" aria-label="비밀번호" required minLength={10} autoComplete="new-password" className={input} />
          <input name="password2" type="password" placeholder="비밀번호 확인" aria-label="비밀번호 확인" required minLength={10} autoComplete="new-password" className={input} />
          <p role="alert" className="text-sm text-red-700 empty:hidden">{error}</p>
          {done && <p role="status" className="text-sm font-semibold text-emerald-700">{done}</p>}
          <button disabled={pending} className="rounded-lg bg-stone-900 py-2.5 font-semibold text-white disabled:opacity-50">
            {pending ? "만드는 중…" : "교사 계정 만들기"}
          </button>
        </form>
      )}

      {status.db.ok && status.needsSetup === false && !status.canReset && (
        <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">
          비밀번호를 잊었다면: Vercel → Settings → Environment Variables에 설정 코드(SETUP_TOKEN, 16자 이상)를 넣고 Redeploy한 뒤,
          이 화면에서 &lsquo;비밀번호 다시 정하기&rsquo;를 할 수 있습니다.
        </p>
      )}

      {resetReady && (
        <form
          className="flex flex-col gap-3 rounded-xl border border-stone-300 bg-white p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending) return;
            const f = new FormData(e.currentTarget);
            if (f.get("password") !== f.get("password2")) return setError("새 비밀번호가 서로 다릅니다.");
            setPending(true);
            setError(null);
            let moving = false;
            try {
              const { res, data } = await postSetup({
                mode: "reset",
                token: f.get("token"),
                loginId: f.get("loginId"),
                password: f.get("password"),
              });
              if (res.ok) {
                moving = true;
                setDone("비밀번호를 새로 정했습니다. 다른 기기에 남아 있던 교사 로그인은 끝났습니다. 교사 화면으로 이동합니다…");
                return router.replace("/teacher");
              }
              setError(failText(res.status, data, "비밀번호를 바꾸지 못했습니다."));
            } catch {
              setError("인터넷 연결을 확인하고 다시 시도하세요.");
            } finally {
              if (!moving) setPending(false);
            }
          }}
        >
          <div>
            <h2 className="font-semibold">비밀번호 다시 정하기</h2>
            <p className="mt-1 text-xs text-stone-600">
              교사 비밀번호를 잊었을 때 씁니다. Vercel에 넣은 설정 코드(SETUP_TOKEN)와 교사 아이디가 있어야 합니다.
              바꾸면 바로 교사 화면으로 들어가고, 다른 기기에 남아 있던 교사 로그인은 끝납니다. 학급과 학생 자료는 그대로입니다.
            </p>
          </div>
          <input name="token" placeholder="설정 코드 (Vercel에 넣은 SETUP_TOKEN 값)" aria-label="설정 코드" required autoComplete="off" className={input} />
          <input name="loginId" placeholder="교사 아이디" aria-label="교사 아이디" required maxLength={50} autoComplete="username" className={input} />
          <input name="password" type="password" placeholder="새 비밀번호 (10자 이상)" aria-label="새 비밀번호" required minLength={10} autoComplete="new-password" className={input} />
          <input name="password2" type="password" placeholder="새 비밀번호 확인" aria-label="새 비밀번호 확인" required minLength={10} autoComplete="new-password" className={input} />
          <p role="alert" className="text-sm text-red-700 empty:hidden">{error}</p>
          {done && <p role="status" className="text-sm font-semibold text-emerald-700">{done}</p>}
          <button disabled={pending} className="rounded-lg bg-stone-900 py-2.5 font-semibold text-white disabled:opacity-50">
            {pending ? "바꾸는 중…" : "비밀번호 다시 정하기"}
          </button>
        </form>
      )}
    </div>
  );
}

// 화면 제목: 교사 계정이 이미 있으면 '비밀번호 다시 정하기', 아니면 '첫 교사 계정 만들기'
function Heading({ status }: { status: Status | null }) {
  const exists = status?.needsSetup === false;
  return (
    <div>
      <h1 className="text-xl font-bold">{exists ? "교사 계정 · 비밀번호 다시 정하기" : "첫 교사 계정 만들기"}</h1>
      <p className="mt-2 text-sm text-stone-600">
        {exists
          ? "이 앱에는 이미 교사 계정이 있습니다. 비밀번호를 잊었을 때만 이 화면에서 설정 코드(SETUP_TOKEN)로 새 비밀번호를 정하세요."
          : "배포한 뒤 한 번만 씁니다. Vercel에 넣은 설정 코드(SETUP_TOKEN)가 있어야 하고, 교사 계정이 이미 있으면 만들 수 없습니다."}
      </p>
    </div>
  );
}
