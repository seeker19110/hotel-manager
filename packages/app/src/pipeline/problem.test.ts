import { describe, expect, it } from "vitest";
import { CommandError, toProblem } from "./problem.ts";

const pgError = (code: string, hint?: string) =>
  Object.assign(new Error("pg"), { code, ...(hint ? { hint } : {}) });

describe("toProblem (API-CONTRACT §2)", () => {
  it.each([
    ["55000", "DOCUMENT_IMMUTABLE", 409],
    ["23514", "INVALID_TRANSITION", 409],
    ["23514", "LAST_OWNER", 409],
    ["23514", "VALIDATION_FAILED", 422],
  ])("pg %s + HINT %s → %s", (code, hint, status) => {
    expect(toProblem(pgError(code, hint))).toMatchObject({ code: hint, status });
  });

  it("lớp lỗi Postgres không có HINT: theo bảng mặc định", () => {
    expect(toProblem(pgError("23P01"))).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    expect(toProblem(pgError("23505"))).toMatchObject({ code: "DUPLICATE", status: 409 });
  });

  it("thiếu ngữ cảnh tổ chức và lỗi lạ → INTERNAL 500, không lộ chi tiết", () => {
    expect(toProblem(pgError("P0001", "TENANT_CONTEXT_MISSING"))).toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
    const p = toProblem(new Error("stack bí mật"), "corr-1");
    expect(p).toMatchObject({ code: "INTERNAL", status: 500, correlation_id: "corr-1" });
    expect(JSON.stringify(p)).not.toContain("bí mật");
  });

  it("HINT lạ không phải mã đã biết → không dùng làm mã", () => {
    expect(toProblem(pgError("55000", "X"))).toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("CommandError giữ mã và status", () => {
    expect(toProblem(new CommandError("FILE_TOO_LARGE", 413, "lớn"))).toMatchObject({
      code: "FILE_TOO_LARGE",
      status: 413,
    });
  });
});
