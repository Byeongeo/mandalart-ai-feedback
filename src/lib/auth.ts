import "server-only";
import { redirect } from "next/navigation";
import { sql } from "./db";
import { getSession, studentPinTag, teacherPasswordTag } from "./session";
import { fingerprintMatches } from "./pin";

export type StudentRow = {
  id: string;
  class_id: string;
  number: number;
  name: string;
  class_name: string;
  /** false면 학생은 볼 수만 있고 고치기·피드백·제출은 못 함 */
  is_open: boolean;
  max_feedback_rounds: number;
};

export type TeacherRow = { id: string; login_id: string; display_name: string };

export async function currentStudent(): Promise<StudentRow | null> {
  const s = await getSession();
  // 지문(pf)이 없는 토큰(이 확인을 넣기 전에 만든 토큰 포함)은 받지 않습니다.
  if (!s || s.role !== "student" || !s.pf) return null;
  const [row] = await sql<(StudentRow & { pin: string | null; require_pin: boolean })[]>`
    select s.id, s.class_id, s.number, s.name, c.name as class_name, c.is_open, c.max_feedback_rounds, s.pin, c.require_pin
    from students s join classes c on c.id = s.class_id
    where s.id = ${s.id}`;
  if (!row) return null;
  // 'PIN 다시 만들기', 이름 고치기, 학급의 '학생 PIN 사용' 켜기·끄기를 하면 로그인할 때의 지문과 달라지므로,
  // 그 전에 열린 세션은 로그아웃된 것으로 봅니다. pin·require_pin은 비교에만 쓰고 돌려주는 값에는 넣지 않습니다.
  const { pin, require_pin, ...student } = row;
  if (!fingerprintMatches(await studentPinTag(pin, student.name, require_pin), s.pf)) return null;
  return student;
}

export async function currentTeacher(): Promise<TeacherRow | null> {
  const s = await getSession();
  if (!s || s.role !== "teacher" || !s.pf) return null;
  const [row] = await sql<(TeacherRow & { password_hash: string })[]>`
    select id, login_id, display_name, password_hash from teachers where id = ${s.id}`;
  if (!row) return null;
  // 비밀번호를 다시 정하면 그 전에 로그인한 세션은 끝납니다. 해시는 돌려주지 않습니다.
  const { password_hash, ...teacher } = row;
  if (!fingerprintMatches(await teacherPasswordTag(password_hash), s.pf)) return null;
  return teacher;
}

export async function requireStudentPage(): Promise<StudentRow> {
  const st = await currentStudent();
  if (!st) redirect("/");
  return st;
}

export async function requireTeacherPage(): Promise<TeacherRow> {
  const t = await currentTeacher();
  if (!t) redirect("/teacher/login");
  return t;
}

// 교사가 소유한 학급인지 확인
export async function ownsClass(teacherId: string, classId: string): Promise<boolean> {
  if (!isUuid(classId)) return false;
  const rows = await sql`select 1 from classes where id = ${classId} and teacher_id = ${teacherId}`;
  return rows.length > 0;
}

// 주소의 id가 uuid 모양이 아니면 DB 오류(22P02) 대신 '없음'으로 처리합니다.
export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

// 학급이 닫혀 있을 때 학생에게 보여 줄 문구
export const CLASS_CLOSED_MESSAGE = "선생님이 지금은 만다라트 쓰기를 닫아 두었어요. 볼 수만 있어요.";
