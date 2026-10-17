// URL từ dữ liệu ngoài → chỉ cho qua http(s):/mailto: và đường dẫn nội bộ (FE-SEC-002). Không render `javascript:`/`data:`/`blob:`/`file:`
// vào `href`/`src`. Không phụ thuộc Node/DOM nên dùng được ở server component lẫn client component.

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
// Gốc giả chỉ để phân giải đường dẫn tương đối; origin của kết quả phải trùng gốc này (không thoát ra máy khác).
const PROBE_ORIGIN = "https://hm-probe.invalid";

/**
 * Trả URL đã chuẩn hoá (canonical) nếu an toàn, `null` nếu không. An toàn = scheme `http:`/`https:`/`mailto:` (tuyệt đối)
 * hoặc đường dẫn nội bộ bắt đầu bằng một `/` (không `//host`, không `/\host`). `javascript:` bị chặn kể cả khi viết hoa/chèn
 * tab/xuống dòng/ký tự điều khiển (trình duyệt bỏ chúng khi phân tích scheme — `URL` của WHATWG làm y như vậy).
 */
export function safeUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw === "" || raw.length > 4096) return null;
  if (raw.startsWith("/")) {
    // `//evil.example` và `/\evil.example` là URL cùng-scheme tới máy khác với trình duyệt.
    if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
    try {
      const u = new URL(raw, PROBE_ORIGIN);
      if (u.origin !== PROBE_ORIGIN) return null;
      const out = `${u.pathname}${u.search}${u.hash}`;
      // Chuẩn hoá có thể TẠO ra `//host` từ đường dẫn có vẻ lành (`/.//evil.com`, `/a/..//evil.com`, `/%2e//evil.com` →
      // `//evil.com`): kiểm lại KẾT QUẢ, không chỉ đầu vào.
      return out.startsWith("//") || out.startsWith("/\\") ? null : out;
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(raw);
    return ALLOWED_SCHEMES.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
