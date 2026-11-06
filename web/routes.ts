// 화면 목록. 화면마다 코드 조각을 따로 만들어(React.lazy) 학생 화면이 교사 화면 코드를 받지 않게 합니다.
// view: 그 화면이 처음 그릴 때와 router.refresh() 때 받는 데이터 주소(worker/views.ts). 없으면 데이터 없이 그립니다.
import type { ComponentType } from "react";
import type { Params } from "./nav";

export type RouteDef = {
  path: string;
  load: () => Promise<{ default: ComponentType }>;
  view?: (p: Params) => string;
};

/** 화면 코드 조각을 받지 못함(앱 업데이트로 옛 조각이 없어졌거나 인터넷이 끊김). '다시 시도'는 페이지를 새로 엽니다. */
export class ChunkLoadError extends Error {}

function chunk(f: () => Promise<{ default: ComponentType }>) {
  let p: Promise<{ default: ComponentType }> | null = null;
  return () =>
    (p ??= f().catch((e: unknown) => {
      p = null;
      throw new ChunkLoadError(e instanceof Error ? e.message : String(e));
    }));
}

const id = (p: Params, k: string) => encodeURIComponent(p[k] ?? "");

export const ROUTES: RouteDef[] = [
  { path: "/", load: chunk(() => import("./pages/Home")), view: () => "/api/view/home" },
  { path: "/student", load: chunk(() => import("./pages/Student")), view: () => "/api/view/student" },
  { path: "/teacher", load: chunk(() => import("./pages/teacher/TeacherHome")), view: () => "/api/view/teacher" },
  { path: "/teacher/login", load: chunk(() => import("./pages/teacher/TeacherLogin")) },
  { path: "/teacher/setup", load: chunk(() => import("./pages/teacher/TeacherSetup")) },
  {
    path: "/teacher/class/:id",
    load: chunk(() => import("./pages/teacher/ClassPage")),
    view: (p) => `/api/view/teacher/class/${id(p, "id")}`,
  },
  {
    path: "/teacher/class/:id/student/:sid",
    load: chunk(() => import("./pages/teacher/StudentDetail")),
    view: (p) => `/api/view/teacher/class/${id(p, "id")}/student/${id(p, "sid")}`,
  },
];
