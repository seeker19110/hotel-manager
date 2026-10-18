import { describe, expect, it } from "vitest";
import { requestedOrgId } from "./org-context.ts";

describe("requestedOrgId — header ưu tiên cookie; thiếu/rỗng khác nhau chỗ nào (BASE-DATA-003)", () => {
  it("header có giá trị thắng cookie", () => {
    expect(requestedOrgId("h", "c")).toBe("h");
  });
  it("header rỗng/khoảng trắng/thiếu → dùng cookie", () => {
    expect(requestedOrgId("", "c")).toBe("c");
    expect(requestedOrgId("   ", "c")).toBe("c");
    expect(requestedOrgId(null, "c")).toBe("c");
    expect(requestedOrgId(undefined, "c")).toBe("c");
  });
  it("cả hai không dùng được → null (không phải chuỗi rỗng)", () => {
    expect(requestedOrgId("", " ")).toBeNull();
    expect(requestedOrgId(null, undefined)).toBeNull();
  });
  it("cắt khoảng trắng hai đầu giá trị được chọn", () => {
    expect(requestedOrgId(" a ", "c")).toBe("a");
  });
});
