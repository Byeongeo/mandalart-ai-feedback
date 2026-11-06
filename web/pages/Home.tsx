import Link from "next/link";
import { useView } from "../nav";
import { withRo } from "@/lib/student";
import StudentLoginForm from "@/components/StudentLoginForm";
import LogoutButton from "@/components/LogoutButton";

/** GET /api/view/home (교사로 로그인해 있으면 {redirect:"/teacher"}) */
export type HomeView = { student: { number: number; name: string | null; class_name: string } | null };

// 학생 첫 화면(원래 src/app/page.tsx). 교사로 로그인해 있으면 교사 화면으로 갑니다(데이터 주소가 redirect로 답함).
export default function Home() {
  const { student: st } = useView<HomeView>();
  // 공용 기기: 앞 학생의 로그인이 남아 있으면 바로 들어가지 않고 누구로 계속할지 먼저 묻습니다.
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
        <p className="mt-2 text-sm text-stone-600">선생님께 받은 안내 카드를 보고 학급 코드, 번호, 이름(PIN을 받았으면 PIN도)을 입력하세요.</p>
      </div>
      <StudentLoginForm />
      <Link href="/teacher/login" className="text-center text-xs text-stone-500 underline">
        교사 로그인
      </Link>
    </main>
  );
}
