// Ma trận quyền (SPEC-access-and-property 5.3) dạng dữ liệu. Test `matrix.spec-sync.test.ts` đọc bảng trong SPEC
// và so với file này — sửa quyền phải sửa CẢ HAI (SPEC là nguồn duyệt, code là nguồn chạy).

export const ROLES = [
  "owner",
  "manager",
  "front_desk",
  "accountant",
  "housekeeping",
  "maintenance",
  "tenant",
  "guest",
] as const;
export type MatrixRole = (typeof ROLES)[number];

/**
 * yes = được trong phạm vi cơ sở · limit = trong hạn mức (vượt → APPROVAL_LIMIT_EXCEEDED) · own = chỉ bản ghi của mình
 * read = chỉ xem · request = chỉ lập đề nghị · no = không.
 */
export type Grant = "yes" | "limit" | "own" | "read" | "request" | "no";

type Row = readonly [Grant, Grant, Grant, Grant, Grant, Grant, Grant, Grant];

/** Khoá hành động → nhãn dòng trong SPEC (để test đồng bộ) và quyền theo thứ tự ROLES. */
export const MATRIX = {
  "org.configure": [
    "Sửa tổ chức; tạo cơ sở; múi giờ/giờ chốt/mẫu",
    ["yes", "no", "no", "no", "no", "no", "no", "no"],
  ],
  "unit.manage": ["Tầng, phòng (tạo/sửa/lưu trữ)", ["yes", "yes", "no", "no", "no", "no", "no", "no"]],
  "pricing.manage": ["Loại phòng, bảng giá (F-006)", ["yes", "no", "no", "no", "no", "no", "no", "no"]],
  "member.invite_senior": [
    "Mời/thu hồi `owner`/`manager`/`accountant`",
    ["yes", "no", "no", "no", "no", "no", "no", "no"],
  ],
  "member.invite_staff": [
    "Mời/thu hồi `front_desk`/`housekeeping`/`maintenance`",
    ["yes", "yes", "no", "no", "no", "no", "no", "no"],
  ],
  "member.change_role": ["Đổi vai trò, phạm vi, hạn mức", ["yes", "no", "no", "no", "no", "no", "no", "no"]],
  "session.revoke_other": ["Thu hồi phiên người khác", ["yes", "yes", "no", "no", "no", "no", "no", "no"]],
  "calendar.read_guests": [
    "Xem lịch phòng (có tên khách)",
    ["yes", "yes", "yes", "read", "no", "no", "no", "no"],
  ],
  "calendar.read_status": [
    "Xem lịch phòng (chỉ số phòng, trống/có khách, vệ sinh)",
    ["yes", "yes", "yes", "yes", "yes", "yes", "no", "no"],
  ],
  "reservation.manage": [
    "Tạo hold/booking, đổi ngày, huỷ, check-in/out",
    ["yes", "yes", "yes", "no", "no", "no", "no", "no"],
  ],
  "residence_notice.manage": [
    "Thông báo lưu trú: xuất mẫu, đánh dấu đã thông báo (`stay.exportResidenceNotice`/`stay.markNoticeSubmitted`)",
    ["yes", "yes", "yes", "no", "no", "no", "no", "no"],
  ],
  "reservation.override_price": [
    "Đổi giá/giảm giá trên booking",
    ["yes", "limit", "limit", "no", "no", "no", "no", "no"],
  ],
  "stay.checkout_with_debt": [
    "Check-out còn công nợ",
    ["yes", "yes", "request", "no", "no", "no", "no", "no"],
  ],
  "stay.move": ["Chuyển phòng", ["yes", "yes", "yes", "no", "no", "no", "no", "no"]],
  "block.propose": ["Đề xuất block", ["yes", "yes", "yes", "no", "no", "yes", "no", "no"]],
  "block.approve": ["Duyệt/kết thúc block", ["yes", "yes", "no", "no", "no", "no", "no", "no"]],
  "unit.set_availability": [
    "Bật/tắt phòng ngừng khai thác (`inventory.setUnitAvailability`)",
    ["yes", "yes", "no", "no", "no", "no", "no", "no"],
  ],
  "inventory.resolve_exception": [
    "Xử lý ngoại lệ lịch (`inventory.resolveException`)",
    ["yes", "yes", "no", "no", "no", "no", "no", "no"],
  ],
  "folio.post_charge": ["Ghi dịch vụ/phụ thu vào folio", ["yes", "yes", "yes", "no", "no", "no", "no", "no"]],
  "money.read": ["Xem số tiền, folio, công nợ", ["yes", "yes", "yes", "yes", "no", "no", "own", "own"]],
  "payment.record": ["Ghi nhận thanh toán (F-005)", ["yes", "yes", "yes", "yes", "no", "no", "no", "no"]],
  "payment.confirm_transfer": [
    "Xác nhận thanh toán chuyển khoản có chứng cứ (INV-F3)",
    ["yes", "yes", "no", "yes", "no", "no", "no", "no"],
  ],
  "payment.confirm_cash": [
    "Xác nhận tiền mặt (INV-F3b): `payment.confirm` method `cash`",
    ["yes", "yes", "own", "yes", "no", "no", "no", "no"],
  ],
  "deposit.receive": ["Nhận cọc (`deposit.receive`)", ["yes", "yes", "yes", "yes", "no", "no", "no", "no"]],
  "payment.allocate": [
    "Phân bổ tiền, điều chỉnh có lý do",
    ["yes", "limit", "no", "yes", "no", "no", "no", "no"],
  ],
  "deposit.refund": [
    "Hoàn/khấu trừ cọc (`deposit.requestRefund`/`approveRefund`, `requestDeduction`/`approveDeduction`; INV-F5)",
    ["yes", "limit", "limit", "request", "no", "no", "no", "no"],
  ],
  "credit.refund": [
    "Hoàn ứng trước (`credit.requestRefund`/`credit.approveRefund`)",
    ["yes", "limit", "limit", "request", "no", "no", "no", "no"],
  ],
  "shift.open_close": [
    "Mở/đóng ca quầy (`shift.open`/`shift.close`)",
    ["yes", "yes", "own", "yes", "no", "no", "no", "no"],
  ],
  "shift.handover": [
    "Bàn giao ca (`shift.handover` — người nhận xác nhận, không tự nhận ca của mình)",
    ["yes", "yes", "own", "yes", "no", "no", "no", "no"],
  ],
  "period.lock": [
    "Chốt kỳ (`billing.lockPeriod`/`ledger.lockPeriod`)",
    ["yes", "yes", "no", "yes", "no", "no", "no", "no"],
  ],
  "period.unlock": [
    "Mở khoá kỳ (`ledger.unlockPeriod`, `locked → issued`; INV-F6)",
    ["yes", "no", "no", "no", "no", "no", "no", "no"],
  ],
  "lease.manage": [
    "Lập hợp đồng, ký, kích hoạt (`lease.createDraft`/`updateDraft`/`submitForSignature`/`sign`/`activate`/`renew`/`giveNotice`)",
    ["yes", "yes", "no", "no", "no", "no", "no", "no"],
  ],
  "lease.hold": [
    "Giữ chỗ hợp đồng (`lease.hold`, TTL 48 giờ cấu hình)",
    ["yes", "yes", "yes", "no", "no", "no", "no", "no"],
  ],
  "lease.handover": [
    "Bàn giao nhận/trả phòng (`lease.recordHandover`)",
    ["yes", "yes", "yes", "no", "no", "no", "own", "no"],
  ],
  "lease.prepare_settlement": [
    "Lập quyết toán/thanh lý (`lease.prepareSettlement`)",
    ["yes", "yes", "no", "request", "no", "no", "no", "no"],
  ],
  "lease.approve_settlement": [
    "Duyệt quyết toán/thanh lý (`lease.approveSettlement`, `lease.close`)",
    ["yes", "limit", "no", "no", "no", "no", "no", "no"],
  ],
  "meter.record": [
    "Nhập chỉ số công tơ (`meter.recordReading`)",
    ["yes", "yes", "yes", "no", "no", "own", "no", "no"],
  ],
  "meter.replace": ["Thay công tơ (`meter.replace`)", ["yes", "yes", "no", "no", "no", "no", "no", "no"]],
  "billing.prepare": [
    "Tạo/xem trước/gửi duyệt kỳ thu (`billing.createPeriod`/`previewPeriod`/`submitForReview`/`returnToDraft`)",
    ["yes", "yes", "no", "yes", "no", "no", "no", "no"],
  ],
  "billing.issue": [
    "Phát hành kỳ thu (`billing.issuePeriod`)",
    ["yes", "yes", "no", "yes", "no", "no", "no", "no"],
  ],
  "import.prepare": [
    "Chuẩn bị nhập liệu (`import.prepare`: upload/validate)",
    ["yes", "yes", "no", "no", "no", "no", "no", "no"],
  ],
  "import.commit": [
    "Xác nhận/commit nhập liệu có số dư tiền (`import.confirm`/`import.commit`)",
    ["yes", "no", "no", "no", "no", "no", "no", "no"],
  ],
  "portal.invite_tenant": ["Mời người thuê vào portal", ["yes", "yes", "yes", "no", "no", "no", "no", "no"]],
  "portal.guest_link": [
    "Tạo/thu hồi link khách (`portal.createGuestLink`/`revokeGuestLink`)",
    ["yes", "yes", "yes", "no", "no", "no", "no", "no"],
  ],
  "notification.configure": [
    "Cấu hình thông báo (`notification_settings`)",
    ["yes", "yes", "no", "no", "no", "no", "no", "no"],
  ],
  "identity.read": ["Đọc `identity_documents`", ["yes", "yes", "yes", "no", "no", "no", "own", "no"]],
  "housekeeping.assign": ["Tạo/giao việc dọn", ["yes", "yes", "yes", "no", "own", "no", "no", "no"]],
  "housekeeping.progress": ["Cập nhật tiến độ việc dọn", ["yes", "yes", "no", "no", "own", "no", "no", "no"]],
  "task.verify": [
    "Nghiệm thu (`verified`) việc dọn/sự cố",
    ["yes", "yes", "no", "no", "no", "no", "no", "no"],
  ],
  "work_order.create": ["Tạo phiếu sự cố", ["yes", "yes", "yes", "no", "yes", "yes", "own", "no"]],
  "work_order.handle": ["Xử lý phiếu sự cố", ["yes", "yes", "no", "no", "no", "own", "no", "no"]],
  "audit.read": ["Xem audit", ["yes", "yes", "no", "yes", "no", "no", "no", "no"]],
  "data.export": ["Xuất dữ liệu (xác thực lại)", ["yes", "no", "no", "yes", "no", "no", "no", "no"]],
  "support.grant": [
    "Cấp/thu hồi truy cập hỗ trợ có thời hạn (`support.grantAccess`/`support.revokeAccess`, F-015)",
    ["yes", "no", "no", "no", "no", "no", "no", "no"],
  ],
  "org.delete": [
    "Yêu cầu/huỷ xoá tổ chức (`org.requestDeletion` xác thực lại/`org.cancelDeletion`, T-2312)",
    ["yes", "no", "no", "no", "no", "no", "no", "no"],
  ],
} as const satisfies Record<string, readonly [string, Row]>;

export type Action = keyof typeof MATRIX;

/**
 * `platform_support` (F-015, D-122): KHÔNG có cột trong ma trận — mặc định không có quyền gì. Khi đang có truy cập hỗ trợ còn hiệu lực
 * (chủ tổ chức cấp, `support_grants`; `resolveActor` chỉ trả actor này khi grant chưa thu hồi/chưa hết hạn) thì CHỈ ĐỌC đúng các
 * hành động dưới đây — không tên khách, không tiền, không giấy tờ, không audit. Mở rộng = sửa danh sách + SPEC-access 5.3 + test.
 */
export const SUPPORT_READ_ACTIONS: readonly Action[] = ["calendar.read_status"];

export function grantFor(action: Action, role: MatrixRole): Grant {
  const [, row] = MATRIX[action];
  return row[ROLES.indexOf(role)] as Grant;
}

/**
 * Hạn mức mặc định theo vai trò (đồng/lần); `memberships.limits` ghi đè.
 * `refund`: số đã duyệt 2026-10-15 (SPEC-ledger mục 10). `price_override`, `allocation`: SPEC chưa có số → 0
 * (mọi khoản cần duyệt — mặc định an toàn) cho tới khi PO chốt.
 */
export const DEFAULT_LIMITS: Readonly<Partial<Record<MatrixRole, Readonly<Record<string, number>>>>> = {
  // allocation: phân bổ/đảo/điều chỉnh — mặc định bằng hạn mức tiền của quản lý (PLAN đợt 2, quyết 2026-10-15).
  manager: { refund: 5_000_000, price_override: 0, allocation: 5_000_000 },
  front_desk: { refund: 2_000_000, price_override: 0 },
};

/** Loại hạn mức áp cho từng hành động có `limit`. */
export const LIMIT_KIND: Partial<Record<Action, string>> = {
  "reservation.override_price": "price_override",
  "payment.allocate": "allocation",
  "deposit.refund": "refund",
  "credit.refund": "refund",
  "lease.approve_settlement": "refund",
};
