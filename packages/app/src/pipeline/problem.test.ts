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
    ["23514", "PERIOD_LOCKED", 409],
    ["23514", "EVIDENCE_REQUIRED", 422],
    // SPEC-ledger S-003: sổ lệch là lỗi hệ thống 500 nhưng giữ mã để cảnh báo/tra cứu.
    ["23514", "LEDGER_UNBALANCED", 500],
  ])("pg %s + HINT %s → %s", (code, hint, status) => {
    expect(toProblem(pgError(code, hint))).toMatchObject({ code: hint, status });
  });

  it("lớp lỗi Postgres không có HINT: theo bảng mặc định", () => {
    expect(toProblem(pgError("23P01"))).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    expect(toProblem(pgError("23505"))).toMatchObject({ code: "DUPLICATE", status: 409 });
  });

  it("UNIQUE có mã nghiệp vụ riêng theo tên ràng buộc (uq_units_code → UNIT_CODE_TAKEN); ràng buộc khác vẫn DUPLICATE", () => {
    const unique = (constraint: string) => Object.assign(pgError("23505"), { constraint });
    expect(toProblem(unique("uq_units_code"))).toMatchObject({ code: "UNIT_CODE_TAKEN", status: 409 });
    expect(toProblem(unique("uq_khac"))).toMatchObject({ code: "DUPLICATE", status: 409 });
    // Chỉ lớp 23505 mới đổi mã: cùng tên ràng buộc nhưng lớp khác không bị nhận nhầm.
    expect(toProblem(Object.assign(pgError("23514"), { constraint: "uq_units_code" }))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
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
