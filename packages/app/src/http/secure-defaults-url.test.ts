// FE-SEC-002 — URL từ dữ liệu ngoài chỉ được render nếu qua `safeUrl()` (allowlist scheme http(s)/mailto, đường dẫn nội bộ).
// Gồm: test hàm + rào quét `href={…}`/`src={…}`/điều hướng trong apps/web (biến không qua safeUrl → đỏ).
import { describe, expect, it } from "vitest";
import { braceBody, type SourceFile, sourceFiles } from "../testing/source-scan.ts";
import { safeUrl } from "./safe-url.ts";

describe("safeUrl", () => {
  it.each([
    ["https://example.vn/a?b=1#c", "https://example.vn/a?b=1#c"],
    ["http://localhost:3000/x", "http://localhost:3000/x"],
    ["mailto:chu@example.vn", "mailto:chu@example.vn"],
    ["  https://example.vn  ", "https://example.vn/"],
    ["HTTPS://EXAMPLE.VN/Phong", "https://example.vn/Phong"],
    ["/hop-dong/123?x=1#y", "/hop-dong/123?x=1#y"],
    ["/", "/"],
  ])("cho qua %j → %j", (input, out) => {
    expect(safeUrl(input)).toBe(out);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "vbscript:msgbox(1)",
    "blob:https://example.vn/uuid",
    "file:///etc/passwd",
    "ftp://example.vn/x",
    "//evil.example/x",
    "/\\evil.example/x",
    "\\\\evil.example\\x",
    "tel:+84900000000",
    "phong/101",
    "",
    "   ",
    "https://",
    `https://example.vn/${"a".repeat(5000)}`,
  ])("chặn %j", (input) => {
    expect(safeUrl(input)).toBeNull();
  });

  it.each([null, undefined, 0, 12, {}, [], true, Symbol.for("x")])(
    "giá trị không phải chuỗi %s → null",
    (v) => {
      expect(safeUrl(v)).toBeNull();
    },
  );

  it("Unicode/tiếng Việt trong đường dẫn được mã hoá, không đổi nghĩa", () => {
    expect(safeUrl("/phong/Phòng 101")).toBe("/phong/Ph%C3%B2ng%20101");
    expect(safeUrl("https://example.vn/phòng")).toBe("https://example.vn/ph%C3%B2ng");
  });
});

// ----- Rào: mọi URL động trong apps/web phải qua safeUrl hoặc là đường dẫn nội bộ dựng từ id/hằng -----

interface Hit {
  file: string;
  line: number;
  expr: string;
}

const lineOf = (text: string, i: number) => text.slice(0, i).split("\n").length;

/** Đối số đầu của lời gọi, bắt đầu ngay sau `(`: đến dấu `,` hoặc `)` ở độ sâu 0 (đếm ngoặc `()[]{}`). */
function firstArg(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c as string)) depth++;
    else if (")]}".includes(c as string)) {
      if (depth === 0) return text.slice(start, i).trim();
      depth--;
    } else if (c === "," && depth === 0) return text.slice(start, i).trim();
  }
  return text.slice(start).trim();
}

/** Biểu thức của `href={…}`/`src={…}` và đối số đầu của điều hướng (`location.assign(…)`, `router.push(…)`, `redirect(…)`…). */
function urlExpressions(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(/\b(?:href|src|formAction|poster)=\{/g)) {
      const body = braceBody(f.text, m.index + m[0].length - 1);
      if (body !== null) hits.push({ file: f.path, line: lineOf(f.text, m.index), expr: body.trim() });
    }
    for (const m of f.text.matchAll(
      /\b(?:location\.(?:assign|replace)|window\.open|router\.(?:push|replace)|redirect|permanentRedirect)\(/g,
    ))
      hits.push({
        file: f.path,
        line: lineOf(f.text, m.index),
        expr: firstArg(f.text, m.index + m[0].length),
      });
    for (const m of f.text.matchAll(/\blocation\.href\s*=\s*([^;\n]+)/g))
      hits.push({ file: f.path, line: lineOf(f.text, m.index), expr: (m[1] ?? "").trim() });
  }
  return hits;
}

/** Đường dẫn nội bộ viết thẳng (chuỗi/template bắt đầu bằng `/` hoặc `#`) hoặc đã qua safeUrl. */
const SAFE = /^(?:`[/#][^`]*`|"[/#][^"]*"|'[/#][^']*'|\(?safeUrl\([^)]*\)\)?(?: as string| \?\? .+)?$)/;

/**
 * Ngoại lệ có lý do: biểu thức KHÔNG dựng từ dữ liệu ngoài — hằng trong cùng file hoặc id/ngày do server tạo ghép vào đường dẫn
 * nội bộ. Mỗi mục phải còn khớp (không mồ côi).
 */
const ALLOWED: readonly { file: string; expr: RegExp; why: string }[] = [
  {
    file: "apps/web/components/rental/app-nav.tsx",
    expr: /^i\.href$/,
    why: "đường dẫn hằng của bảng ITEMS trong file",
  },
  {
    file: "apps/web/components/portal/portal-nav.tsx",
    expr: /^i\.href$/,
    why: "đường dẫn hằng của bảng ITEMS trong file",
  },
  {
    file: "apps/web/app/lich-phong/page.tsx",
    expr: /^link\(/,
    why: "`link()` ghép id cơ sở (uuid từ CSDL) và ngày ISO vào đường dẫn `/lich-phong?…`",
  },
  {
    file: "apps/web/app/hom-nay/[card]/page.tsx",
    expr: /^(?:hrefOf\(|propertyId \? `\/)/,
    why: "`hrefOf()` trả đường dẫn nội bộ theo bảng thẻ; còn lại ghép uuid cơ sở vào `/?property_id=`",
  },
  {
    file: "apps/web/app/thong-bao/page.tsx",
    expr: /^link$/,
    why: "`linkOf()` chỉ trả đường dẫn nội bộ thuộc danh sách KNOWN (đã kiểm `/` đơn + tiền tố được phép)",
  },
  {
    file: "apps/web/lib/portal-page.tsx",
    expr: /^PORTAL_LOGIN$/,
    why: "hằng đường dẫn đăng nhập người thuê",
  },
];

describe("FE-SEC-002 — rào: không render/điều hướng URL động ngoài safeUrl", () => {
  const files = sourceFiles(["apps/web/app", "apps/web/components", "apps/web/lib"], /\.(ts|tsx)$/);

  it("mọi href/src/điều hướng là đường dẫn nội bộ viết thẳng, qua safeUrl, hoặc ngoại lệ có lý do", () => {
    const hits = urlExpressions(files);
    expect(hits.length).toBeGreaterThan(30); // bộ quét thật sự thấy các chỗ dùng
    const used = new Set<number>();
    const bad = hits.filter((h) => {
      if (SAFE.test(h.expr)) return false;
      const i = ALLOWED.findIndex((a) => a.file === h.file && a.expr.test(h.expr));
      if (i < 0) return true;
      used.add(i);
      return false;
    });
    expect(bad.map((h) => `${h.file}:${h.line} ${h.expr}`)).toEqual([]);
    expect(ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file} ${a.expr}`)).toEqual([]);
  });

  it("rào bắt đúng các dạng nguy hiểm (hồi quy của chính rào)", () => {
    const bad = (text: string) =>
      urlExpressions([{ path: "x.tsx", text }])
        .filter((h) => !SAFE.test(h.expr))
        .map((h) => h.expr);
    expect(bad("<a href={r.photoUrl}>x</a>")).toEqual(["r.photoUrl"]);
    expect(bad("<img src={user.avatar} />")).toEqual(["user.avatar"]);
    expect(bad("window.location.assign(next)")).toEqual(["next"]);
    expect(bad("router.push(returnTo)")).toEqual(["returnTo"]);
    expect(bad("location.href = params.get('u')")).toEqual(["params.get('u')"]);
    expect(bad("<a href={`${base}/x`}>")).toEqual(["`${base}/x`"]);
    expect(bad("<a href={`/hop-dong/${id}`}>")).toEqual([]);
    expect(bad("<a href={safeUrl(u) as string}>")).toEqual([]);
    expect(bad('window.location.assign("/dang-nhap")')).toEqual([]);
    expect(bad('redirect("/phong")')).toEqual([]);
  });

  it("photoUrl và URL tải file (nguồn từ máy chủ ký) đều qua safeUrl", () => {
    const read = (p: string) => files.find((f) => f.path === p)?.text ?? "";
    expect(read("apps/web/app/portal/dien-nuoc/page.tsx")).toContain("safeUrl(r.photoUrl)");
    expect(read("apps/web/components/hotel/notice-actions.tsx")).toContain("safeUrl(url)");
  });
});
