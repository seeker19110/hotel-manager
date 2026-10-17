// Mẫu thông báo trong app + email văn bản thuần (SPEC-notifications S-001, S-006, S-012; Q-03). Thuần, không I/O.
// - Mỗi mẫu chỉ đọc đúng các biến khai báo — trường thừa (CCCD, SĐT, số tài khoản…) có trong `vars` cũng không lọt ra.
// - Email KHÔNG ghi số tiền (Q-03); thông báo trong app (đã đăng nhập) ghi đủ.
// - Giá trị bị bỏ ký tự điều khiển/xuống dòng (chống chèn header khi có adapter SMTP), cắt độ dài.
// - Giá trị chữ tự do (tên cơ sở, mã phòng…) có dạng số CCCD/CMND (9/12 chữ số liền), SĐT Việt Nam hay số tài khoản
//   10–19 chữ số → thay bằng `***` (vd tên "Nhà nghỉ Hoa Mai - 0905123456" vẫn gửi được, không lộ số).
// - Lưới cuối: nội dung render vẫn còn các dạng đó → TemplateError (mặc định an toàn: không gửi thay vì lộ).

export const NOTIFICATION_TYPES = [
  "account_security",
  "invoice_issued",
  "invoice_overdue",
  "lease_expiring",
  "stay_notice_due",
  "maintenance_status",
  "export_ready",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** Loại bắt buộc — không tắt được (S-011, ERD `ck_notification_preferences_required`). */
export const REQUIRED_TYPES: ReadonlySet<NotificationType> = new Set(["account_security"]);

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export type Vars = Readonly<Record<string, unknown>>;

export interface Rendered {
  title: string;
  body: string;
  link: string | null;
  emailSubject: string;
  emailText: string;
}

const MAX_VALUE = 200;

// Biên: không dính chữ số, và dấu chấm chỉ bị coi là một phần số khi là dấu phân cách nghìn (`1.580.000`) — số dính dấu
// chấm câu/viết tắt (`ĐT.0905123456`, `… 0905123456.`) vẫn bị bắt.
const DOC_NO = /(?<!\d)(?<!\d\.)\d{9}(?:\d{3})?(?!\d)(?!\.\d)/;
const PHONE = /(?<!\d)(?<!\d\.)(?:\+?84|0)(?:[\s.-]?\d){9,10}(?!\d)(?!\.\d)/;
const ACCOUNT_NO = /(?<!\d)(?<!\d\.)\d{10,19}(?!\d)(?!\.\d)/;

/** Dạng nhạy cảm không được xuất hiện trong nội dung render (S-012). */
const SENSITIVE: readonly [string, RegExp][] = [
  ["số giấy tờ", DOC_NO],
  ["số điện thoại", PHONE],
  ["số tài khoản", ACCOUNT_NO],
];

/** Che các dạng nhạy cảm trong một giá trị biến (SĐT trước: dạng có dấu cách/chấm dài hơn dạng số liền). */
function redact(s: string): string {
  let out = s;
  for (const rx of [PHONE, DOC_NO, ACCOUNT_NO]) out = out.replace(new RegExp(rx.source, "g"), "***");
  return out;
}

function clean(v: unknown, name: string, opts: { redact?: boolean } = {}): string {
  if (v === undefined || v === null || v === "") throw new TemplateError(`thiếu biến ${name}`);
  if (typeof v !== "string" && typeof v !== "number") throw new TemplateError(`biến ${name} sai kiểu`);
  // Ký tự điều khiển (CR/LF/NUL…) → khoảng trắng: chống chèn header khi có adapter SMTP.
  const s = Array.from(String(v), (ch) => {
    const c = ch.charCodeAt(0);
    return c < 0x20 || c === 0x7f ? " " : ch;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!s) throw new TemplateError(`thiếu biến ${name}`);
  const cut = (x: string) => (x.length > MAX_VALUE ? `${x.slice(0, MAX_VALUE - 1)}…` : x);
  if (opts.redact === false) return cut(s);
  // Che → cắt → che lại: che trước để số nằm vắt qua chỗ cắt không còn lại phần dở (8/10 chữ số SĐT), che lại để dãy số
  // quá dài (≥ 20 chữ số, không khớp mẫu) bị cắt còn 10–19 chữ số cũng bị che.
  return redact(cut(redact(s)));
}

function str(vars: Vars, name: string): string {
  return clean(vars[name], name);
}

function vnd(vars: Vars, name: string): string {
  const v = vars[name];
  if (typeof v !== "number" || !Number.isSafeInteger(v))
    throw new TemplateError(`biến ${name} phải là số nguyên đồng`);
  return `${v.toLocaleString("vi-VN")} đ`;
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`. */
export function viDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new TemplateError(`ngày không hợp lệ: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function date(vars: Vars, name: string): string {
  return viDate(str(vars, name));
}

function uuidLink(prefix: string, vars: Vars, name: string): string {
  // Mã kiểm bằng định dạng UUID, không che (nhóm cuối 12 chữ số liền là UUID hợp lệ).
  const id = clean(vars[name], name, { redact: false });
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new TemplateError(`biến ${name} không phải mã hợp lệ`);
  return `${prefix}/${id}`;
}

const MAINTENANCE_LABEL: Readonly<Record<string, string>> = {
  assigned: "đã giao kỹ thuật",
  in_progress: "đang sửa",
  done: "đã sửa xong, chờ nghiệm thu",
  verified: "đã hoàn tất",
  cancelled: "đã huỷ",
};

const SEVERITY_PREFIX: Readonly<Record<string, string>> = {
  normal: "",
  urgent: "Khẩn: ",
  overdue: "Quá hạn: ",
};

type Builder = (vars: Vars) => Omit<Rendered, "emailText"> & { emailLines: string[] };

const BUILDERS: Readonly<Record<NotificationType, Builder>> = {
  account_security: (v) => {
    const org = str(v, "orgName");
    if (v.kind === "tenant_invited") {
      // Lời mời vào cổng người thuê (SPEC-portal S-014): đăng nhập bằng mã gửi về chính email này (không mật khẩu).
      return {
        title: `${org} mời bạn vào cổng người thuê`,
        body: "Bạn có thể xem kỳ thu, hợp đồng và gửi yêu cầu. Đăng nhập bằng email này — mã đăng nhập gửi qua email.",
        link: "/dang-nhap",
        emailSubject: `${org} mời bạn vào cổng người thuê`,
        emailLines: [
          `${org} đã mời bạn vào cổng người thuê để xem kỳ thu, hợp đồng và gửi yêu cầu.`,
          "Đăng nhập bằng địa chỉ email này; hệ thống sẽ gửi mã đăng nhập mỗi lần.",
          "Nếu bạn không thuê phòng ở đây, hãy bỏ qua email này.",
        ],
      };
    }
    const action = str(v, "action");
    return {
      title: `${org}: ${action}`,
      body: `Có thao tác bảo mật trên tài khoản của bạn: ${action}. Nếu không phải bạn, hãy liên hệ quản lý.`,
      link: "/tai-khoan",
      emailSubject: `${org}: ${action}`,
      emailLines: [
        `Có thao tác bảo mật trên tài khoản của bạn tại ${org}: ${action}.`,
        "Nếu không phải bạn, hãy liên hệ quản lý.",
      ],
    };
  },
  invoice_issued: (v) => {
    const p = str(v, "propertyName");
    const period = str(v, "period");
    const due = date(v, "dueOn");
    return {
      title: `Phiếu thu kỳ ${period}`,
      body: `${p}: phiếu thu kỳ ${period} ${vnd(v, "amount")}, hạn thanh toán ${due}.`,
      link: uuidLink("/portal/phieu-thu", v, "invoiceId"),
      emailSubject: `${p}: phiếu thu kỳ ${period}`,
      emailLines: [`${p} đã phát hành phiếu thu kỳ ${period}, hạn thanh toán ${due}.`],
    };
  },
  invoice_overdue: (v) => {
    const p = str(v, "propertyName");
    const period = str(v, "period");
    const due = date(v, "dueOn");
    return {
      title: `Phiếu thu kỳ ${period} đã quá hạn`,
      body: `${p}: phiếu thu kỳ ${period} còn ${vnd(v, "amount")}, đã quá hạn ${due}.`,
      link: uuidLink("/portal/phieu-thu", v, "invoiceId"),
      emailSubject: `${p}: nhắc phiếu thu kỳ ${period} quá hạn`,
      emailLines: [`Phiếu thu kỳ ${period} tại ${p} đã quá hạn thanh toán (${due}).`],
    };
  },
  lease_expiring: (v) => {
    const p = str(v, "propertyName");
    const unit = str(v, "unitCode");
    const end = date(v, "endOn");
    return {
      title: `Hợp đồng phòng ${unit} hết hạn ${end}`,
      body: `${p}: hợp đồng phòng ${unit} kết thúc ${end}. Cần gia hạn hoặc chuẩn bị trả phòng.`,
      // Người thuê (người đại diện) mở portal; nhân viên mở trang hợp đồng.
      link: v.audience === "tenant" ? "/portal/hop-dong" : uuidLink("/hop-dong", v, "leaseId"),
      emailSubject: `${p}: hợp đồng phòng ${unit} sắp hết hạn`,
      emailLines: [`Hợp đồng phòng ${unit} tại ${p} kết thúc ${end}.`],
    };
  },
  stay_notice_due: (v) => {
    const p = str(v, "propertyName");
    if (v.kind === "config_missing") {
      // S-020: cơ sở chưa cấu hình hạn thông báo lưu trú (không có mặc định cứng — Q-08).
      return {
        title: "Chưa cấu hình hạn thông báo lưu trú",
        body: `${p}: chưa cấu hình hạn thông báo lưu trú nên hệ thống không nhắc được. Vào Cài đặt → Thông báo để nhập hạn.`,
        link: "/cai-dat/thong-bao",
        emailSubject: `${p}: chưa cấu hình hạn thông báo lưu trú`,
        emailLines: [`${p} chưa cấu hình hạn thông báo lưu trú nên hệ thống không nhắc được.`],
      };
    }
    const unit = str(v, "unitCode");
    const dueAt = str(v, "dueAtLocal");
    const sev = SEVERITY_PREFIX[String(v.severity ?? "normal")] ?? "";
    return {
      title: `${sev}Phòng ${unit}: thông báo lưu trú`,
      body: `${sev}Phòng ${unit}: cần thông báo lưu trú trước ${dueAt}. Hệ thống không tự gửi cho cơ quan nhà nước.`,
      link: uuidLink("/luu-tru", v, "noticeId"),
      emailSubject: `${p}: ${sev}phòng ${unit} cần thông báo lưu trú`,
      emailLines: [`${sev}Phòng ${unit} tại ${p}: cần thông báo lưu trú trước ${dueAt}.`],
    };
  },
  maintenance_status: (v) => {
    const p = str(v, "propertyName");
    const unit = str(v, "unitCode");
    const label = MAINTENANCE_LABEL[str(v, "status")];
    if (!label) throw new TemplateError("trạng thái phiếu sự cố không hợp lệ");
    return {
      title: `Sự cố phòng ${unit}: ${label}`,
      body: `${p}: phiếu sự cố phòng ${unit} ${label}.`,
      link: uuidLink("/portal/su-co", v, "workOrderId"),
      emailSubject: `${p}: sự cố phòng ${unit} ${label}`,
      emailLines: [`Phiếu sự cố phòng ${unit} tại ${p} ${label}.`],
    };
  },
  export_ready: (v) => {
    const name = str(v, "exportName");
    return {
      title: `Đã xuất xong: ${name}`,
      body: `File ${name} đã sẵn sàng tải về (liên kết có hạn).`,
      link: uuidLink("/xuat-du-lieu", v, "exportId"),
      emailSubject: `Đã xuất xong: ${name}`,
      emailLines: [`File ${name} đã sẵn sàng. Đăng nhập để tải về.`],
    };
  },
};

function assertNoSensitive(text: string): void {
  for (const [what, rx] of SENSITIVE)
    if (rx.test(text)) throw new TemplateError(`nội dung chứa dạng ${what} — không gửi`);
}

/** Render thông báo; `baseUrl` (vd https://app.example) để email có liên kết tuyệt đối tới trang cần đăng nhập. */
export function render(
  type: NotificationType,
  vars: Vars,
  opts: { baseUrl?: string; unsubscribeUrl?: string } = {},
): Rendered {
  const b = BUILDERS[type];
  if (!b) throw new TemplateError(`không có mẫu ${type}`);
  const r = b(vars);
  const lines = [
    "Xin chào,",
    "",
    ...r.emailLines,
    ...(r.link
      ? ["", `Xem chi tiết (cần đăng nhập): ${(opts.baseUrl ?? "").replace(/\/$/, "")}${r.link}`]
      : []),
    "",
    "—",
    "Email tự động từ Hotel Manager, vui lòng không trả lời.",
    ...(opts.unsubscribeUrl && !REQUIRED_TYPES.has(type)
      ? [`Không muốn nhận loại email này: ${opts.unsubscribeUrl}`]
      : []),
  ];
  const out: Rendered = {
    title: r.title,
    body: r.body,
    link: r.link,
    emailSubject: r.emailSubject,
    emailText: lines.join("\n"),
  };
  assertNoSensitive([out.title, out.body, out.emailSubject, ...r.emailLines].join("\n"));
  return out;
}

/** Che email trong log: `an.nguyen@example.com` → `a***@example.com` (S-012). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export type DeliveryStatus = "queued" | "sending" | "sent" | "retrying" | "failed" | "dead" | "suppressed";

/** Nhãn trung thực cho lịch sử gửi (S-006): không bao giờ "đã nhận"; `sent` = đã chuyển cho nhà cung cấp. */
export function deliveryStatusLabel(status: DeliveryStatus, suppressedReason?: string | null): string {
  switch (status) {
    case "queued":
    case "sending":
      return "Đang chờ gửi";
    case "retrying":
      return "Nhà cung cấp tạm lỗi — đang thử lại";
    case "sent":
      return "Đã chuyển cho nhà cung cấp email";
    case "failed":
    case "dead":
      return "Gửi thất bại — cần xử lý";
    case "suppressed":
      return suppressedReason === "OPTED_OUT"
        ? "Không gửi — người nhận đã tắt loại email này"
        : suppressedReason === "NO_ADDRESS"
          ? "Không gửi — chưa có địa chỉ email"
          : "Không gửi — đã thanh toán xong";
  }
}
