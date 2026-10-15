import Link from "next/link";
import TeacherLoginForm from "@/components/teacher/TeacherLoginForm";

export default function TeacherLogin() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div>
        <p className="text-xs text-stone-500">AI 만다라트 피드백</p>
        <h1 className="text-xl font-bold">교사 로그인</h1>
      </div>
      <TeacherLoginForm />
      <div className="flex flex-col gap-1 text-center text-xs text-stone-500">
        <Link href="/teacher/setup" className="underline">처음 설치했나요? 첫 교사 계정 만들기</Link>
        <Link href="/teacher/setup" className="underline">비밀번호를 잊었나요? 설정 코드로 다시 정하기</Link>
        <Link href="/" className="underline">학생 로그인 화면으로</Link>
      </div>
    </main>
  );
}
