// 작은 화면 길잡이(router). History API만 씁니다.
//
// Next.js App Router와 같게 움직이도록 만든 점:
// - 화면을 옮길 때(push/replace/뒤로 가기) 새 화면의 코드와 데이터(/api/view/...)가 준비될 때까지 지금 화면을 그대로 둡니다
//   (React transition + Suspense). 처음 열 때만 '불러오는 중'이 보입니다.
// - router.refresh()는 지금 화면의 데이터만 다시 받아 같은 컴포넌트에 새 props로 넘깁니다. 컴포넌트는 그대로 붙어 있으므로
//   입력 중인 글, 펼친 상자, '안전 신호 보기' 같은 화면 상태가 남습니다(Next의 refresh와 같음). useTransition 안에서 부르면
//   새 데이터가 들어올 때까지 isPending이 true입니다. 다시 받다가 인터넷이 끊기면 앞 데이터를 그대로 둡니다.
// - 데이터 주소가 {redirect}로 답하면(로그인이 끝남 등) 그 주소로 바꿔 가고, 404면 '찾는 화면이 없어요'를 보여 줍니다.
import { Component, Suspense, lazy, startTransition, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  LocationCtx, NotFoundSignal, ParamsCtx, RedirectSignal, ViewCtx, readLoc, router, setRouterApi,
  type Loc, type Params, type ViewOutcome,
} from "./nav";
import { ChunkLoadError, ROUTES, type RouteDef } from "./routes";
import NotFound from "./pages/NotFound";
import ErrorPage from "./pages/ErrorPage";
import Loading from "./pages/Loading";

// ── 데이터(/api/view/...) ──

const VIEW_TIMEOUT_MS = 20_000;

class ViewLoadError extends Error {
  constructor(public status: number) {
    super(`화면 데이터 오류 ${status}`);
  }
}

async function fetchView(url: string): Promise<ViewOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VIEW_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: ctrl.signal });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body.redirect === "string") return { kind: "redirect", to: body.redirect };
    if (res.status === 404) return { kind: "notFound" };
    if (!res.ok || !body) throw new ViewLoadError(res.status);
    return { kind: "ok", data: body };
  } finally {
    clearTimeout(timer);
  }
}

/** 데이터를 받습니다. prev가 있으면(새로 고침) 받지 못할 때 앞 결과를 그대로 씁니다. */
function loadView(url: string, prev?: Promise<ViewOutcome> | null): Promise<ViewOutcome> {
  const p = prev ? fetchView(url).catch(() => prev) : fetchView(url);
  // 화면 코드 조각이 오기 전에 실패하면 아직 아무도 기다리지 않으므로, '처리하지 않은 오류'로 찍히지 않게 해 둡니다(화면은 use()로 오류를 받음).
  p.catch(() => {});
  return p;
}

// ── 경로 맞추기 ──

type Compiled = RouteDef & { re: RegExp; keys: string[]; Page: ComponentType };
type Match = { route: Compiled | null; params: Params };

const COMPILED: Compiled[] = ROUTES.map((r) => {
  const keys: string[] = [];
  const src = r.path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { ...r, re: new RegExp(`^${src}$`), keys, Page: lazy(r.load) };
});

/** 주소 끝의 '/'를 뗍니다(Next와 같음). */
function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

function matchPath(pathname: string): Match {
  const path = normalize(pathname);
  for (const r of COMPILED) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params: Params = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        params[k] = m[i + 1];
      }
    });
    return { route: r, params };
  }
  return { route: null, params: {} };
}

// ── 길잡이 상태 ──

type RouterState = {
  loc: Loc;
  match: Match;
  /** 이 화면의 데이터(데이터가 없는 화면은 null) */
  view: Promise<ViewOutcome> | null;
  /** 화면을 새로 붙일 때마다 바뀌는 번호(다른 주소로 가거나 '다시 시도'를 누를 때). refresh에서는 그대로 */
  visit: number;
  scroll: boolean;
};

let visits = 0;

function enter(loc: Loc, scroll: boolean): RouterState {
  const match = matchPath(loc.pathname);
  const url = match.route?.view?.(match.params) ?? null;
  // 코드 조각과 데이터를 함께 받기 시작합니다.
  if (match.route) void match.route.load().catch(() => {});
  return { loc, match, view: url ? loadView(url) : null, visit: ++visits, scroll };
}

// 화면 하나의 오류 상자(error.tsx·not-found.tsx 자리): 다른 주소로 보내기, '없음' 화면, '잠시 문제가 생겼어요' 화면.
class RouteBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    if (error instanceof RedirectSignal) router.navigate(error.to, { replace: true });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (error instanceof RedirectSignal) return <Loading />;
    if (error instanceof NotFoundSignal) return <NotFound />;
    // 앱을 업데이트해 옛 화면 조각이 없어졌으면(또는 받다가 끊겼으면) 페이지를 새로 엽니다.
    return <ErrorPage retry={() => (error instanceof ChunkLoadError ? window.location.reload() : router.reload())} />;
  }
}

export function RouterProvider() {
  const [state, setState] = useState<RouterState>(() => enter(readLoc(), false));
  // 가장 나중에 요청한 상태(아직 그려지지 않았을 수 있음)
  const latest = useRef(state);
  // 같은 순간에 '이동 + refresh'를 부르면(로그아웃 등) 막 받기 시작한 새 화면 데이터를 한 번 더 받지 않습니다.
  const fresh = useRef(false);

  useEffect(() => {
    const n = normalize(window.location.pathname);
    if (n !== window.location.pathname) history.replaceState(history.state, "", n + window.location.search + window.location.hash);

    const go = (next: RouterState, transition: boolean) => {
      latest.current = next;
      if (transition) startTransition(() => setState(next));
      else setState(next);
    };
    const markFresh = () => {
      fresh.current = true;
      queueMicrotask(() => {
        fresh.current = false;
      });
    };

    setRouterApi({
      navigate(to, opts = {}) {
        let url: URL;
        try {
          url = new URL(to, window.location.href);
        } catch {
          return;
        }
        if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) {
          if (opts.replace) window.location.replace(url.href);
          else window.location.assign(url.href);
          return;
        }
        const href = normalize(url.pathname) + url.search + url.hash;
        if (opts.replace) history.replaceState(null, "", href);
        else history.pushState(null, "", href);
        go(enter(readLoc(), opts.scroll ?? true), true);
        markFresh();
      },
      refresh() {
        if (fresh.current) return;
        const s = latest.current;
        const url = s.match.route?.view?.(s.match.params);
        if (url) go({ ...s, view: loadView(url, s.view), scroll: false }, true);
      },
      reload() {
        go(enter(latest.current.loc, false), false);
        markFresh();
      },
      prefetch(to) {
        try {
          void matchPath(new URL(to, window.location.href).pathname).route?.load().catch(() => {});
        } catch {
          // 무시
        }
      },
    });
    const onPop = () => go(enter(readLoc(), false), true);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      setRouterApi(null);
    };
  }, []);

  // 새 화면이 그려진 뒤 맨 위로(뒤로 가기·새로 고침은 제외)
  useLayoutEffect(() => {
    if (state.scroll) window.scrollTo(0, 0);
  }, [state.visit, state.scroll]);

  const { route, params } = state.match;
  const Page = route?.Page ?? NotFound;
  return (
    <LocationCtx.Provider value={state.loc}>
      <ParamsCtx.Provider value={params}>
        <ViewCtx.Provider value={state.view}>
          {/* Suspense는 한 번만 두어(화면마다 새로 만들지 않음) 이동 중에는 앞 화면이 남게 합니다. */}
          <Suspense fallback={<Loading />}>
            <RouteBoundary key={state.visit}>
              <Page key={state.visit} />
            </RouteBoundary>
          </Suspense>
        </ViewCtx.Provider>
      </ParamsCtx.Provider>
    </LocationCtx.Provider>
  );
}

/** createRoot의 onCaughtError: 오류 상자가 받은 오류를 콘솔에 남깁니다(다른 주소로 보내기·'없음' 신호는 오류가 아니므로 남기지 않음). */
export function logCaughtError(error: unknown) {
  if (error instanceof RedirectSignal || error instanceof NotFoundSignal) return;
  console.error("[화면 오류]", error);
}

/** 맨 바깥 오류 상자(global-error.tsx 자리): 길잡이 자체가 망가졌을 때 */
export class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <ErrorPage retry={() => window.location.reload()} /> : this.props.children;
  }
}
