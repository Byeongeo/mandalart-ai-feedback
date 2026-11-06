// 서버 쪽 next/navigation 흉내. Worker에는 서버 화면(페이지)이 없으므로 redirect/notFound는 오류로 던집니다.
export class NavigationThrow extends Error {
  constructor(public kind: "redirect" | "notFound", public to?: string) {
    super(kind);
  }
}
export function redirect(to: string): never {
  throw new NavigationThrow("redirect", to);
}
export function notFound(): never {
  throw new NavigationThrow("notFound");
}
