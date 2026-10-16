import Link from "next/link";
import { requireTeacherPage } from "@/lib/auth";
import { listClasses } from "@/lib/queries";
import { aiStatus } from "@/lib/feedback/client";
import LogoutButton from "@/components/LogoutButton";
import CreateClassForm from "@/components/teacher/CreateClassForm";
import ExportButtons from "@/components/teacher/ExportButtons";
import AiStatusBanner from "@/components/teacher/AiStatusBanner";
import AppUpdate from "@/components/teacher/AppUpdateCard";

export default async function TeacherHome() {
  const t = await requireTeacherPage();
  const classes = await listClasses(t.id);
  const ai = aiStatus();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs text-stone-500">AI 만다라트 피드백 · 교사</p>
          <h1 className="text-xl font-bold">{t.display_name} 선생님</h1>
        </div>
        <LogoutButton to="/teacher/login" />
      </header>

      <AiStatusBanner ai={ai} />

      <section className="flex flex-col gap-3">
        <h2 className="font-bold">내 학급</h2>
        {classes.length === 0 && <p className="text-sm text-stone-500">아직 학급이 없습니다. 아래에서 학급을 만들어 보세요.</p>}
        <ul className="grid gap-3 sm:grid-cols-2">
          {classes.map((c) => (
            <li key={c.id} className="flex flex-col gap-3 rounded-xl border border-stone-300 bg-white p-4">
              <Link href={`/teacher/class/${c.id}`} className="group flex flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold group-hover:underline">
                  {c.name}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.is_open ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"}`}>
                    {c.is_open ? "열림" : "닫힘"}
                  </span>
                  {c.school_level === "high" && (
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800">고등학교</span>
                  )}
                  {!c.require_pin && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900"
                      title="학생 PIN을 쓰지 않는 학급입니다. 학급 코드·번호·이름만으로 들어오므로, 시범 수업이 끝나면 학급 화면에서 PIN을 다시 켜세요.">
                      PIN 끔
                    </span>
                  )}
                  {c.n_concern_students > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900"
                      title="표현 검사나 AI 신호가 붙은 학생 중 아직 ‘확인했어요’를 누르지 않았거나 그 뒤 새 신호가 생긴 학생 수입니다(진단 아님). 학급 화면에서 ‘안전 신호 보기’를 눌러 살펴보세요.">
                      ⚠️ 살펴볼 학생 {c.n_concern_students}명
                    </span>
                  )}
                </p>
                <p className="text-sm text-stone-600">
                  학급 코드 <b className="font-mono">{c.class_code}</b> · 학생 {c.n_students}명 · 제출 {c.n_submitted}명
                </p>
                <p className="text-xs text-sky-700">학급 화면 열기 →</p>
              </Link>
              <ExportButtons classId={c.id} />
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-bold">학급 만들기</h2>
        <CreateClassForm />
      </section>

      <p className="text-xs text-stone-500">
        CSV 파일에는 학생 이름이 들어 있습니다(PIN과 ⚠️ 안전 신호는 들어 있지 않음). 학교 개인정보 보관 기준에 맞게 보관하고, 메신저나 공개 드라이브에 올리지 마세요.
      </p>

      <AppUpdate />
    </main>
  );
}
