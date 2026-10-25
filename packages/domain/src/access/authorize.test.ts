import { describe, expect, it } from "vitest";
import { type AuthzActor, authorize, authorizeRequest } from "./authorize.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function actor(role: string, extra: Partial<AuthzActor> = {}): AuthzActor {
  return {
    personId: `person-${role}`,
    membershipId: `m-${role}`,
    role,
    allProperties: false,
    propertyIds: [P1],
    limits: {},
    ...extra,
  };
}

describe("phạm vi cơ sở", () => {
  it("cơ sở ngoài phạm vi → NOT_FOUND (không lộ tồn tại)", () => {
    expect(() => authorize(actor("manager"), "unit.manage", { propertyId: P2 })).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", status: 404 }),
    );
  });
  it("all_properties thấy mọi cơ sở", () => {
    expect(
      authorize(actor("owner", { allProperties: true, propertyIds: [] }), "unit.manage", { propertyId: P2 })
        .grant,
    ).toBe("yes");
  });
});

describe("quyền theo vai trò", () => {
  it.each([
    ["housekeeping", "money.read"],
    ["front_desk", "period.unlock"],
    ["manager", "period.unlock"],
    ["accountant", "reservation.manage"],
    ["tenant", "unit.manage"],
    ["platform_support", "money.read"],
  ])("%s không được %s → FORBIDDEN", (role, action) => {
    expect(() => authorize(actor(role), action as never, { propertyId: P1 })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("owner mở khoá kỳ được", () => {
    expect(authorize(actor("owner"), "period.unlock").grant).toBe("yes");
  });
});

describe("platform_support (F-015, T-2313) — chỉ đọc SUPPORT_READ_ACTIONS", () => {
  it("được: xem trạng thái phòng trong phạm vi; ngoài phạm vi cơ sở ⇒ NOT_FOUND", () => {
    expect(authorize(actor("platform_support"), "calendar.read_status", { propertyId: P1 }).grant).toBe(
      "read",
    );
    expect(() =>
      authorize(actor("platform_support"), "calendar.read_status", { propertyId: P2 }),
    ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });
  it.each([
    "calendar.read_guests",
    "money.read",
    "identity.read",
    "audit.read",
    "data.export",
    "unit.manage",
    "support.grant",
  ])("không được %s ⇒ FORBIDDEN", (action) => {
    expect(() => authorize(actor("platform_support"), action as never, { propertyId: P1 })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("không lập được đề nghị duyệt", () => {
    expect(() =>
      authorizeRequest(actor("platform_support"), "deposit.refund", { propertyId: P1 }),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });
  it("cấp/thu hồi truy cập hỗ trợ: chỉ owner", () => {
    expect(authorize(actor("owner"), "support.grant").grant).toBe("yes");
    for (const r of ["manager", "accountant", "front_desk", "housekeeping", "maintenance", "tenant"])
      expect(() => authorize(actor(r), "support.grant"), r).toThrowError(
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
  });
});

describe("quyền 'own'", () => {
  it("lễ tân xác nhận tiền mặt của chính mình được; của người khác → FORBIDDEN", () => {
    const fd = actor("front_desk");
    expect(authorize(fd, "payment.confirm_cash", { subjectPersonId: fd.personId }).grant).toBe("own");
    expect(() => authorize(fd, "payment.confirm_cash", { subjectPersonId: "nguoi-khac" })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
});

describe("hạn mức hoàn cọc (đã duyệt 2026-10-15; SPEC-access S-026)", () => {
  it.each([
    ["front_desk", 2_000_000, true, "ok"],
    ["front_desk", 2_000_001, true, "APPROVAL_LIMIT_EXCEEDED"],
    ["front_desk", 1_000_000, false, "FORBIDDEN"],
    ["manager", 5_000_000, false, "ok"],
    ["manager", 5_000_001, false, "APPROVAL_LIMIT_EXCEEDED"],
    ["owner", 900_000_000, false, "ok"],
  ])("%s hoàn %d đ (check-out=%s) → %s", (role, amount, atCheckout, expected) => {
    const run = () =>
      authorize(actor(role, { allProperties: true }), "deposit.refund", { amount, atCheckout });
    if (expected === "ok") expect(run().grant).toMatch(/yes|limit/);
    else expect(run).toThrowError(expect.objectContaining({ code: expected }));
  });

  it("kế toán chỉ lập đề nghị (request), không duyệt", () => {
    expect(authorize(actor("accountant"), "deposit.refund", { amount: 10 }).grant).toBe("request");
  });

  it("memberships.limits ghi đè mặc định", () => {
    const m = actor("manager", { limits: { refund: 1_000_000 } });
    expect(() => authorize(m, "deposit.refund", { amount: 1_500_000 })).toThrowError(
      expect.objectContaining({ code: "APPROVAL_LIMIT_EXCEEDED" }),
    );
  });

  it("tự duyệt yêu cầu mình lập → SELF_APPROVAL_FORBIDDEN (kể cả owner)", () => {
    const o = actor("owner");
    expect(() => authorize(o, "deposit.refund", { amount: 1, requestedByPersonId: o.personId })).toThrowError(
      expect.objectContaining({ code: "SELF_APPROVAL_FORBIDDEN" }),
    );
    const m = actor("manager");
    expect(() => authorize(m, "deposit.refund", { amount: 1, requestedByPersonId: m.personId })).toThrowError(
      expect.objectContaining({ code: "SELF_APPROVAL_FORBIDDEN" }),
    );
  });

  it("số tiền không phải số nguyên đồng → FORBIDDEN (không đoán)", () => {
    expect(() => authorize(actor("manager"), "deposit.refund", { amount: 10.5 })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("đổi giá: hạn mức chưa chốt = 0 → mọi thay đổi của lễ tân cần duyệt", () => {
    expect(() => authorize(actor("front_desk"), "reservation.override_price", { amount: 1 })).toThrowError(
      expect.objectContaining({ code: "APPROVAL_LIMIT_EXCEEDED" }),
    );
  });
});

describe("câu lỗi ra API giữ nguyên chữ sau khi chuyển sang catalog domain (D-107)", () => {
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return { code: (e as { code: string }).code, message: (e as Error).message };
    }
    return null;
  };
  it("từ chối: mỗi nhánh trả đúng mã + câu cũ; được phép: không ném", () => {
    expect(msg(() => authorize(actor("tenant"), "unit.manage"))).toEqual({
      code: "FORBIDDEN",
      message: "Bạn không có quyền thực hiện thao tác này",
    });
    expect(msg(() => authorize(actor("manager"), "unit.manage", { propertyId: P2 }))).toEqual({
      code: "NOT_FOUND",
      message: "Không tìm thấy",
    });
    expect(msg(() => authorize(actor("chu_nha"), "unit.manage"))).toEqual({
      code: "FORBIDDEN",
      message: "Vai trò không có quyền này",
    });
    expect(msg(() => authorize(actor("housekeeping"), "unit.manage"))).toEqual({
      code: "FORBIDDEN",
      message: "Bạn không có quyền thực hiện thao tác này",
    });
    expect(
      msg(() =>
        authorize(actor("owner"), "deposit.refund", { requestedByPersonId: "person-owner", amount: 1 }),
      ),
    ).toEqual({ code: "SELF_APPROVAL_FORBIDDEN", message: "Bạn không thể tự duyệt yêu cầu mình lập" });
    expect(
      msg(() =>
        authorize(actor("manager"), "deposit.refund", { requestedByPersonId: "person-manager", amount: 1 }),
      ),
    ).toEqual({ code: "SELF_APPROVAL_FORBIDDEN", message: "Bạn không thể tự duyệt yêu cầu mình lập" });
    expect(msg(() => authorize(actor("tenant"), "money.read", { subjectPersonId: "x" }))).toEqual({
      code: "FORBIDDEN",
      message: "Chỉ được thao tác trên bản ghi của mình",
    });
    expect(msg(() => authorize(actor("front_desk"), "deposit.refund", { amount: 1 }))).toEqual({
      code: "FORBIDDEN",
      message: "Lễ tân chỉ hoàn trong lúc trả phòng",
    });
    expect(msg(() => authorize(actor("manager"), "deposit.refund", {}))).toEqual({
      code: "FORBIDDEN",
      message: "Thiếu số tiền hợp lệ để kiểm hạn mức",
    });
    expect(msg(() => authorize(actor("manager"), "deposit.refund", { amount: 5_000_001 }))).toEqual({
      code: "APPROVAL_LIMIT_EXCEEDED",
      message: "Vượt hạn mức — cần người có thẩm quyền duyệt",
    });
    expect(msg(() => authorizeRequest(actor("housekeeping"), "deposit.refund"))).toEqual({
      code: "FORBIDDEN",
      message: "Bạn không có quyền lập yêu cầu này",
    });
    expect(msg(() => authorizeRequest(actor("manager"), "deposit.refund", { propertyId: P2 }))).toEqual({
      code: "NOT_FOUND",
      message: "Không tìm thấy",
    });
    // Được phép: cùng hành động, đúng phạm vi/hạn mức/ngữ cảnh.
    expect(authorize(actor("manager"), "deposit.refund", { amount: 5_000_000 })).toEqual({
      grant: "limit",
      limit: 5_000_000,
    });
    expect(authorize(actor("tenant"), "money.read", { subjectPersonId: "person-tenant" }).grant).toBe("own");
    expect(msg(() => authorizeRequest(actor("accountant"), "deposit.refund"))).toBeNull();
  });
});
