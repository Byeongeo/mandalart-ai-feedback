"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function TeacherLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending) return;
        setPending(true);
        setError(null);
        const f = new FormData(e.currentTarget);
        let moving = false;
        try {
          const res = await fetch("/api/auth/teacher", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ loginId: f.get("loginId"), password: f.get("password") }),
          });
          if (res.ok) {
            moving = true;
            return router.replace("/teacher");
          }
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? (res.status >= 500 ? "서버 오류입니다. Vercel 로그를 확인하세요." : "로그인 실패"));
        } catch {
          setError("인터넷 연결을 확인하고 다시 시도하세요.");
        } finally {
          if (!moving) setPending(false);
        }
      }}
    >
      <input name="loginId" placeholder="아이디" aria-label="아이디" required className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base" />
      <input name="password" type="password" placeholder="비밀번호" aria-label="비밀번호" required className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base" />
      <p role="alert" className="text-sm text-red-700 empty:hidden">{error}</p>
      <button disabled={pending} className="rounded-lg bg-stone-900 py-2.5 font-semibold text-white disabled:opacity-50">
        {pending ? "확인 중…" : "로그인"}
      </button>
    </form>
  );
}
