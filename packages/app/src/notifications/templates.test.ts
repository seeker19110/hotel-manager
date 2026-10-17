// PLAN đợt 3 T-213 — mẫu thông báo thuần (SPEC-notifications S-006, S-012; Q-03).
import { describe, expect, it } from "vitest";
import { EmailSendError, FakeEmailSender } from "./email.ts";
import {
  deliveryStatusLabel,
  maskEmail,
  NOTIFICATION_TYPES,
  type NotificationType,
  render,
  TemplateError,
  type Vars,
} from "./templates.ts";

const ID = "6f1c2b3a-1111-4222-8333-444455556666";
/** Dữ liệu giả có đủ thứ nhạy cảm — mẫu chỉ được đọc biến khai báo (S-012). */
const SENSITIVE = {
  cccd: "012345678901",
  passport: "C1234567",
  phone: "0100005678",
  accountNumber: "0123456789",
  fullName: "Nguyễn Văn An",
  contractText: "Điều 5: bên B phải trả",
};
const VARS: Record<NotificationType, Vars> = {
  account_security: { orgName: "Nhà trọ Hoa Sen", action: "đặt lại xác thực hai lớp" },
  invoice_issued: {
    propertyName: "Nhà trọ Hoa Sen",
    period: "10/2026",
    dueOn: "2026-10-10",
    amount: 1_580_000,
    invoiceId: ID,
  },
  invoice_overdue: {
    propertyName: "Nhà trọ Hoa Sen",
    period: "10/2026",
    dueOn: "2026-10-10",
    amount: 1_580_000,
    invoiceId: ID,
  },
  lease_expiring: { propertyName: "Nhà trọ Hoa Sen", unitCode: "203", endOn: "2026-11-30", leaseId: ID },
  stay_notice_due: {
    propertyName: "KS Mai",
    unitCode: "203",
    dueAtLocal: "23:00 15/10/2026",
    noticeId: ID,
    severity: "urgent",
  },
  maintenance_status: { propertyName: "Nhà trọ Hoa Sen", unitCode: "203", status: "done", workOrderId: ID },
  export_ready: { exportName: "Báo cáo công nợ 10/2026", exportId: ID },
};

describe("account_security — sự kiện bảo mật của chính tài khoản (T-405)", () => {
  it.each([
    ["mfa_reset", "xác thực hai lớp đã được đặt lại", /đặt lại/],
    ["password_changed", "mật khẩu đã được đổi", /Mật khẩu tài khoản của bạn đã được đổi/],
    ["mfa_disabled", "xác thực hai lớp đã được tắt", /đã được tắt/],
  ])("%s: nêu việc đã xảy ra + cách xử lý, bắt buộc có cơ sở", (kind, action, re) => {
    const r = render("account_security", { orgName: "Nhà trọ Hoa Sen", action, kind });
    expect(r.title).toBe(`Nhà trọ Hoa Sen: ${action}`);
    expect(r.body).toMatch(re);
    expect(r.body).toContain("Nếu không phải bạn");
    expect(r.emailText).toContain("Nếu không phải bạn");
  });
});

describe("S-012 nội dung không chứa PII nhạy cảm", () => {
  for (const type of NOTIFICATION_TYPES) {
    it(`${type}: không CCCD/hộ chiếu/SĐT/số tài khoản/tên/nội dung hợp đồng dù có trong dữ liệu`, () => {
      const r = render(
        type,
        { ...SENSITIVE, ...VARS[type] },
        { baseUrl: "https://app.example", unsubscribeUrl: "https://app.example/u/x" },
      );
      const all = [r.title, r.body, r.emailSubject, r.emailText].join("\n");
      for (const v of Object.values(SENSITIVE)) expect(all).not.toContain(v);
      if (r.link) expect(r.emailText).toContain(`https://app.example${r.link}`);
      expect(r.emailText).toContain("cần đăng nhập");
    });
  }

  it("Q-03: email nhắc/phiếu thu không ghi số tiền; trong app ghi đủ `1.580.000 đ`", () => {
    for (const type of ["invoice_issued", "invoice_overdue"] as const) {
      const r = render(type, VARS[type]);
      expect(r.body).toContain("1.580.000 đ");
      expect(`${r.emailSubject}\n${r.emailText}`).not.toMatch(/1\.580\.000|đ\b/);
      expect(r.emailText).toContain("10/10/2026");
    }
  });

  it("biến khai báo mang dạng nhạy cảm (SĐT/CCCD/số tài khoản) → che `***`, vẫn gửi được, không lộ số (review PR #10)", () => {
    const cases: [NotificationType, Vars, string][] = [
      [
        "invoice_issued",
        { ...VARS.invoice_issued, propertyName: "Nhà nghỉ Hoa Mai - 0100003456" },
        "0100003456",
      ],
      ["invoice_issued", { ...VARS.invoice_issued, propertyName: "Nhà trọ +84 905 123 456" }, "905 123 456"],
      ["lease_expiring", { ...VARS.lease_expiring, unitCode: "012345678901" }, "012345678901"],
      ["export_ready", { ...VARS.export_ready, exportName: "TK 19036012345678" }, "19036012345678"],
    ];
    for (const [type, vars, secret] of cases) {
      const r = render(type, vars, { baseUrl: "https://app.example" });
      const all = [r.title, r.body, r.emailSubject, r.emailText].join("\n");
      expect(all).not.toContain(secret);
      expect(all).toContain("***");
    }
    expect(
      render("invoice_issued", { ...VARS.invoice_issued, propertyName: "Nhà nghỉ Hoa Mai - 0100003456" })
        .body,
    ).toBe("Nhà nghỉ Hoa Mai - ***: phiếu thu kỳ 10/2026 1.580.000 đ, hạn thanh toán 10/10/2026.");
  });

  it("mã UUID có nhóm cuối toàn chữ số không bị che (liên kết vẫn đúng)", () => {
    const id = "6f1c2b3a-1111-4222-8333-123456789012";
    expect(render("invoice_issued", { ...VARS.invoice_issued, invoiceId: id }).link).toBe(
      `/portal/phieu-thu/${id}`,
    );
  });

  it("thiếu biến/sai kiểu → TemplateError; ký tự xuống dòng bị loại khỏi tiêu đề (chống chèn header)", () => {
    expect(() => render("invoice_issued", { ...VARS.invoice_issued, dueOn: undefined })).toThrow(
      TemplateError,
    );
    expect(() => render("invoice_issued", { ...VARS.invoice_issued, amount: "1580000" })).toThrow(
      TemplateError,
    );
    expect(() => render("invoice_issued", { ...VARS.invoice_issued, invoiceId: "../x" })).toThrow(
      TemplateError,
    );
    const r = render("export_ready", { ...VARS.export_ready, exportName: "A\r\nBcc: x@evil.test" });
    expect(r.emailSubject).not.toMatch(/[\r\n]/);
  });

  it("liên kết huỷ đăng ký không có ở loại bắt buộc account_security", () => {
    expect(
      render("account_security", VARS.account_security, { unsubscribeUrl: "https://u" }).emailText,
    ).not.toContain("https://u");
    expect(
      render("invoice_issued", VARS.invoice_issued, { unsubscribeUrl: "https://u" }).emailText,
    ).toContain("https://u");
  });

  it("che email trong log", () => {
    expect(maskEmail("an.nguyen@example.com")).toBe("a***@example.com");
    expect(maskEmail("x")).toBe("***");
  });
});

describe("S-006 nhãn lịch sử gửi trung thực", () => {
  it("queued/sending: Đang chờ gửi; sent: đã chuyển cho nhà cung cấp; failed/dead: cần xử lý; không bao giờ 'Đã nhận'", () => {
    expect(deliveryStatusLabel("queued")).toBe("Đang chờ gửi");
    expect(deliveryStatusLabel("sending")).toBe("Đang chờ gửi");
    expect(deliveryStatusLabel("sent")).toBe("Đã chuyển cho nhà cung cấp email");
    expect(deliveryStatusLabel("failed")).toBe("Gửi thất bại — cần xử lý");
    expect(deliveryStatusLabel("dead")).toBe("Gửi thất bại — cần xử lý");
    for (const s of ["queued", "sending", "sent", "retrying", "failed", "dead", "suppressed"] as const)
      expect(deliveryStatusLabel(s, "OPTED_OUT")).not.toMatch(/đã nhận/i);
  });
});

describe("FakeEmailSender (hợp đồng adapter)", () => {
  it("cùng idempotencyKey → một email, cùng providerMessageId; lỗi cấu hình được ném đúng loại", async () => {
    const f = new FakeEmailSender();
    const m = { to: "a@example.com", subject: "s", text: "t", idempotencyKey: "d1" };
    const a = await f.send(m);
    const b = await f.send(m);
    expect(a).toEqual(b);
    expect(f.sent).toHaveLength(1);
    f.failWith = () => new EmailSendError("permanent", "550 5.1.1");
    await expect(f.send({ ...m, idempotencyKey: "d2" })).rejects.toMatchObject({ kind: "permanent" });
  });
});
