// T-705: chính sách giấy phép (CMP-LIC-002, D-057) — phán quyết theo license-policy.json, ngoại lệ có hạn.
import { describe, expect, it } from "vitest";
import { checkLicenses, isAllowed, loadPolicy, validatePolicy, verdict } from "./check-licenses.mjs";

const TODAY = "2026-10-17";
const policy = (over = {}) => ({
  schema: 1,
  allow: ["MIT", "Apache-2.0", "ISC"],
  deny: ["AGPL-3.0-only", "GPL-3.0-only", "UNKNOWN"],
  review: ["LGPL-3.0-only", "MPL-1.1"],
  exceptions: [],
  ...over,
});
const ex = (over = {}) => ({
  package: "libx",
  license: "LGPL-3.0-only",
  reason: "chỉ dùng ở công cụ dev, không phân phối",
  approved_by: "chủ dự án",
  expires: "2026-12-31",
  ...over,
});
const pkgs = (license, ...names) => ({ [license]: names.map((name) => ({ name, versions: ["1.0.0"] })) });

describe("verdict / isAllowed (SPDX)", () => {
  it.each([
    ["MIT", "allow"],
    ["MIT OR Apache-2.0", "allow"],
    ["(MIT OR GPL-3.0-only)", "allow"],
    ["AGPL-3.0-only", "deny"],
    ["MIT AND GPL-3.0-only", "deny"],
    ["MIT AND LGPL-3.0-only", "review"],
    ["GPL-3.0-only OR LGPL-3.0-only", "review"],
    ["Zlib", "unknown"],
    ["MIT AND Zlib", "unknown"],
    ["UNKNOWN", "deny"],
    ["", "unknown"],
    ["  mit  ", "unknown"], // SPDX phân biệt hoa thường theo danh sách; chữ thường không được đoán
  ])("%j → %s", (expr, v) => {
    expect(verdict(expr, policy())).toBe(v);
  });

  it("isAllowed dùng file chính sách thật khi không truyền policy", () => {
    expect(isAllowed("MIT")).toBe(true);
    expect(isAllowed("MIT OR Apache-2.0")).toBe(true);
    expect(isAllowed("(MIT OR GPL-3.0-or-later)")).toBe(true);
    expect(isAllowed("AGPL-3.0-only")).toBe(false);
    expect(isAllowed("GPL-3.0-or-later")).toBe(false);
    expect(isAllowed("MIT AND GPL-2.0-only")).toBe(false);
    expect(isAllowed("BUSL-1.1")).toBe(false);
    expect(isAllowed("UNKNOWN")).toBe(false);
  });
});

describe("validatePolicy", () => {
  it("chính sách tối thiểu hợp lệ; ngoại lệ còn hạn hợp lệ", () => {
    expect(validatePolicy(policy(), TODAY)).toEqual([]);
    expect(validatePolicy(policy({ exceptions: [ex()] }), TODAY)).toEqual([]);
  });
  it("ngoại lệ hết hạn → lỗi; đúng ngày hết hạn vẫn còn hiệu lực, hôm sau thì hết", () => {
    expect(validatePolicy(policy({ exceptions: [ex({ expires: "2026-10-16" })] }), TODAY).join()).toMatch(
      /hết hạn/,
    );
    expect(validatePolicy(policy({ exceptions: [ex({ expires: TODAY })] }), TODAY)).toEqual([]);
    expect(validatePolicy(policy({ exceptions: [ex({ expires: TODAY })] }), "2026-10-18").join()).toMatch(
      /hết hạn/,
    );
  });
  it.each(["package", "license", "reason", "approved_by", "expires"])("ngoại lệ thiếu/rỗng %s → lỗi", (f) => {
    expect(validatePolicy(policy({ exceptions: [ex({ [f]: undefined })] }), TODAY).join()).toContain(
      `thiếu trường ${f}`,
    );
    expect(validatePolicy(policy({ exceptions: [ex({ [f]: "  " })] }), TODAY).join()).toContain(
      `thiếu trường ${f}`,
    );
  });
  it.each(["2026-13-01", "2026-02-30", "31/12/2026", "2026-1-1", "soon"])(
    "expires %j không hợp lệ → lỗi",
    (d) => {
      expect(validatePolicy(policy({ exceptions: [ex({ expires: d })] }), TODAY).join()).toMatch(
        /YYYY-MM-DD/,
      );
    },
  );
  it("cấu trúc sai: không phải object, schema, danh sách, trùng/xung đột", () => {
    expect(validatePolicy(null)).toHaveLength(1);
    expect(validatePolicy([])).toHaveLength(1);
    expect(validatePolicy(policy({ schema: 2 }), TODAY).join()).toMatch(/schema/);
    expect(validatePolicy(policy({ allow: [] }), TODAY).join()).toMatch(/allow rỗng/);
    expect(validatePolicy(policy({ deny: "MIT" }), TODAY).join()).toMatch(/deny phải là mảng/);
    expect(validatePolicy(policy({ deny: ["MIT"] }), TODAY).join()).toMatch(/MIT có ở cả allow và deny/);
    expect(validatePolicy(policy({ exceptions: undefined }), TODAY).join()).toMatch(
      /exceptions phải là mảng/,
    );
    expect(validatePolicy(policy({ exceptions: [null] }), TODAY).join()).toMatch(/phải là object/);
    expect(validatePolicy(policy({ exceptions: [ex(), ex()] }), TODAY).join()).toMatch(/trùng ngoại lệ/);
  });
});

describe("checkLicenses", () => {
  it("toàn gói được phép → sạch", () => {
    const r = checkLicenses({ ...pkgs("MIT", "a"), ...pkgs("MIT OR Apache-2.0", "b") }, policy(), TODAY);
    expect(r).toMatchObject({ errors: [], violations: [], used: [], stale: [] });
  });
  it("gói AGPL / không xác định / review bị chặn, thông báo nêu lý do", () => {
    const r = checkLicenses(
      { ...pkgs("AGPL-3.0-only", "agpl"), ...pkgs("Zlib", "zl"), ...pkgs("LGPL-3.0-only", "lg") },
      policy(),
      TODAY,
    );
    expect(r.violations).toHaveLength(3);
    expect(r.violations.join("\n")).toMatch(/agpl@1.0.0.*cấm/);
    expect(r.violations.join("\n")).toMatch(/zl@1.0.0.*không xác định/);
    expect(r.violations.join("\n")).toMatch(/lg@1.0.0.*review/);
  });
  it("ngoại lệ còn hạn cho đúng (gói, giấy phép) → qua, ghi nhận đã dùng", () => {
    const e = ex({ package: "lg" });
    const r = checkLicenses(pkgs("LGPL-3.0-only", "lg"), policy({ exceptions: [e] }), TODAY);
    expect(r.violations).toEqual([]);
    expect(r.used).toEqual([e]);
  });
  it("ngoại lệ chỉ che đúng gói đó và đúng giấy phép đó", () => {
    const e = ex({ package: "lg" });
    expect(
      checkLicenses(pkgs("LGPL-3.0-only", "khac"), policy({ exceptions: [e] }), TODAY).violations,
    ).toHaveLength(1);
    expect(
      checkLicenses(pkgs("GPL-3.0-only", "lg"), policy({ exceptions: [e] }), TODAY).violations,
    ).toHaveLength(1);
  });
  it("ngoại lệ hết hạn → gói bị chặn VÀ chính sách báo lỗi (đỏ)", () => {
    const e = ex({ package: "lg", expires: "2026-10-16" });
    const r = checkLicenses(pkgs("LGPL-3.0-only", "lg"), policy({ exceptions: [e] }), TODAY);
    expect(r.errors.join()).toMatch(/hết hạn/);
    expect(r.violations).toHaveLength(1);
    expect(r.used).toEqual([]);
  });
  it("ngoại lệ thiếu approved_by không có hiệu lực", () => {
    const e = ex({ package: "lg", approved_by: "" });
    const r = checkLicenses(pkgs("LGPL-3.0-only", "lg"), policy({ exceptions: [e] }), TODAY);
    expect(r.errors.join()).toContain("thiếu trường approved_by");
    expect(r.violations).toHaveLength(1);
  });
  it("ngoại lệ không còn gói khớp → stale (cảnh báo dọn)", () => {
    const r = checkLicenses(pkgs("MIT", "a"), policy({ exceptions: [ex({ package: "cu" })] }), TODAY);
    expect(r.stale).toHaveLength(1);
    expect(r.violations).toEqual([]);
  });
  it("nhiều phiên bản của cùng gói đều được liệt kê; danh sách rỗng → sạch", () => {
    const r = checkLicenses(
      { "AGPL-3.0-only": [{ name: "p", versions: ["1.0.0", "2.0.0"] }] },
      policy(),
      TODAY,
    );
    expect(r.violations[0]).toContain("p@1.0.0,2.0.0");
    expect(checkLicenses({}, policy(), TODAY).violations).toEqual([]);
  });
});

describe("license-policy.json thật của repo", () => {
  const real = loadPolicy();
  it("hợp lệ ở thời điểm hiện tại (không có ngoại lệ hết hạn/thiếu trường)", () => {
    expect(validatePolicy(real)).toEqual([]);
  });
  it("allow không chứa giấy phép copyleft/nguồn-mở-có-điều-kiện/không rõ (chỉ siết, không nới)", () => {
    for (const id of real.allow)
      expect(id, id).not.toMatch(/GPL|SSPL|BUSL|Elastic|UNKNOWN|UNLICENSED|NOASSERTION|-NC/);
  });
  it("deny gồm AGPL (ADR-0002) và nhóm review gồm LGPL", () => {
    expect(real.deny).toContain("AGPL-3.0-only");
    expect(real.deny).toContain("AGPL-3.0-or-later");
    expect(real.review).toContain("LGPL-3.0-only");
  });
  it("mọi ngoại lệ thật đều đủ trường", () => {
    for (const e of real.exceptions)
      for (const f of ["package", "license", "reason", "approved_by", "expires"]) expect(e[f]).toBeTruthy();
  });
});
