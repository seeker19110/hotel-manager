// Chuỗi hiển thị: chuỗi RỖNG/chỉ khoảng trắng coi như thiếu (khác với `??`, vốn chỉ bỏ qua null/undefined) — dùng cho
// thông điệp lỗi/mã tra cứu do server trả, nơi "" vô nghĩa với người đọc (BASE-DATA-003: chủ ý, không phải `||` tiện tay).
export function firstNonEmpty(...values: ReadonlyArray<string | null | undefined>): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.trim() !== "");
}
