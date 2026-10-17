// Sinh `apps/web/openapi.json` từ registry (STD-API-001). Chạy: `pnpm openapi` (ghi file) · `pnpm openapi --check` (đỏ nếu lệch).
// Node 24 chạy thẳng .ts (cùng cách worker `node src/index.ts`). Sau khi ghi, định dạng bằng Biome để `biome ci` không đổi file;
// so khớp luôn theo NỘI DUNG JSON (không theo khoảng trắng).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "../../../packages/app/src/http/openapi.ts";

const target = fileURLToPath(new URL("../openapi.json", import.meta.url));
const next = buildOpenApi();

if (process.argv.includes("--check")) {
  let current;
  try {
    current = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    current = undefined; // chưa có / hỏng → lệch
  }
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    process.stderr.write("apps/web/openapi.json lệch registry — chạy `pnpm openapi` rồi commit.\n");
    process.exit(1);
  }
} else {
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  try {
    execFileSync("pnpm", ["exec", "biome", "format", "--write", target], { stdio: "ignore" });
  } catch {
    process.stderr.write("cảnh báo: không chạy được biome format — chạy `pnpm format` trước khi commit.\n");
  }
  process.stdout.write(`đã ghi ${target}\n`);
}
