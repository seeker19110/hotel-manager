// Rào "thiếu ≠ rỗng ≠ 0" (BASE-DATA-003; PLAN đợt 9 T-805): mã sản phẩm không dùng `||`/`||=` để lấy mặc định cho giá trị
// mà 0/""/[]/false có thể hợp lệ — `||` nuốt cả bốn, `??` chỉ bỏ qua null/undefined. Cấm: `|| 0`, `|| ""`, `|| ''`, `|| []`,
// `|| {}`, `|| false`, `|| null`, `|| undefined`, `||=`. Chuẩn hoá chuỗi rỗng → null: dùng `blankToNull`/`firstNonBlank`
// (@hm/domain, đã có test 0/""/null) hoặc `firstNonEmpty` ở web. Ngoại lệ phải nằm ở ALLOW kèm lý do; ALLOW chỉ được co lại
// (mục không còn khớp dòng nào → test đỏ đòi xoá). Rào bổ trợ cho lint `nursery/useNullishCoalescing` (biome.json), thứ
// chỉ bắt khi kiểu bên trái "có thể nullish".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set(["node_modules", ".next", "dist", "coverage", "test-results", ".git"]);
const PRODUCT = /^(apps\/(web|worker)\/(app|components|lib|src)|packages\/[^/]+\/src)\//;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs)$/;
const FORBIDDEN = /\|\|=|\|\|\s*(?:0|""|''|\[\]|\{\}|false|null|undefined)(?![\w$.])/;

/** Ngoại lệ có chủ ý: `file` + đoạn `text` có trong dòng + lý do. */
const ALLOW = [
  {
    file: "packages/app/src/ledger/period-close.ts",
    text: "0 - (b.DEPOSIT_LIAB ?? 0) || 0",
    reason:
      "đảo dấu số dư tiền: chặn NaN/-0 lọt vào báo cáo (tiền số nguyên); 0 ở đây là giá trị hợp lệ và `||` chỉ đổi NaN→0",
  },
  {
    file: "packages/app/src/ledger/period-close.ts",
    text: "0 - (b.CUSTOMER_CREDIT ?? 0) || 0",
    reason: "như trên (đảo dấu công nợ khách)",
  },
  {
    file: "packages/app/src/logging/security-events.ts",
    text: "Number.parseInt(x, 16) || 0",
    reason: "nhóm IPv6 không hợp lệ → NaN → 0 khi ẩn danh hoá IP; 0 là kết quả hợp lệ của parseInt('0')",
  },
  {
    file: "packages/app/src/access/org-context.ts",
    text: "properties.find((p) => p.id === id)) || null",
    reason:
      '`id && find(...)` có thể ra ""/null/undefined — gom hết về null là chủ ý (cơ sở đã lưu không còn trong phạm vi)',
  },
  {
    file: "apps/web/components/ui/field.tsx",
    text: '.join(" ") || undefined',
    reason:
      'aria-describedby: chuỗi rỗng (không có hint/lỗi) phải bỏ hẳn thuộc tính, không để aria-describedby=""',
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mjs)$/.test(name)) yield full;
  }
}

/** Mã (không phải dòng chú thích) khớp mẫu cấm → [{line, text}]. */
function violations(source) {
  const out = [];
  source.split("\n").forEach((raw, i) => {
    const code = raw.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    if (FORBIDDEN.test(raw.replace(/\/\/.*$/, ""))) out.push({ line: i + 1, text: raw.trim() });
  });
  return out;
}

const files = [...walk(ROOT)]
  .map((f) => relative(ROOT, f).split("\\").join("/"))
  .filter((f) => PRODUCT.test(f) && !TEST_FILE.test(f));
const found = files.flatMap((f) =>
  violations(readFileSync(join(ROOT, f), "utf8")).map((v) => ({ file: f, ...v })),
);
const allowed = (v) => ALLOW.some((a) => a.file === v.file && v.text.includes(a.text));

describe("thiếu ≠ rỗng ≠ 0: không dùng `||` lấy mặc định (BASE-DATA-003)", () => {
  it("bộ dò bắt đúng các mẫu cấm và bỏ qua `??`, `||` giữa hai điều kiện, chú thích", () => {
    expect(violations("const a = x || 0;").length).toBe(1);
    expect(violations('const a = x || "";').length).toBe(1);
    expect(violations("const a = x || [];").length).toBe(1);
    expect(violations("const a = x || null;").length).toBe(1);
    expect(violations("a ||= 1;").length).toBe(1);
    expect(violations("const a = x ?? 0;").length).toBe(0);
    expect(violations("if (a || b) {}").length).toBe(0);
    expect(violations("if (a || 0.5 < b) {}").length).toBe(0);
    expect(violations("// x || 0 (ví dụ trong chú thích)").length).toBe(0);
    expect(violations("const a = f(); // dự phòng || null").length).toBe(0);
  });

  it("quét được mã sản phẩm (không rỗng)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("mã sản phẩm không còn `||`/`||=` lấy mặc định ngoài ALLOW", () => {
    const bad = found.filter((v) => !allowed(v)).map((v) => `${v.file}:${v.line}: ${v.text}`);
    expect(bad).toEqual([]);
  });

  it("ALLOW chỉ co lại: mục không khớp dòng nào phải xoá; mỗi mục có lý do thật", () => {
    for (const a of ALLOW) {
      expect(a.reason.length, `${a.file}: thiếu lý do`).toBeGreaterThanOrEqual(20);
      expect(
        found.some((v) => v.file === a.file && v.text.includes(a.text)),
        `ALLOW thừa: ${a.file} «${a.text}»`,
      ).toBe(true);
    }
  });
});
