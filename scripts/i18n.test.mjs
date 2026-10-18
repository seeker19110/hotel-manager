// XC-I18N-001 / XC-I18N-009 (D-073): chuỗi người dùng thấy nằm trong apps/web/messages/<locale>.json; tệp dịch được kiểm (khoá, cú
// pháp ICU, tham số, HTML lạ) trong CI (job quality chạy unit); chuỗi viết thẳng chỉ được giảm (ratchet theo tệp).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { t, tOr } from "../apps/web/lib/i18n.ts";
import { ROLE_LABEL, STATUS_LABEL } from "../apps/web/lib/roles.ts";
import { checkCatalogs, loadCatalogs, messageArgs, roleKeyErrors } from "./i18n-check.mjs";
import { BASELINE, countLiterals, regressions, scan } from "./i18n-literals.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const node = (script, ...args) =>
  spawnSync("node", [join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8" });
const entry = (message, description = "ngữ cảnh") => ({ message, description });

describe("XC-I18N-009 — kiểm tệp dịch", () => {
  it("tệp dịch thật của repo sạch (khoá, mô tả, ICU, tham số, HTML) và mọi t() trỏ khoá có thật", () => {
    expect(checkCatalogs(loadCatalogs())).toEqual([]);
    const r = node("scripts/i18n-check.mjs");
    expect(r.status, r.stderr).toBe(0);
  });

  it("tham số ICU: lấy đúng tên, kể cả trong plural/select; sai cú pháp → ném lỗi", () => {
    expect(messageArgs("Xin chào {name}, phòng {room} còn {count}")).toEqual(["count", "name", "room"]);
    expect(() => messageArgs("Thiếu ngoặc {name")).toThrow();
  });

  it("chỉ nhận tập con mà t() hiển thị được: plural/select, tên có dấu, dấu nháy đơn bị từ chối", () => {
    for (const bad of [
      "Còn {n, plural, one {# phòng} other {# phòng}}",
      "Chào {tên}",
      "Mã '{code}' sai",
      "Giá {n, number}",
      "Chào { name }",
      "Chào {name }",
    ])
      expect(() => messageArgs(bad), bad).toThrow();
  });

  it("message không phải chuỗi/rỗng ở locale dịch là lỗi; nguồn sai ICU không làm ném lỗi dù en đứng trước", () => {
    expect(checkCatalogs({ vi: { a: entry("A") }, en: { a: null } })).toContain(
      "en:a: message phải là chuỗi không rỗng",
    );
    expect(checkCatalogs({ vi: { a: entry("A") }, en: { a: { msg: "x" } } })).toContain(
      "en:a: message phải là chuỗi không rỗng",
    );
    expect(checkCatalogs({ vi: { a: entry("A") }, en: { a: entry("  ") } })).toContain(
      "en:a: message phải là chuỗi không rỗng",
    );
    expect(checkCatalogs({ vi: { a: entry("Sai {") }, en: { a: entry("x") } })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^vi:a: sai cú pháp ICU/)]),
    );
  });

  it("mọi vai trò và trạng thái đều có nhãn thật (không rơi về mã thô)", () => {
    for (const r of ["owner", "manager", "front_desk", "accountant", "housekeeping", "maintenance", "tenant"])
      expect(ROLE_LABEL[r], r).not.toBe(r);
    for (const st of ["active", "suspended", "invited"]) expect(STATUS_LABEL[st], st).not.toBe(st);
    const roles = readFileSync(join(ROOT, "apps/web/lib/roles.ts"), "utf8");
    const vi = loadCatalogs().vi;
    expect(roleKeyErrors(vi, roles)).toEqual([]);
    const { "role.tenant": _x, ...thieu } = vi;
    expect(roleKeyErrors(thieu, roles)).toEqual(["thiếu khoá role.tenant (roles.ts)"]);
  });

  it("bắt: thiếu mô tả, thiếu khoá ở locale dịch, khoá lạ, tham số đổi tên/mất, sai ICU, HTML/script chèn vào", () => {
    const errors = checkCatalogs({
      vi: { a: entry("Chào {name}"), b: entry("Hai", ""), c: entry("Ba") },
      en: {
        a: entry("Hello {ten}"),
        c: entry("<script>alert(1)</script>"),
        d: entry("x"),
        e: entry("Bad {"),
      },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "vi:b: thiếu description (ngữ cảnh cho người dịch)",
        "en:b: thiếu khoá của nguồn",
        "en:d: khoá không có trong nguồn vi",
        "en:a: tham số [ten] khác nguồn [name]",
        "en:c: có HTML/script lạ",
      ]),
    );
    expect(errors.some((e) => e.startsWith("en:e: sai cú pháp ICU"))).toBe(true);
  });

  it("t(): thay tham số, giữ nguyên tham số thiếu; tOr(): khoá lạ → fallback", () => {
    expect(t("role.owner")).toBe("Chủ sở hữu");
    expect(tOr("role.khong-co", "khong-co")).toBe("khong-co");
    expect(ROLE_LABEL.front_desk).toBe("Lễ tân");
    expect(STATUS_LABEL.suspended).toBe("Tạm khoá");
  });
});

describe("XC-I18N-001 — chuỗi viết thẳng chỉ được giảm (ratchet)", () => {
  it("bộ đếm: chuỗi và JSX text tiếng Việt; bỏ chú thích, chuỗi không dấu, khoá", () => {
    const src = [
      "// Chú thích có dấu không tính",
      "/* khối chú thích: Phòng */",
      'const a = "Lễ tân";',
      "const b = 'abc';",
      'const c = t("role.owner");',
      'const d = <p className="x">Đã lưu {n} phòng</p>;',
      ["const e = `Còn $", "{x} đ`;"].join(""),
    ].join("\n");
    expect(countLiterals(src)).toBe(3);
  });

  it("không tệp nào tăng so với baseline; tệp mới = 0", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    expect(regressions(scan(), baseline)).toEqual([]);
    expect(regressions({ "x.tsx": 1 }, {})).toHaveLength(1);
    expect(regressions({ "x.tsx": 2 }, { "x.tsx": 3 })).toEqual([]);
  });

  it("baseline không được nới so với main (chỉ hạ hoặc xoá dòng)", () => {
    const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    // Job gate checkout đủ lịch sử (fetch-depth: 0) và đặt I18N_REQUIRE_BASE=1: thiếu ref ở đó = rào bị vô hiệu → đỏ, không bỏ qua. Job khác (checkout nông) và máy dev: bỏ qua.
    if (ref.status !== 0) {
      expect(
        process.env.CI,
        "CI phải có origin/main để so baseline (checkout fetch-depth: 0)",
      ).toBeUndefined();
      return;
    }
    const main = spawnSync("git", ["show", "origin/main:scripts/i18n-literal-baseline.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (main.status !== 0) return; // baseline chưa có trên main (PR đầu tiên) — không có gì để so
    const before = JSON.parse(main.stdout);
    const now = JSON.parse(readFileSync(BASELINE, "utf8"));
    const raised = Object.entries(now).filter(([f, n]) => n > (before[f] ?? 0));
    expect(raised).toEqual([]);
  });

  it("tệp đã chuyển (lib/roles.ts) không còn chuỗi viết thẳng", () => {
    expect(scan()["apps/web/lib/roles.ts"]).toBeUndefined();
  });
});
