import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Gói workspace xuất mã TypeScript nguồn (import kiểu ESM `./x.js` → `./x.ts`).
  transpilePackages: ["@hm/app", "@hm/db"],
  // Thư viện server dùng module Node (pg) — không bundle.
  serverExternalPackages: ["pg", "better-auth"],
};

export default config;
