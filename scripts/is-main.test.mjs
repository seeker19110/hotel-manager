// Test cho scripts/is-main.mjs (guard "chạy trực tiếp" của các script chuỗi cung ứng; T-802).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMain } from "./is-main.mjs";

const HERE = fileURLToPath(import.meta.url);
const IS_MAIN = join(fileURLToPath(new URL(".", import.meta.url)), "is-main.mjs");

describe("isMain", () => {
  it("argv[1] trùng module → true; khác → false", () => {
    expect(isMain(import.meta.url, HERE)).toBe(true);
    expect(isMain(import.meta.url, IS_MAIN)).toBe(false);
  });
  it("thiếu/rỗng/không tồn tại → false (không ném lỗi)", () => {
    expect(isMain(import.meta.url, undefined)).toBe(false);
    expect(isMain(import.meta.url, "")).toBe(false);
    expect(isMain(import.meta.url, join(tmpdir(), "khong-ton-tai-xyz.mjs"))).toBe(false);
  });
  it("chạy thật: đường dẫn có khoảng trắng + Unicode và qua symlink vẫn nhận ra chạy trực tiếp", () => {
    const dir = mkdtempSync(join(tmpdir(), "ismain-"));
    try {
      const real = join(dir, "thư mục có dấu cách");
      mkdirSync(real);
      const file = join(real, "chay.mjs");
      writeFileSync(
        file,
        `import { isMain } from ${JSON.stringify(pathToFileURL(IS_MAIN).href)};\nprocess.stdout.write(String(isMain(import.meta.url)));\n`,
      );
      const link = join(dir, "link.mjs");
      symlinkSync(file, link);
      const run = (f) => execFileSync("node", [f], { encoding: "utf8" });
      expect(run(file)).toBe("true");
      expect(run(link)).toBe("true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
