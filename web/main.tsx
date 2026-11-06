// 학생·교사 화면의 입구(Vite). 원래 Next.js 레이아웃(src/app/layout.tsx)의 자리입니다: 전체 스타일(globals.css)과 화면 길잡이.
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { RootBoundary, RouterProvider, logCaughtError } from "./router";

createRoot(document.getElementById("root")!, { onCaughtError: logCaughtError }).render(
  <RootBoundary>
    <RouterProvider />
  </RootBoundary>,
);
