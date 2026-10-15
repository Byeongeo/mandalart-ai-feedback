import type { NextConfig } from "next";

// 모든 화면이 로그인 세션에 따라 달라지는 앱이라 Cache Components는 쓰지 않습니다.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
