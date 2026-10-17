// PLAN đợt 5 T-407 — rào máy chạy trong `pnpm test` (không đổi cấu hình cổng/CI):
//   · không số ma thuật đổi đơn vị ngoài module units (XC-UNITS-009)            · không parseFloat/float ở mã tiền (BASE-DATA-005, IND-FIN-001, XC-UNITS-005)
//   · không toLocale*String trong mã chạy (XC-I18N-003)                         · phản hồi JSON có charset=utf-8 (BASE-DATA-001)
//   · không chuỗi tiếng Việt không dấu (UX-CONTENT-001)                         · mọi file văn bản là UTF-8 không BOM (BASE-DATA-001)
//   · cột numeric/kiểu tiền trong migration khớp ADR-0003 (XC-UNITS-005)         · dữ liệu test: email/SĐT/file lớn (QA-DATA-001/002)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BYTES_PER_MIB,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  SECONDS_PER_DAY,
} from "./units.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".xtemplates",
  "test-results",
  "playwright-report",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (f: string) => relative(ROOT, f).replaceAll("\\", "/");
const isTestFile = (f: string) => /\.(test|spec)\.(ts|tsx|mjs)$/.test(f) || f.includes("/e2e/");

/** Mã chạy của sản phẩm (không test/e2e). */
function productFiles(): string[] {
  const roots = [
    "packages/domain/src",
    "packages/app/src",
    "packages/db/src",
    "packages/testkit/src",
    "apps/worker/src",
    "apps/web/app",
    "apps/web/components",
    "apps/web/lib",
  ];
  const files = roots.flatMap((r) => {
    try {
      return walk(join(ROOT, r));
    } catch {
      return [];
    }
  });
  files.push(join(ROOT, "apps/web/proxy.ts"));
  return files.filter((f) => /\.(ts|tsx)$/.test(f) && !isTestFile(f) && !f.endsWith(".d.ts"));
}

/** Bỏ comment dòng `//` (không đụng `://` trong URL) để không bắt chữ trong lời giải thích. */
const stripLineComments = (src: string) =>
  src
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
const code = (f: string) => stripLineComments(readFileSync(f, "utf8"));

// ───────────────────────── module units ─────────────────────────

describe("units-guards — hằng đơn vị tập trung (XC-UNITS-009)", () => {
  it("hằng đúng giá trị", () => {
    expect(MS_PER_SECOND).toBe(1000);
    expect(MS_PER_MINUTE).toBe(60_000);
    expect(MS_PER_HOUR).toBe(3_600_000);
    expect(MS_PER_DAY).toBe(86_400_000);
    expect(SECONDS_PER_DAY).toBe(86_400);
    expect(BYTES_PER_MIB).toBe(1_048_576);
  });

  // Ngoại lệ có lý do: nhóm 3 chữ số khi đọc số tiền thành chữ tiếng Việt — không phải đổi đơn vị.
  const MAGIC_ALLOWED = new Set([
    "packages/domain/src/units/units.ts",
    "packages/domain/src/payments/vnd-words.ts",
  ]);
  const MAGIC: [string, RegExp][] = [
    ["* 1000", /\*\s*1_?000(?![\dn_])/],
    ["/ 1000", /\/\s*1_?000(?![\dn_])/],
    ["1024", /\b1024\b/],
    ["86_400_000 (ms/ngày)", /\b86_?400_?000\b/],
    ["3_600_000 (ms/giờ)", /\b3_?600_?000\b/],
    ["3600 (giây/giờ)", /\b3_?600\b/],
    ["60_000 (ms/phút)", /\b60_?000\b/],
  ];

  it("không số ma thuật đổi đơn vị trong mã chạy (dùng hằng/hàm ở @hm/domain units)", () => {
    const bad: string[] = [];
    for (const f of productFiles()) {
      if (MAGIC_ALLOWED.has(rel(f))) continue;
      code(f)
        .split("\n")
        .forEach((line, i) => {
          for (const [label, re] of MAGIC) if (re.test(line)) bad.push(`${rel(f)}:${i + 1} ${label}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it("rào bắt đúng mẫu (ca âm tính và dương tính)", () => {
    const hit = (s: string) => MAGIC.some(([, re]) => re.test(s));
    expect(hit("const x = n * 1000;")).toBe(true);
    expect(hit("n / 1000")).toBe(true);
    expect(hit("10 * 1024 * 1024")).toBe(true);
    expect(hit("now + 86_400_000")).toBe(true);
    expect(hit("rounding = 1000n")).toBe(false);
    expect(hit("timeoutMs: 30_000")).toBe(false);
    expect(hit("const v = 10_000;")).toBe(false);
  });
});

// ───────────────────────── tiền: không float ─────────────────────────

describe("units-guards — mã tiền không dùng số thực (BASE-DATA-005, IND-FIN-001, XC-UNITS-005)", () => {
  const MONEY_DIRS = [
    "packages/domain/src/money",
    "packages/domain/src/billing",
    "packages/domain/src/payments",
    "packages/app/src/ledger",
    "packages/app/src/payments",
    "packages/app/src/deposits",
    "packages/app/src/reconciliation",
    "packages/app/src/billing",
    "packages/app/src/shifts",
  ];
  const MONEY_FILES = ["packages/app/src/stay/folio.ts", "packages/app/src/stay/checkout.ts"];
  const moneyFiles = () =>
    [...MONEY_DIRS.flatMap((d) => walk(join(ROOT, d))), ...MONEY_FILES.map((f) => join(ROOT, f))].filter(
      (f) => /\.ts$/.test(f) && !isTestFile(f),
    );

  it("không parseFloat / Number.parseFloat ở bất kỳ mã chạy nào", () => {
    const bad = productFiles().filter((f) => /\bparseFloat\b/.test(code(f)));
    expect(bad.map(rel)).toEqual([]);
  });

  it("mã tiền: không toFixed/Math.round/float/double (làm tròn chỉ qua domain/money)", () => {
    const bad = moneyFiles()
      .filter(
        (f) => rel(f) !== "packages/domain/src/money/money.ts" || /\b(parseFloat|toFixed)\b/.test(code(f)),
      )
      .filter((f) => /\b(parseFloat|toFixed|float|double)\b|\bMath\.round\(/.test(code(f)));
    expect(bad.map(rel)).toEqual([]);
  });

  // `Number(x)` trong mã tiền chỉ đổi chuỗi bigint của pg / chuỗi nguyên đã kiểm regex sang number an toàn. Ratchet: số lần gọi
  // theo file KHÔNG được tăng; giảm thì phải hạ con số ở đây (nền lập đợt 5, T-407). Việc gỡ dần: hàm `moneyFromDb` có kiểm safe-integer.
  const NUMBER_CALLS: Record<string, number> = {
    "packages/app/src/billing/billing.ts": 3,
    "packages/app/src/deposits/deposits.ts": 9,
    "packages/app/src/ledger/bank-inbox.ts": 1,
    "packages/app/src/ledger/ledger.ts": 3,
    "packages/app/src/ledger/period-close.ts": 5,
    "packages/app/src/payments/payments.ts": 18,
    "packages/app/src/reconciliation/auto-apply.ts": 1,
    "packages/app/src/reconciliation/matching.ts": 2,
    "packages/app/src/reconciliation/reconciliation.ts": 5,
    "packages/app/src/shifts/shifts.ts": 5,
    "packages/app/src/stay/checkout.ts": 5,
    "packages/app/src/stay/folio.ts": 13,
    "packages/domain/src/billing/engine.ts": 5,
    "packages/domain/src/money/money.ts": 1,
    "packages/domain/src/payments/statement-csv.ts": 7,
  };

  it("số lần `Number(` trong mã tiền khớp nền ratchet (không tăng; giảm thì hạ nền)", () => {
    const actual: Record<string, number> = {};
    for (const f of moneyFiles()) {
      const n = (code(f).match(/\bNumber\(/g) ?? []).length;
      if (n > 0) actual[rel(f)] = n;
    }
    expect(actual).toEqual(NUMBER_CALLS);
  });

  it("migration: cột numeric chỉ (18,4) và (14,3) như ADR-0003; không real/double/float/money", () => {
    const dir = join(ROOT, "packages/db/src/migrations");
    const allowed = new Set(["18,4", "14,3"]);
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((x) => /^\d{4}_.*\.ts$/.test(x))) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/\bnumeric\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi))
        if (!allowed.has(`${m[1]},${m[2]}`))
          bad.push(`${f}: numeric(${m[1]},${m[2]}) chưa có trong ADR-0003`);
      for (const m of src.matchAll(/^\s*"?\w+"?\s+(real|double precision|float\d?|money)\b/gim))
        bad.push(`${f}: kiểu ${m[1]} bị cấm cho cột tiền/số`);
    }
    expect(bad).toEqual([]);
  });
});

// ───────────────────────── định dạng/i18n ─────────────────────────

describe("units-guards — định dạng qua Intl, UTF-8 (XC-I18N-003, BASE-DATA-001)", () => {
  it("không toLocaleString/toLocaleDateString/toLocaleTimeString trong mã chạy (dùng packages/domain format/intl)", () => {
    const bad = productFiles().filter((f) => /\.toLocale(Date|Time)?String\(/.test(code(f)));
    expect(bad.map(rel)).toEqual([]);
  });

  it("phản hồi JSON/problem+json ở lớp HTTP khai charset=utf-8", () => {
    const bad: string[] = [];
    const scanned = productFiles().filter(
      (f) =>
        rel(f).startsWith("packages/app/src/") ||
        rel(f).startsWith("apps/web/app/api/") ||
        rel(f) === "apps/web/proxy.ts",
    );
    for (const f of scanned) {
      for (const m of code(f).matchAll(
        /"content-type"\s*:\s*"(application\/(?:problem\+)?json)(;[^"]*)?"/gi,
      )) {
        if (!/charset=utf-8/i.test(m[2] ?? "")) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    // Chỉ header PHẢN HỒI: các form/fetch phía trình duyệt nằm ngoài `apps/web/app/api` và packages/app.
    expect(bad).toEqual([]);
  });

  it("mọi file văn bản trong repo giải mã được UTF-8, không BOM, không ký tự thay thế U+FFFD", () => {
    const TEXT = /\.(ts|tsx|mjs|js|json|md|sql|css|yml|yaml|html|txt|sh|py)$/;
    const bad: string[] = [];
    for (const f of walk(ROOT).filter((x) => TEXT.test(x))) {
      const buf = readFileSync(f);
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${rel(f)}: có BOM`);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        bad.push(`${rel(f)}: không phải UTF-8`);
        continue;
      }
      if (text.includes("�") && !isTestFile(f)) bad.push(`${rel(f)}: chứa U+FFFD`);
    }
    expect(bad).toEqual([]);
  });
});

// ───────────────────────── tiếng Việt có dấu ─────────────────────────

describe("units-guards — chữ tiếng Việt có dấu (UX-CONTENT-001)", () => {
  // Cụm hay gặp khi gõ không dấu. Chỉ cụm nhiều từ hoặc từ không trùng tiếng Anh/định danh.
  const UNACCENTED =
    /\b(dang nhap|dang xuat|dang ky|khong tim thay|khong hop le|khong co|thanh cong|that bai|tai khoan|mat khau|so dien thoai|khach hang|khach san|hop dong|vui long|nguoi dung|nguoi thue|phong tro|nha nghi|hoa don|thu tien|xac nhan|da xay ra|co loi)\b/i;
  it("không có chuỗi/chú thích không dấu trong mã chạy", () => {
    const bad: string[] = [];
    for (const f of productFiles()) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (UNACCENTED.test(line)) bad.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it("rào bắt đúng mẫu", () => {
    expect(UNACCENTED.test('"Dang nhap that bai"')).toBe(true);
    expect(UNACCENTED.test('"Đăng nhập thất bại"')).toBe(false);
    expect(UNACCENTED.test("/dang-nhap")).toBe(false);
  });
});

// ───────────────────────── dữ liệu test ─────────────────────────

describe("units-guards — dữ liệu test (QA-DATA-001/002)", () => {
  const doc = readFileSync(join(ROOT, "docs/compliance/test-data.md"), "utf8");
  const allowedPhones = new Set([...doc.matchAll(/^- `(\+?\d{9,15})`/gm)].map((m) => m[1] as string));
  const allowedDomains = new Set([
    "example.com",
    "example.org",
    "example.net",
    "example.test",
    "hotel-manager.invalid",
    "evil.test",
    "localhost",
  ]);
  const SOURCE = /\.(ts|tsx|mjs|json|sql|csv|md|yml|yaml)$/;
  const scanRoots = ["packages", "apps", "scripts", "deploy"];
  const scanFiles = () => scanRoots.flatMap((r) => walk(join(ROOT, r))).filter((f) => SOURCE.test(f));

  it("danh sách SĐT mẫu đọc được từ docs/compliance/test-data.md", () => {
    expect(allowedPhones.has("0912345678")).toBe(true);
    expect(doc).toContain("0100000NNN");
  });

  it("SĐT dạng Việt Nam thật trong mã/fixture phải nằm trong danh sách số mẫu đã khai", () => {
    const PHONE = /(?<![\d.])(?:\+84|0)[35789]\d{8}(?!\d)/g;
    const bad: string[] = [];
    for (const f of scanFiles()) {
      for (const m of readFileSync(f, "utf8").matchAll(PHONE)) {
        if (!allowedPhones.has(m[0])) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("dải SĐT giả 0100000NNN hợp lệ với validate hiện có và KHÔNG khớp dạng số thật", () => {
    const validator = /^\+?[0-9 .()-]{6,20}$/;
    expect(validator.test("0100000123")).toBe(true);
    expect(/(?:\+84|0)[35789]\d{8}/.test("0100000123")).toBe(false);
  });

  it("email trong mã/fixture chỉ dùng domain dành riêng", () => {
    const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
    const bad: string[] = [];
    for (const f of scanFiles()) {
      for (const m of readFileSync(f, "utf8").matchAll(EMAIL)) {
        if (!allowedDomains.has((m[1] as string).toLowerCase())) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("không có file .sql/.csv/.json/.xlsx/.tsv > 1 MB trong repo (nghi dump dữ liệu)", () => {
    const BIG = /\.(sql|csv|json|xlsx|tsv)$/;
    const bad = walk(ROOT)
      .filter((f) => BIG.test(f) && statSync(f).size > 1024 * 1024)
      .map((f) => `${rel(f)}: ${statSync(f).size} byte`);
    expect(bad).toEqual([]);
  });
});
