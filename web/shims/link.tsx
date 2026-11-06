// next/link 흉내: 보통 <a>이고, 그냥 누르면 페이지를 다시 받지 않고 화면만 바꿉니다(web/router.tsx).
// Ctrl·Cmd·Shift·Alt를 누른 채 누르기, 가운데 버튼, target="_blank", download는 브라우저가 평소처럼 엽니다.
import type { AnchorHTMLAttributes, MouseEvent, Ref } from "react";
import { router } from "../nav";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string | { pathname?: string; search?: string; hash?: string };
  replace?: boolean;
  scroll?: boolean;
  /** Next의 미리 받기 설정. 여기서는 마우스를 올리면 화면 코드만 미리 받습니다(데이터는 받지 않음). */
  prefetch?: boolean | null | "auto";
  ref?: Ref<HTMLAnchorElement>;
};

function toHref(h: Props["href"]): string {
  return typeof h === "string" ? h : `${h.pathname ?? ""}${h.search ?? ""}${h.hash ?? ""}`;
}

function isPlainClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export default function Link({ href, replace, scroll, prefetch, onClick, onMouseEnter, ref, target, download, ...rest }: Props) {
  const to = toHref(href);
  return (
    <a
      {...rest}
      ref={ref}
      href={to}
      target={target}
      download={download}
      onMouseEnter={(e) => {
        onMouseEnter?.(e);
        if (prefetch !== false) router.prefetch(to);
      }}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !isPlainClick(e) || (target && target !== "_self") || download !== undefined) return;
        // 다른 사이트 주소는 브라우저에 맡깁니다.
        let url: URL;
        try {
          url = new URL(to, window.location.href);
        } catch {
          return;
        }
        if (url.origin !== window.location.origin) return;
        e.preventDefault();
        router.navigate(url.pathname + url.search + url.hash, { replace, scroll });
      }}
    />
  );
}
