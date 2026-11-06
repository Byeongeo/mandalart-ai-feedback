// 화면 길잡이의 바탕(다른 모듈이 가져다 쓰는 것만). 실제 길잡이는 router.tsx의 RouterProvider가 붙을 때 setRouterApi로 채웁니다.
// next/link·next/navigation 흉내(web/shims)와 화면(web/pages)이 여기서 가져갑니다(router.tsx와 서로 가져오지 않게 나눔).
import { createContext, use, useContext } from "react";

export type Loc = { pathname: string; search: string; hash: string };
export type Params = Record<string, string>;

/** /api/view/... 응답을 정리한 것 */
export type ViewOutcome = { kind: "ok"; data: unknown } | { kind: "redirect"; to: string } | { kind: "notFound" };

export type NavigateOptions = { replace?: boolean; scroll?: boolean };

type Api = {
  navigate: (to: string, opts?: NavigateOptions) => void;
  refresh: () => void;
  reload: () => void;
  prefetch: (to: string) => void;
};

let api: Api | null = null;

export function setRouterApi(a: Api | null) {
  api = a;
}

/** 길잡이 기능. 길잡이가 아직 붙지 않았으면 브라우저 이동으로 대신합니다. */
export const router: Api = {
  navigate: (to, opts) => {
    if (api) api.navigate(to, opts);
    else if (opts?.replace) window.location.replace(to);
    else window.location.assign(to);
  },
  refresh: () => api?.refresh(),
  reload: () => (api ? api.reload() : window.location.reload()),
  prefetch: (to) => api?.prefetch(to),
};

export function readLoc(): Loc {
  const l = window.location;
  return { pathname: l.pathname, search: l.search, hash: l.hash };
}

export const LocationCtx = createContext<Loc | null>(null);
export const ParamsCtx = createContext<Params>({});
export const ViewCtx = createContext<Promise<ViewOutcome> | null>(null);

export function useLocation(): Loc {
  return useContext(LocationCtx) ?? readLoc();
}

export function useRouteParams(): Params {
  return useContext(ParamsCtx);
}

/** 화면이 그리다 던지는 신호: 다른 주소로 보내기(로그인 화면 등). router.tsx의 RouteBoundary가 받습니다. */
export class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect ${to}`);
  }
}

/** 화면이 그리다 던지는 신호: '찾는 화면이 없어요' */
export class NotFoundSignal extends Error {
  constructor() {
    super("not found");
  }
}

/** 이 화면의 데이터(/api/view/...)를 기다려 돌려줍니다. 화면 컴포넌트 안에서만 부르세요. */
export function useView<T>(): T {
  const p = useContext(ViewCtx);
  if (!p) throw new Error("이 화면에는 데이터 주소가 없습니다(web/routes.ts).");
  const o = use(p);
  if (o.kind === "redirect") throw new RedirectSignal(o.to);
  if (o.kind === "notFound") throw new NotFoundSignal();
  return o.data as T;
}
