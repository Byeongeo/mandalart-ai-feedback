"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const BASE = "shrink-0 rounded-lg border border-stone-400 bg-white font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50";

// beforeLogout: 로그아웃 전에 할 일(예: 마지막 자동 저장). false를 돌려주면 로그아웃하지 않습니다.
// 오래 걸릴 수 있는 일은 beforeLogout 쪽에서 시간을 제한합니다(Editor는 저장을 길어야 20초 기다림).
export default function LogoutButton({ to = "/", beforeLogout, label = "로그아웃", large = false }: {
  to?: string;
  beforeLogout?: () => Promise<boolean>;
  label?: string;
  large?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          if (beforeLogout && !(await beforeLogout())) return;
          // 응답이 15초 안에 오지 않으면 끊고 실패로 알립니다('나가는 중…'에 멈춰 있지 않게).
          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), 15_000);
          try {
            const res = await fetch("/api/auth/logout", { method: "POST", signal: ctrl.signal });
            if (!res.ok) throw new Error(String(res.status));
          } finally {
            clearTimeout(timeout);
          }
          router.replace(to);
          router.refresh();
        } catch {
          alert("로그아웃하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.");
        } finally {
          setPending(false);
        }
      }}
      className={`${BASE} ${large ? "py-3" : "px-3 py-1.5 text-sm"}`}
    >
      {pending ? "나가는 중…" : label}
    </button>
  );
}
