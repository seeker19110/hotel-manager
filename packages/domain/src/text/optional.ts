// Chuỗi tuỳ chọn: phân biệt THIẾU (null/undefined) · RỖNG ("", chỉ khoảng trắng) · giá trị thật (kể cả "0") — BASE-DATA-003.
// Ở đây rỗng được CHỦ Ý chuẩn hoá về `null` (ô nhập bỏ trống = không có giá trị); "0" và mọi chuỗi có nội dung giữ nguyên.
// Không dùng `||` tại chỗ gọi: `||` còn nuốt cả `0`/`false` nếu kiểu đổi sau này.

/** `null`/`undefined`/rỗng/chỉ khoảng trắng → `null`; còn lại trả bản đã `trim()`. */
export function blankToNull(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

/** Giá trị có nội dung đầu tiên (đã `trim()`); không có → `null`. */
export function firstNonBlank(...values: ReadonlyArray<string | null | undefined>): string | null {
  for (const v of values) {
    const t = blankToNull(v);
    if (t !== null) return t;
  }
  return null;
}

/**
 * Cập nhật từng phần: `undefined` = không gửi → giữ giá trị hiện có; `null`/0/""/false = giá trị được gửi, dùng nguyên.
 * (Khác `??`, vốn gộp `null` với `undefined` nên không cho phép "xoá" một trường.)
 */
export function keepIfUndefined<T>(given: T | undefined, current: T): T {
  return given === undefined ? current : given;
}
