// Test rào sổ vận hành (WF-DOC-008, CMP-AUDIT-010, CMP-INTL-006, IND-SAAS-010, PM-HANDOVER-009; T-2306).
import { describe, expect, it } from "vitest";
import { incidentErrors, legalErrors, renewalFindings, run, runbookFindings } from "./ops-registers.mjs";

const T = Date.parse("2026-10-25T00:00:00Z");
const DAY = 86_400_000;

describe("repo thật", () => {
  it("không lỗi (cảnh báo diễn tập là việc của người)", () => {
    expect(run(T).errors).toEqual([]);
  });
});

describe("runbookFindings (WF-DOC-008)", () => {
  const index = [
    "| Deploy | [a](runbooks/a.md) |",
    "| Rollback | [a](runbooks/a.md) |",
    "| Khôi phục backup | [b](runbooks/b.md) |",
    "| Xoay secret | [c](runbooks/c.md) |",
    "| Sự cố thường gặp | x |",
  ].join("\n");
  const fm = (d) => `---\ntitle: x\nlast_drilled: ${d}\n---\n# x`;
  it("ngày trong 6 tháng → không cảnh báo; quá hạn / chưa diễn tập → cảnh báo; thiếu trường / thiếu tệp → lỗi", () => {
    const files = {
      "runbooks/a.md": fm("2026-09-01 — ok"),
      "runbooks/b.md": fm("2025-01-01"),
      "runbooks/c.md": fm("chưa diễn tập"),
    };
    const r = runbookFindings(index, (p) => files[p] ?? null, T);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/b\.md: diễn tập quá 6 tháng[\s\S]*c\.md: chưa diễn tập/);
    expect(r.warnings.join()).not.toMatch(/a\.md/);
    const missing = runbookFindings(index, (p) => (p === "runbooks/a.md" ? "# x" : null), T).errors.join(
      "\n",
    );
    expect(missing).toMatch(/a\.md: thiếu last_drilled/);
    expect(missing).toMatch(/b\.md: không tồn tại/);
  });
  it("mục lục thiếu việc bắt buộc → lỗi", () => {
    expect(
      runbookFindings("| Deploy | [a](runbooks/a.md) |", () => fm("2026-10-01"), T).errors.join(),
    ).toMatch(/Rollback/);
  });
});

describe("incidentErrors (CMP-AUDIT-010)", () => {
  const sections = "## Phát hiện\n## Phân loại\n## Thông báo\n## Khắc phục\n## Post-mortem\n## Hành động\n";
  const readme = (row) => `## Sự cố\n\n| Ngày | Tệp | Mức |\n|---|---|---|\n${row}\n\n## Diễn tập\n`;
  it("bản ghi đủ mục, có dòng ở sổ → hợp lệ", () => {
    expect(
      incidentErrors(readme("| 2026-01-01 | `2026-01-01-db-down.md` | SEV2 |"), sections, {
        "2026-01-01-db-down.md": sections,
      }),
    ).toEqual([]);
  });
  it("thiếu mục, tên sai, chưa vào sổ, sổ trỏ tệp không có → lỗi", () => {
    const e = incidentErrors(readme("| x | `2026-02-02-ghost.md` | SEV1 |"), sections, {
      "su-co.md": "## Phát hiện\n",
    }).join("\n");
    expect(e).toMatch(/su-co\.md: tên phải là/);
    expect(e).toMatch(/su-co\.md: thiếu mục "Thông báo"/);
    expect(e).toMatch(/su-co\.md: chưa có dòng/);
    expect(e).toMatch(/2026-02-02-ghost\.md" không có thật/);
    expect(incidentErrors(readme(""), "## Phát hiện\n", {}).join()).toMatch(/TEMPLATE\.md thiếu mục/);
  });
});

describe("legalErrors (CMP-INTL-006, IND-SAAS-010)", () => {
  const breach = (rows) =>
    `## Thời hạn theo vùng\n| Vùng | Cơ quan | Thời hạn |\n|---|---|---|\n${rows}\n## Khác\n`;
  const all = ["VN", "EU/EEA", "UK", "Thái Lan", "Singapore"].map((r) => `| ${r} | x | 72 giờ |`).join("\n");
  const dpa =
    "---\nversion: 0.1.0\nupdated: 2026-10-25\n---\n≥ 30 ngày · 72 giờ · 3 ngày lịch · Việt Nam\n| 0.1.0 | 2026-10-25 |";
  const sub = "---\nversion: 0.1.0\nupdated: 2026-10-25\n---\n≥ 30 ngày\n| 0.1.0 | 2026-10-25 |";
  it("đủ vùng, đủ cam kết, có phiên bản → hợp lệ", () => {
    expect(legalErrors(breach(all), dpa, sub)).toEqual([]);
  });
  it("thiếu vùng / thời hạn / phiên bản / cam kết → lỗi", () => {
    const e = legalErrors(breach("| VN | x |  |"), "---\nupdated: x\n---\n", "---\n---\n").join("\n");
    expect(e).toMatch(/thiếu "Singapore"/);
    expect(e).toMatch(/vùng VN thiếu thời hạn/);
    expect(e).toMatch(/DPA\.md: thiếu version/);
    expect(e).toMatch(/3 ngày lịch/);
    expect(e).toMatch(/subprocessors\.md: thiếu cam kết/);
  });
});

describe("renewalFindings (PM-HANDOVER-009)", () => {
  const table = (rows) => `| Mục | Loại | Hết hạn |\n|---|---|---|\n${rows}`;
  it("quá hạn → lỗi; ≤ 30 ngày → cảnh báo; — bỏ qua; ngày sai định dạng → lỗi", () => {
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    const r = renewalFindings(
      table(
        `| A | x | ${iso(T - DAY)} |\n| B | x | ${iso(T + 10 * DAY)} |\n| C | x | — |\n| D | x | sắp |\n| E | x | ${iso(T + 90 * DAY)} |`,
      ),
      {},
      T,
    );
    expect(r.errors.join("\n")).toMatch(/"A": đã hết hạn[\s\S]*"D": Hết hạn phải là/);
    expect(r.warnings).toEqual([expect.stringMatching(/"B": hết hạn .*≤ 30 ngày/)]);
  });
  it("lệch ngày với security.txt hoặc license-policy.json → lỗi", () => {
    const rows = table("| `security.txt` | x | 2027-01-01 |\n| Ngoại lệ `pkg-a` | x | 2027-02-02 |");
    expect(
      renewalFindings(
        rows,
        { securityTxtExpires: "2027-01-01", licenseExpiries: { "pkg-a": "2027-02-02" } },
        T,
      ).errors,
    ).toEqual([]);
    const e = renewalFindings(
      rows,
      { securityTxtExpires: "2027-03-03", licenseExpiries: { "pkg-b": "2027-02-02" } },
      T,
    ).errors.join("\n");
    expect(e).toMatch(/security\.txt phải ghi 2027-03-03/);
    expect(e).toMatch(/pkg-b phải có dòng/);
  });
});
