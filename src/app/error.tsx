"use client";

import Link from "next/link";

// 화면을 그리다 오류가 났을 때 보여 주는 화면(대부분 데이터베이스에 잠깐 연결하지 못한 경우).
// 학생과 교사가 모두 볼 수 있으므로 쉬운 말로 짧게 쓰고, 오류 내용은 화면에 보여 주지 않습니다(서버 로그에 남고, 브라우저 콘솔에는 React가 남김).
// '다시 시도'는 retry: 서버에서 화면을 다시 받아 그립니다(reset은 다시 받지 않고 그리기만 해서 DB 오류가 그대로 남음).
export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
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
        선생님: 계속되면 <Link href="/teacher/setup" className="underline">/teacher/setup</Link> 에서 데이터베이스 연결을 확인하세요.
      </p>
    </main>
  );
}
