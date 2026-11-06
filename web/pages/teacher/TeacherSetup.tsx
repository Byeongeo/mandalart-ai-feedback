import { useEffect, useState } from "react";
import SetupForm from "@/components/teacher/SetupForm";

// 설치 프로그램은 https://<앱>/teacher/setup#code=XXXX 로 엽니다. 주소의 # 뒤는 서버로 가지 않습니다.
function codeFromHash(): string {
  const h = window.location.hash.replace(/^#/, "");
  if (!h) return "";
  try {
    return new URLSearchParams(h).get("code")?.trim() ?? "";
  } catch {
    return "";
  }
}

// 첫 교사 계정 만들기, 교사 비밀번호 다시 정하기(원래 src/app/teacher/setup/page.tsx). 제목과 안내는 설치 상태에 따라 SetupForm이 보여 줍니다.
// 주소에 #code=…가 있으면 설정 코드 칸을 미리 채우고, 주소창에서는 # 뒤를 바로 지웁니다(화면에 남거나 즐겨찾기에 저장되지 않게).
export default function TeacherSetup() {
  const [code] = useState(codeFromHash);
  useEffect(() => {
    if (window.location.hash) history.replaceState(history.state, "", window.location.pathname + window.location.search);
  }, []);
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <SetupForm initialToken={code} />
    </main>
  );
}
