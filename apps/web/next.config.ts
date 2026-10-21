import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` không tự sinh apps/web/AGENTS.md: luật agent duy nhất là AGENTS.md ở gốc repo.
  agentRules: false,
  // Gói workspace xuất mã TypeScript nguồn (import kiểu ESM `./x.js` → `./x.ts`).
  transpilePackages: ["@hm/app", "@hm/db"],
  // Thư viện server dùng module Node (pg) — không bundle.
  serverExternalPackages: ["pg", "better-auth"],
};

// withSerwist chỉ thêm esbuild vào serverExternalPackages (bundle SW lúc build — app/serwist/[path]/route.ts).
export default withSerwist(config);
