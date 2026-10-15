// Phục vụ /serwist/sw.js (bundle lúc build, tĩnh). Precache: asset tĩnh có hash của Next + public/ + /offline.
import { randomUUID } from "node:crypto";
import { createSerwistRoute } from "@serwist/turbopack";

// Revision của /offline đổi theo mỗi bản build (trang offline tham chiếu chunk có hash của chính bản đó).
const revision = process.env.HM_BUILD_ID ?? randomUUID();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  swSrc: "app/sw.ts",
  useNativeEsbuild: true,
  additionalPrecacheEntries: [{ url: "/offline", revision }],
  // Không phát hành sourcemap của SW.
  esbuildOptions: { sourcemap: false },
});
