// BASE-CFG-008 — quét bundle client (`.next/static`) theo MẪU GIÁ TRỊ bí mật, bổ sung `client-bundle.test.ts` (quét theo TÊN biến).
// Có bundle sau `pnpm build` (cổng `gate`/E2E build trước test); chưa build thì phần quét thật được bỏ qua, phần mẫu vẫn chạy.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, sourceFiles } from "../testing/source-scan.ts";

const STATIC_DIR = `${REPO_ROOT}apps/web/.next/static`;

/** Mẫu giá trị bí mật điển hình: khoá Stripe live, service_role, khoá AWS, khối khoá riêng PEM, URL kết nối có mật khẩu, JWT dài. */
const SECRET_VALUE_PATTERNS: readonly [string, RegExp][] = [
  ["sk_live", /sk_live_[0-9A-Za-z]{8,}/],
  ["service_role", /service_role/],
  ["AKIA", /\bAKIA[0-9A-Z]{16}\b/],
  ["PEM", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["url-mat-khau", /\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|smtps?):\/\/[^\s:/@"'`]+:[^\s@/"'`]+@/],
  ["BETTER_AUTH_SECRET", /BETTER_AUTH_SECRET\s*[:=]\s*["'][^"']{8,}/],
];

describe("mẫu giá trị bí mật (hồi quy của chính bộ quét)", () => {
  it.each([
    // Chuỗi giả ghép lúc chạy để gitleaks không coi là khoá thật (WF-GIT-010); bộ quét vẫn thấy chuỗi đầy đủ.
    ["sk_live", `const k='${["sk", "live", "abcdefgh12345678"].join("_")}'`],
    ["service_role", 'role:"service_role"'],
    ["AKIA", `id=${"AKIA"}${"ABCDEFGHIJKLMNOP"};`],
    ["PEM", "-----BEGIN RSA PRIVATE KEY-----"],
    ["PEM", "-----BEGIN PRIVATE KEY-----"],
    ["url-mat-khau", 'u="postgres://app:mk123@db:5432/hm"'],
  ])("bắt %s", (name, text) => {
    expect(SECRET_VALUE_PATTERNS.some(([n, re]) => n === name && re.test(text))).toBe(true);
  });

  it("không bắt nhầm đoạn lành tính (URL không mật khẩu, tên biến trống)", () => {
    for (const text of ["https://example.vn/x", "postgres://localhost/db", "AKIA-TEST", "pk_live_x"])
      expect(
        SECRET_VALUE_PATTERNS.some(([, re]) => re.test(text)),
        text,
      ).toBe(false);
  });
});

describe.skipIf(!existsSync(STATIC_DIR))(
  "bundle client — không chứa mẫu giá trị bí mật (cần `pnpm build` trước)",
  () => {
    it("không file tĩnh nào khớp mẫu bí mật", () => {
      const files = sourceFiles(["apps/web/.next/static"], /\.(js|css|html|json|map)$/, {
        includeTests: true,
      });
      expect(files.length).toBeGreaterThan(0);
      const hits = files.flatMap((f) =>
        SECRET_VALUE_PATTERNS.filter(([, re]) => re.test(f.text)).map(([n]) => `${f.path}: ${n}`),
      );
      expect(hits).toEqual([]);
    });

    it("không có biến PUBLIC_* nhúng trong bundle (build không đặt biến công khai nào)", () => {
      const text = sourceFiles(["apps/web/.next/static"], /\.js$/, { includeTests: true })
        .map((f) => f.text)
        .join("\n");
      expect(text).not.toMatch(/process\.env\.(?:NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_)[A-Z_]+/);
      expect(readFileSync(`${STATIC_DIR}/../../next.config.ts`, "utf8")).not.toMatch(/\benv\s*:/);
    });
  },
);
