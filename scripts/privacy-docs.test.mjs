// T-309: rào cấu trúc cho hồ sơ quyền riêng tư và sổ rủi ro (CMP-PRIV-001, CMP-AUDIT-003/007, PM-RISK-001).
// Đối chiếu data-map.yaml với catalog CSDL nằm ở packages/app/src/privacy/data-map.db.test.ts (cần Postgres).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const rows = (text, prefix) =>
  text
    .split("\n")
    .filter((l) => l.startsWith(`| ${prefix}`))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );

describe("docs/RISKS.md", () => {
  const text = read("docs/RISKS.md");
  const risks = rows(text, "RK-");
  it("RK-001… liên tục, không trùng, đủ cột", () => {
    expect(risks.length).toBeGreaterThanOrEqual(15);
    risks.forEach((r, i) => {
      expect(r[0]).toBe(`RK-${String(i + 1).padStart(3, "0")}`);
      expect(r).toHaveLength(10);
      for (const c of r) expect(c.length, `${r[0]}: ô trống`).toBeGreaterThan(0);
    });
  });
  it("khả năng/tác động ∈ {Thấp, TB, Cao}", () => {
    for (const r of risks) {
      expect(["Thấp", "TB", "Cao"], `${r[0]} khả năng`).toContain(r[2]);
      expect(["Thấp", "TB", "Cao"], `${r[0]} tác động`).toContain(r[3]);
    }
  });
  it("có rủi ro từ PROJECT §8 (R06, R08, R11) và từ PLAN", () => {
    for (const frag of [
      "R06",
      "R08",
      "R11",
      "PLAN đợt 3 R1",
      "PLAN đợt 3 R2",
      "PLAN đợt 3 R3",
      "PLAN đợt 3 R4",
    ])
      expect(text, frag).toContain(frag);
  });
  it("đường dẫn test/tài liệu trong cột task/test có thật", () => {
    for (const r of risks) {
      for (const m of r[8].matchAll(/`([^`]+)`/g)) {
        if (/^(apps|packages|scripts|deploy|docs|\.github)\//.test(m[1]))
          expect(existsSync(join(ROOT, m[1])), `${r[0]}: không có ${m[1]}`).toBe(true);
      }
    }
  });
});

describe("docs/privacy", () => {
  it("processors.md: VPS, kho sao lưu, SMTP relay ở trạng thái chưa chọn; mỗi dòng đủ cột", () => {
    const text = read("docs/privacy/processors.md");
    for (const name of ["VPS tại Việt Nam", "Kho sao lưu pgBackRest", "SMTP relay"]) {
      const row = text.split("\n").find((l) => l.startsWith(`| **${name}`));
      expect(row, name).toBeTruthy();
      expect(row).toMatch(/chưa chọn/);
    }
    const table = text.split("\n").filter((l) => /^\| (\*\*|Better|Ngân)/.test(l));
    expect(table.length).toBeGreaterThanOrEqual(8);
    for (const l of table) expect(l.slice(1, -1).split("|")).toHaveLength(7);
  });
  it("ROPA.md là khung chờ DPIA, có đủ hoạt động và cột bắt buộc", () => {
    const text = read("docs/privacy/ROPA.md");
    expect(text).toMatch(/chờ DPIA/);
    for (const col of [
      "Mục đích",
      "Chủ thể",
      "Cơ sở pháp lý (đề xuất — chờ DPIA)",
      "Bên nhận / xử lý",
      "Hạn giữ",
      "Biện pháp bảo vệ",
    ])
      expect(text, col).toContain(col);
    expect(rows(text, "HĐ-").length).toBeGreaterThanOrEqual(8);
    expect(text).toMatch(/## Lịch sử cập nhật/);
  });
  it("data-map.yaml tồn tại và đánh dấu đề xuất chờ DPIA", () => {
    const y = read("docs/privacy/data-map.yaml");
    expect(y).toMatch(/^status: ".*chờ DPIA/m);
    expect(y).toContain("legal_basis_status");
  });
  it("không bịa số điều luật: Điều/Đ. chỉ xuất hiện kèm đánh dấu chưa xác minh ở cùng dòng", () => {
    for (const f of [
      "docs/privacy/processors.md",
      "docs/privacy/ROPA.md",
      "docs/privacy/data-map.yaml",
      "docs/RISKS.md",
    ])
      for (const line of read(f)
        .split("\n")
        .filter((l) => /\bĐiều \d+|\bĐ\.\d+/.test(l)))
        expect(line, `${f}: ${line}`).toMatch(/chưa xác minh/);
  });
});

describe("scripts/privacy-docs.mjs (CMP-INTL-002, CMP-AUDIT-003, CMP-AUDIT-007)", async () => {
  const { changelogFindings, dataMapErrors, run, vendorErrors } = await import("./privacy-docs.mjs");
  const DAY = 86_400_000;
  const T = Date.parse("2026-10-25T00:00:00Z");
  const entry = (o) => ({
    table: "public.t",
    column: "c",
    legal_basis: "x",
    legal_basis_code: "contract",
    ...o,
  });

  it("repo thật: không lỗi", () => {
    expect(run(T).errors).toEqual([]);
  });

  it("data map: thiếu/sai legal_basis_code, nhạy cảm thiếu art9_condition hoặc thiếu note → lỗi", () => {
    expect(dataMapErrors({ entries: [entry({})] })).toEqual([]);
    expect(dataMapErrors({ entries: [entry({ legal_basis_code: "hop_dong" })] })[0]).toMatch(
      /legal_basis_code/,
    );
    expect(dataMapErrors({ entries: [entry({ legal_basis: "" })] })[0]).toMatch(/thiếu legal_basis/);
    expect(dataMapErrors({ entries: [entry({ classification: "nhay_cam" })] })[0]).toMatch(/art9_condition/);
    expect(
      dataMapErrors({
        entries: [entry({ classification: "nhay_cam", art9_condition: "khong_thuoc_art9" })],
      })[0],
    ).toMatch(/art9_note/);
    expect(
      dataMapErrors({ entries: [entry({ classification: "nhay_cam", art9_condition: "explicit_consent" })] }),
    ).toEqual([]);
    expect(dataMapErrors({ entries: [] })).toEqual(["data map không có mục nào"]);
  });

  const v = (o) => ({
    name: "A",
    role: "r",
    data: "d",
    location: "VN",
    dpa: "x",
    status: "dang_dung",
    reviewed: "2026-01-01",
    sdk_packages: [],
    ...o,
  });
  const md = "| **A** | r |\n";
  it("nhà cung cấp: hợp lệ; quá 12 tháng chưa rà; trùng tên; lệch processors.md hai chiều", () => {
    expect(vendorErrors({ vendors: [v({})] }, md, [], T)).toEqual([]);
    expect(vendorErrors({ vendors: [v({ reviewed: "2025-01-01" })] }, md, [], T)[0]).toMatch(/quá 12 tháng/);
    expect(
      vendorErrors({ vendors: [v({ reviewed: "2025-01-01", status: "chua_chon" })] }, md, [], T),
    ).toEqual([]);
    expect(vendorErrors({ vendors: [v({}), v({})] }, md, [], T)).toContain("A: trùng tên");
    expect(vendorErrors({ vendors: [v({ name: "B" })] }, md, [], T).join()).toMatch(
      /B: không có trong.*"A": thiếu dòng/,
    );
    expect(
      vendorErrors({ vendors: [v({ status: "x", sdk_packages: undefined })] }, md, [], T).join(),
    ).toMatch(/sdk_packages phải là mảng.*status "x"/);
  });
  it("SDK dịch vụ ngoài trong phụ thuộc runtime phải có ở sdk_packages; thư viện thường thì không cần", () => {
    expect(vendorErrors({ vendors: [v({})] }, md, ["@sentry/node", "zod"], T)).toEqual([
      'phụ thuộc runtime "@sentry/node" là SDK dịch vụ ngoài nhưng chưa có trong sdk_packages của vendors.yaml',
    ]);
    expect(
      vendorErrors({ vendors: [v({ sdk_packages: ["@sentry/node"] })] }, md, ["@sentry/node"], T),
    ).toEqual([]);
  });

  it("CHANGELOG: phải có mục ngày, xếp mới nhất trên; updated mới hơn mục mới nhất → lỗi; quá 6 tháng → cảnh báo", () => {
    expect(changelogFindings("# x\n", [], T).errors[0]).toMatch(/chưa có mục/);
    expect(changelogFindings("## 2026-01-01\n## 2026-02-01\n", [], T).errors[0]).toMatch(/mới nhất ở trên/);
    expect(changelogFindings("## 2026-10-25\n", [["ROPA.md", "2026-10-26"]], T).errors[0]).toMatch(
      /ROPA\.md/,
    );
    const old = changelogFindings("## 2026-01-01\n", [["ROPA.md", "2026-01-01"]], T);
    expect(old.errors).toEqual([]);
    expect(old.warnings[0]).toMatch(/quá 6 tháng/);
    expect(changelogFindings("## 2026-10-01\n", [], T + 0 * DAY).warnings).toEqual([]);
  });
});
