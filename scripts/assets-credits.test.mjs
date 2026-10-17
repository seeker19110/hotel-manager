// Rào nguồn tài sản (PLAN đợt 5 T-411, UX-VISUAL-007): mọi tệp dưới apps/web/public có dòng trong assets/CREDITS.md và ngược
// lại (so khớp 100%); không nhúng phông (@font-face) mà không khai báo; ảnh AI tạo phải ghi `có` ở cột "AI tạo".
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC = "apps/web/public";
const credits = readFileSync("assets/CREDITS.md", "utf8");

function files(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p.replaceAll("\\", "/"));
  }
  return out;
}

/** Các dòng bảng: [đường dẫn, nguồn, giấy phép, AI tạo]. */
const rows = credits
  .split("\n")
  .filter((l) => /^\|\s*`apps\/web\/public\//.test(l))
  .map((l) =>
    l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().replaceAll("`", "")),
  );

describe("assets/CREDITS.md", () => {
  it("mọi tệp trong apps/web/public có dòng khai báo, và mọi dòng trỏ tới tệp có thật (100%)", () => {
    const onDisk = files(PUBLIC);
    const listed = rows.map((r) => r[0]);
    expect(onDisk.filter((f) => !listed.includes(f))).toEqual([]);
    expect(listed.filter((f) => !existsSync(f))).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it("mỗi dòng có nguồn, giấy phép và cột AI tạo (có/không) — không để trống", () => {
    for (const r of rows) {
      expect(r.length, r[0]).toBe(4);
      expect(r[1], `${r[0]}: nguồn`).not.toBe("");
      expect(r[2], `${r[0]}: giấy phép`).not.toBe("");
      expect(["có", "không"], `${r[0]}: AI tạo`).toContain(r[3]);
    }
  });

  it("icon PWA tự sinh: script gen-icons.mjs có thật và được nêu ở CREDITS", () => {
    expect(existsSync("apps/web/scripts/gen-icons.mjs")).toBe(true);
    expect(credits).toContain("apps/web/scripts/gen-icons.mjs");
  });

  it("không nhúng phông ngoài (@font-face / url() trong CSS) khi CREDITS ghi dùng phông hệ thống", () => {
    const css = readFileSync("apps/web/app/globals.css", "utf8");
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/url\(/);
    expect(credits).toMatch(/phông hệ thống/);
  });

  it("bộ so khớp bắt được ca xấu: tệp mồ côi và dòng ma", () => {
    const listed = ["apps/web/public/icons/a.png"];
    const disk = ["apps/web/public/icons/a.png", "apps/web/public/icons/b.png"];
    expect(disk.filter((f) => !listed.includes(f))).toEqual(["apps/web/public/icons/b.png"]);
    expect(existsSync("apps/web/public/icons/khong-co.png")).toBe(false);
  });
});
