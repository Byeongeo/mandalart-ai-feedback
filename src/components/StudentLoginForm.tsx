"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const input = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base uppercase tracking-wider outline-none focus:border-stone-800 focus-visible:ring-2 focus-visible:ring-sky-600";

export default function StudentLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    let moving = false;
    try {
      const res = await fetch("/api/auth/student", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classCode: f.get("classCode"), number: f.get("number"), name: f.get("name"), pin: String(f.get("pin") ?? "") }),
      });
      if (res.ok) {
        moving = true; // 화면을 옮기는 동안 버튼을 다시 누르지 못하게 둡니다.
        return router.replace("/student");
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? (res.status >= 500 ? "서버에 문제가 있어요. 선생님께 알려 주세요." : "로그인하지 못했어요."));
    } catch {
      setError("인터넷 연결을 확인하고 다시 눌러 주세요.");
    } finally {
      if (!moving) setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        학급 코드
        <input name="classCode" required autoComplete="off" className={input} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        번호
        <input name="number" required type="number" inputMode="numeric" min={1} max={99} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        이름
        <input name="name" required autoComplete="off" className={input.replace("uppercase tracking-wider", "")} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        PIN(4자리)
        <input name="pin" required type="password" inputMode="numeric" pattern="[0-9]{4}" minLength={4} maxLength={4} autoComplete="off"
          title="숫자 4자리" aria-describedby="pin-hint" className={input} />
        <span id="pin-hint" className="text-xs font-normal text-stone-500">안내 카드에 있는 숫자 4자리예요. 친구에게 알려 주지 마세요.</span>
      </label>
      <p role="alert" className="text-sm text-red-700 empty:hidden">{error}</p>
      <button disabled={pending} className="rounded-lg bg-stone-900 py-3 font-semibold text-white disabled:opacity-50">
        {pending ? "확인 중…" : "시작하기"}
      </button>
    </form>
  );
}
