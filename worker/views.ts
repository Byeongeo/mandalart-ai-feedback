// 화면 데이터 주소(/api/view/...). 원래 Next.js 서버 화면(src/app/**/page.tsx)이 DB에서 읽던 것을 JSON으로 돌려줍니다.
// 화면(web/pages)은 처음 그릴 때와 router.refresh() 때 이 주소를 부릅니다.
//
// 답의 모양
// - 200: 화면 데이터(시각은 ISO 문자열. c.json이 Date를 바꿈)
// - 401 {error, redirect}: 로그인이 안 되어 있음(학생 → "/", 교사 → "/teacher/login"). 화면이 그 주소로 갑니다.
// - 200 {redirect}: 다른 화면으로 보내기(교사가 학생 첫 화면을 열었을 때 → "/teacher")
// - 404 {error}: 없거나 이 교사의 학급·학생이 아님
// 학생 PIN은 교사 화면 데이터(학급 화면: 안내 카드와 'PIN 보기')에만 넣습니다.
import type { Hono } from "hono";
import type { AppEnv } from "../src/lib/request-context";
import { CLASS_CLOSED_MESSAGE, currentStudent, currentTeacher, isUuid } from "../src/lib/auth";
import { getSession } from "../src/lib/session";
import { classOverview, listClasses, studentDetail, studentHome } from "../src/lib/queries";
import { aiStatus } from "../src/lib/feedback/client";
import { ensureAiKey } from "../src/lib/ai-key";

const LOGIN_AGAIN = "다시 로그인해 주세요.";
const NOT_FOUND = "찾을 수 없어요.";

export function viewRoutes(app: Hono<{ Bindings: AppEnv }>) {
  // 학생 첫 화면(원래 src/app/page.tsx): 교사로 로그인해 있으면 교사 화면으로. 학생 로그인이 남아 있으면 '누구로 계속할까요?'
  app.get("/api/view/home", async (c) => {
    const s = await getSession();
    if (s?.role === "teacher") return c.json({ redirect: "/teacher" });
    const st = s?.role === "student" ? await currentStudent() : null;
    return c.json({ student: st ? { number: st.number, name: st.name, class_name: st.class_name } : null });
  });

  // 학생 화면(원래 src/app/student/page.tsx): Editor에 넘길 값 그대로
  app.get("/api/view/student", async (c) => {
    const st = await currentStudent();
    if (!st) return c.json({ error: LOGIN_AGAIN, redirect: "/" }, 401);
    const home = await studentHome(st);
    return c.json({
      mandalartId: home.mandalart.id,
      initialContent: home.mandalart.content,
      initialRevision: home.mandalart.revision,
      submitted: home.mandalart.status === "submitted",
      header: `${st.class_name} ${st.number}번 ${st.name}`,
      maxRounds: st.max_feedback_rounds,
      initialRounds: home.rounds,
      aiReady: home.aiReady,
      closedMessage: st.is_open ? null : CLASS_CLOSED_MESSAGE,
    });
  });

  // 교사 첫 화면(원래 src/app/teacher/page.tsx)
  app.get("/api/view/teacher", async (c) => {
    const t = await currentTeacher();
    if (!t) return c.json({ error: LOGIN_AGAIN, redirect: "/teacher/login" }, 401);
    const classes = await listClasses(t.id);
    await ensureAiKey(); // aiStatus가 교사 화면에서 넣은 AI 키(DB)를 볼 수 있게
    const ai = aiStatus();
    return c.json({ teacher: { display_name: t.display_name }, classes, ai });
  });

  // 학급 화면(원래 src/app/teacher/class/[id]/page.tsx)
  app.get("/api/view/teacher/class/:id", async (c) => {
    const t = await currentTeacher();
    if (!t) return c.json({ error: LOGIN_AGAIN, redirect: "/teacher/login" }, 401);
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: NOT_FOUND }, 404);
    const overview = await classOverview(t.id, id);
    if (!overview) return c.json({ error: NOT_FOUND }, 404);
    return c.json({ overview });
  });

  // 학생 한 명 보기(원래 src/app/teacher/class/[id]/student/[sid]/page.tsx). 이 화면은 PIN을 쓰지 않으므로 빼고 보냅니다.
  app.get("/api/view/teacher/class/:id/student/:sid", async (c) => {
    const t = await currentTeacher();
    if (!t) return c.json({ error: LOGIN_AGAIN, redirect: "/teacher/login" }, 401);
    const id = c.req.param("id");
    const sid = c.req.param("sid");
    if (!isUuid(id) || !isUuid(sid)) return c.json({ error: NOT_FOUND }, 404);
    const d = await studentDetail(t.id, id, sid);
    if (!d) return c.json({ error: NOT_FOUND }, 404);
    const { pin, ...student } = d.student;
    void pin;
    return c.json({ detail: { ...d, student } });
  });
}
