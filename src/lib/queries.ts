import "server-only";
import { sql } from "./db";
import { MandalartContent, emptyContent, stageProgress, type RoundSummary, type Target } from "./mandalart";
import { loadRoundsForMandalart, type RoundView } from "./feedback/round";
import { aiStatus } from "./feedback/client";
import type { StudentRow } from "./auth";
import { CONCERN_KIND_KEYS, type Category, type ConcernKind, type RejectReason } from "./feedback/categories";
import { ruleConcernsByKind, type RuleConcern } from "./concern-rules";
import type { SchoolLevel } from "./school-level";

// 화면(서버 컴포넌트)과 API가 함께 쓰는 읽기 함수 모음. 화면은 sql을 직접 쓰지 말고 이 함수들을 쓰세요.

// ── 학생 ──────────────────────────────────────────────────────

export type MandalartRow = {
  id: string;
  content: MandalartContent;
  status: "draft" | "submitted";
  submitted_at: Date | null;
  updated_at: Date;
};

/** 학생 화면용: revision은 저장 번호(학생 화면이 저장·제출할 때 함께 보내 오래된 화면이 새 글을 덮어쓰지 못하게 함, src/lib/save-rules.ts) */
export type StudentMandalart = MandalartRow & { revision: number };

/** 학생의 만다라트(학생당 1개). 없으면 빈 만다라트를 만들어 돌려줍니다. */
export async function getOrCreateMandalart(studentId: string): Promise<StudentMandalart> {
  await sql`insert into mandalarts (student_id, content) values (${studentId}, ${sql.json(emptyContent())})
            on conflict (student_id) do nothing`;
  const [m] = await sql<(Omit<StudentMandalart, "content"> & { content: unknown })[]>`
    select id, content, status, submitted_at, updated_at, revision from mandalarts where student_id = ${studentId}`;
  return { ...m, content: MandalartContent.parse(m.content) };
}

export type StudentHome = {
  student: { id: string; number: number; name: string; class_name: string; is_open: boolean; max_feedback_rounds: number };
  mandalart: StudentMandalart;
  rounds: RoundView[];
  /** false면 교사가 아직 AI 키를 넣지 않음(피드백 버튼을 눌러도 안내 문구만 나옴) */
  aiReady: boolean;
};

/** 학생 첫 화면에 필요한 모든 것 */
export async function studentHome(st: StudentRow): Promise<StudentHome> {
  const mandalart = await getOrCreateMandalart(st.id);
  const rounds = await loadRoundsForMandalart(mandalart.id);
  return {
    student: { id: st.id, number: st.number, name: st.name, class_name: st.class_name, is_open: st.is_open, max_feedback_rounds: st.max_feedback_rounds },
    mandalart,
    rounds,
    aiReady: aiStatus().keyConfigured,
  };
}

// ── 교사: 학급 목록 ───────────────────────────────────────────

export type ClassListItem = {
  id: string;
  name: string;
  class_code: string;
  is_open: boolean;
  max_feedback_rounds: number;
  /** 학생 PIN 사용(false면 학급 코드·번호·이름만으로 들어옴) */
  require_pin: boolean;
  /** 학교급(AI 진단 기준과 카드 질문 수준) */
  school_level: SchoolLevel;
  created_at: Date;
  n_students: number;
  n_submitted: number;
  /** 살펴볼 학생 수: 안전 신호(규칙 신호 또는 AI 회차 신호)가 교사의 '확인했어요' 뒤에 생긴(또는 아직 확인하지 않은) 학생 */
  n_concern_students: number;
};

// '살펴볼 학생' 기준(첫 화면 배지, 학급 화면 상자·표 강조가 함께 씀): 표현 검사에 걸린 시각(rule_concern_at)이나
// AI 신호 회차가 students.concern_reviewed_at보다 뒤면 살펴볼 학생입니다. 확인한 뒤 새로 걸리면 다시 셉니다.
// 조각(fragment)으로 나눌 수 없어(db.ts 참고) listClasses와 classOverview에 같은 조건을 그대로 씁니다. 고칠 때 둘 다 고치세요.

export async function listClasses(teacherId: string): Promise<ClassListItem[]> {
  return sql<ClassListItem[]>`
    select c.id, c.name, c.class_code, c.is_open, c.max_feedback_rounds, c.require_pin, c.school_level, c.created_at,
      (select count(*)::int from students s where s.class_id = c.id) as n_students,
      (select count(*)::int from students s join mandalarts m on m.student_id = s.id
         where s.class_id = c.id and m.status = 'submitted') as n_submitted,
      (select count(*)::int from students s join mandalarts m on m.student_id = s.id
         where s.class_id = c.id and (m.rule_concern_at > coalesce(s.concern_reviewed_at, '-infinity')
           or exists (select 1 from feedback_rounds r where r.mandalart_id = m.id and r.concern
                        and r.created_at > coalesce(s.concern_reviewed_at, '-infinity')))) as n_concern_students
    from classes c where c.teacher_id = ${teacherId} order by c.created_at`;
}

// ── 교사: 학급 화면 ───────────────────────────────────────────

// ── 규칙 기반 안전 신호(src/lib/concern-rules.ts) ─────────────────
// 기록(DB, save-mandalart.ts가 저장할 때마다 적음)과 지금 글을 나눠 보여 줍니다. 둘이 다를 수 있으니 섞어 쓰지 마세요.
// - kind: 지금까지 걸린 것 중 가장 무거운 종류(기록). 학생이 그 표현을 지워도, 더 가벼운 표현만 남아도 바뀌지 않습니다.
// - at: 새 표현(새 종류나 새 칸 글)이 마지막으로 걸린 시각(기록). '살펴볼 학생' 기준에 씁니다.
// - now: 지금 글에서 걸리는 종류와 칸(무거운 순). 지금 내용으로 다시 계산하며, 지웠으면 빈 배열입니다.
// - kind_now: 기록된 종류(kind)가 지금 글에도 있는지. false면 화면에 '(지금 글에는 없음)'을 붙입니다.
// - reviewed: 교사가 '확인했어요'를 누른 뒤로 새로 걸리지 않았음(DB가 계산).
export type RuleConcernView = { kind: ConcernKind; at: Date | null; now: RuleConcern[]; kind_now: boolean; reviewed: boolean };

function ruleConcernView(kind: ConcernKind | null, at: Date | null, content: unknown, reviewed: boolean): RuleConcernView | null {
  if (!kind) return null;
  const parsed = MandalartContent.safeParse(content);
  const now = parsed.success ? ruleConcernsByKind(parsed.data) : [];
  return { kind, at, now, kind_now: now.some((g) => g.kind === kind), reviewed };
}

export type ClassInfo = {
  id: string; name: string; class_code: string; is_open: boolean; max_feedback_rounds: number;
  /** 학생 PIN 사용(false면 학급 코드·번호·이름만으로 들어옴. 학생 PIN은 지우지 않고 그대로 둠) */
  require_pin: boolean;
  /** 학교급(AI 진단 기준과 카드 질문 수준). 바꾸면 그다음 피드백부터 적용 */
  school_level: SchoolLevel;
  created_at: Date;
};

export type StudentProgress = {
  id: string;
  number: number;
  name: string;
  /** 4자리 PIN(없으면 null). 교사 화면·안내 카드에만 보여 주세요. */
  pin: string | null;
  /** 로그인을 여러 번 틀려 잠겨 있음(학생 PIN을 끈 학급에서는 잠금을 쓰지 않으므로 화면에 보이지 않음) */
  locked: boolean;
  mandalart_id: string | null;
  /** null = 아직 들어오지 않음 */
  status: "draft" | "submitted" | null;
  submitted_at: Date | null;
  updated_at: Date | null;
  /** 채운 칸 수(0~73: 중심 1 + 세부 8 + 실천 64) */
  filled: number;
  /** 받은 피드백 횟수(확인 피드백 포함) */
  rounds: number;
  /** 카드 수와, 마지막 응답 기준 '해 볼게요'/'안 할래요' 수 */
  cards: number;
  accepted: number;
  rejected: number;
  /** 단계 진행: 중심·세부 목표 완료, 끝낸 블록 수(0~8), 전체 피드백 완료 */
  core_done: boolean;
  blocks_done: number;
  whole_done: boolean;
  /** AI 안전 신호가 붙은 피드백 회차 수 */
  concern_count: number;
  /** 규칙 기반 안전 신호(없으면 null) */
  rule_concern: RuleConcernView | null;
  /** 교사가 안전 신호를 '확인했어요'로 표시한 시각(없으면 null) */
  concern_reviewed_at: Date | null;
  /** 살펴볼 학생: 아직 확인하지 않았거나 확인한 뒤 새로 생긴 안전 신호가 있음(첫 화면 배지와 같은 기준) */
  needs_review: boolean;
};

/** 살펴볼 AI 신호를 학생별로 묶은 것(마지막 신호가 최근인 순). 확인한 뒤의 회차만 셉니다. */
export type AiConcernGroup = {
  student_id: string;
  number: number;
  /** 붙은 종류(겹치지 않게, 종류 순서대로) */
  kinds: ConcernKind[];
  /** 신호가 붙은 피드백 횟수 */
  count: number;
  last_at: Date;
  /** 전에 '확인했어요'를 누른 뒤 새로 생긴 신호인지 */
  after_review: boolean;
};

/** 살펴볼 규칙 기반 안전 신호가 있는 학생(최근 순). after_review: 전에 '확인했어요'를 누른 뒤 새로 걸렸는지 */
export type RuleConcernItem = { student_id: string; number: number; after_review: boolean } & RuleConcernView;

export type ClassOverview = {
  cls: ClassInfo;
  students: StudentProgress[];
  /** 살펴볼 AI 안전 신호(학생별로 묶음). 진단이 아니라 교사가 직접 살펴보라는 힌트입니다. */
  aiConcerns: AiConcernGroup[];
  /** 살펴볼 규칙 기반 안전 신호가 있는 학생(최근 순). AI와 별개로 자동 저장·제출 때마다 검사합니다. */
  ruleConcerns: RuleConcernItem[];
  /** 만다라트를 쓰기 시작한 학생이 있는지(명렬표 다시 올리기에서 이름 변경 확인에 씀) */
  hasWork: boolean;
  ai: { keyConfigured: boolean; mock: boolean; model: string };
};

/** 학급 화면 전체 자료. 교사의 학급이 아니면 null. */
export async function classOverview(teacherId: string, classId: string): Promise<ClassOverview | null> {
  const [cls] = await sql<ClassInfo[]>`
    select id, name, class_code, is_open, max_feedback_rounds, require_pin, school_level, created_at
    from classes where id = ${classId} and teacher_id = ${teacherId}`;
  if (!cls) return null;

  const rows = await sql<(Omit<StudentProgress, "core_done" | "blocks_done" | "whole_done" | "rule_concern" | "needs_review"> & {
    content: unknown; rule_concern_kind: ConcernKind | null; rule_concern_at: Date | null; rule_new: boolean; ai_new: boolean;
  })[]>`
    select s.id, s.number, s.name, s.pin, m.content, m.rule_concern_kind, m.rule_concern_at, s.concern_reviewed_at,
      -- '살펴볼 학생' 기준(listClasses와 같게 유지)
      coalesce(m.rule_concern_at > coalesce(s.concern_reviewed_at, '-infinity'), false) as rule_new,
      exists (select 1 from feedback_rounds r where r.mandalart_id = m.id and r.concern
                and r.created_at > coalesce(s.concern_reviewed_at, '-infinity')) as ai_new,
      (s.locked_until is not null and s.locked_until > now()) as locked,
      m.id as mandalart_id, m.status, m.submitted_at, m.updated_at,
      ((select count(*) from jsonb_array_elements_text(m.content->'subs') x where trim(x) <> '')
       + (select count(*) from jsonb_array_elements(m.content->'actions') a, jsonb_array_elements_text(a) y where trim(y) <> '')
       + (case when trim(m.content->>'goal') <> '' then 1 else 0 end))::int as filled,
      (select count(*)::int from feedback_rounds r where r.mandalart_id = m.id) as rounds,
      coalesce(cnt.cards, 0) as cards, coalesce(cnt.accepted, 0) as accepted, coalesce(cnt.rejected, 0) as rejected,
      (select count(*)::int from feedback_rounds r where r.mandalart_id = m.id and r.concern) as concern_count
    from students s
    left join mandalarts m on m.student_id = s.id
    left join lateral (
      select count(*)::int as cards,
        count(*) filter (where lr.action = 'accept')::int as accepted,
        count(*) filter (where lr.action = 'reject')::int as rejected
      from feedback_rounds r join feedback_cards c on c.round_id = r.id
      left join lateral (
        select fr.action from feedback_responses fr where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1
      ) lr on true
      where r.mandalart_id = m.id
    ) cnt on true
    where s.class_id = ${classId} order by s.number`;

  const summaries = await sql<(RoundSummary & { student_id: string })[]>`
    select m.student_id, r.stage, r.block_index, r.attempt,
      (select count(*)::int from feedback_cards c where c.round_id = r.id and c.kind = 'issue') as n_cards,
      (select count(*)::int from feedback_cards c where c.round_id = r.id and c.kind = 'issue'
         and (select fr.action from feedback_responses fr where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1) = 'reject') as n_rejected
    from feedback_rounds r join mandalarts m on m.id = r.mandalart_id join students s on s.id = m.student_id
    where s.class_id = ${classId} order by r.round_no`;

  // 확인한 뒤(또는 아직 확인하지 않은) AI 신호 회차만 학생별로 묶습니다. 종류가 없는 신호는 '기타'로 셉니다.
  const aiRows = await sql<(Omit<AiConcernGroup, "kinds"> & { kinds: ConcernKind[] })[]>`
    select s.id as student_id, s.number, array_agg(distinct coalesce(r.concern_kind, 'other')) as kinds,
      count(*)::int as count, max(r.created_at) as last_at, (s.concern_reviewed_at is not null) as after_review
    from feedback_rounds r join mandalarts m on m.id = r.mandalart_id join students s on s.id = m.student_id
    where s.class_id = ${classId} and r.concern and r.created_at > coalesce(s.concern_reviewed_at, '-infinity')
    group by s.id order by last_at desc`;
  const aiConcerns: AiConcernGroup[] = aiRows.map((g) => ({
    ...g,
    kinds: CONCERN_KIND_KEYS.filter((k) => g.kinds.includes(k)),
  }));

  const students: StudentProgress[] = rows.map((r) => {
    const { content, rule_concern_kind, rule_concern_at, rule_new, ai_new, ...rest } = r;
    const p = stageProgress(summaries.filter((x) => x.student_id === r.id), cls.max_feedback_rounds);
    return {
      ...rest, core_done: p.coreDone, blocks_done: p.blocksDone, whole_done: p.wholeDone,
      rule_concern: ruleConcernView(rule_concern_kind, rule_concern_at, content, !rule_new),
      needs_review: rule_new || ai_new,
    };
  });
  const ruleConcerns: RuleConcernItem[] = students
    .filter((st) => st.rule_concern && !st.rule_concern.reviewed)
    .map((st) => ({ student_id: st.id, number: st.number, after_review: st.concern_reviewed_at !== null, ...st.rule_concern! }))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  return {
    cls,
    students,
    aiConcerns,
    ruleConcerns,
    hasWork: await classHasWork(classId),
    ai: aiStatus(),
  };
}

/** 만다라트를 한 번이라도 저장했거나 제출·피드백이 있는 학생이 있는지(빈 만다라트를 열어 보기만 한 것은 제외) */
export async function classHasWork(classId: string): Promise<boolean> {
  const [{ has_work }] = await sql<{ has_work: boolean }[]>`
    select exists (
      select 1 from mandalarts m join students s on s.id = m.student_id
      where s.class_id = ${classId} and (m.status = 'submitted' or m.updated_at > m.created_at
        or exists (select 1 from feedback_rounds r where r.mandalart_id = m.id))
    ) as has_work`;
  return has_work;
}

// ── 교사: 학생 한 명 ─────────────────────────────────────────

export type TeacherCardView = {
  id: string;
  position: number;
  category: Category;
  target: Target;
  body: string;
  kind: "issue" | "resolved" | "unresolved";
  response: { action: "accept" | "reject"; reason_code: RejectReason | null; reason_text: string | null; /** ISO 문자열 */ created_at: string } | null;
};

export type TeacherRoundView = {
  id: string;
  round_no: number;
  stage: "core" | "block" | "whole";
  block_index: number | null;
  attempt: number;
  created_at: Date;
  /** 그 피드백을 요청할 때의 만다라트 */
  content_snapshot: MandalartContent;
  concern: boolean;
  concern_kind: ConcernKind | null;
  /** AI 신호가 붙었고, 교사가 그 뒤에 '확인했어요'를 눌렀음 */
  concern_reviewed: boolean;
  cards: TeacherCardView[];
};

export type StudentDetail = {
  cls: { id: string; name: string; max_feedback_rounds: number; require_pin: boolean };
  student: {
    id: string; number: number; name: string; pin: string | null; locked: boolean;
    /** 교사가 안전 신호를 '확인했어요'로 표시한 시각(없으면 null) */
    concern_reviewed_at: Date | null;
  };
  mandalart: MandalartRow | null;
  rounds: TeacherRoundView[];
  /** 규칙 기반 안전 신호(없으면 null). now에 지금 글에서 걸린 종류별 칸이 있습니다. */
  rule_concern: RuleConcernView | null;
  /** 살펴볼 학생인지(아직 확인하지 않았거나 확인한 뒤 새로 생긴 안전 신호가 있음) */
  needs_review: boolean;
  /** 이 화면에 보인 가장 늦은 안전 신호 시각. '확인했어요'를 누를 때 함께 보내, 그사이 새로 생긴 신호를 놓치지 않게 합니다. */
  concern_seen_until: Date | null;
};

/** 교사용 학생 상세(만다라트, 받은 카드 전체와 반응, 안전 신호). 교사의 학급·학생이 아니면 null. */
export async function studentDetail(teacherId: string, classId: string, studentId: string): Promise<StudentDetail | null> {
  const [st] = await sql<{
    id: string; number: number; name: string; pin: string | null; locked: boolean; concern_reviewed_at: Date | null;
    class_name: string; max_feedback_rounds: number; require_pin: boolean;
  }[]>`
    select s.id, s.number, s.name, s.pin, (s.locked_until is not null and s.locked_until > now()) as locked, s.concern_reviewed_at,
      c.name as class_name, c.max_feedback_rounds, c.require_pin
    from students s join classes c on c.id = s.class_id
    where s.id = ${studentId} and c.id = ${classId} and c.teacher_id = ${teacherId}`;
  if (!st) return null;
  // rule_new·concern_reviewed: '살펴볼 학생' 기준(listClasses와 같음)을 DB에서 계산합니다(시각을 JS로 옮기면 마이크로초가 잘림).
  const [m] = await sql<(Omit<MandalartRow, "content"> & { content: unknown; rule_concern_kind: ConcernKind | null; rule_concern_at: Date | null; rule_new: boolean })[]>`
    select m.id, m.content, m.status, m.submitted_at, m.updated_at, m.rule_concern_kind, m.rule_concern_at,
      coalesce(m.rule_concern_at > coalesce(s.concern_reviewed_at, '-infinity'), false) as rule_new
    from mandalarts m join students s on s.id = m.student_id where m.student_id = ${studentId}`;
  let rounds: TeacherRoundView[] = [];
  if (m) {
    const rs = await sql<(Omit<TeacherRoundView, "cards" | "content_snapshot"> & { content_snapshot: unknown })[]>`
      select r.id, r.round_no, r.stage, r.block_index, r.attempt, r.created_at, r.content_snapshot, r.concern, r.concern_kind,
        (r.concern and r.created_at <= coalesce(s.concern_reviewed_at, '-infinity')) as concern_reviewed
      from feedback_rounds r join mandalarts m on m.id = r.mandalart_id join students s on s.id = m.student_id
      where r.mandalart_id = ${m.id} order by r.round_no`;
    const cards = rs.length
      ? await sql<(TeacherCardView & { round_id: string })[]>`
          select c.round_id, c.id, c.position, c.category, c.target, c.body, c.kind,
            (select json_build_object('action', fr.action, 'reason_code', fr.reason_code, 'reason_text', fr.reason_text, 'created_at', fr.created_at)
               from feedback_responses fr where fr.card_id = c.id order by fr.created_at desc, fr.id desc limit 1) as response
          from feedback_cards c where c.round_id = any(${rs.map((r) => r.id)}::uuid[]) order by c.position`
      : [];
    rounds = rs.map((r) => ({
      ...r,
      content_snapshot: MandalartContent.parse(r.content_snapshot),
      cards: cards.filter((c) => c.round_id === r.id).map((c) => {
        const { round_id, ...card } = c;
        void round_id;
        return card;
      }),
    }));
  }
  let mandalart: MandalartRow | null = null;
  let rule: StudentDetail["rule_concern"] = null;
  if (m) {
    const { rule_concern_kind, rule_concern_at, rule_new, ...row } = m;
    mandalart = { ...row, content: MandalartContent.parse(row.content) };
    rule = ruleConcernView(rule_concern_kind, rule_concern_at, mandalart.content, !rule_new);
  }
  const signalTimes = [rule?.at, ...rounds.filter((r) => r.concern).map((r) => r.created_at)]
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime());
  return {
    cls: { id: classId, name: st.class_name, max_feedback_rounds: st.max_feedback_rounds, require_pin: st.require_pin },
    student: { id: st.id, number: st.number, name: st.name, pin: st.pin, locked: st.locked, concern_reviewed_at: st.concern_reviewed_at },
    mandalart,
    rounds,
    rule_concern: rule,
    needs_review: (rule !== null && !rule.reviewed) || rounds.some((r) => r.concern && !r.concern_reviewed),
    concern_seen_until: signalTimes.length ? new Date(Math.max(...signalTimes)) : null,
  };
}
