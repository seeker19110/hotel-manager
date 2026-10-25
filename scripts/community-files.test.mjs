// File sức khoẻ cộng đồng và kênh báo lỗ hổng (XC-OSS-001, BASE-SEC-009, XC-OSS-004; D-112).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const PVR = "https://github.com/seeker19110/hotel-manager/security/advisories/new";
const DAY = 86_400_000;

describe("file sức khoẻ cộng đồng (đường dẫn GitHub nhận)", () => {
  it("đủ LICENSE, README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, SUPPORT, mẫu issue/PR", () => {
    for (const f of [
      "LICENSE",
      "README.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "SUPPORT.md",
      ".github/pull_request_template.md",
      ".github/ISSUE_TEMPLATE/bug.md",
    ])
      expect(existsSync(join(ROOT, f)), f).toBe(true);
  });
  it("CODE_OF_CONDUCT nêu phiên bản Contributor Covenant và cách báo vi phạm", () => {
    const coc = read("CODE_OF_CONDUCT.md");
    expect(coc).toMatch(/Contributor Covenant, phiên bản 2\.1/);
    expect(coc).toMatch(/Báo hành vi vi phạm/);
  });
  it("mẫu PR có checklist dark pattern (UX-CONTENT-005, D-121)", () => {
    const t = read(".github/pull_request_template.md");
    const sec = t.split("## UX — không dark pattern (UX-CONTENT-005)")[1]?.split("\n## ")[0] ?? "";
    for (const frag of [
      "mặc định bật",
      "không nhiều bước hơn",
      "confirmshaming",
      "đếm ngược",
      "Nút từ chối ngang hàng",
    ])
      expect(sec, frag).toContain(frag);
  });
  it("tệp được nhắc tới trong CONTRIBUTING/SUPPORT tồn tại", () => {
    for (const f of ["CONTRIBUTING.md", "SUPPORT.md"])
      for (const [, p] of read(f).matchAll(/`((?:docs|scripts|\.github|\.xtemplates)\/[^`*<> ]+?)`/g))
        expect(existsSync(join(ROOT, p.replace(/\/$/, ""))), `${f}: ${p}`).toBe(true);
  });
});

describe("SECURITY.md (BASE-SEC-009, XC-OSS-004)", () => {
  const sec = read("SECURITY.md");
  it("phiên bản được hỗ trợ, kênh riêng tư PVR, cấm báo công khai", () => {
    expect(sec).toMatch(/## Phiên bản được hỗ trợ/);
    expect(sec).toContain(PVR);
    expect(sec).toMatch(/\*\*Không\*\* báo lỗ hổng qua issue/);
  });
  it("cam kết phản hồi ban đầu ≤ 14 ngày và chính sách công bố phối hợp", () => {
    const ack = Number(/Xác nhận đã nhận báo cáo \| ≤ (\d+) ngày/.exec(sec)?.[1]);
    expect(ack).toBeGreaterThan(0);
    expect(ack).toBeLessThanOrEqual(14);
    expect(sec).toMatch(/## Công bố phối hợp/);
  });
});

describe("security.txt (RFC 9116)", () => {
  const txt = read("apps/web/public/.well-known/security.txt");
  it("Contact trỏ kênh riêng tư như SECURITY.md; Policy trỏ SECURITY", () => {
    expect(txt).toMatch(new RegExp(`^Contact: ${PVR.replace(/[.]/g, "\\.")}$`, "m"));
    expect(txt).toMatch(/^Policy: https:\/\/github\.com\/seeker19110\/hotel-manager\/security\/policy$/m);
  });
  it("Expires là ISO 8601, còn hạn và không quá 1 năm (RFC 9116 §2.5.5) — đỏ khi cần gia hạn", () => {
    const exp = Date.parse(/^Expires: (\S+)$/m.exec(txt)?.[1] ?? "");
    expect(Number.isNaN(exp)).toBe(false);
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp - Date.now()).toBeLessThanOrEqual(366 * DAY);
  });
});
