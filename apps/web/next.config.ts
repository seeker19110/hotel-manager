import { fileURLToPath } from "node:url";
import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // D-144: artifact runtime chỉ gồm closure đã trace; không phân phối compiler hoặc công cụ test.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // Next NFT bỏ các file giấy phép không được import; giữ attribution của phần Next đóng gói sẵn.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/next/LICENSE*", "./node_modules/next/dist/compiled/**/LICENSE*"],
  },
  // `next dev` không tự sinh apps/web/AGENTS.md: luật agent duy nhất là AGENTS.md ở gốc repo.
  agentRules: false,
  // Gói workspace xuất mã TypeScript nguồn (import kiểu ESM `./x.js` → `./x.ts`).
  transpilePackages: ["@hm/app", "@hm/db"],
  // Thư viện server dùng module Node (pg) — không bundle.
  serverExternalPackages: ["pg", "better-auth"],
};

// withSerwist chỉ thêm esbuild vào serverExternalPackages (bundle SW lúc build — app/serwist/[path]/route.ts).
export default withSerwist(config);
