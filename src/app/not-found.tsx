import Link from "next/link";

// 없는 주소로 들어왔을 때(또는 지워진 학급·학생 화면에서 notFound()가 불렸을 때) 보여 주는 화면. 학생과 교사가 모두 봅니다.
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div>
        <p className="text-xs text-stone-500">AI 만다라트 피드백</p>
        <h1 className="text-xl font-bold">찾는 화면이 없어요.</h1>
        <p className="mt-2 text-sm text-stone-600">지워졌거나 주소가 바뀌었을 수 있어요.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Link href="/" className="rounded-lg bg-stone-900 py-2.5 text-center font-semibold text-white">
          학생 첫 화면
        </Link>
        <Link href="/teacher" className="rounded-lg border border-stone-300 bg-white py-2.5 text-center font-semibold">
          교사 화면
        </Link>
      </div>
    </main>
  );
}
