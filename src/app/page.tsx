import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { currentStudent } from "@/lib/auth";
import { withRo } from "@/lib/student";
import StudentLoginForm from "@/components/StudentLoginForm";
import LogoutButton from "@/components/LogoutButton";

export default async function Home() {
  const s = await getSession();
  if (s?.role === "teacher") redirect("/teacher");
  // 공용 기기: 앞 학생의 로그인이 남아 있으면 바로 들어가지 않고 누구로 계속할지 먼저 묻습니다.
  const st = s?.role === "student" ? await currentStudent() : null;
  if (st) {
    const who = `${st.number}번 ${st.name ?? ""}`.trim();
    return (
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
        <div>
          <p className="text-sm text-stone-600">{st.class_name}</p>
          <h1 className="mt-1 text-2xl font-bold">{withRo(who)} 계속할까요?</h1>
          <p className="mt-2 text-sm text-stone-600">내가 아니면 &lsquo;다른 학생이에요&rsquo;를 누르고 내 번호와 이름으로 다시 들어와요.</p>
        </div>
        <div className="flex flex-col gap-3">
          <Link href="/student" className="rounded-lg bg-stone-900 py-3 text-center font-semibold text-white">
            계속하기
          </Link>
          <LogoutButton label="다른 학생이에요" large />
        </div>
      </main>
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-4 py-12">
      <div>
        <h1 className="text-2xl font-bold">AI 만다라트 피드백</h1>
        <p className="mt-2 text-sm text-stone-600">선생님께 받은 안내 카드를 보고 학급 코드, 번호, 이름, PIN을 입력하세요.</p>
      </div>
      <StudentLoginForm />
      <Link href="/teacher/login" className="text-center text-xs text-stone-500 underline">
        교사 로그인
      </Link>
    </main>
  );
}
