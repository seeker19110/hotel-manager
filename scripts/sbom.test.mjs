// Test cho scripts/sbom.mjs và scripts/sbom-check.mjs (CMP-LIC-003, CMP-LIC-004; T-802).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "./check-licenses.mjs";
import { buildSbom, licenseEntries, lockIntegrity, purlOf } from "./sbom.mjs";
import { analyzeSbom, isSourceAvailable, isUnasserted, validateExceptions } from "./sbom-check.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TODAY = "2026-10-17";
const EX = (over = {}) => ({
  package: "weed",
  license: "NOASSERTION",
  reason: "binary dựng sẵn, giấy phép Apache-2.0 theo kho nguồn",
  approved_by: "chủ dự án",
  expires: "2027-03-01",
  ...over,
});

describe("purlOf / licenseEntries", () => {
  it("scope mã hoá %40, tên thường giữ nguyên, ký tự lạ mã hoá", () => {
    expect(purlOf("@biomejs/biome", "2.5.15")).toBe("pkg:npm/%40biomejs/biome@2.5.15");
    expect(purlOf("yaml", "2.9.1")).toBe("pkg:npm/yaml@2.9.1");
    expect(purlOf("a b", "1.0.0+x")).toBe("pkg:npm/a%20b@1.0.0%2Bx");
  });
  it("id đơn → license.id; biểu thức → expression; rỗng/Unknown/null → []", () => {
    expect(licenseEntries("MIT")).toEqual([{ license: { id: "MIT" } }]);
    expect(licenseEntries("MIT OR Apache-2.0")).toEqual([{ expression: "MIT OR Apache-2.0" }]);
    expect(licenseEntries("(MIT OR CC0-1.0)")).toEqual([{ expression: "(MIT OR CC0-1.0)" }]);
    expect(licenseEntries("")).toEqual([]);
    expect(licenseEntries("Unknown")).toEqual([]);
    expect(licenseEntries(undefined)).toEqual([]);
    expect(licenseEntries("Mã tự đặt")).toEqual([{ license: { name: "Mã tự đặt" } }]);
  });
  it("chỉ dùng license.id khi là SPDX id hợp lệ; còn lại license.name; có AND/OR/WITH → expression", () => {
    expect(licenseEntries("LGPL-3.0-or-later")).toEqual([{ license: { id: "LGPL-3.0-or-later" } }]);
    expect(licenseEntries("(MIT)")).toEqual([{ license: { id: "MIT" } }]);
    expect(licenseEntries("MIT*")).toEqual([{ license: { name: "MIT*" } }]);
    expect(licenseEntries("BSD")).toEqual([{ license: { name: "BSD" } }]);
    expect(licenseEntries("UNLICENSED")).toEqual([{ license: { name: "UNLICENSED" } }]);
    expect(licenseEntries("LicenseRef-Custom")).toEqual([{ license: { name: "LicenseRef-Custom" } }]);
    expect(licenseEntries("SEE LICENSE IN LICENSE")).toEqual([
      { license: { name: "SEE LICENSE IN LICENSE" } },
    ]);
    expect(licenseEntries("GPL-2.0-only WITH Classpath-exception-2.0")).toEqual([
      { expression: "GPL-2.0-only WITH Classpath-exception-2.0" },
    ]);
    expect(licenseEntries("Apache-2.0 AND MIT")).toEqual([{ expression: "Apache-2.0 AND MIT" }]);
  });
  it("mọi id của license-policy.json được nhận là SPDX id", () => {
    const p = loadPolicy();
    const pseudo = new Set(["UNLICENSED", "UNKNOWN", "NOASSERTION"]);
    for (const id of [...p.allow, ...p.deny, ...p.review].filter((x) => !pseudo.has(x)))
      expect(licenseEntries(id), id).toEqual([{ license: { id } }]);
  });
});

describe("lockIntegrity", () => {
  it("lấy băm SHA-512 từ document có importers, bỏ document môi trường", () => {
    const hex = "ab".repeat(64);
    const b64 = Buffer.from(hex, "hex").toString("base64");
    const lock = `lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  env-only@1.0.0:\n    resolution: {integrity: sha512-${b64}}\n---\nlockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  '@a/b@1.2.3':\n    resolution: {integrity: sha512-${b64}}\n  no-hash@1.0.0:\n    resolution: {tarball: x}\n`;
    const m = lockIntegrity(lock);
    expect([...m.keys()]).toEqual(["@a/b@1.2.3"]);
    expect(m.get("@a/b@1.2.3")).toBe(hex);
  });
  it("rỗng → Map rỗng", () => {
    expect(lockIntegrity("").size).toBe(0);
  });
});

describe("buildSbom", () => {
  const by = {
    MIT: [{ name: "@a/b", versions: ["2.0.0", "1.0.0"] }],
    "MIT OR Apache-2.0": [{ name: "zed", versions: ["3.0.0"] }],
    Unknown: [{ name: "x", versions: ["0.1.0"] }],
  };
  it("component có purl/license, sắp xếp ổn định, hash khi có, khoá bắt buộc của CycloneDX", () => {
    const bom = buildSbom(by, {
      root: { name: "r", version: "1.0.0" },
      integrity: new Map([["zed@3.0.0", "aa"]]),
    });
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.6");
    expect(bom.metadata.component).toMatchObject({ name: "r", version: "1.0.0" });
    expect(bom.components.map((c) => `${c.group ?? ""}|${c.name}|${c.version}`)).toEqual([
      "@a|b|1.0.0",
      "@a|b|2.0.0",
      "|x|0.1.0",
      "|zed|3.0.0",
    ]);
    expect(bom.components[0].purl).toBe("pkg:npm/%40a/b@1.0.0");
    expect(bom.components[2].licenses).toBeUndefined();
    expect(bom.components[3].hashes).toEqual([{ alg: "SHA-512", content: "aa" }]);
    expect(bom.metadata.timestamp).toBeUndefined();
  });
  it("hai lần dựng cùng đầu vào → giống hệt (diff = 0); rỗng → không thành phần", () => {
    expect(JSON.stringify(buildSbom(by))).toBe(JSON.stringify(buildSbom(by)));
    expect(buildSbom({}).components).toEqual([]);
  });
  it("trùng gói/phiên bản giữa các giấy phép chỉ tính một lần", () => {
    const dup = { MIT: [{ name: "a", versions: ["1.0.0"] }], ISC: [{ name: "a", versions: ["1.0.0"] }] };
    expect(buildSbom(dup).components).toHaveLength(1);
  });
});

const lib = (name, licenses, extra = {}) => ({
  type: "library",
  name,
  version: "1.0.0",
  ...(licenses ? { licenses } : {}),
  ...extra,
});
const bomOf = (...components) => ({ bomFormat: "CycloneDX", specVersion: "1.6", components });
const mit = [{ license: { id: "MIT" } }];

describe("isUnasserted / isSourceAvailable", () => {
  it.each([
    ["NOASSERTION", true],
    ["unknown", true],
    ["(MIT OR NOASSERTION)", true],
    ["MIT", false],
    ["Apache-2.0 AND MIT", false],
  ])("isUnasserted(%s) = %s", (s, want) => expect(isUnasserted(s)).toBe(want));
  it.each([
    ["BUSL-1.1", true],
    ["SSPL-1.0", true],
    ["Elastic-2.0", true],
    ["Elastic License 2.0", true],
    ["Commons Clause", true],
    ["MIT OR BUSL-1.1", true],
    ["Apache-2.0", false],
    ["MIT", false],
  ])("isSourceAvailable(%s) = %s", (s, want) => expect(isSourceAvailable(s)).toBe(want));
});

describe("analyzeSbom", () => {
  it("đạt: mọi thành phần có giấy phép", () => {
    const r = analyzeSbom(bomOf(lib("a", mit), lib("b", mit)), { today: TODAY });
    expect(r.errors).toEqual([]);
    expect(r.coverage).toBe(100);
    expect(r.total).toBe(2);
  });
  it("bỏ file/operating-system khỏi mẫu số", () => {
    const r = analyzeSbom(
      bomOf(lib("a", mit), { type: "operating-system", name: "debian" }, { type: "file", name: "f" }),
      { today: TODAY },
    );
    expect(r.total).toBe(1);
    expect(r.errors).toEqual([]);
  });
  it("biên 99%: 1/100 thiếu vẫn đạt, 2/100 thiếu đỏ", () => {
    const hundred = (miss) =>
      bomOf(...Array.from({ length: 100 }, (_, i) => lib(`p${i}`, i < miss ? undefined : mit)));
    expect(analyzeSbom(hundred(1), { today: TODAY }).errors).toEqual([]);
    const red = analyzeSbom(hundred(2), { today: TODAY });
    expect(red.coverage).toBe(98);
    expect(red.errors.join()).toMatch(/98\.0% < 99%/);
  });
  it("NOASSERTION/UNKNOWN đỏ dù độ phủ ≥ 99%; ngoại lệ còn hạn thì đạt; hết hạn thì đỏ lại", () => {
    const many = Array.from({ length: 200 }, (_, i) => lib(`p${i}`, mit));
    const bom = bomOf(...many, lib("weed", [{ license: { name: "NOASSERTION" } }]));
    const red = analyzeSbom(bom, { today: TODAY });
    expect(red.coverage).toBeGreaterThan(99);
    expect(red.unasserted).toEqual(["weed@1.0.0 — NOASSERTION"]);
    expect(red.errors.join()).toMatch(/NOASSERTION\/UNKNOWN ngoài ngoại lệ/);
    expect(analyzeSbom(bom, { exceptions: [EX()], today: TODAY }).errors).toEqual([]);
    const expired = analyzeSbom(bom, { exceptions: [EX({ expires: "2026-10-16" })], today: TODAY });
    expect(expired.errors.join()).toMatch(/đã hết hạn/);
    expect(expired.unasserted).toHaveLength(1);
  });
  it("source-available: đỏ nếu không có ngoại lệ; ngoại lệ thiếu ADR vẫn đỏ; có ADR thì đạt", () => {
    const bom = bomOf(lib("db", [{ license: { id: "BUSL-1.1" } }]));
    expect(analyzeSbom(bom, { today: TODAY }).sourceAvailable).toEqual(["db@1.0.0 — BUSL-1.1"]);
    const noAdr = EX({ package: "db", license: "BUSL-1.1", reason: "đã duyệt miệng" });
    expect(analyzeSbom(bom, { exceptions: [noAdr], today: TODAY }).errors.join()).toMatch(/source-available/);
    const withAdr = EX({
      package: "db",
      license: "BUSL-1.1",
      reason: "xem ADR-0007: dùng nội bộ, không phân phối lại",
    });
    expect(analyzeSbom(bom, { exceptions: [withAdr], today: TODAY }).errors).toEqual([]);
  });
  it("gói có group khớp ngoại lệ theo `group/name`", () => {
    const bom = bomOf(lib("b", [{ license: { id: "UNKNOWN" } }], { group: "@a" }));
    expect(
      analyzeSbom(bom, { exceptions: [EX({ package: "@a/b", license: "UNKNOWN" })], today: TODAY }).errors,
    ).toEqual([]);
  });
  it("SBOM rỗng/không phải CycloneDX/không có thành phần → đỏ (không xanh giả)", () => {
    expect(analyzeSbom(bomOf(), { today: TODAY }).errors.join()).toMatch(/rỗng/);
    expect(analyzeSbom({}, { today: TODAY }).errors.join()).toMatch(/CycloneDX/);
    expect(analyzeSbom(null, { today: TODAY }).errors.join()).toMatch(/CycloneDX/);
    expect(analyzeSbom({ bomFormat: "CycloneDX" }, { today: TODAY }).errors.join()).toMatch(/rỗng/);
  });
  it("biểu thức giấy phép Unicode/tên lạ vẫn tính là có giấy phép", () => {
    expect(
      analyzeSbom(bomOf(lib("a", [{ license: { name: "Giấy phép tự đặt ✓" } }])), { today: TODAY }).errors,
    ).toEqual([]);
  });
  it("minCoverage tuỳ chỉnh được siết (100%)", () => {
    const r = analyzeSbom(bomOf(lib("a", mit), lib("b")), { minCoverage: 100, today: TODAY });
    expect(r.errors.join()).toMatch(/50\.0% < 100%/);
  });
});

describe("analyzeSbom với chính sách (--policy)", () => {
  const POLICY = {
    schema: 1,
    allow: ["MIT", "Apache-2.0", "ISC"],
    deny: ["AGPL-3.0-only", "UNLICENSED", "UNKNOWN", "NOASSERTION"],
    review: ["LGPL-3.0-or-later"],
    exceptions: [],
    sbom_exceptions: [],
  };
  const withEx = (over, list = "sbom_exceptions") => ({
    ...POLICY,
    [list]: [EX({ package: "x", license: "LGPL-3.0-or-later", expires: "2026-12-31", ...over })],
  });
  const run = (comp, policy = POLICY) =>
    analyzeSbom(bomOf(lib("ok", mit), comp), { policy, exceptions: policy.sbom_exceptions, today: TODAY });
  const named = (name) => [{ license: { name } }];

  it("giấy phép thuộc allow (kể cả biểu thức) → đạt", () => {
    const both = [{ expression: "MIT OR Apache-2.0" }];
    expect(run(lib("x", both)).errors).toEqual([]);
    expect(run(lib("x", [{ expression: "(MIT AND ISC)" }])).errors).toEqual([]);
  });
  it("AGPL-3.0-only → đỏ, và ngoại lệ không cứu được deny thật", () => {
    const agpl = lib("x", [{ license: { id: "AGPL-3.0-only" } }]);
    const r = run(agpl);
    expect(r.policyViolations).toEqual([
      "x@1.0.0 — AGPL-3.0-only: giấy phép bị cấm (deny), không có ngoại lệ",
    ]);
    expect(r.errors.join()).toMatch(/ngoài chính sách/);
    const attempted = run(agpl, withEx({ license: "AGPL-3.0-only" }, "exceptions"));
    expect(attempted.errors.join()).toMatch(/ngoài chính sách/);
    expect(attempted.errors.join()).toMatch(/thuộc deny/); // validatePolicy cũng từ chối ngoại lệ deny
  });
  it("UNLICENSED và 'SEE LICENSE IN …' → đỏ (chưa rõ); NOASSERTION vẫn đỏ qua luật 2", () => {
    const u = run(lib("x", named("UNLICENSED")));
    expect(u.policyViolations.join()).toMatch(/chưa rõ/);
    const see = run(lib("x", named("SEE LICENSE IN LICENSE")));
    expect(see.policyViolations.join()).toMatch(/chưa rõ/);
    expect(see.errors).not.toEqual([]);
    const na = run(lib("x", named("NOASSERTION")));
    expect(na.unasserted).toHaveLength(1);
    expect(na.policyViolations).toEqual([]); // không báo trùng
    expect(na.errors).not.toEqual([]);
  });
  it("giấy phép lạ/không xác định → đỏ", () => {
    expect(run(lib("x", named("Mã tự đặt ✓"))).policyViolations.join()).toMatch(/chưa có trong allow/);
    expect(run(lib("x", named("MIT*"))).errors).not.toEqual([]);
  });
  it("review (LGPL): đỏ nếu không có ngoại lệ; ngoại lệ còn hạn → đạt (cả ở sbom_exceptions lẫn exceptions)", () => {
    const lgpl = lib("x", [{ license: { id: "LGPL-3.0-or-later" } }]);
    expect(run(lgpl).policyViolations.join()).toMatch(/review/);
    expect(run(lgpl, withEx({})).errors).toEqual([]);
    expect(run(lgpl, withEx({}, "exceptions")).errors).toEqual([]);
  });
  it("ngoại lệ hết hạn → đỏ; sai tên gói hoặc sai giấy phép → đỏ; hạn cuối ngày hôm nay vẫn còn hiệu lực", () => {
    const lgpl = lib("x", [{ license: { id: "LGPL-3.0-or-later" } }]);
    const expired = run(lgpl, withEx({ expires: "2026-10-16" }));
    expect(expired.errors.join()).toMatch(/đã hết hạn/);
    expect(expired.policyViolations).toHaveLength(1);
    expect(run(lgpl, withEx({ package: "khac" })).policyViolations).toHaveLength(1);
    expect(run(lgpl, withEx({ license: "LGPL-2.1-only" })).policyViolations).toHaveLength(1);
    expect(run(lgpl, withEx({ expires: TODAY })).errors).toEqual([]);
  });
  it("ngoại lệ UNLICENSED còn hạn (sbom_exceptions) → đạt; thiếu approved_by → đỏ", () => {
    const comp = lib("x", named("UNLICENSED"));
    expect(run(comp, withEx({ license: "UNLICENSED" })).errors).toEqual([]);
    const bad = run(comp, withEx({ license: "UNLICENSED", approved_by: "" }));
    expect(bad.errors.join()).toMatch(/thiếu trường approved_by/);
    expect(bad.policyViolations).toHaveLength(1);
  });
  it("gói có group khớp ngoại lệ `group/name`", () => {
    const c = lib("libvips", [{ license: { id: "LGPL-3.0-or-later" } }], { group: "@img" });
    expect(run(c, withEx({ package: "@img/libvips" })).errors).toEqual([]);
  });
  it("không truyền policy → hành vi cũ (AGPL không bị luật 4 chặn)", () => {
    const r = analyzeSbom(bomOf(lib("x", [{ license: { id: "AGPL-3.0-only" } }])), { today: TODAY });
    expect(r.errors).toEqual([]);
  });
});

describe("validateExceptions", () => {
  it("thiếu trường, ngày sai, quá 12 tháng, không phải mảng", () => {
    expect(validateExceptions(undefined, TODAY)).toEqual([]);
    expect(validateExceptions([], TODAY)).toEqual([]);
    expect(validateExceptions({}, TODAY)).toEqual(["sbom_exceptions phải là mảng (có thể rỗng)"]);
    expect(validateExceptions([EX({ reason: "" })], TODAY).join()).toMatch(/thiếu trường reason/);
    expect(validateExceptions([EX({ expires: "2026-13-40" })], TODAY).join()).toMatch(/YYYY-MM-DD hợp lệ/);
    expect(validateExceptions([EX({ expires: "2030-01-01" })], TODAY).join()).toMatch(/quá 12 tháng/);
    expect(validateExceptions([null], TODAY).join()).toMatch(/phải là object/);
  });
});

describe("license-policy.json thật", () => {
  it("sbom_exceptions hợp lệ ở hôm nay (không ngoại lệ hết hạn)", () => {
    expect(validateExceptions(loadPolicy().sbom_exceptions)).toEqual([]);
  });
});

describe("CLI", () => {
  const run = (args) => {
    try {
      const out = execFileSync("node", [join(ROOT, "scripts/sbom-check.mjs"), ...args], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  it("không có đối số → exit 2; file không đọc được → exit 1; SBOM tốt → 0, xấu → 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbom-"));
    try {
      expect(run([]).code).toBe(2);
      expect(run([join(dir, "khong-co.json")]).code).toBe(1);
      const good = join(dir, "good.cdx.json");
      const bad = join(dir, "bad.cdx.json");
      writeFileSync(good, JSON.stringify(bomOf(lib("a", mit))));
      writeFileSync(bad, JSON.stringify(bomOf(lib("a"))));
      expect(run([good]).code).toBe(0);
      expect(run([bad]).code).toBe(1);
      expect(run([good, bad]).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("--policy: AGPL/UNLICENSED → exit 1; chính sách thiếu/hỏng → exit 1; thiếu giá trị → exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbom-"));
    try {
      const policy = join(dir, "policy.json");
      writeFileSync(
        policy,
        JSON.stringify({
          schema: 1,
          allow: ["MIT"],
          deny: ["AGPL-3.0-only", "UNLICENSED"],
          review: [],
          exceptions: [],
          sbom_exceptions: [],
        }),
      );
      const good = join(dir, "good.cdx.json");
      const agpl = join(dir, "agpl.cdx.json");
      const unl = join(dir, "unl.cdx.json");
      const see = join(dir, "see.cdx.json");
      writeFileSync(good, JSON.stringify(bomOf(lib("a", mit))));
      writeFileSync(
        agpl,
        JSON.stringify(bomOf(lib("a", mit), lib("b", [{ license: { id: "AGPL-3.0-only" } }]))),
      );
      writeFileSync(
        unl,
        JSON.stringify(bomOf(lib("a", mit), lib("b", [{ license: { name: "UNLICENSED" } }]))),
      );
      writeFileSync(
        see,
        JSON.stringify(bomOf(lib("a", mit), lib("b", [{ license: { name: "SEE LICENSE IN LICENSE" } }]))),
      );
      expect(run(["--policy", policy, good]).code).toBe(0);
      expect(run([agpl]).code).toBe(0); // không --policy: luật 4 tắt
      for (const f of [agpl, unl, see])
        expect(run(["--policy", policy, "--min-coverage", "50", f]).code, f).toBe(1);
      expect(run(["--policy", join(dir, "khong-co.json"), good]).code).toBe(1);
      expect(run([good, "--policy"]).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("sbom.mjs trên repo thật: sinh BOM CycloneDX có thành phần và qua sbom-check", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbom-"));
    try {
      const out = join(dir, "npm.cdx.json");
      execFileSync("node", [join(ROOT, "scripts/sbom.mjs"), "--out", out], { cwd: ROOT, stdio: "pipe" });
      const bom = JSON.parse(readFileSync(out, "utf8"));
      expect(bom.components.length).toBeGreaterThan(50);
      expect(bom.components.every((c) => c.purl.startsWith("pkg:npm/"))).toBe(true);
      // Phải thấy phụ thuộc runtime của package con (không chỉ devDependencies của gốc).
      const names = new Set(bom.components.map((c) => (c.group ? `${c.group}/${c.name}` : c.name)));
      for (const n of ["next", "pg-boss", "kysely"]) expect(names.has(n), n).toBe(true);
      expect(run([out]).code).toBe(0);
      expect(run(["--policy", join(ROOT, "license-policy.json"), out]).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
