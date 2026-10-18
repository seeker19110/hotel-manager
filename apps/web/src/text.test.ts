import { describe, expect, it } from "vitest";
import { firstNonEmpty } from "../lib/text.ts";

describe("firstNonEmpty — rỗng/thiếu/0 (BASE-DATA-003)", () => {
  it("lấy giá trị có nội dung đầu tiên", () => {
    expect(firstNonEmpty("a", "b")).toBe("a");
  });
  it("bỏ qua null, undefined, chuỗi rỗng và chỉ khoảng trắng", () => {
    expect(firstNonEmpty(undefined, null, "", "   ", "c")).toBe("c");
  });
  it("không có giá trị nào dùng được → undefined (gọi tự chọn mặc định)", () => {
    expect(firstNonEmpty()).toBeUndefined();
    expect(firstNonEmpty("", null, undefined)).toBeUndefined();
  });
  it("giữ nguyên khoảng trắng bên trong và Unicode tiếng Việt", () => {
    expect(firstNonEmpty("", " Không báo giá được ")).toBe(" Không báo giá được ");
  });
});
