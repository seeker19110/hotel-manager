// XC-I18N-001 / XC-I18N-009 (D-073): chuỗi người dùng thấy nằm trong apps/web/messages/<locale>.json; tệp dịch được kiểm (khoá, cú
// pháp ICU, tham số, HTML lạ) trong CI (job quality chạy unit); chuỗi viết thẳng chỉ được giảm (ratchet theo tệp).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { messagesFor, t, tOr } from "../apps/web/lib/i18n.ts";
import { format, tm } from "../apps/web/lib/i18n-format.ts";
import { ROLE_LABEL, STATUS_LABEL } from "../apps/web/lib/roles.ts";
import { formText } from "../packages/app/src/http/command-inputs.ts";
import { format as appFormat, t as appT } from "../packages/app/src/i18n.ts";
import {
  checkCatalogs,
  clientCatalogErrors,
  loadCatalogs,
  messageArgs,
  roleKeyErrors,
  sourceErrors,
  subcatalogErrors,
  TREES,
  tCallErrors,
  treeErrors,
} from "./i18n-check.mjs";
import {
  BASELINE,
  countLiterals,
  EXEMPT,
  exemptErrors,
  loadExempt,
  regressions,
  remaining,
  SCOPE,
  scan,
  unjustifiedRaises,
} from "./i18n-literals.mjs";

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

  it("khoá trùng thuộc tính Object.prototype không bị coi là có trong nguồn (review #98)", () => {
    expect(checkCatalogs({ vi: { a: entry("A") }, en: { a: entry("A"), toString: entry("z") } })).toContain(
      "en:toString: khoá không có trong nguồn vi",
    );
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
    // Module tên gần giống không bị bắt nhầm; import namespace/mặc định của lib/i18n bị từ chối (review #97).
    expect(tCallErrors('import { t } from "next-i18n";\nt("a.hi");', "w.ts", src)).toEqual([]);
    expect(tCallErrors('import * as i18n from "../lib/i18n.ts";\ni18n.t("a.hi");', "v.ts", src)[0]).toMatch(
      /import \{ t \}/,
    );
    // Khoá trùng tên thuộc tính của Object.prototype: không sập, báo "không có trong nguồn" ở sourceErrors.
    expect(errs('t("toString");')).toEqual([]);
    expect(
      tCallErrors('import type * as I from "./i18n.ts";\nimport type i18n from "./i18n.ts";', "u.ts", src),
    ).toEqual([]);
  });

  it("tham số tm(m, …) (client, D-098): khoá viết thẳng có trong nguồn, đúng tập {tên}; chỉ tm import từ lib/i18n-format", () => {
    const src = { "a.hi": entry("Chào {name}, còn {n} phòng"), "a.plain": entry("Đã lưu") };
    const file = (body) => `import { tm } from "../lib/i18n-format.ts";\n${body}`;
    const errs = (body) => tCallErrors(file(body), "c.tsx", src);
    expect(errs('tm(m, "a.hi", { name: u, n: 2 }); tm(props.m, "a.plain");')).toEqual([]);
    expect(errs('tm(m, "a.khong_co");')).toEqual(['c.tsx:2: tm("a.khong_co") không có trong nguồn']);
    expect(errs('tm(m, "toString");')).toEqual(['c.tsx:2: tm("toString") không có trong nguồn']);
    expect(errs('tm(m, "a.hi", { name: u });')).toEqual(['c.tsx:2: tm("a.hi") thiếu tham số {n}']);
    expect(errs('tm(m, "a.hi");')).toEqual(['c.tsx:2: tm("a.hi") thiếu tham số {n}, {name}']);
    expect(errs('tm(m, "a.plain", { nam: 1 });')).toEqual([
      'c.tsx:2: tm("a.plain") thừa tham số nam (message không có)',
    ]);
    expect(errs('tm(m, "a.hi", params);')[0]).toMatch(/tm\("a\.hi"\) — tham số phải là object literal/);
    expect(errs("tm(m, key);")[0]).toMatch(/tm\(\) cần khoá viết thẳng/);
    // Nhiều dòng: báo đúng dòng của lời gọi.
    expect(errs('const a = 1;\nconst b = tm(m, "a.hi", { name: 1 });')).toEqual([
      'c.tsx:3: tm("a.hi") thiếu tham số {n}',
    ]);
    // Đổi tên khi import vẫn bị kiểm; `tm` tự định nghĩa / từ module khác / `import type` thì không.
    expect(
      tCallErrors('import { tm as x } from "./i18n-format.ts";\nx(m, "a.hi");', "d.tsx", src),
    ).toHaveLength(1);
    expect(tCallErrors('const tm = (a, b) => b;\ntm(m, "a.hi");', "e.tsx", src)).toEqual([]);
    expect(tCallErrors('import { tm } from "./other-format.ts";\ntm(m, "a.hi");', "f.tsx", src)).toEqual([]);
    expect(tCallErrors('import type { tm } from "./i18n-format.ts";\ntm(m, "a.hi");', "g.tsx", src)).toEqual(
      [],
    );
    expect(tCallErrors('import * as F from "./i18n-format.ts";\nF.tm(m, "a.hi");', "h.tsx", src)[0]).toMatch(
      /import \{ tm \}/,
    );
    // D-101: `m` từ context — `tm(useMessages(), …)` và `const m = useMessages(); tm(m, …)` kiểm y như prop `m`.
    const ctx = (body) =>
      tCallErrors(
        `import { useMessages } from "../lib/i18n-context.tsx";\nimport { tm } from "../lib/i18n-format.ts";\n${body}`,
        "ctx.tsx",
        src,
      );
    expect(
      ctx('tm(useMessages(), "a.hi", { name: u, n: 1 });\nconst m = useMessages();\ntm(m, "a.plain");'),
    ).toEqual([]);
    expect(ctx('tm(useMessages(), "a.khong_co");')).toEqual([
      'ctx.tsx:3: tm("a.khong_co") không có trong nguồn',
    ]);
    expect(ctx('tm(useMessages(), "a.hi", { name: 1 });')).toEqual([
      'ctx.tsx:3: tm("a.hi") thiếu tham số {n}',
    ]);
    expect(ctx('const m = useMessages();\ntm(m, "a.plain", { x: 1 });')).toEqual([
      'ctx.tsx:4: tm("a.plain") thừa tham số x (message không có)',
    ]);
    expect(ctx("tm(useMessages(), key);")[0]).toMatch(/tm\(\) cần khoá viết thẳng/);
    // `t` và `tm` cùng tệp: mỗi hàm đọc khoá ở đúng vị trí đối số.
    expect(
      tCallErrors(
        'import { t } from "../lib/i18n.ts";\nimport { tm } from "../lib/i18n-format.ts";\nt("a.plain"); tm(m, "a.plain");',
        "k.tsx",
        src,
      ),
    ).toEqual([]);
  });

  it("format/tm/messagesFor: cùng kết quả với t(); một lượt thay; tham số thiếu giữ nguyên; chỉ khoá đúng tiền tố", () => {
    expect(format("Chào {name}, {name}! {x}", { name: "An" })).toBe("Chào An, An! {x}");
    expect(format("{a}{b}", { a: "{b}", b: 0 })).toBe("{b}0"); // một lượt: giá trị chứa `{b}` không bị thay tiếp
    expect(format("Không tham số")).toBe("Không tham số");
    expect(format("{toString}", {})).toBe("{toString}"); // khoá prototype không bị coi là tham số
    const m = messagesFor("booking.hold.");
    expect(Object.keys(m).sort()).toEqual([
      "booking.hold.countdown",
      "booking.hold.expired",
      "booking.hold.until",
    ]);
    expect(tm(m, "booking.hold.countdown", { minutes: 2, seconds: "05" })).toBe(
      t("booking.hold.countdown", { minutes: 2, seconds: "05" }),
    );
    expect(tm(m, "booking.hold.until")).toBe(t("booking.hold.until")); // tham số thiếu: giữ `{until}` như t()
    const two = messagesFor("booking.quote.", "booking.hold.");
    expect(Object.keys(two)).toHaveLength(4);
    expect(two["booking.quote.total"]).toBe(loadCatalogs().vi["booking.quote.total"].message);
    // Catalog thật: mọi tiền tố dùng ở client đều có khoá; mỗi khoá vào đúng object (không lẫn tiền tố khác).
    for (const p of ["invitation.", "guest_stay.", "booking.quote.", "booking.hold."]) {
      const keys = Object.keys(messagesFor(p));
      expect(keys.length, p).toBeGreaterThan(0);
      expect(keys.every((k) => k.startsWith(p))).toBe(true);
    }
    expect(() => messagesFor("khong_co.")).toThrow(/no message key with prefix/);
    expect(() => messagesFor("booking.hold.", "")).toThrow(/no message key with prefix/);
  });

  it("module client không kéo catalog vào bundle, kể cả gián tiếp (D-098, bundle-size PR #123)", () => {
    const root = mkdtempSync(join(tmpdir(), "i18n-client-"));
    try {
      const w = (rel, body) => {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), body);
        return join(root, rel);
      };
      w("apps/web/lib/i18n.ts", "export const t = (k) => k;\n");
      w("apps/web/lib/i18n-format.ts", "export const tm = (m, k) => m[k];\n");
      w("apps/web/messages/vi.json", "{}");
      const ok = w(
        "apps/web/c/ok.tsx",
        '"use client";\nimport type { Messages } from "../lib/i18n.ts";\nimport { tm } from "../lib/i18n-format.ts";\n',
      );
      const server = w("apps/web/c/server.tsx", 'import { t } from "../lib/i18n.ts";\n');
      const direct = w("apps/web/c/direct.tsx", '"use client";\nimport { t } from "../lib/i18n.ts";\n');
      const json = w("apps/web/c/json.tsx", '"use client";\nimport vi from "../messages/vi.json";\n');
      w("apps/web/c/mid.tsx", 'export { x } from "./leaf";\n'); // không ghi đuôi → thử .ts/.tsx
      w("apps/web/c/leaf.ts", 'import { type T, t } from "../lib/i18n.ts";\nexport const x = 1;\n');
      const indirect = w("apps/web/c/indirect.tsx", '"use client";\nimport { x } from "./mid.tsx";\n');
      const lazy = w("apps/web/c/lazy.tsx", '"use client";\nconst m = import("../lib/i18n.ts");\n');
      // D-101: provider client chỉ `import type` từ lib/i18n.ts; module client dùng hook của nó cũng không bị chặn nhầm.
      w(
        "apps/web/lib/i18n-context.tsx",
        '"use client";\nimport { createContext } from "react";\nimport type { Messages } from "./i18n.ts";\nexport const useMessages = () => null;\n',
      );
      const ctx = join(root, "apps/web/lib/i18n-context.tsx");
      const viaCtx = w(
        "apps/web/c/via-ctx.tsx",
        '"use client";\nimport { useMessages } from "../lib/i18n-context.tsx";\nimport { tm } from "../lib/i18n-format.ts";\n',
      );
      const files = [ok, server, direct, json, indirect, lazy, ctx, viaCtx];
      const errors = clientCatalogErrors(files, root);
      expect(errors).toHaveLength(4);
      expect(errors.join("\n")).not.toMatch(/ok\.tsx|server\.tsx|i18n-context\.tsx|via-ctx\.tsx/);
      expect(errors.find((e) => e.startsWith("apps/web/c/indirect.tsx"))).toContain(
        "apps/web/c/indirect.tsx → apps/web/c/mid.tsx → apps/web/c/leaf.ts → apps/web/lib/i18n.ts",
      );
      expect(errors.some((e) => e.startsWith("apps/web/c/json.tsx"))).toBe(true);
      expect(errors.some((e) => e.startsWith("apps/web/c/lazy.tsx"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sourceErrors gom lỗi khoá lạ và tham số t() từ tệp thật trên đĩa (main() dùng hàm này)", () => {
    const root = mkdtempSync(join(tmpdir(), "i18n-src-"));
    try {
      const f = join(root, "page.tsx");
      writeFileSync(
        f,
        'import { t, tOr } from "./lib/i18n.ts";\nt("a.hi", { name: 1 });\nt("toString");\ntOr(`zz.$' +
          '{x}`, "-");\n',
      );
      expect(sourceErrors([f], { "a.hi": entry("Chào {name}, còn {n} phòng") }, root)).toEqual([
        'page.tsx: t("toString") không có trong nguồn',
        'page.tsx: tiền tố "zz." không có khoá nào',
        'page.tsx:2: t("a.hi") thiếu tham số {n}',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("XC-I18N-009 — catalog thứ hai packages/app/messages (D-104)", () => {
  const tmpTree = (files) => {
    const root = mkdtempSync(join(tmpdir(), "i18n-app-"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
    }
    return root;
  };
  const APP = TREES.find((tr) => tr.name === "packages/app");

  it("cả hai catalog được kiểm; catalog thật của packages/app sạch và mọi t() của nó trỏ khoá có thật", () => {
    expect(TREES.map((tr) => tr.messages)).toEqual(["apps/web/messages", "packages/app/messages"]);
    expect(treeErrors(APP).errors).toEqual([]);
    const r = node("scripts/i18n-check.mjs");
    expect(r.stdout).toMatch(/packages\/app\/messages: 1 locale · \d+ khoá · 0 lỗi/);
  });

  it("bắt ở catalog packages/app: mô tả rỗng, khoá thiếu, tham số sai, HTML lạ, thiếu thư mục catalog", () => {
    const root = tmpTree({
      "packages/app/messages/vi.json": {
        "e.hi": entry("Chào {name}"),
        "e.empty": entry("Rỗng mô tả", "  "),
        "e.html": entry("<b>x</b>"),
      },
      "packages/app/src/http/route.ts": [
        'import { t } from "../i18n.ts";',
        't("e.hi", { name: 1 });',
        't("e.khong_co");',
        't("e.hi", { nam: 1 });',
        't("e.hi");',
      ].join("\n"),
      // `t` không import từ i18n của gói thì không bị bắt nhầm; tệp test bị bỏ qua.
      "packages/app/src/other.ts": 'const t = (k) => k;\nt("e.hi", { x: 1 });\n',
      "packages/app/src/x.test.ts": 'import { t } from "./i18n.ts";\nt("e.test_only");\n',
    });
    try {
      const { errors } = treeErrors(APP, root);
      expect(errors).toEqual(
        expect.arrayContaining([
          "packages/app/messages/vi:e.empty: thiếu description (ngữ cảnh cho người dịch)",
          "packages/app/messages/vi:e.html: có HTML/script lạ",
          'packages/app/src/http/route.ts: t("e.khong_co") không có trong nguồn',
          'packages/app/src/http/route.ts:4: t("e.hi") thiếu tham số {name}',
          'packages/app/src/http/route.ts:4: t("e.hi") thừa tham số nam (message không có)',
          'packages/app/src/http/route.ts:5: t("e.hi") thiếu tham số {name}',
          // Cây packages/app khai catalog con form (D-106): thiếu tệp là lỗi, không lặng lẽ bỏ qua.
          "packages/app/messages/form.vi.json: thiếu catalog con",
        ]),
      );
      expect(errors).toHaveLength(7);
      // Khoá của catalog web không hợp lệ ở packages/app (catalog riêng, không trộn).
      const web = tmpTree({
        "packages/app/messages/vi.json": {},
        "packages/app/src/a.ts": 'import { t } from "./i18n.ts";\nt("role.owner");\n',
      });
      expect(treeErrors(APP, web).errors).toEqual([
        'packages/app/src/a.ts: t("role.owner") không có trong nguồn',
        "packages/app/messages/form.vi.json: thiếu catalog con",
      ]);
      expect(treeErrors(APP, tmpTree({ "packages/app/src/a.ts": "" })).errors).toEqual([
        "packages/app/messages: thiếu thư mục catalog",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("t() của packages/app: thay tham số một lượt, giữ nguyên câu chữ cũ; format trùng hành vi bản apps/web", () => {
    expect(appT("http.validation_failed")).toBe("Dữ liệu không hợp lệ");
    expect(appT("http.idempotency_key_invalid")).toBe("Thiếu hoặc sai Idempotency-Key (UUID)");
    expect(appT("http.rate_limit.upload_member")).toBe(
      "Bạn tải lên quá nhiều trong một phút. Vui lòng thử lại sau.",
    );
    for (const [m, p] of [
      ["Chào {name}, {name}! {x}", { name: "An" }],
      ["{a}{b}", { a: "{b}", b: 0 }],
      ["Không tham số", {}],
      ["{toString}", {}],
      ["{ name } {n}", { name: "x", n: -1 }],
      ["", {}],
    ])
      expect(appFormat(m, p), m).toBe(format(m, p));
    // t() không tham số trả đúng message (tham số thiếu giữ nguyên `{tên}` — không mất chữ).
    const app = loadCatalogs(join(ROOT, "packages/app/messages")).vi;
    for (const [k, v] of Object.entries(app)) expect(appT(k), k).toBe(v.message);
  });

  it("module client không kéo catalog packages/app qua import gói `@hm/app/…` (D-098)", () => {
    const root = tmpTree({
      "packages/app/package.json": {
        name: "@hm/app",
        exports: { "./http": "./src/http/security.ts", "./safe": "./src/safe.ts", ".": "./src/index.ts" },
      },
      "packages/app/messages/vi.json": {},
      "packages/app/src/i18n.ts": "export const t = (k) => k;\n",
      "packages/app/src/http/security.ts":
        'import { t } from "../i18n.ts";\nexport const safeUrl = (u) => u;\n',
      "packages/app/src/safe.ts": 'import type { AppMessageKey } from "./i18n.ts";\nexport const x = 1;\n',
      "packages/app/src/index.ts": 'export { safeUrl } from "./http/security.ts";\n',
      "apps/web/c/bad.tsx": '"use client";\nimport { safeUrl } from "@hm/app/http";\n',
      "apps/web/c/root.tsx": '"use client";\nimport { safeUrl } from "@hm/app";\n',
      "apps/web/c/ok.tsx":
        '"use client";\nimport { x } from "@hm/app/safe";\nimport type { y } from "@hm/app/http";\n',
      "apps/web/c/unknown.tsx":
        '"use client";\nimport { z } from "@hm/app/khong-xuat";\nimport { q } from "zod";\n',
      "apps/web/c/server.tsx": 'import { safeUrl } from "@hm/app/http";\n',
    });
    try {
      const files = ["bad", "root", "ok", "unknown", "server"].map((n) => join(root, `apps/web/c/${n}.tsx`));
      const errors = clientCatalogErrors(files, root);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(
        "apps/web/c/bad.tsx → packages/app/src/http/security.ts → packages/app/src/i18n.ts",
      );
      expect(errors[1]).toMatch(/^apps\/web\/c\/root\.tsx: .*packages\/app\/src\/index\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("XC-I18N-009 — catalog con form.vi.json cho module trình duyệt nạp (D-106)", () => {
  const tmpTree = (files) => {
    const root = mkdtempSync(join(tmpdir(), "i18n-sub-"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
    }
    return root;
  };
  const APP = TREES.find((tr) => tr.name === "packages/app");
  const FORM = APP.subcatalogs.find((s) => s.name === "form");

  it("catalog con thật sạch, mọi khoá đều được formText() dùng; formText trùng hành vi format của t()", () => {
    expect(FORM).toEqual({
      name: "form",
      fn: "formText",
      sources: ["packages/app/src/http/command-inputs.ts"],
    });
    const { errors, catalogs } = subcatalogErrors(APP, FORM);
    expect(errors).toEqual([]);
    expect(Object.keys(catalogs.vi).length).toBeGreaterThan(10);
    // Catalog chính không đọc nhầm catalog con thành locale "form.vi".
    expect(Object.keys(loadCatalogs(join(ROOT, "packages/app/messages")))).toEqual(["vi"]);
    expect(node("scripts/i18n-check.mjs").stdout).toMatch(
      /catalog con packages\/app\/messages\/form\.\*\.json: \d+ khoá/,
    );
    for (const [k, v] of Object.entries(catalogs.vi)) expect(formText(k), k).toBe(v.message);
    expect(formText("form.max_chars", { max: 1000 })).toBe("Tối đa 1000 ký tự");
    expect(formText("form.min_items", { min: "{max}", max: 1 })).toBe("Cần ít nhất {max} mục"); // một lượt
    expect(formText("form.min_chars")).toBe("Cần ít nhất {min} ký tự"); // thiếu tham số giữ nguyên
  });

  it("bắt: khoá lạ, thiếu/thừa tham số, khoá động, khoá không dùng, thiếu mô tả, thiếu catalog con/tệp nguồn", () => {
    const root = tmpTree({
      "packages/app/messages/vi.json": {},
      "packages/app/messages/form.vi.json": {
        "form.max": entry("Tối đa {max}"),
        "form.plain": entry("Sai", " "),
        "form.unused": entry("Không ai dùng"),
      },
      "packages/app/src/http/command-inputs.ts": [
        "const formText = (k, p) => k;",
        'formText("form.max", { max: 1 });',
        'formText("form.plain");',
        'formText("form.khong_co");',
        'formText("form.max");',
        'formText("form.plain", { x: 1 });',
        "formText(key);",
      ].join("\n"),
    });
    try {
      const { errors } = subcatalogErrors(APP, FORM, root);
      expect(errors.sort()).toEqual(
        [
          "packages/app/messages/form.vi:form.plain: thiếu description (ngữ cảnh cho người dịch)",
          'packages/app/src/http/command-inputs.ts:4: formText("form.khong_co") không có trong nguồn',
          'packages/app/src/http/command-inputs.ts:5: formText("form.max") thiếu tham số {max}',
          'packages/app/src/http/command-inputs.ts:6: formText("form.plain") thừa tham số x (message không có)',
          'packages/app/src/http/command-inputs.ts:7: formText() cần khoá viết thẳng "…" ở đối số thứ 1',
          "packages/app/messages/form.vi:form.unused: khoá không được formText() nào dùng — bỏ khỏi catalog con",
        ].sort(),
      );
      // Lỗi catalog con được gộp vào lỗi của cây (main() thoát 1).
      expect(treeErrors(APP, root).errors).toEqual(expect.arrayContaining(errors));
      expect(subcatalogErrors(APP, FORM, tmpTree({ "packages/app/messages/vi.json": {} })).errors).toEqual([
        "packages/app/messages/form.vi.json: thiếu catalog con",
      ]);
      expect(
        subcatalogErrors(
          APP,
          FORM,
          tmpTree({ "packages/app/messages/form.vi.json": { "form.a": entry("a") } }),
        ).errors,
      ).toEqual([
        "packages/app/src/http/command-inputs.ts: tệp dùng catalog con form không tồn tại",
        "packages/app/messages/form.vi:form.a: khoá không được formText() nào dùng — bỏ khỏi catalog con",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rào client: module trình duyệt được nạp catalog con form.vi.json, KHÔNG được nạp vi.json/i18n.ts của packages/app", () => {
    const root = tmpTree({
      "packages/app/package.json": {
        name: "@hm/app",
        exports: { "./command-inputs": "./src/http/command-inputs.ts", "./bad": "./src/http/bad.ts" },
      },
      "packages/app/messages/vi.json": {},
      "packages/app/messages/form.vi.json": {},
      "packages/app/src/i18n.ts":
        'import vi from "../messages/vi.json" with { type: "json" };\nexport const t = (k) => vi[k];\n',
      "packages/app/src/http/command-inputs.ts":
        'import m from "../../messages/form.vi.json" with { type: "json" };\nexport const c = m;\n',
      "packages/app/src/http/bad.ts":
        'import m from "../../messages/vi.json" with { type: "json" };\nimport { t } from "../i18n.ts";\nexport const c = [m, t];\n',
      "apps/web/c/lazy.ts": 'export const load = () => import("@hm/app/command-inputs");\n',
      "apps/web/c/form.tsx": '"use client";\nimport { load } from "./lazy.ts";\n',
      "apps/web/c/bad.tsx": '"use client";\nimport { c } from "@hm/app/bad";\n',
    });
    try {
      const errors = clientCatalogErrors(
        ["form", "bad"].map((n) => join(root, `apps/web/c/${n}.tsx`)),
        root,
      );
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(
        "apps/web/c/bad.tsx → packages/app/src/http/bad.ts → packages/app/messages/vi.json",
      );
      expect(errors[1]).toContain("packages/app/src/i18n.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("t() import đổi tên (`import { t as msg }`) vẫn bị bắt khoá lạ và tham số sai", () => {
    const src = { "a.hi": entry("Chào {name}") };
    const file = 'import { t as msg } from "../i18n.ts";\nmsg("a.khong_co");\nmsg("a.hi");\n';
    expect(tCallErrors(file, "x.ts", src)).toEqual([
      'x.ts:2: msg("a.khong_co") không có trong nguồn',
      'x.ts:3: t("a.hi") thiếu tham số {name}',
    ]);
  });
});

describe("XC-I18N-001 — ngoại lệ theo tệp có lý do và --strict (D-105)", () => {
  it("danh sách ngoại lệ thật hợp lệ; tệp ngoại lệ không bị đếm, không nằm trong baseline", () => {
    const exempt = loadExempt();
    expect(exemptErrors(exempt)).toEqual([]);
    expect(Object.keys(exempt).length).toBeGreaterThan(0);
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    const counted = scan();
    for (const f of Object.keys(exempt)) {
      expect(baseline[f], f).toBeUndefined();
      expect(counted[f], f).toBeUndefined();
      expect(exempt[f].trim().length, f).toBeGreaterThan(20); // lý do cụ thể, không phải "log"
    }
    expect(EXEMPT).toMatch(/scripts\/i18n-literal-exempt\.json$/);
  });

  it("lỗi: lý do thiếu/rỗng/không phải chuỗi, tệp không tồn tại, ngoài phạm vi quét, không phải object", () => {
    const root = mkdtempSync(join(tmpdir(), "i18n-exempt-"));
    try {
      for (const d of SCOPE) mkdirSync(join(root, d), { recursive: true });
      mkdirSync(join(root, "docs"), { recursive: true });
      for (const f of ["packages/app/src/a.ts", "packages/app/src/a.test.ts", "docs/x.ts"])
        writeFileSync(join(root, f), 'export const s = "Lỗi";\n');
      expect(exemptErrors({ "packages/app/src/a.ts": "Chỉ log vận hành" }, root)).toEqual([]);
      expect(exemptErrors({ "packages/app/src/a.ts": "" }, root)).toEqual([
        "packages/app/src/a.ts: ngoại lệ thiếu lý do",
      ]);
      expect(exemptErrors({ "packages/app/src/a.ts": "   " }, root)).toHaveLength(1);
      expect(exemptErrors({ "packages/app/src/a.ts": null }, root)).toHaveLength(1);
      expect(exemptErrors({ "packages/app/src/a.ts": 1 }, root)).toHaveLength(1);
      expect(exemptErrors({ "packages/app/src/khong-co.ts": "lý do" }, root)).toEqual([
        "packages/app/src/khong-co.ts: tệp ngoại lệ không tồn tại",
      ]);
      expect(exemptErrors({ "packages/app/src": "thư mục" }, root)).toEqual([
        "packages/app/src: tệp ngoại lệ không tồn tại",
      ]);
      expect(exemptErrors({ "docs/x.ts": "lý do" }, root)[0]).toMatch(/ngoài phạm vi quét/);
      expect(exemptErrors({ "packages/app/src/a.test.ts": "lý do" }, root)[0]).toMatch(/ngoài phạm vi quét/);
      writeFileSync(join(root, "packages/app/src/clean.ts"), "export const s = 'ok';\n");
      expect(exemptErrors({ "packages/app/src/clean.ts": "lý do" }, root)).toEqual([
        "packages/app/src/clean.ts: ngoại lệ thừa (0 chuỗi viết thẳng) — bỏ khỏi danh sách",
      ]);
      expect(exemptErrors([], root)[0]).toMatch(/phải là object/);
      expect(exemptErrors(null, root)[0]).toMatch(/phải là object/);
      // scan bỏ đúng tệp ngoại lệ.
      writeFileSync(join(root, "packages/app/src/b.ts"), 'export const s = "Phòng";\n');
      expect(scan(root)).toEqual({ "packages/app/src/a.ts": 1, "packages/app/src/b.ts": 1 });
      // Mặc định đọc scripts/i18n-literal-exempt.json của chính root.
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts/i18n-literal-exempt.json"), '{ "packages/app/src/b.ts": "Chỉ log" }');
      expect(scan(root)).toEqual({ "packages/app/src/a.ts": 1 });
      expect(scan(root, { "packages/app/src/a.ts": "Chỉ log" })).toEqual({ "packages/app/src/b.ts": 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--strict: còn tệp > 0 ngoài ngoại lệ (baseline hoặc lần quét) ⇒ lỗi; không --strict thì ratchet như cũ", () => {
    expect(remaining({}, {}, {})).toEqual([]);
    expect(remaining({ "a.ts": 0 }, { "a.ts": 0 })).toEqual([]);
    expect(remaining({ "a.ts": 1 }, {}, { "a.ts": "log" })).toEqual([]);
    expect(remaining({}, { "b.ts": 2 })).toEqual(["b.ts"]);
    expect(remaining({ "c.ts": 1 }, { "b.ts": 2 }, {})).toEqual(["b.ts", "c.ts"]);
    const plain = node("scripts/i18n-literals.mjs");
    expect(plain.status, plain.stderr).toBe(0);
    const strict = node("scripts/i18n-literals.mjs", "--strict");
    const left = Object.keys(JSON.parse(readFileSync(BASELINE, "utf8"))).length;
    expect(strict.status).toBe(left > 0 ? 1 : 0);
    if (left > 0) expect(strict.stderr).toMatch(/--strict cần 0 ngoài ngoại lệ/);
  });
});
