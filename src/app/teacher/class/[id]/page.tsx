import { notFound } from "next/navigation";
import Link from "next/link";
import { isUuid, requireTeacherPage } from "@/lib/auth";
import { classOverview } from "@/lib/queries";
import ClassManager from "@/components/teacher/ClassManager";
import AiStatusBanner from "@/components/teacher/AiStatusBanner";
import { toJson } from "@/components/format";

export default async function ClassPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await requireTeacherPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const overview = await classOverview(t.id, id);
  if (!overview) notFound();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 print:max-w-none print:p-0">
      <Link href="/teacher" className="text-sm text-sky-700 print:hidden">← 학급 목록</Link>
      <AiStatusBanner ai={overview.ai} />
      <ClassManager overview={toJson(overview)} />
    </main>
  );
}
