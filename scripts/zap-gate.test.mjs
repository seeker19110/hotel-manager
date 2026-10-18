// Cổng DAST (scripts/zap-gate.mjs): ngưỡng Medium, allowlist có lý do, báo cáo rỗng/hỏng = thất bại.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_RISK, parseAllowlist, violations } from "./zap-gate.mjs";

const GATE = fileURLToPath(new URL("./zap-gate.mjs", import.meta.url));
const alert = (pluginid, riskcode, name = `rule ${pluginid}`, count = "1") => ({
  pluginid,
  riskcode,
  name,
  count,
});
const report = (...alerts) => ({ site: [{ "@name": "http://127.0.0.1:3100", alerts }] });

describe("violations", () => {
  it("ngưỡng là Medium (2): Informational/Low qua, Medium/High vi phạm", () => {
    expect(MIN_RISK).toBe(2);
    const r = report(
      alert("10109", "0"),
      alert("10049", "1"),
      alert("10038", "2"),
      alert("40012", "3", "XSS"),
    );
    expect(violations(r).map((v) => v.pluginid)).toEqual(["10038", "40012"]);
  });

  it("allowlist theo pluginid loại cảnh báo đã duyệt, không loại cảnh báo khác", () => {
    const r = report(alert("10038", "2"), alert("40012", "3"));
    expect(violations(r, new Set(["10038"])).map((v) => v.pluginid)).toEqual(["40012"]);
  });

  it("site không có cảnh báo → 0 vi phạm (ca rỗng hợp lệ)", () => {
    expect(violations({ site: [{ "@name": "x" }] })).toEqual([]);
    expect(violations(report())).toEqual([]);
  });

  it.each([
    ["null", null],
    ["không có site", {}],
    ["site rỗng", { site: [] }],
  ])("báo cáo %s → ném lỗi (không để 'không quét gì' thành xanh)", (_n, r) => {
    expect(() => violations(r)).toThrow(/không quét được gì/);
  });

  it("riskcode không phải số → ném lỗi", () => {
    expect(() => violations(report(alert("1", "cao")))).toThrow(/riskcode/);
  });
});

describe("parseAllowlist", () => {
  it("nhận mục có pluginid + reason; trả tập pluginid", () => {
    const s = parseAllowlist(JSON.stringify({ allow: [{ pluginid: "10038", reason: "CSP đặt ở proxy" }] }));
    expect([...s]).toEqual(["10038"]);
  });

  it.each([
    [{ allow: [{ pluginid: "10038" }] }],
    [{ allow: [{ pluginid: "10038", reason: "  " }] }],
    [{ allow: [{ reason: "thiếu id" }] }],
    [{ allow: "khong-phai-mang" }],
    [{}],
  ])("từ chối allowlist sai dạng/không lý do %j", (data) => {
    expect(() => parseAllowlist(JSON.stringify(data))).toThrow();
  });
});

describe("CLI", () => {
  const run = (...reports) => {
    const dir = mkdtempSync(join(tmpdir(), "zap-gate-"));
    try {
      const files = reports.map((r, i) => {
        const f = join(dir, `r${i}.json`);
        writeFileSync(f, typeof r === "string" ? r : JSON.stringify(r));
        return f;
      });
      return spawnSync(process.execPath, [GATE, ...files], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("sạch → exit 0", () => {
    const res = run(report(alert("10049", "1")));
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/0 cảnh báo/);
  });

  it("có Medium trong báo cáo thứ hai → exit 1, nêu pluginid", () => {
    const res = run(report(), report(alert("40012", "3", "Cross Site Scripting (Reflected)")));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/\[40012\] Cross Site Scripting/);
  });

  it("báo cáo hỏng → exit 2; không đối số → exit 2", () => {
    expect(run("{khong-phai-json").status).toBe(2);
    expect(spawnSync(process.execPath, [GATE], { encoding: "utf8" }).status).toBe(2);
  });
});
