import SetupForm from "@/components/teacher/SetupForm";

// 첫 교사 계정 만들기, 교사 비밀번호 다시 정하기. 제목과 안내는 설치 상태에 따라 SetupForm이 보여 줍니다.
export default function TeacherSetup() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <SetupForm />
    </main>
  );
}
