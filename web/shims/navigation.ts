// next/navigation 흉내(브라우저용). 원래 컴포넌트(src/components)가 쓰는 만큼만 같은 모양으로 둡니다.
// - useRouter(): push/replace/back/forward/refresh/prefetch. refresh는 지금 화면의 데이터를 다시 받아 같은 컴포넌트에 새 props로 넘깁니다.
// - usePathname, useSearchParams, useParams
// - redirect, notFound: 화면을 그리는 중에 부르면 web/router.tsx의 오류 상자가 받아 다른 주소로 가거나 '없음' 화면을 보여 줍니다.
import { useMemo } from "react";
import { NotFoundSignal, RedirectSignal, router, useLocation, useRouteParams, type NavigateOptions } from "../nav";

export type AppRouterInstance = {
  push: (href: string, opts?: { scroll?: boolean }) => void;
  replace: (href: string, opts?: { scroll?: boolean }) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
};

const instance: AppRouterInstance = {
  push: (href, opts) => router.navigate(href, { scroll: opts?.scroll } satisfies NavigateOptions),
  replace: (href, opts) => router.navigate(href, { replace: true, scroll: opts?.scroll }),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => router.refresh(),
  prefetch: (href) => router.prefetch(href),
};

export function useRouter(): AppRouterInstance {
  return instance;
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useRouteParams() as T;
}

export function redirect(to: string): never {
  throw new RedirectSignal(to);
}

export function permanentRedirect(to: string): never {
  throw new RedirectSignal(to);
}

export function notFound(): never {
  throw new NotFoundSignal();
}
