import Link from "next/link";
import { useView } from "../../nav";
import type { ClassOverview } from "@/lib/queries";
import type { Jsonify } from "@/components/format";
import ClassManager from "@/components/teacher/ClassManager";
import AiStatusBanner from "@/components/teacher/AiStatusBanner";

/** GET /api/view/teacher/class/:id (교사의 학급이 아니면 404, 로그인이 안 되어 있으면 401 {redirect}) */
export type ClassView = { overview: Jsonify<ClassOverview> };

// 학급 화면(원래 src/app/teacher/class/[id]/page.tsx). ClassManager가 30초마다·바꾼 뒤마다 router.refresh()로 이 데이터를 다시 받습니다.
export default function ClassPage() {
  const { overview } = useView<ClassView>();
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 print:max-w-none print:p-0">
      <Link href="/teacher" className="text-sm text-sky-700 print:hidden">← 학급 목록</Link>
      <AiStatusBanner ai={overview.ai} />
      <ClassManager overview={overview} />
    </main>
  );
}
