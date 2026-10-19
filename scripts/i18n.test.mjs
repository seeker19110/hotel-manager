// XC-I18N-001 / XC-I18N-009 (D-073): chuỗi người dùng thấy nằm trong apps/web/messages/<locale>.json; tệp dịch được kiểm (khoá, cú
// pháp ICU, tham số, HTML lạ) trong CI (job quality chạy unit); chuỗi viết thẳng chỉ được giảm (ratchet theo tệp).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { t, tOr } from "../apps/web/lib/i18n.ts";
import { ROLE_LABEL, STATUS_LABEL } from "../apps/web/lib/roles.ts";
import { checkCatalogs, loadCatalogs, messageArgs, roleKeyErrors, tCallErrors } from "./i18n-check.mjs";
import { BASELINE, countLiterals, regressions, SCOPE, scan, unjustifiedRaises } from "./i18n-literals.mjs";

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

  it("tham số t(): đúng tập {tên} của khoá; thiếu/thừa/không phải object literal/khoá động đều là lỗi (T-1202)", () => {
    const src = { "a.hi": entry("Chào {name}, còn {n} phòng"), "a.plain": entry("Đã lưu") };
    const file = (body) => `import { t } from "../lib/i18n.ts";\n${body}`;
    const errs = (body, name = "x.tsx") => tCallErrors(file(body), name, src);
    expect(errs('t("a.hi", { name: u, n: 2 }); t("a.plain");')).toEqual([]);
    expect(errs('t("a.hi", { "name": u, n });')).toEqual([]); // khoá chuỗi + viết tắt
    expect(errs('t("a.hi", { name: u });')).toEqual(['x.tsx:2: t("a.hi") thiếu tham số {n}']);
    expect(errs('t("a.hi");')).toEqual(['x.tsx:2: t("a.hi") thiếu tham số {n}, {name}']);
    expect(errs('t("a.plain", { nam: 1 });')).toEqual([
      'x.tsx:2: t("a.plain") thừa tham số nam (message không có)',
    ]);
    expect(errs('t("a.hi", params);')[0]).toMatch(/object literal với khoá tĩnh/);
    expect(errs('t("a.hi", { ...p });')[0]).toMatch(/object literal với khoá tĩnh/);
    expect(errs('t("a.hi", { [k]: 1, n: 2 });')[0]).toMatch(/object literal với khoá tĩnh/);
    expect(errs(["t(`a.$", "{x}`);"].join(""))[0]).toMatch(/khoá viết thẳng/);
    expect(errs('t("khong.co");')).toEqual([]); // khoá lạ do usedKeys/main() báo, không báo hai lần
    // Tên cục bộ khác (import as) vẫn được kiểm; `t` không import từ i18n thì không bị bắt nhầm.
    expect(tCallErrors('import { t as tr } from "./i18n.ts";\ntr("a.hi");', "y.ts", src)).toHaveLength(1);
    expect(tCallErrors('const t = (x) => x;\nt("a.hi");', "z.ts", src)).toEqual([]);
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
    // "Lễ tân", `Còn ${x} đ`, "Đã lưu " và " phòng" (JSX text trước và sau biểu thức `{n}` là hai đoạn)
    expect(countLiterals(src)).toBe(4);
  });

  it("chữ JSX đứng sau một biểu thức `{…}` cũng được đếm; mảnh template `${` thì không", () => {
    expect(countLiterals("<span>{n} phòng</span>")).toBe(1);
    expect(countLiterals("<p>Giữ {a} (còn {m} phút)</p>")).toBe(3);
    // chỉ một chuỗi (template) — mảnh ` còn ` sau `${a}` không bị đếm thêm như chữ JSX
    expect(countLiterals(["const s = `$", "{a} còn $", "{b}`;"].join(""))).toBe(1);
    expect(countLiterals("<span>{n} rooms</span>")).toBe(0);
    expect(countLiterals("<span>{n}</span>")).toBe(0);
  });

  it("đếm trên AST: template lồng, chữ JSX kết thúc bằng `$`, `//` trong chữ JSX, ép kiểu `<T>` ở .ts (review #78)", () => {
    // Template lồng: ngoài + trong + chuỗi 'hết', và chuỗi SAU nó vẫn được đếm (regex cũ lệch cặp nháy từ đây).
    const nested = [
      "const s = `Phòng $",
      "{a ? `còn $",
      "{b}` : 'hết'} trống`;",
      '\nconst z = "Đã lưu";',
    ].join("");
    expect(countLiterals(nested)).toBe(4);
    expect(countLiterals(["<p>Giá $", "{price}</p>"].join(""))).toBe(1);
    expect(countLiterals("<p>Xem https://a.vn để biết</p>")).toBe(1);
    expect(countLiterals('const x = <string>"Lỗi";', "a.ts")).toBe(1);
    expect(countLiterals("// Phòng\n/* Lễ tân */\nconst a = 1;")).toBe(0);
    // Thuộc tính JSX, kiểu literal, template viết bằng escape, chữ tổ hợp (NFD) — review #96.
    expect(countLiterals('<button title="Đóng" />')).toBe(1);
    expect(countLiterals('type K = "Phòng" | "Đã";', "k.ts")).toBe(2);
    expect(countLiterals("const s = `Ph\\u00f2ng $" + "{x}`;", "e.ts")).toBe(1);
    expect(countLiterals('const s = "Pho\u0300ng";', "n.ts")).toBe(1);
    expect(() => countLiterals("const = ;", "hỏng.ts")).toThrow(/hỏng\.ts: không phân tích được/);
  });

  it("scan đọc tệp .ts không bật jsx (ép kiểu `<T>x` hợp lệ) — tên tệp được truyền vào bộ đếm", () => {
    const root = mkdtempSync(join(tmpdir(), "i18n-scan-"));
    try {
      for (const d of SCOPE) mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, "packages/app/src/a.ts"), 'export const x = <string>"Lỗi";\n');
      expect(scan(root)).toEqual({ "packages/app/src/a.ts": 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("không tệp nào tăng so với baseline; tệp mới = 0", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    expect(regressions(scan(), baseline)).toEqual([]);
    expect(regressions({ "x.tsx": 1 }, {})).toHaveLength(1);
    expect(regressions({ "x.tsx": 2 }, { "x.tsx": 3 })).toEqual([]);
  });

  it("baseline chỉ được hạ, hoặc nâng tới đúng số đếm của tệp trên main (bộ đếm chặt hơn — D-078)", () => {
    const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    // Job gate checkout đủ lịch sử (fetch-depth: 0) và đặt I18N_REQUIRE_BASE=1: thiếu ref ở đó = rào bị vô hiệu → đỏ, không bỏ qua. Job khác (checkout nông) và máy dev: bỏ qua.
    if (ref.status !== 0) {
      expect(
        process.env.I18N_REQUIRE_BASE,
        "job gate (I18N_REQUIRE_BASE=1) phải có origin/main để so baseline (checkout fetch-depth: 0)",
      ).not.toBe("1");
      return;
    }
    const main = spawnSync("git", ["show", "origin/main:scripts/i18n-literal-baseline.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (main.status !== 0) return; // baseline chưa có trên main (PR đầu tiên) — không có gì để so
    const before = JSON.parse(main.stdout);
    const now = JSON.parse(readFileSync(BASELINE, "utf8"));
    // Nâng chỉ hợp lệ tới số đếm (bộ đếm hiện tại) của chính tệp trên origin/main — xem unjustifiedRaises.
    const onMain = (f) => {
      const r = spawnSync("git", ["show", `origin/main:${f}`], { cwd: ROOT, encoding: "utf8" });
      return r.status === 0 ? countLiterals(r.stdout, f) : 0;
    };
    expect(unjustifiedRaises(now, before, onMain)).toEqual([]);
  });

  it("unjustifiedRaises: hạ/giữ luôn được; nâng chỉ tới số đếm trên main; tệp mới trên main = 0", () => {
    const count = { "a.tsx": 5, "b.tsx": 3 };
    const onMain = (f) => count[f] ?? 0;
    expect(unjustifiedRaises({ "a.tsx": 4, "b.tsx": 3 }, { "a.tsx": 4, "b.tsx": 3 }, onMain)).toEqual([]);
    expect(unjustifiedRaises({ "a.tsx": 5 }, { "a.tsx": 4 }, onMain)).toEqual([]);
    expect(unjustifiedRaises({ "a.tsx": 6 }, { "a.tsx": 4 }, onMain)).toEqual([
      "a.tsx: baseline 4 → 6 nhưng trên main chỉ có 5 chuỗi",
    ]);
    expect(unjustifiedRaises({ "c.tsx": 1 }, {}, onMain)).toHaveLength(1);
  });

  it("job gate có lịch sử và bật so baseline (fetch-depth: 0 + I18N_REQUIRE_BASE)", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const gate = ci.split(/^ {2}gate:\n/m)[1].split(/^ {2}[a-z-]+:\n/m)[0];
    expect(gate).toMatch(/I18N_REQUIRE_BASE: "1"/);
    expect(gate).toMatch(/fetch-depth: 0/);
  });

  it("tệp đã chuyển (lib/roles.ts) không còn chuỗi viết thẳng", () => {
    expect(scan()["apps/web/lib/roles.ts"]).toBeUndefined();
  });
});
