// Biến môi trường cho đo hiệu năng có đăng nhập — k6 nightly (perf-nightly.yml; QA-PERF-002, D-072) và Lighthouse trang sau đăng nhập (frontend-quality.yml job `lighthouse`; PRF-WEB-005): đăng nhập chủ khách sạn Biển (giả, có TOTP)
// trên server E2E đang chạy rồi in `K6_COOKIE`, `ORG_ID`, `PROPERTY_ID`, `UNIT_IDS` dạng `KEY=value` (dán vào $GITHUB_ENV).
// Cookie là phiên của DB tạm dữ liệu giả; vẫn được che trong log Actions (`::add-mask::`, in ra stderr).
// Dùng: (cd apps/web && E2E_PORT=3100 node e2e/perf-session-env.ts) >> "$GITHUB_ENV"
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { perfSeedFile } from "./fixtures.ts";
import { loginOwner } from "./sessions.ts";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const seed = JSON.parse(readFileSync(perfSeedFile(port), "utf8")) as {
  org_id: string;
  property_id: string;
  unit_ids: string[];
};
// Cùng quy tắc chọn trình duyệt với playwright.config.ts: PW_CHROMIUM_PATH, Chromium có sẵn ở /opt/pw-browsers, không thì bản
// do `playwright install chromium` cài (CI).
const executablePath =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const cookies = await loginOwner(browser, baseURL, "hotel");
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  if (!cookie) throw new Error("đăng nhập không trả cookie phiên");
  process.stderr.write(`::add-mask::${cookie}\n`);
  process.stdout.write(
    [
      `K6_COOKIE=${cookie}`,
      `ORG_ID=${seed.org_id}`,
      `PROPERTY_ID=${seed.property_id}`,
      `UNIT_IDS=${seed.unit_ids.join(",")}`,
      "",
    ].join("\n"),
  );
} finally {
  await browser.close();
}
