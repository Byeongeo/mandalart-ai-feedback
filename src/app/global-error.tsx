"use client";

import "./globals.css";

// 맨 바깥 레이아웃(layout.tsx)에서 오류가 났을 때 그 레이아웃 대신 보여 주는 화면. 레이아웃이 없으므로 <html>·<body>를 직접 그립니다.
// metadata를 쓸 수 없어 <title>을 직접 둡니다. 오류 내용은 화면에 보여 주지 않습니다(서버 로그에만 남음).
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <title>AI 만다라트 피드백</title>
        <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
          <div role="alert">
            <p className="text-xs text-stone-500">AI 만다라트 피드백</p>
            <h1 className="text-xl font-bold">잠시 문제가 생겼어요.</h1>
            <p className="mt-2 text-sm text-stone-600">잠시 뒤 다시 시도해 주세요.</p>
          </div>
          <button type="button" onClick={() => retry()} className="rounded-lg bg-stone-900 py-2.5 font-semibold text-white">
            다시 시도
          </button>
          <p className="text-center text-xs text-stone-500">
            선생님: 계속되면 /teacher/setup 에서 데이터베이스 연결을 확인하세요.
          </p>
        </main>
      </body>
    </html>
  );
}
