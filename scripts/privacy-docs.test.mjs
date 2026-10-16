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
